/**
 * Unit tests for the runtime-tools handlers.
 *
 * The runtime-tools file has the largest concentration of non-trivial logic
 * in the project: bridge response shaping, runtime-error escalation, mode
 * branching for debug-output and stop, ensureRuntimeSession gating, and the
 * timeout calculation in simulate_input. None of these need a Godot binary
 * to verify — they all branch on runner state + bridge response strings.
 *
 * The fake runner here extends the standard fake with the runtime surface
 * (sendCommandWithErrors, session state, stopProject). Kept inline because
 * runtime-tools is the only consumer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  handleDetachProject,
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
  handleRunProject,
  handleAttachProject,
  handleLaunchEditor,
} from '../../../src/tools/runtime-tools.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import type {
  GodotRunner,
  GodotProcess,
  RuntimeSessionMode,
  RuntimeStopResult,
} from '../../../src/utils/godot-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { useTmpDirs } from '../../helpers/tmp.js';

// ---------------------------------------------------------------------------
// Runtime fake runner
// ---------------------------------------------------------------------------

interface BridgeCall {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

interface RuntimeFake {
  asRunner: GodotRunner;
  bridgeCalls: BridgeCall[];
  /** Number of times stopProject() has been invoked. */
  stopCalls(): number;
  setSession(opts: {
    mode: RuntimeSessionMode | null;
    projectPath?: string | null;
    process?: Partial<GodotProcess> | null;
  }): void;
  setBridgeResponse(response: string, runtimeErrors?: string[]): void;
  setStopResult(result: RuntimeStopResult | null): void;
  setGodotPath(path: string): void;
  setBridgeReady(ready: boolean, error?: string): void;
  setRunProjectError(error: Error | null): void;
}

function createRuntimeFake(): RuntimeFake {
  const bridgeCalls: BridgeCall[] = [];
  let bridgeResponse = '{}';
  let bridgeRuntimeErrors: string[] = [];
  let stopResult: RuntimeStopResult | null = {
    mode: 'spawned',
    output: [],
    errors: [],
  };
  let godotPath = '';
  let bridgeReady = true;
  let bridgeError: string | undefined;
  let runProjectError: Error | null = null;
  let stopCallCount = 0;

  const state: {
    activeSessionMode: RuntimeSessionMode | null;
    activeProjectPath: string | null;
    activeProcess: GodotProcess | null;
  } = {
    activeSessionMode: null,
    activeProjectPath: null,
    activeProcess: null,
  };

  const fake = {
    get activeSessionMode() {
      return state.activeSessionMode;
    },
    get activeProjectPath() {
      return state.activeProjectPath;
    },
    get activeProcess() {
      return state.activeProcess;
    },
    async sendCommandWithErrors(
      command: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ) {
      bridgeCalls.push({ command, params, timeoutMs });
      return { response: bridgeResponse, runtimeErrors: bridgeRuntimeErrors };
    },
    async stopProject() {
      stopCallCount++;
      // Bridge-failure paths in handleRunProject tear down the session before
      // returning the error, so reset the mode/project state to mirror the
      // real runner's stopProject behavior.
      state.activeSessionMode = null;
      state.activeProjectPath = null;
      state.activeProcess = null;
      return stopResult;
    },
    closeConnection() {},
    getGodotPath() {
      return godotPath;
    },
    async detectGodotPath() {
      return godotPath;
    },
    launchEditor(_projectPath: string) {
      const proc = { on: () => proc };
      return proc as unknown as GodotProcess['process'];
    },
    activeBridgePort: null as number | null,
    async runProject(
      projectPath: string,
      _scene?: string,
      _background?: boolean,
      bridgePort?: number,
    ) {
      if (runProjectError) throw runProjectError;
      state.activeSessionMode = 'spawned';
      state.activeProjectPath = projectPath;
      state.activeProcess = makeRunningProcess();
      fake.activeBridgePort = bridgePort ?? 19900;
    },
    async attachProject(projectPath: string, bridgePort?: number) {
      state.activeSessionMode = 'attached';
      state.activeProjectPath = projectPath;
      fake.activeBridgePort = bridgePort ?? 19901;
    },
    async waitForBridge() {
      return { ready: bridgeReady, error: bridgeError };
    },
    async waitForBridgeAttached() {
      return { ready: bridgeReady, error: bridgeError };
    },
    getRecentErrors(_n: number): string[] {
      return [];
    },
    readBakedBridgePort(_projectPath: string): number | null {
      return null;
    },
  };

  return {
    asRunner: fake as unknown as GodotRunner,
    bridgeCalls,
    stopCalls() {
      return stopCallCount;
    },
    setSession({ mode, projectPath = null, process = null }) {
      state.activeSessionMode = mode;
      state.activeProjectPath = projectPath;
      state.activeProcess = process as GodotProcess | null;
    },
    setBridgeResponse(response, runtimeErrors = []) {
      bridgeResponse = response;
      bridgeRuntimeErrors = runtimeErrors;
    },
    setStopResult(result) {
      stopResult = result;
    },
    setGodotPath(path: string) {
      godotPath = path;
    },
    setBridgeReady(ready: boolean, error?: string) {
      bridgeReady = ready;
      bridgeError = error;
    },
    setRunProjectError(error: Error | null) {
      runProjectError = error;
    },
  };
}

