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
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  handleDetachProject,
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
} from '../../../src/tools/runtime-tools.js';
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
  setSession(opts: {
    mode: RuntimeSessionMode | null;
    projectPath?: string | null;
    process?: Partial<GodotProcess> | null;
  }): void;
  setBridgeResponse(response: string, runtimeErrors?: string[]): void;
  setStopResult(result: RuntimeStopResult | null): void;
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
    stopProject() {
      return stopResult;
    },
  };

  return {
    asRunner: fake as unknown as GodotRunner,
    bridgeCalls,
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
  it('returns the spawned-stopped message when stopProject reports mode:spawned', () => {
    const fake = createRuntimeFake();
    fake.setStopResult({ mode: 'spawned', output: ['o1'], errors: ['e1'] });
    const result = handleStopProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.message).toBe('Godot project stopped');
    expect(parsed.mode).toBe('spawned');
    expect(parsed.externalProcessPreserved).toBe(false);
  });

  it('returns the attached-detached message when stopProject reports mode:attached', () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'attached',
      output: [],
      errors: [],
      externalProcessPreserved: true,
    });
    const result = handleStopProject(fake.asRunner);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.message).toBe('Attached project detached and MCP bridge state cleaned up');
    expect(parsed.mode).toBe('attached');
    expect(parsed.externalProcessPreserved).toBe(true);
  });

  it('returns isError when no session was active', () => {
    const fake = createRuntimeFake();
    fake.setStopResult(null);
    const result = handleStopProject(fake.asRunner);
    expectErrorMatching(result, /No active Godot process/i);
  });
});

// ---------------------------------------------------------------------------
// handleDetachProject
// ---------------------------------------------------------------------------

describe('handleDetachProject', () => {
  it('rejects when there is no session at all', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: null });
    const result = handleDetachProject(fake.asRunner);
    expectErrorMatching(result, /No attached project to detach/i);
  });

  it('rejects when an active session is spawned (must use stop_project)', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    const result = handleDetachProject(fake.asRunner);
    expectErrorMatching(result, /No attached project to detach/i);
    // Solutions block points at stop_project for the spawned case.
    const solutionsText = (result as { content: Array<{ text: string }> }).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/stop_project/);
  });

  it('detaches and reports externalProcessPreserved when mode is attached', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    fake.setStopResult({
      mode: 'attached',
      output: [],
      errors: [],
      externalProcessPreserved: true,
    });
    const result = handleDetachProject(fake.asRunner);
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
  beforeEach(() => {
    fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
  });

  it('returns isError when the bridge response is not JSON', async () => {
    fake.setBridgeResponse('not json at all');
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /Invalid response from screenshot server/);
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
    fake.setBridgeResponse(JSON.stringify({ path: '/definitely/does/not/exist/screenshot.png' }));
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /Screenshot file not found/i);
  });
});
