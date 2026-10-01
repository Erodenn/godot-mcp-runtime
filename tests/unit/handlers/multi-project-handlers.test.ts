/**
 * Handler tests for sessions on several projects, against a real GodotRunner
 * holding installed session records (no Godot process, no bridge socket).
 *
 * Covers switch_project, the runtime and profiling handlers refusing to fall
 * back to another live session, and the project path every runtime response
 * names. The bridge is a spy on `sendCommandWithErrors`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Ajv from 'ajv';
import { resolve } from 'path';
import {
  BridgeDisconnectedError,
  GodotRunner,
  type GodotProcess,
} from '../../../src/utils/godot-runner.js';
import {
  handleGetDebugOutput,
  handleGetUiElements,
  handleRunScript,
  handleSimulateInput,
  handleStopProject,
  handleSwitchProject,
  handleTakeScreenshot,
  runtimeToolDefinitions,
} from '../../../src/tools/runtime-tools.js';
import {
  handleProfileProject,
  handleStartProfiler,
  handleStopProfiler,
} from '../../../src/tools/profiler-tools.js';
import { installSession, currentRecord } from '../../helpers/session-install.js';
import { fakeSessionApi } from '../../helpers/fake-sessions.js';
import { expectErrorMatching, hasError, unwrap } from '../../helpers/assertions.js';
import { useTmpDirs } from '../../helpers/tmp.js';

const tmp = useTmpDirs();

const PORT_A = 6101;
const PORT_B = 6102;
const EXIT_CODE = 3;
const SWITCH_DESCRIPTION_BUDGET_CHARS = 500;
const BENIGN_SCRIPT = 'extends RefCounted\nfunc execute(scene_tree):\n\treturn 1\n';
const SINGLE_PROJECT_SCREENSHOT_ERROR =
  'No active runtime session. A project must be running or attached to take a screenshot.';

function liveProcess(): GodotProcess {
  return {
    process: undefined as never,
    output: ['live-out'],
    errors: [],
    totalErrorsWritten: 0,
    exitCode: null,
    hasExited: false,
    sessionToken: 'tok',
  };
}

function exitedProcess(code: number): GodotProcess {
  return {
    process: undefined as never,
    output: ['exited-out'],
    errors: ['exited-err'],
    totalErrorsWritten: 0,
    exitCode: code,
    hasExited: true,
    sessionToken: 'tok',
  };
}

function stubBridge(runner: GodotRunner, payload: unknown) {
  return vi.spyOn(runner, 'sendCommandWithErrors').mockResolvedValue({
    response: JSON.stringify(payload),
    runtimeErrors: [],
    stderrWindow: [],
  });
}

function fullText(result: unknown): string {
  return unwrap(result)
    .content.map((entry) => entry.text ?? '')
    .join('\n');
}

function payloadOf(result: unknown): Record<string, unknown> {
  expect(hasError(result)).toBe(false);
  return unwrap(result).structuredContent as Record<string, unknown>;
}

function makeProjectPath(prefix: string): string {
  return resolve(tmp.makeProject(prefix));
}

function installLive(
  runner: GodotRunner,
  projectPath: string,
  bridgePort: number,
  current: boolean,
): void {
  installSession(runner, {
    projectPath,
    mode: 'spawned',
    bridgePort,
    process: liveProcess(),
    current,
  });
}

function installExited(runner: GodotRunner, projectPath: string, current: boolean): void {
  installSession(runner, {
    projectPath,
    mode: null,
    process: exitedProcess(EXIT_CODE),
    current,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('switch_project', () => {
  it('makes a live session on another project current and names both projects', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    const b = makeProjectPath('switch-b-');
    installLive(runner, a, PORT_A, false);
    installLive(runner, b, PORT_B, true);
    stubBridge(runner, { status: 'pong' });

    const result = await handleSwitchProject(runner, { projectPath: a });

    const payload = payloadOf(result);
    expect(payload.projectPath).toBe(a);
    expect(payload.previousProjectPath).toBe(b);
    expect(payload.live).toBe(true);
    expect(payload.sessionMode).toBe('spawned');
    expect(payload.bridgePort).toBe(PORT_A);
    expect(payload.bridgeResponsive).toBe(true);
    expect(payload).not.toHaveProperty('warnings');
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(a);
  });

  it('errors for a project with no session and lists the live sessions', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    const b = makeProjectPath('switch-b-');
    const c = makeProjectPath('switch-c-');
    installLive(runner, a, PORT_A, false);
    installLive(runner, b, PORT_B, true);

    const result = await handleSwitchProject(runner, { projectPath: c });

    expectErrorMatching(result, /No runtime session on/);
    expect(fullText(result)).toContain(a);
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);
  });

  it.each([
    ['a missing projectPath', {}, /projectPath is required/],
    ['a numeric projectPath', { projectPath: 42 }, /must be a string/],
    ['a path with ..', { projectPath: '../elsewhere' }, /Invalid project path/],
  ])('rejects %s through parseProjectArgs', async (_label, args, pattern) => {
    const runner = new GodotRunner();
    const switchSpy = vi.spyOn(runner, 'switchSession');

    const result = await handleSwitchProject(runner, args as Record<string, unknown>);

    expectErrorMatching(result, pattern);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('rejects a directory with no project.godot through parseProjectArgs', async () => {
    const runner = new GodotRunner();
    const switchSpy = vi.spyOn(runner, 'switchSession');
    const notAProject = tmp.make('switch-not-a-project-');

    const result = await handleSwitchProject(runner, { projectPath: notAProject });

    expectErrorMatching(result, /Not a valid Godot project/);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('accepts project_path in snake_case', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    installLive(runner, a, PORT_A, false);
    stubBridge(runner, { status: 'pong' });

    const result = await handleSwitchProject(runner, { project_path: a });

    expect(payloadOf(result).projectPath).toBe(a);
  });

  it('selects a session whose game exited and says it is not live', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    const b = makeProjectPath('switch-b-');
    installLive(runner, a, PORT_A, true);
    installExited(runner, b, false);
    const bridge = stubBridge(runner, { status: 'pong' });

    const result = await handleSwitchProject(runner, { projectPath: b });

    const payload = payloadOf(result);
    expect(payload.projectPath).toBe(b);
    expect(payload.live).toBe(false);
    expect(payload.bridgeResponsive).toBeNull();
    expect(payload.exitCode).toBe(EXIT_CODE);
    const warnings = payload.warnings as string[];
    expect(warnings[0]).toMatch(/exited/);
    expect(warnings[0]).toMatch(/get_debug_output/);
    expect(bridge).not.toHaveBeenCalled();

    const logs = payloadOf(handleGetDebugOutput(runner, {}));
    expect(logs.projectPath).toBe(b);
    expect(logs.running).toBe(false);
  });

  it('reports an unanswered probe without failing the switch', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    const b = makeProjectPath('switch-b-');
    installLive(runner, a, PORT_A, false);
    installLive(runner, b, PORT_B, true);
    vi.spyOn(runner, 'sendCommandWithErrors').mockRejectedValue(new Error('Connection refused'));

    const result = await handleSwitchProject(runner, { projectPath: a });

    const payload = payloadOf(result);
    expect(payload.bridgeResponsive).toBe(false);
    expect((payload.warnings as string[])[0]).toContain('Connection refused');
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(a);
  });

  it('is idempotent on the session that is already current', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    installLive(runner, a, PORT_A, true);
    stubBridge(runner, { status: 'pong' });

    const first = payloadOf(await handleSwitchProject(runner, { projectPath: a }));
    const second = payloadOf(await handleSwitchProject(runner, { projectPath: a }));

    expect(first.previousProjectPath).toBe(a);
    expect(second.projectPath).toBe(a);
    expect(second.message).toMatch(/already the current session/);
    expect(runner.getCurrentSessionInfo()?.projectPath).toBe(a);
  });

  it('payloads validate against the declared outputSchema', async () => {
    const definition = runtimeToolDefinitions.find((t) => t.name === 'switch_project');
    if (!definition) throw new Error('switch_project definition not found');
    const validate = new Ajv({ strict: false }).compile(definition.outputSchema as object);
    const runner = new GodotRunner();
    const a = makeProjectPath('switch-a-');
    const b = makeProjectPath('switch-b-');
    installLive(runner, a, PORT_A, false);
    installExited(runner, b, true);
    stubBridge(runner, { status: 'pong' });

    const livePayload = payloadOf(await handleSwitchProject(runner, { projectPath: a }));
    expect(validate(livePayload), JSON.stringify(validate.errors)).toBe(true);

    const exitedPayload = payloadOf(await handleSwitchProject(runner, { projectPath: b }));
    expect(validate(exitedPayload), JSON.stringify(validate.errors)).toBe(true);
  });

  it('description stays within the character budget and has no em-dash', () => {
    const definition = runtimeToolDefinitions.find((t) => t.name === 'switch_project');
    if (!definition) throw new Error('switch_project definition not found');
    expect(definition.description.length).toBeLessThanOrEqual(SWITCH_DESCRIPTION_BUDGET_CHARS);
    expect(definition.description).not.toContain('—');
  });
});

describe('no silent fallback', () => {
  const runtimeHandlers: Array<
    [
      string,
      (runner: GodotRunner, args: Record<string, unknown>) => unknown,
      Record<string, unknown>,
    ]
  > = [
    ['take_screenshot', handleTakeScreenshot, {}],
    ['simulate_input', handleSimulateInput, { actions: [{ type: 'wait', ms: 1 }] }],
    ['get_ui_elements', handleGetUiElements, {}],
    ['run_script', handleRunScript, { script: BENIGN_SCRIPT }],
  ];
  const profilerHandlers: Array<
    [string, (runner: GodotRunner, args: Record<string, unknown>) => unknown]
  > = [
    ['profile_project', handleProfileProject],
    ['start_profiler', handleStartProfiler],
    ['stop_profiler', handleStopProfiler],
  ];

  it.each(runtimeHandlers)(
    '%s errors and lists the live session when nothing is current',
    async (_name, handler, args) => {
      const runner = new GodotRunner();
      const a = makeProjectPath('fallback-a-');
      installLive(runner, a, PORT_A, false);
      const bridge = stubBridge(runner, { elements: [] });

      const result = await handler(runner, args);

      expectErrorMatching(result, /No current runtime session/);
      expect(fullText(result)).toContain(a);
      expect(fullText(result)).toContain('switch_project');
      expect(bridge).not.toHaveBeenCalled();
      expect(runner.getCurrentSessionInfo()).toBeNull();
    },
  );

  it.each(runtimeHandlers)(
    '%s names the exit and lists the live session when the current game exited',
    async (_name, handler, args) => {
      const runner = new GodotRunner();
      const a = makeProjectPath('fallback-a-');
      const b = makeProjectPath('fallback-b-');
      installLive(runner, a, PORT_A, false);
      installExited(runner, b, true);
      const bridge = stubBridge(runner, { elements: [] });

      const result = await handler(runner, args);

      expectErrorMatching(result, /spawned Godot process has exited/);
      const text = fullText(result);
      expect(text).toContain(b);
      expect(text).toContain(`exit code ${EXIT_CODE}`);
      expect(text).toContain(a);
      expect(text).toContain('switch_project');
      expect(bridge).not.toHaveBeenCalled();
      expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);
    },
  );

  it.each(profilerHandlers)(
    '%s errors and lists the live session when nothing is current',
    async (_name, handler) => {
      const runner = new GodotRunner();
      const a = makeProjectPath('fallback-a-');
      installLive(runner, a, PORT_A, false);

      const result = await handler(runner, {});

      expectErrorMatching(result, /No current runtime session/);
      expect(fullText(result)).toContain(a);
      expect(fullText(result)).toContain('switch_project');
    },
  );

  it('get_debug_output errors and lists the live session when nothing is current', () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('fallback-a-');
    installLive(runner, a, PORT_A, false);

    const result = handleGetDebugOutput(runner, {});

    expectErrorMatching(result, /No current runtime session/);
    expect(fullText(result)).toContain(a);
    expect(fullText(result)).toContain('switch_project');
  });

  it('stop_project errors and lists the live session when nothing is current, and stops nothing', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('fallback-a-');
    installLive(runner, a, PORT_A, false);

    const result = await handleStopProject(runner);

    expectErrorMatching(result, /No active Godot process to stop/);
    expect(fullText(result)).toContain(a);
    expect(fullText(result)).toContain('switch_project');
    expect(runner.hasLiveSessionOnProject(a)).toBe(true);
  });

  it('stop_project on an exited current session names its project and the sessions still live', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('fallback-a-');
    const b = makeProjectPath('fallback-b-');
    installLive(runner, a, PORT_A, false);
    installExited(runner, b, true);

    const first = await handleStopProject(runner);

    const payload = payloadOf(first);
    expect(payload.projectPath).toBe(b);
    expect(payload.alreadyExited).toBe(true);
    expect(payload.message as string).toContain(a);

    const second = await handleStopProject(runner);
    expectErrorMatching(second, /No active Godot process to stop/);
    expect(fullText(second)).toContain(a);
  });

  it('a bridge failure that ends the session lists the remaining live session', async () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('fallback-a-');
    const b = makeProjectPath('fallback-b-');
    installLive(runner, a, PORT_A, false);
    installSession(runner, { projectPath: b, mode: 'attached', bridgePort: PORT_B, current: true });
    vi.spyOn(runner, 'sendCommandWithErrors').mockImplementation(async () => {
      const internals = runner as unknown as { forgetSession(session: unknown): void };
      internals.forgetSession(currentRecord(runner));
      throw new BridgeDisconnectedError('Bridge session ended');
    });

    const result = await handleGetUiElements(runner, {});

    expectErrorMatching(result, /Failed to get UI elements/);
    const text = fullText(result);
    expect(text).toMatch(/session ended during this call/);
    expect(text).toContain(a);
    expect(text).toContain('switch_project');
  });

  it('keeps the single-project wording when no other session is live', async () => {
    const runner = new GodotRunner();

    const result = await handleTakeScreenshot(runner, {});

    expect(hasError(result)).toBe(true);
    const text = fullText(result);
    expect(unwrap(result).content[0]?.text).toBe(SINGLE_PROJECT_SCREENSHOT_ERROR);
    expect(text).not.toContain('switch_project');
  });
});

describe('projectPath in runtime responses', () => {
  it.each([
    ['get_ui_elements', handleGetUiElements, {}, { elements: [] }],
    [
      'simulate_input',
      handleSimulateInput,
      { actions: [{ type: 'wait', ms: 1 }] },
      { success: true, results: [] },
    ],
    ['run_script', handleRunScript, { script: BENIGN_SCRIPT }, { success: true, result: 1 }],
  ])(
    '%s names the session project',
    async (
      _name: string,
      handler: (runner: GodotRunner, args: Record<string, unknown>) => unknown,
      args: Record<string, unknown>,
      bridgePayload: unknown,
    ) => {
      const runner = new GodotRunner();
      const a = makeProjectPath('named-a-');
      installLive(runner, a, PORT_A, true);
      stubBridge(runner, bridgePayload);

      const result = await handler(runner, args);

      expect(payloadOf(result).projectPath).toBe(a);
    },
  );

  it('get_debug_output names the project of a live and of an exited current session', () => {
    const runner = new GodotRunner();
    const a = makeProjectPath('named-a-');
    const b = makeProjectPath('named-b-');
    installLive(runner, a, PORT_A, true);
    installExited(runner, b, false);

    const live = payloadOf(handleGetDebugOutput(runner, {}));
    expect(live.projectPath).toBe(a);
    expect(live.running).toBe(true);

    runner.switchSession(b);
    const exited = payloadOf(handleGetDebugOutput(runner, {}));
    expect(exited.projectPath).toBe(b);
    expect(exited.running).toBe(false);
  });
});

describe('fake session derivation matches GodotRunner', () => {
  const rows: Array<
    [
      string,
      {
        mode: 'spawned' | 'attached' | null;
        process: 'none' | 'live' | 'exited';
      },
    ]
  > = [
    ['nothing', { mode: null, process: 'none' }],
    ['spawned live', { mode: 'spawned', process: 'live' }],
    ['spawned with an exited process', { mode: 'spawned', process: 'exited' }],
    ['mode null with an exited process', { mode: null, process: 'exited' }],
    ['attached', { mode: 'attached', process: 'none' }],
    ['spawned with no process', { mode: 'spawned', process: 'none' }],
  ];

  it.each(rows)('%s', (label, row) => {
    const runner = new GodotRunner();
    const projectPath = makeProjectPath('derive-');
    const process =
      row.process === 'live'
        ? liveProcess()
        : row.process === 'exited'
          ? exitedProcess(EXIT_CODE)
          : null;
    if (label !== 'nothing') installSession(runner, { projectPath, mode: row.mode, process });

    const fake = fakeSessionApi(() => ({ current: { mode: row.mode, projectPath, process } }));
    const real = runner.getRuntimeSessionStatus();
    const derived = fake.getRuntimeSessionStatus();

    expect(derived.state).toBe(real.state);
    expect(derived.current?.live).toBe(real.current?.live);
    expect(derived.current?.processExited).toBe(real.current?.processExited);
    expect(derived.current?.exitCode).toBe(real.current?.exitCode);
    expect(derived.current?.mode).toBe(real.current?.mode);
  });
});