const tmp = useTmpDirs();

function makeRunningProcess(opts: Partial<GodotProcess> = {}): GodotProcess {
  return {
    // Intentionally unset — no covered handler reads `.process`. If a future handler calls
    // `proc.process.kill()` or similar, give it a real (or stubbed) ChildProcess here.
    process: undefined as unknown as GodotProcess['process'],
    output: opts.output ?? [],
    errors: opts.errors ?? [],
    totalErrorsWritten: opts.totalErrorsWritten ?? 0,
    exitCode: opts.exitCode ?? null,
    hasExited: opts.hasExited ?? false,
    sessionToken: 'tok',
  };
}

// ---------------------------------------------------------------------------
// Validation paths for handleRunProject / handleAttachProject / handleLaunchEditor
// ---------------------------------------------------------------------------

describe('handleRunProject validation', () => {
  it('rejects missing projectPath', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, {});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, { projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, { projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  // Regression: issue #15 — without an explicit Godot-path precheck, an
  // unresolved godotPath used to bubble up as a generic "Failed to run
  // Godot project" error pointing at a hardcoded `C:\Program Files\...`
  // fallback path the user never configured. The handler must now surface
  // a clear "set GODOT_PATH" message before attempting to spawn.
  it('returns a "set GODOT_PATH" error when no Godot executable can be resolved', async () => {
    const fake = createRuntimeFake();
    // godotPath stays empty (default), so the precheck must fire.
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /Could not find a valid Godot executable path/);
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/GODOT_PATH/);
  });

  it('returns display-unavailable error with attach_project suggestion', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setRunProjectError(
      new Error(
        'No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). ' +
          'Godot requires a display to run a project window.',
      ),
    );
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /No display server available/);
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/attach_project/);
  });

  it('cleans up bridge artifacts when process exits before bridge readiness', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'Process exited with code 1');
    let stopCalled = false;
    const runner = fake.asRunner;
    const originalStop = runner.stopProject.bind(runner);
    (runner as unknown as Record<string, unknown>).stopProject = async () => {
      stopCalled = true;
      return originalStop();
    };
    // runProject sets activeProcess to a running process; override it to an
    // exited process after the call so waitForBridge sees the early exit.
    const origRun = runner.runProject.bind(runner);
    (runner as unknown as Record<string, unknown>).runProject = (
      pp: string,
      s?: string,
      b?: boolean,
    ) => {
      origRun(pp, s, b);
      fake.setSession({
        mode: 'spawned',
        projectPath: pp,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    };
    const result = await handleRunProject(runner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /exited before.*bridge/i);
    expect(stopCalled).toBe(true);
  });
});

