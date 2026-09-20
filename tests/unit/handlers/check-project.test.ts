import { describe, it, expect } from 'vitest';
import { handleCheckProject } from '../../../src/tools/project-tools.js';
import { createRuntimeFake } from '../../helpers/runtime-fakes.js';
import { unwrap, hasError } from '../../helpers/assertions.js';

/**
 * Coverage for check_project's always-present `runtime` block. Argument
 * validation and the projectPath-present payload shape (name/path/structure)
 * live in project-handlers.test.ts; this file exercises only the runtime
 * probe branches, via the bridge-command fake in runtime-fakes.ts.
 */
describe('handleCheckProject runtime block', () => {
  it('reports { activeSession: false } exactly when there is no session', async () => {
    const fake = createRuntimeFake();
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime).toEqual({ activeSession: false });
  });

  it('reports activeSession:true and bridgeResponsive:true when the bridge answers pong', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(true);
    expect(data.runtime.sessionMode).toBe('spawned');
    expect(data.runtime.bridgeResponsive).toBe(true);
    expect(fake.bridgeCalls[0]!.command).toBe('ping');
  });

  it('reports processExited:true after a spawned game exited on its own', async () => {
    // The state the real runner lands in: handleSpawnedProcessExit nulls the
    // session fields and keeps the process, so a report gated on the session
    // fields alone would call this "no session" and withhold the one thing
    // worth saying about it.
    const fake = createRuntimeFake();
    fake.setSession({ mode: null, projectPath: null, hasExited: true });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.processExited).toBe(true);
    expect(data.runtime.diagnostics.join('; ')).toContain('stop_project');
    expect(data.runtime.diagnostics.join('; ')).toContain('get_debug_output');
    // No bridge ping on a dead process.
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('reports activeSession:false and processExited:true when a spawn never produced a live process', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: true });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.processExited).toBe(true);
    expect(Array.isArray(data.runtime.diagnostics)).toBe(true);
    expect(data.runtime.diagnostics.length).toBeGreaterThan(0);
  });

  it('reports bridgeResponsive:false without failing the call when the ping throws', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setSendCommandError(new Error('Connection refused'));
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    expect(unwrap(result)).not.toHaveProperty('isError', true);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.bridgeResponsive).toBe(false);
    expect(data.runtime.diagnostics.join('; ')).toContain('Connection refused');
  });

  it('returns only { godotVersion, runtime } when projectPath is omitted', async () => {
    const fake = createRuntimeFake();
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(Object.keys(data).sort()).toEqual(['godotVersion', 'runtime']);
  });
});
