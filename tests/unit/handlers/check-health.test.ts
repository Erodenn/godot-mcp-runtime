import { describe, it, expect } from 'vitest';
import { handleCheckHealth } from '../../../src/tools/runtime-tools.js';
import { createRuntimeFake, makeContext } from '../../helpers/runtime-fakes.js';
import { unwrap } from '../../helpers/assertions.js';

describe('handleCheckHealth', () => {
  it('reports healthy session when bridge responds to ping', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckHealth(fake.asRunner, {}, makeContext(fake));
    expect(result.ok).toBe(true);
    const data = JSON.parse(unwrap(result).content[0]!.text);
    expect(data.healthy).toBe(true);
    expect(data.active_session).toBe(true);
    expect(data.session_mode).toBe('spawned');
    expect(data.bridge_responsive).toBe(true);
    expect(fake.bridgeCalls[0]!.command).toBe('ping');
  });

  it('works without an active session (reports inactive, still succeeds)', async () => {
    const fake = createRuntimeFake();
    const result = await handleCheckHealth(fake.asRunner, {}, makeContext(fake));
    expect(result.ok).toBe(true);
    const data = JSON.parse(unwrap(result).content[0]!.text);
    expect(data.healthy).toBe(false);
    expect(data.active_session).toBe(false);
    expect(data.diagnostics).toContain('No active runtime session');
  });

  it('reports unhealthy when spawned process has exited', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: true });
    const result = await handleCheckHealth(fake.asRunner, {}, makeContext(fake));
    expect(result.ok).toBe(true);
    const data = JSON.parse(unwrap(result).content[0]!.text);
    expect(data.healthy).toBe(false);
    expect(data.active_session).toBe(false);
    expect(data.process_exited).toBe(true);
  });

  it('reports unhealthy when bridge does not respond', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setSendCommandError(new Error('Connection refused'));
    const result = await handleCheckHealth(fake.asRunner, {}, makeContext(fake));
    expect(result.ok).toBe(true);
    const data = JSON.parse(unwrap(result).content[0]!.text);
    expect(data.healthy).toBe(false);
    expect(data.bridge_responsive).toBe(false);
    expect(data.diagnostics.join('; ')).toContain('Connection refused');
  });

  it('includes engine version and suggestions on failure', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setSendCommandError(new Error('timeout'));
    const result = await handleCheckHealth(fake.asRunner, {}, makeContext(fake));
    const data = JSON.parse(unwrap(result).content[0]!.text);
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data.suggestions.length).toBeGreaterThan(0);
  });
});