describe('handleRunProject bridge port', () => {
  it('includes the assigned bridge port in the success response', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/port \d+/);
  });
});

describe('handleAttachProject bridge port', () => {
  it('includes the assigned bridge port in the success response', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeReady(true);
    const result = await handleAttachProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      bridgePort: 12345,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/port 12345/);
  });
});

describe('handleRunProject bridge failure paths', () => {
  it('returns "exited before MCP bridge could initialize" error when process exits during wait', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'process gone');
    // Replace the default runProject so the post-state has hasExited=true.
    // The handler must take the "process exited" branch (not the timeout
    // branch) and tear down before returning.
    const runProjectExited = (projectPath: string): unknown => {
      fake.setSession({
        mode: 'spawned',
        projectPath,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
      return undefined;
    };
    (fake.asRunner as unknown as { runProject: unknown }).runProject = runProjectExited;
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /exited before the MCP bridge could initialize/);
    // Handler must tear down before returning so retry works cleanly.
    expect(fake.stopCalls()).toBe(1);
  });

  it('returns "bridge did not respond" error and tears down when bridge times out', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'timeout after 5s');
    // The default fake.runProject sets process with hasExited=false, so the
    // handler takes the timeout branch (not the process-exited branch).
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /bridge did not respond/);
    expect(fake.stopCalls()).toBe(1);
  });
});

describe('handleAttachProject bridge failure paths', () => {
  it('returns "bridge is not ready" error and tears down when bridge wait fails', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeReady(false, 'attach timeout');
    const result = await handleAttachProject(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /bridge is not ready/);
    expect(fake.stopCalls()).toBe(1);
  });
});

describe('handleAttachProject validation', () => {
  it('rejects missing projectPath', async () => {
    const fake = createRuntimeFake();
    const result = await handleAttachProject(fake.asRunner, {});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createRuntimeFake();
    const result = await handleAttachProject(fake.asRunner, { projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createRuntimeFake();
    const result = await handleAttachProject(fake.asRunner, { projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });
});

describe('handleLaunchEditor validation', () => {
  it('rejects missing projectPath', async () => {
    const fake = createRuntimeFake();
    const result = await handleLaunchEditor(fake.asRunner, {});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createRuntimeFake();
    const result = await handleLaunchEditor(fake.asRunner, { projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createRuntimeFake();
    const result = await handleLaunchEditor(fake.asRunner, { projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects when no Godot executable can be detected', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('');
    const result = await handleLaunchEditor(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /Could not find a valid Godot executable/i);
  });
});

// ---------------------------------------------------------------------------
// ensureRuntimeSession (via handleTakeScreenshot — same gate every runtime
// handler uses)
// ---------------------------------------------------------------------------

describe('ensureRuntimeSession (via handleTakeScreenshot)', () => {
  it('rejects when no session is active', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: null, projectPath: null });
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /No active runtime session/i);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects when spawned process has exited', async () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
    });
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /spawned Godot process has exited/i);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects when spawned process is null', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: null });
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /spawned Godot process has exited/i);
  });

  it('passes through to bridge when attached session is active (no live process required)', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    fake.setBridgeResponse(JSON.stringify({ error: 'irrelevant' })); // forces error response
    await handleTakeScreenshot(fake.asRunner, {});
    expect(fake.bridgeCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleGetDebugOutput
// ---------------------------------------------------------------------------

describe('handleGetDebugOutput', () => {
  it('rejects when no session is active', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: null });
    const result = handleGetDebugOutput(fake.asRunner, {});
    expectErrorMatching(result, /No active runtime session/i);
  });

  it('returns synthetic attached payload (no process inspection)', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    const result = handleGetDebugOutput(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      output: [],
      errors: [],
      running: null,
      attached: true,
      tip: expect.stringMatching(/Attached mode does not capture/i),
    });
  });

  it('rejects spawned mode when activeProcess is null', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: null });
    const result = handleGetDebugOutput(fake.asRunner, {});
    expectErrorMatching(result, /No active spawned process/i);
  });

  it('returns the last `limit` lines of output and errors for an active spawned process', () => {
    const output = Array.from({ length: 10 }, (_, i) => `out${i}`);
    const errors = Array.from({ length: 10 }, (_, i) => `err${i}`);
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess({ output, errors }),
    });

    const result = handleGetDebugOutput(fake.asRunner, { limit: 3 });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.output).toEqual(['out7', 'out8', 'out9']);
    expect(parsed.errors).toEqual(['err7', 'err8', 'err9']);
    expect(parsed.running).toBe(true);
    expect(parsed.exitCode).toBeUndefined();
    expect(parsed.tip).toBeUndefined();
  });

  it('defaults limit to 200 when no limit param is supplied', () => {
    const output = Array.from({ length: 250 }, (_, i) => `o${i}`);
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess({ output }),
    });
    const result = handleGetDebugOutput(fake.asRunner, {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.output).toHaveLength(200);
    expect(parsed.output[0]).toBe('o50');
    expect(parsed.output[199]).toBe('o249');
  });

  it('adds exitCode and stop_project tip when the spawned process has exited', () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess({ hasExited: true, exitCode: 137, output: ['x'] }),
    });
    const result = handleGetDebugOutput(fake.asRunner, {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.running).toBe(false);
    expect(parsed.exitCode).toBe(137);
    expect(parsed.tip).toMatch(/Process has exited/i);
    expect(parsed.tip).toMatch(/stop_project/);
  });
});

