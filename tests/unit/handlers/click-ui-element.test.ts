import { describe, it, expect } from 'vitest';
import { handleClickUiElement } from '../../../src/tools/runtime-tools.js';
import { createRuntimeFake, makeContext } from '../../helpers/runtime-fakes.js';

describe('handleClickUiElement', () => {
  it('rejects when no runtime session is active', async () => {
    const fake = createRuntimeFake();
    const result = await handleClickUiElement(fake.asRunner, {}, makeContext(fake));
    const text = JSON.stringify(result);
    expect(text).toContain('No active runtime session');
  });

  it('rejects missing element identifier', async () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/fake/project',
      hasExited: false,
    });
    const result = await handleClickUiElement(fake.asRunner, {}, makeContext(fake));
    expect(JSON.stringify(result)).toContain('element');
  });

  it('forwards element as camelCase param to the bridge with input command', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ clicked: true, signal_emitted: 'pressed', new_value: true });
    const result = await handleClickUiElement(
      fake.asRunner,
      { element: 'HUD/StartButton' },
      makeContext(fake),
    );
    const text = JSON.stringify(result);
    expect(text).toContain('"clicked":true');
    expect(fake.bridgeCalls.length).toBe(1);
    expect(fake.bridgeCalls[0]!.command).toBe('click_ui_element');
    expect(fake.bridgeCalls[0]!.params.element).toBe('HUD/StartButton');
  });

  it('propagates bridge error responses as an error result', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ clicked: false, error: 'element not found' });
    const result = await handleClickUiElement(
      fake.asRunner,
      { element: 'NoSuchButton' },
      makeContext(fake),
    );
    const text = JSON.stringify(result);
    expect(text).toContain('element not found');
    expect(text).toContain('isError');
    expect(fake.bridgeCalls.length).toBe(1);
  });

  it('attaches runtime errors as warnings', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ clicked: true }, ['SCRIPT ERROR: boom.gd:10 handler crashed']);
    const result = await handleClickUiElement(fake.asRunner, { element: 'Btn' }, makeContext(fake));
    const text = JSON.stringify(result);
    expect(text).toContain('boom.gd:10');
    expect(text).toContain('clicked');
  });
});