// ---------------------------------------------------------------------------
// handleStopProject
// ---------------------------------------------------------------------------

describe('handleStopProject', () => {
  it('returns the spawned-stopped message when stopProject reports mode:spawned', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({ mode: 'spawned', output: ['o1'], errors: ['e1'] });
    const result = await handleStopProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.message).toBe('Godot project stopped');
    expect(parsed.mode).toBe('spawned');
    expect(parsed.externalProcessPreserved).toBe(false);
  });

  it('returns the attached-detached message when stopProject reports mode:attached', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'attached',
      output: [],
      errors: [],
      externalProcessPreserved: true,
    });
    const result = await handleStopProject(fake.asRunner);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.message).toBe('Attached project detached and MCP bridge state cleaned up');
    expect(parsed.mode).toBe('attached');
    expect(parsed.externalProcessPreserved).toBe(true);
  });

  it('returns isError when no session was active', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult(null);
    const result = await handleStopProject(fake.asRunner);
    expectErrorMatching(result, /No active Godot process/i);
  });
});

// ---------------------------------------------------------------------------
// handleDetachProject
// ---------------------------------------------------------------------------

describe('handleDetachProject', () => {
  it('rejects when there is no session at all', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: null });
    const result = await handleDetachProject(fake.asRunner);
    expectErrorMatching(result, /No attached project to detach/i);
  });

  it('rejects when an active session is spawned (must use stop_project)', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    const result = await handleDetachProject(fake.asRunner);
    expectErrorMatching(result, /No attached project to detach/i);
    // Solutions block points at stop_project for the spawned case.
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/stop_project/);
  });

  it('detaches and reports externalProcessPreserved when mode is attached', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    fake.setStopResult({
      mode: 'attached',
      output: [],
      errors: [],
      externalProcessPreserved: true,
    });
    const result = await handleDetachProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.externalProcessPreserved).toBe(true);
    expect(parsed.message).toMatch(/Detached attached project/i);
  });
});

// ---------------------------------------------------------------------------
// handleSimulateInput — totalWaitMs calculation
// ---------------------------------------------------------------------------

describe('handleSimulateInput', () => {
  function setupActive(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, actions_processed: 1 }));
    return fake;
  }

  it('rejects when actions is missing or empty', async () => {
    const fake = setupActive();
    expectErrorMatching(
      await handleSimulateInput(fake.asRunner, { actions: [] }),
      /non-empty array/i,
    );
    expectErrorMatching(await handleSimulateInput(fake.asRunner, {}), /non-empty array/i);
  });

  it('passes a 10s buffer timeout when there are no wait actions', async () => {
    const fake = setupActive();
    await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'key', key: 'Space', pressed: true }],
    });
    expect(fake.bridgeCalls).toHaveLength(1);
    expect(fake.bridgeCalls[0].timeoutMs).toBe(10000);
  });

  it('sums all wait.ms entries into totalWaitMs and adds the 10s buffer', async () => {
    const fake = setupActive();
    await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'wait', ms: 5000 },
        { type: 'key', key: 'A', pressed: true },
        { type: 'wait', ms: 7500 },
        { type: 'wait', ms: 2500 },
      ],
    });
    // 5000 + 7500 + 2500 + 10000 buffer = 25000
    expect(fake.bridgeCalls[0].timeoutMs).toBe(25000);
  });

  it('ignores non-wait actions and wait actions with non-numeric ms', async () => {
    const fake = setupActive();
    await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'wait' }, // missing ms — ignored
        { type: 'wait', ms: '500' }, // wrong type — ignored
        { type: 'wait', ms: 1000 },
      ],
    });
    expect(fake.bridgeCalls[0].timeoutMs).toBe(11000);
  });

  it('forwards actions to the bridge under the "input" command name', async () => {
    const fake = setupActive();
    const actions = [{ type: 'key', key: 'X', pressed: true }];
    await handleSimulateInput(fake.asRunner, { actions });
    expect(fake.bridgeCalls[0].command).toBe('input');
    expect(fake.bridgeCalls[0].params).toEqual({ actions });
  });

  it('surfaces runtimeErrors as warnings without escalating to isError', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(JSON.stringify({ success: true, actions_processed: 2 }), [
      'SCRIPT ERROR: in _process',
    ]);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'key', key: 'A', pressed: true }],
    });
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.warnings).toEqual(['SCRIPT ERROR: in _process']);
  });
});

// ---------------------------------------------------------------------------
// handleGetUiElements — defaulting + parameter renaming
// ---------------------------------------------------------------------------

describe('handleGetUiElements', () => {
  function setupActive(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ elements: [] }));
    return fake;
  }

  it('defaults visible_only to true when visibleOnly is omitted', async () => {
    const fake = setupActive();
    await handleGetUiElements(fake.asRunner, {});
    expect(fake.bridgeCalls[0].params).toEqual({ visible_only: true });
  });

  it('passes visible_only:false only when explicitly false', async () => {
    const fake = setupActive();
    await handleGetUiElements(fake.asRunner, { visibleOnly: false });
    expect(fake.bridgeCalls[0].params).toEqual({ visible_only: false });
  });

  it('renames the "filter" arg to "type_filter" when forwarding to the bridge', async () => {
    const fake = setupActive();
    await handleGetUiElements(fake.asRunner, { filter: 'Button' });
    expect(fake.bridgeCalls[0].params).toEqual({ visible_only: true, type_filter: 'Button' });
  });

  it('omits type_filter when filter is not provided', async () => {
    const fake = setupActive();
    await handleGetUiElements(fake.asRunner, {});
    expect(fake.bridgeCalls[0].params).not.toHaveProperty('type_filter');
  });
});

// ---------------------------------------------------------------------------
// handleRunScript — false-positive null-result detection + audit write
// ---------------------------------------------------------------------------

describe('handleRunScript', () => {
  const VALID_SCRIPT = 'extends RefCounted\nfunc execute(scene_tree):\n\treturn null\n';

  it('rejects a non-string or empty script', async () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
    expectErrorMatching(
      await handleRunScript(fake.asRunner, { script: '' }),
      /script is required/i,
    );
  });

  it('rejects a script missing func execute', async () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
    expectErrorMatching(
      await handleRunScript(fake.asRunner, { script: 'extends RefCounted\n# no execute\n' }),
      /func execute/i,
    );
  });

  it('escalates to isError when spawned + result:null + runtimeErrors are present', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), [
      'SCRIPT ERROR: divide by zero on line 4',
    ]);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expectErrorMatching(result, /Script runtime error detected/);
    expectErrorMatching(result, /divide by zero on line 4/);
  });

  it('returns success with a warning when spawned + result:null + no runtimeErrors', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.result).toBeNull();
    expect(parsed.warning).toMatch(/GDScript does not propagate exceptions/);
  });

  it('returns success without escalation when attached + result:null (stderr not captured)', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: dir });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expect(hasError(result)).toBe(false);
  });

  it('returns success and surfaces runtimeErrors as warnings when result is non-null', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 42 }), [
      'SCRIPT ERROR: stale ref',
    ]);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.result).toBe(42);
    expect(parsed.warnings).toEqual(['SCRIPT ERROR: stale ref']);
  });

  it('writes the script to .mcp/scripts/{timestamp}.gd for forensic replay', async () => {
    const dir = tmp.makeProject('run-script-audit-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });

    const scriptsDir = join(dir, '.mcp', 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);
    const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.gd'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(scriptsDir, files[0]), 'utf8')).toBe(VALID_SCRIPT);
    // Filename is a numeric timestamp + UUID suffix to avoid collisions.
    expect(files[0]).toMatch(/^\d+-[0-9a-f-]+\.gd$/);
  });
});

// ---------------------------------------------------------------------------
// handleTakeScreenshot — bridge response shape branches
// ---------------------------------------------------------------------------

describe('handleTakeScreenshot bridge response shapes', () => {
  let fake: RuntimeFake;
  let projectPath: string;
  let screenshotDir: string;

  beforeEach(() => {
    projectPath = tmp.make('mcp-project-');
    screenshotDir = join(projectPath, '.mcp', 'screenshots');
    mkdirSync(screenshotDir, { recursive: true });
    fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath,
      process: makeRunningProcess(),
    });
  });

  function writeScreenshot(name: string, content = 'png-data'): string {
    const path = join(screenshotDir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  function parseMetadata(result: { content?: Array<{ type: string; text?: string }> }) {
    const textContent = result.content?.filter((entry) => entry.type === 'text') ?? [];
    const metadataEntry = textContent.find((entry) => entry.text?.startsWith('{'));
    expect(metadataEntry?.text).toBeDefined();
    return JSON.parse(metadataEntry!.text!);
  }

  it('defaults to preview mode and returns a bounded inline preview', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    const previewPath = writeScreenshot('preview.png', 'preview-image');
    fake.setBridgeResponse(
      JSON.stringify({
        path: screenshotPath,
        preview_path: previewPath,
        width: 1280,
        height: 720,
        preview_width: 960,
        preview_height: 540,
      }),
    );

    const result = await handleTakeScreenshot(fake.asRunner, {});

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls[0]).toMatchObject({
      command: 'screenshot',
      params: { preview_max_width: 960, preview_max_height: 540 },
    });
    expect(result.content?.[0]).toMatchObject({
      type: 'image',
      data: Buffer.from('preview-image').toString('base64'),
      mimeType: 'image/png',
    });
    expect(parseMetadata(result)).toMatchObject({
      responseMode: 'preview',
      path: screenshotPath,
      size: { width: 1280, height: 720 },
      previewPath,
      previewSize: { width: 960, height: 540 },
    });
  });

  it('returns full inline PNG when responseMode is full', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, width: 1280, height: 720 }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'full' });

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls[0]).toMatchObject({
      command: 'screenshot',
      params: {},
    });
    expect(result.content?.[0]).toMatchObject({
      type: 'image',
      data: Buffer.from('full-image').toString('base64'),
      mimeType: 'image/png',
    });
    expect(parseMetadata(result)).toMatchObject({
      responseMode: 'full',
      path: screenshotPath,
      size: { width: 1280, height: 720 },
    });
  });

  it('returns a bounded preview image when responseMode is preview', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    const previewPath = writeScreenshot('preview.png', 'preview-image');
    fake.setBridgeResponse(
      JSON.stringify({
        path: screenshotPath,
        preview_path: previewPath,
        width: 1280,
        height: 720,
        preview_width: 960,
        preview_height: 540,
      }),
    );

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'preview' });

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls[0]).toMatchObject({
      command: 'screenshot',
      params: { preview_max_width: 960, preview_max_height: 540 },
    });
    expect(result.content?.[0]).toMatchObject({
      type: 'image',
      data: Buffer.from('preview-image').toString('base64'),
      mimeType: 'image/png',
    });
    expect(parseMetadata(result)).toMatchObject({
      responseMode: 'preview',
      path: screenshotPath,
      previewPath,
      previewSize: { width: 960, height: 540 },
    });
  });

  it('uses caller-provided preview bounds', async () => {
    const screenshotPath = writeScreenshot('screenshot.png');
    const previewPath = writeScreenshot('preview.png');
    fake.setBridgeResponse(
      JSON.stringify({
        path: screenshotPath,
        preview_path: previewPath,
      }),
    );

    const result = await handleTakeScreenshot(fake.asRunner, {
      responseMode: 'preview',
      previewMaxWidth: 480,
      previewMaxHeight: 270,
    });

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls[0].params).toEqual({ preview_max_width: 480, preview_max_height: 270 });
  });

  it('returns metadata only when responseMode is path_only', async () => {
    const screenshotPath = writeScreenshot('screenshot.png');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    expect(result.content?.some((entry) => entry.type === 'image')).toBe(false);
    expect(parseMetadata(result)).toMatchObject({
      responseMode: 'path_only',
      path: screenshotPath,
    });
  });

  it('rejects invalid responseMode', async () => {
    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'small' });
    expectErrorMatching(result, /responseMode/);
  });

  it('rejects invalid preview dimensions', async () => {
    const result = await handleTakeScreenshot(fake.asRunner, {
      responseMode: 'preview',
      previewMaxWidth: 0,
    });
    expectErrorMatching(result, /preview dimensions/);
  });

  it('returns isError when preview mode receives no preview path', async () => {
    const screenshotPath = writeScreenshot('screenshot.png');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'preview' });

    expectErrorMatching(result, /no preview path/i);
  });

  it('returns isError when the bridge response is not JSON', async () => {
    fake.setBridgeResponse('not json at all');
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /Invalid response from bridge \(screenshot\)/);
  });

  it('returns isError when the bridge response carries an error field', async () => {
    fake.setBridgeResponse(JSON.stringify({ error: 'no display' }));
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /Screenshot server error: no display/);
  });

  it('returns isError when the bridge response has no path field', async () => {
    fake.setBridgeResponse(JSON.stringify({ ok: true }));
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /no file path/i);
  });

  it('returns isError when the resolved path does not exist on disk', async () => {
    fake.setBridgeResponse(JSON.stringify({ path: join(screenshotDir, 'missing.png') }));
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /Screenshot file not found/i);
  });

  it('refuses to read a bridge path outside .mcp/screenshots/', async () => {
    fake.setBridgeResponse(JSON.stringify({ path: '/etc/passwd' }));
    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });
    expectErrorMatching(result, /outside \.mcp\/screenshots\//i);
  });

  it('refuses to read a bridge preview_path outside .mcp/screenshots/', async () => {
    const screenshotPath = writeScreenshot('screenshot.png');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, preview_path: '/etc/passwd' }));
    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'preview' });
    expectErrorMatching(result, /preview path outside \.mcp\/screenshots\//i);
  });
});
