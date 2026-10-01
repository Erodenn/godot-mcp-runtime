/**
 * Unit tests for the runtime-tools handlers.
 *
 * The runtime-tools file has the largest concentration of non-trivial logic
 * in the project: bridge response shaping, runtime-error escalation, mode
 * branching for debug-output and stop, ensureRuntimeSession gating, and the
 * timeout calculation in simulate_input. None of these need a Godot binary
 * to verify: they all branch on runner state + bridge response strings.
 *
 * The fake runner here extends the standard fake with the runtime surface
 * (sendCommandWithErrors, session state, stopProject). Kept inline because
 * runtime-tools is the only consumer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Ajv from 'ajv';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  computeInputTimeoutMs,
  handleGetUiElements,
  handleRunScript,
  handleRunProject,
  handleLaunchEditor,
  runtimeToolDefinitions,
} from '../../../src/tools/runtime-tools.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { encodePng, solidRgba } from '../../helpers/png-fixtures.js';
import { auditScriptsDir, screenshotsDir } from '../../../src/utils/artifact-paths.js';
import { BridgeAttachConflictError } from '../../../src/utils/bridge-manager.js';
import type {
  GodotRunner,
  GodotProcess,
  RuntimeSessionMode,
  RuntimeStopResult,
} from '../../../src/utils/godot-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { useTmpDirs } from '../../helpers/tmp.js';
import { fakeSessionApi } from '../../helpers/fake-sessions.js';
import type { Elicitor, McpContext } from '../../../src/utils/mcp-context.js';

// ---------------------------------------------------------------------------
// MCP context fakes
// ---------------------------------------------------------------------------

/**
 * Build a test context with the given elicitor behavior. Defaults to
 * `() => ({ action: 'accept', content: { confirm: true } })`, which auto-accepts
 * both the run_project session gate and any Tier 2 run_script elicitation.
 */
function makeContext(
  opts: {
    elicit?: Elicitor;
    strict?: boolean;
    disableElicitation?: boolean;
    disableSecurity?: boolean;
  } = {},
): McpContext {
  const defaultElicit: Elicitor = async () => ({
    action: 'accept',
    content: { confirm: true },
  });
  return {
    elicitor: opts.elicit ?? defaultElicit,
    strictMode: opts.strict === true,
    disableElicitation: opts.disableElicitation === true,
    disableSecurity: opts.disableSecurity === true,
    sessionState: { runProjectConfirmed: new Set<string>() },
  };
}

const acceptingContext = makeContext;
const declineElicitor: Elicitor = async () => ({ action: 'decline' });
const cancelElicitor: Elicitor = async () => ({ action: 'cancel' });
const confirmFalseElicitor: Elicitor = async () => ({
  action: 'accept',
  content: { confirm: false },
});
const throwingElicitor: Elicitor = async () => {
  throw new Error('Method not found');
};

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
  /** Number of times runProject() has been invoked (the spawn path). */
  runProjectCalls(): number;
  /** Number of times attachProject() has been invoked (the attach path). */
  attachProjectCalls(): number;
  setSession(opts: {
    mode: RuntimeSessionMode | null;
    projectPath?: string | null;
    process?: Partial<GodotProcess> | null;
  }): void;
  setBridgeResponse(response: string, runtimeErrors?: string[]): void;
  setStopResult(result: RuntimeStopResult | null): void;
  setGodotPath(path: string): void;
  setEditorPid(pid: number | undefined): void;
  setBridgeReady(ready: boolean, error?: string): void;
  /** Runs inside waitForBridge / waitForBridgeAttached, before the result is
   *  returned: models session state changing while readiness is being decided. */
  setBridgeWaitHook(hook: (() => void) | null): void;
  setRunProjectError(error: Error | null): void;
  setAttachProjectError(error: Error | null): void;
  /** Hook called after runProject sets session state but before returning. */
  setRunProjectAfterHook(hook: ((projectPath: string) => void) | null): void;
  setStopProjectError(error: Error | null): void;
  /** Runs inside sendCommandWithErrors, before it returns: models session
   *  state changing while a bridge command is in flight. */
  setBridgeHook(hook: (() => void) | null): void;
  /** Stands in for the boundary-sentinel attribution the real runner derives
   *  from stderr, so the handler's attachment logic is testable without a
   *  process. Defaults to no errors and no drain timeout. */
  setActionErrorBuckets(buckets: string[][], trailing?: string[], timedOut?: boolean): void;
  /** Models BridgeManager.isBridgeAutoloadRegistered for the bridge-not-ready
   *  timeout diagnostic. Defaults to true (autoload present). */
  setBridgeAutoloadRegistered(registered: boolean): void;
  /** Models GodotRunner.otherLiveSessionsOnProject for the cross-server edit
   *  guard. Defaults to none. */
  setOtherLiveOwners(
    owners: Array<{
      pid: number;
      instanceId: string;
      hostname: string;
      mode: 'spawned' | 'attached';
      startedAt: string;
      port: number;
    }>,
  ): void;
}

function createRuntimeFake(): RuntimeFake {
  const bridgeCalls: BridgeCall[] = [];
  let bridgeResponse = '{}';
  let bridgeRuntimeErrors: string[] = [];
  let stopResult: RuntimeStopResult | null = {
    mode: 'spawned',
    projectPath: '/fake/project',
    output: [],
    errors: [],
    cleanupProblems: [],
  };
  let godotPath = '';
  let editorPid: number | undefined = 4242;
  let bridgeReady = true;
  let bridgeError: string | undefined;
  let bridgeWaitHook: (() => void) | null = null;
  let runProjectError: Error | null = null;
  let attachProjectError: Error | null = null;
  let stopProjectError: Error | null = null;
  let runProjectAfterHook: ((projectPath: string) => void) | null = null;
  let bridgeHook: (() => void) | null = null;
  let stopCallCount = 0;
  let runProjectCallCount = 0;
  let attachProjectCallCount = 0;
  let actionErrorBuckets: string[][] = [];
  let actionErrorTrailing: string[] = [];
  let actionSentinelTimedOut = false;
  // Defaults model a healthy inject: the autoload is registered and no other
  // server session is on this project. Tests override via
  // setBridgeAutoloadRegistered / setOtherLiveOwners.
  let bridgeAutoloadRegistered = true;
  let otherLiveOwners: Array<{
    pid: number;
    instanceId: string;
    hostname: string;
    mode: 'spawned' | 'attached';
    startedAt: string;
    port: number;
  }> = [];

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
    ...fakeSessionApi(() => ({
      current: {
        mode: state.activeSessionMode,
        projectPath: state.activeProjectPath,
        process: state.activeProcess,
      },
    })),
    async sendCommandWithErrors(
      command: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ) {
      bridgeCalls.push({ command, params, timeoutMs });
      if (bridgeHook) bridgeHook();
      return { response: bridgeResponse, runtimeErrors: bridgeRuntimeErrors };
    },
    async stopProject() {
      stopCallCount++;
      if (stopProjectError) throw stopProjectError;
      // Bridge-failure paths in handleRunProject tear down the session before
      // returning the error, so reset the mode/project/port state to mirror
      // the real runner's stopProject behavior.
      state.activeSessionMode = null;
      state.activeProjectPath = null;
      state.activeProcess = null;
      fake.activeBridgePort = null;
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
      const proc = { on: () => proc, pid: editorPid };
      return proc as unknown as GodotProcess['process'];
    },
    activeBridgePort: null as number | null,
    async runProject(
      projectPath: string,
      _scene?: string,
      _background?: boolean,
      bridgePort?: number,
    ) {
      runProjectCallCount++;
      if (runProjectError) throw runProjectError;
      state.activeSessionMode = 'spawned';
      state.activeProjectPath = projectPath;
      state.activeProcess = makeRunningProcess();
      fake.activeBridgePort = bridgePort ?? 19900;
      if (runProjectAfterHook) runProjectAfterHook(projectPath);
    },
    async attachProject(projectPath: string, bridgePort?: number) {
      attachProjectCallCount++;
      if (attachProjectError) throw attachProjectError;
      state.activeSessionMode = 'attached';
      state.activeProjectPath = projectPath;
      fake.activeBridgePort = bridgePort ?? 19901;
    },
    async waitForBridge() {
      if (bridgeWaitHook) bridgeWaitHook();
      return { ready: bridgeReady, error: bridgeError };
    },
    async waitForBridgeAttached() {
      if (bridgeWaitHook) bridgeWaitHook();
      return { ready: bridgeReady, error: bridgeError };
    },
    getRecentErrors(_n: number): string[] {
      return [];
    },
    isBridgeAutoloadRegistered(_projectPath: string): boolean {
      return bridgeAutoloadRegistered;
    },
    otherLiveSessionsOnProject(_projectPath: string) {
      return otherLiveOwners;
    },
    beginActionErrorCapture() {
      return { marker: 0 };
    },
    async collectActionErrors(_capture: unknown, expectedSentinels: number) {
      return {
        buckets: Array.from(
          { length: Math.max(0, expectedSentinels) },
          (_unused, i) => actionErrorBuckets[i] ?? [],
        ),
        trailing: actionErrorTrailing,
        sentinelTimedOut: actionSentinelTimedOut,
      };
    },
  };

  return {
    asRunner: fake as unknown as GodotRunner,
    bridgeCalls,
    stopCalls() {
      return stopCallCount;
    },
    runProjectCalls() {
      return runProjectCallCount;
    },
    attachProjectCalls() {
      return attachProjectCallCount;
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
      // The real runner always reports cleanupProblems. Default it here so a
      // case that is not about cleanup does not have to spell it out.
      stopResult = result === null ? null : { cleanupProblems: [], ...result };
    },
    setGodotPath(path: string) {
      godotPath = path;
    },
    setEditorPid(pid: number | undefined) {
      editorPid = pid;
    },
    setBridgeReady(ready: boolean, error?: string) {
      bridgeReady = ready;
      bridgeError = error;
    },
    setBridgeWaitHook(hook) {
      bridgeWaitHook = hook;
    },
    setRunProjectError(error: Error | null) {
      runProjectError = error;
    },
    setAttachProjectError(error: Error | null) {
      attachProjectError = error;
    },
    setRunProjectAfterHook(hook) {
      runProjectAfterHook = hook;
    },
    setStopProjectError(error: Error | null) {
      stopProjectError = error;
    },
    setBridgeHook(hook) {
      bridgeHook = hook;
    },
    setActionErrorBuckets(buckets, trailing = [], timedOut = false) {
      actionErrorBuckets = buckets;
      actionErrorTrailing = trailing;
      actionSentinelTimedOut = timedOut;
    },
    setBridgeAutoloadRegistered(registered) {
      bridgeAutoloadRegistered = registered;
    },
    setOtherLiveOwners(owners) {
      otherLiveOwners = owners;
    },
  };
}

const tmp = useTmpDirs();

interface RunProjectPayload {
  warnings?: string[];
  projectPath: string;
  sessionMode: string;
  bridgePort: number | null;
  message: string;
}

/** The structured payload of a run_project success, as a strict client reads it. */
function runProjectPayload(result: unknown): RunProjectPayload {
  return unwrap(result).structuredContent as unknown as RunProjectPayload;
}

function makeRunningProcess(opts: Partial<GodotProcess> = {}): GodotProcess {
  return {
    // Intentionally unset: no covered handler reads `.process`. If a future handler calls
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
// Validation paths for handleRunProject / handleLaunchEditor
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

  // Regression: issue #15: without an explicit Godot-path precheck, an
  // unresolved godotPath used to bubble up as a generic "Failed to run
  // Godot project" error pointing at a hardcoded `C:\Program Files\...`
  // fallback path the user never configured. The handler must now surface
  // a clear "set GODOT_PATH" message before attempting to spawn.
  it('returns a "set GODOT_PATH" error when no Godot executable can be resolved', async () => {
    const fake = createRuntimeFake();
    // godotPath stays empty (default), so the precheck must fire.
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /Could not find a valid Godot executable path/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/GODOT_PATH/);
  });

  it('returns display-unavailable error suggesting attach mode', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setRunProjectError(
      new Error(
        'No display server available (DISPLAY and WAYLAND_DISPLAY are both unset). ' +
          'Godot requires a display to run a project window.',
      ),
    );
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /No display server available/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/attach: true/);
  });

  it('cleans up bridge artifacts when process exits before bridge readiness', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'Process exited with code 1');
    // runProject sets activeProcess to a running process; override it to an
    // exited process after the call so waitForBridge sees the early exit.
    fake.setRunProjectAfterHook((pp) => {
      fake.setSession({
        mode: 'spawned',
        projectPath: pp,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    });
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /exited before.*bridge/i);
    expect(fake.stopCalls()).toBe(1);
  });
});

describe('handleRunProject bridge port', () => {
  it('includes the assigned bridge port in the success response', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.bridgePort).toBe(19900);
    expect(payload.sessionMode).toBe('spawned');
    expect(payload).not.toHaveProperty('bridgeReady');
  });
});

describe('handleRunProject bridge failure paths', () => {
  const PINNED_SPAWN_BRIDGE_PORT = 23456;

  it('returns "exited before MCP bridge could initialize" error when process exits during wait', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'process gone');
    // After runProject sets the session, mark the process as already exited
    // so the handler takes the "process exited" branch (not the timeout
    // branch) and tears down before returning.
    fake.setRunProjectAfterHook((projectPath) => {
      fake.setSession({
        mode: 'spawned',
        projectPath,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    });
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
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
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /bridge did not respond/);
    expect(fake.stopCalls()).toBe(1);
  });

  it('names the assigned bridge port in the timeout solutions, read before the teardown clears it', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'timeout after 5s');
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, bridgePort: PINNED_SPAWN_BRIDGE_PORT },
      acceptingContext(),
    );
    expectErrorMatching(result, /bridge did not respond/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain(`bridge port (${PINNED_SPAWN_BRIDGE_PORT})`);
    expect(solutionsText).not.toContain('null');
  });

  it.each([0, 65536, 8080.5])('rejects the out-of-range bridgePort %s', async (port) => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, bridgePort: port },
      acceptingContext(),
    );
    expectErrorMatching(result, /Invalid bridgePort/);
    expect(fake.runProjectCalls()).toBe(0);
  });

  it('reports the missing-autoload diagnosis instead of the stuck-process line when the entry never made it in', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'timeout after 5s');
    fake.setBridgeAutoloadRegistered(false);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /project\.godot has no McpBridge autoload entry/);
    const message = unwrap(result).content[0]?.text ?? '';
    expect(message).not.toContain('early _ready error');
    expect(fake.stopCalls()).toBe(1);
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

describe('handleLaunchEditor payload', () => {
  it('returns the project path, the editor pid and a message', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const result = await handleLaunchEditor(fake.asRunner, { projectPath: fixtureProjectPath });
    expect(expectMatchesOutputSchema('launch_editor', result)).toEqual({
      projectPath: resolve(fixtureProjectPath),
      pid: 4242,
      message: expect.any(String),
    });
  });

  // A spawn that fails (bad executable) reports no pid and raises 'error'
  // later. Nothing was launched, so nothing may be reported as launched.
  it('launch_editor is an error when the spawn reports no pid', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setEditorPid(undefined);
    const result = await handleLaunchEditor(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /editor process did not start \(the spawn reported no pid\)/);
    expect(unwrap(result).content[1]?.text ?? '').toMatch(/GODOT_PATH/);
  });

  it('declares the editor pid as a plain number, with no warnings channel', () => {
    const definition = runtimeToolDefinitions.find((tool) => tool.name === 'launch_editor');
    const schema = definition?.outputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.pid).toMatchObject({ type: 'number' });
    expect(schema.properties).not.toHaveProperty('warnings');
  });
});

// ---------------------------------------------------------------------------
// ensureRuntimeSession (via handleTakeScreenshot: same gate every runtime
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

  // The auto-clear nulls the mode on process exit but retains the process, so
  // the generic no-session message would otherwise replace the diagnosis.
  it('reports the exited process after the session auto-cleared', async () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: null,
      projectPath: null,
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

  // Nothing is captured in attach mode. Empty arrays would read as "no output
  // and no errors", so the logs are null and the reason leads the payload.
  it('get_debug_output in an attached session returns null logs and a leading warning', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    const result = handleGetDebugOutput(fake.asRunner, {});
    const payload = expectMatchesOutputSchema('get_debug_output', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload).toEqual({
      warnings: [expect.stringMatching(/captures no stdout or stderr.*null, not empty/)],
      projectPath: '/p',
      sessionMode: 'attached',
      output: null,
      errors: null,
      running: null,
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.output).toEqual(['out7', 'out8', 'out9']);
    expect(parsed.errors).toEqual(['err7', 'err8', 'err9']);
    expect(parsed.sessionMode).toBe('spawned');
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.running).toBe(false);
    expect(parsed.exitCode).toBe(137);
    expect(parsed.tip).toMatch(/Process has exited/i);
    expect(parsed.tip).toMatch(/stop_project/);
  });

  // The auto-clear nulls the mode on exit but keeps the process; the logs are exactly
  // what the caller wants at that point, so the gate must not error.
  it('still returns the captured logs after the session auto-cleared', () => {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: null,
      projectPath: null,
      process: makeRunningProcess({
        hasExited: true,
        exitCode: 139,
        output: ['out'],
        errors: ['SCRIPT ERROR: crashed'],
      }),
    });
    const result = handleGetDebugOutput(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.output).toEqual(['out']);
    expect(parsed.errors).toEqual(['SCRIPT ERROR: crashed']);
    expect(parsed.sessionMode).toBe('spawned');
    expect(parsed.running).toBe(false);
    expect(parsed.exitCode).toBe(139);
  });

  it('validates an attached and a spawned payload against the declared schema', () => {
    const attached = createRuntimeFake();
    attached.setSession({ mode: 'attached', projectPath: '/p' });
    expect(
      expectMatchesOutputSchema('get_debug_output', handleGetDebugOutput(attached.asRunner, {}))
        .sessionMode,
    ).toBe('attached');

    const spawned = createRuntimeFake();
    spawned.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess({ output: ['x'] }),
    });
    expect(
      expectMatchesOutputSchema('get_debug_output', handleGetDebugOutput(spawned.asRunner, {}))
        .sessionMode,
    ).toBe('spawned');
  });
});

// ---------------------------------------------------------------------------
// handleStopProject
// ---------------------------------------------------------------------------

describe('handleStopProject', () => {
  it('returns the spawned-stopped message when stopProject reports mode:spawned', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      projectPath: '/p',
      output: ['o1'],
      errors: ['e1'],
    });
    const result = await handleStopProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.message).toBe('Godot project stopped');
    expect(parsed.sessionMode).toBe('spawned');
    expect(parsed).not.toHaveProperty('mode');
    expectMatchesOutputSchema('stop_project', result);
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.message).toBe('Attached project detached and MCP bridge state cleaned up');
    expect(parsed.sessionMode).toBe('attached');
    expect(parsed.externalProcessPreserved).toBe(true);
  });

  it('names the stopped project', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({ mode: 'spawned', projectPath: '/p', output: [], errors: [] });
    const result = await handleStopProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.projectPath).toBe('/p');
  });

  it('returns isError when no session was active', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult(null);
    const result = await handleStopProject(fake.asRunner);
    expectErrorMatching(result, /No active Godot process/i);
  });

  // The process exited on its own; the bridge was cleaned then.
  it('reports alreadyExited with the exit code and captured logs', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      output: ['PASS: scenario complete'],
      errors: ['SCRIPT ERROR: crashed'],
      alreadyExited: true,
      exitCode: 139,
    });
    const result = await handleStopProject(fake.asRunner);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.alreadyExited).toBe(true);
    expect(parsed.exitCode).toBe(139);
    expect(parsed.message).toMatch(/already exited/i);
    expect(parsed.finalOutput).toEqual(['PASS: scenario complete']);
    expect(parsed.finalErrors).toEqual(['SCRIPT ERROR: crashed']);
  });

  it('reports alreadyExited:false for an ordinary stop', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({ mode: 'spawned', output: [], errors: [] });
    const result = await handleStopProject(fake.asRunner);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.alreadyExited).toBe(false);
    expect(parsed.exitCode).toBeUndefined();
  });

  it('condenses finalOutput/finalErrors to diagnostic lines on success', async () => {
    const fake = createRuntimeFake();
    const banner = [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      '',
      'Metal 4.0 - Forward+ - Using Device #1: Apple M3 Pro',
      '',
    ];
    fake.setStopResult({
      mode: 'spawned',
      output: [...banner, 'PASS: scenario complete', ''],
      errors: [...banner, 'SCRIPT ERROR: something real'],
    });
    const result = await handleStopProject(fake.asRunner);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    // Banner lines are dropped from the success payload; the tail + any
    // error lines survive so diagnostics stay reachable.
    expect(parsed.finalOutput).toEqual(['PASS: scenario complete']);
    expect(parsed.finalErrors).toEqual(['SCRIPT ERROR: something real']);
  });

  it('falls back to the last non-empty line when every line is filtered', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      output: ['Godot Engine v4.7.2', '', 'Metal 4.0 - Forward+ - Using Device #1: Apple M3 Pro'],
      errors: [],
    });
    const result = await handleStopProject(fake.asRunner);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    // Every line is filtered, so this exercises the fallback rather than the
    // ordinary keep path -- a bare 'Metal 4.0 - Forward+' would survive the
    // banner pattern and never reach it.
    expect(parsed.finalOutput).toEqual(['Metal 4.0 - Forward+ - Using Device #1: Apple M3 Pro']);
    expect(parsed.finalErrors).toEqual([]);
  });

  // The stop still happened, so these are successes. What they must not do is
  // say the bridge was removed when a removal step was never confirmed.
  it('stop_project leads with a warning when bridge cleanup was incomplete', async () => {
    const problem =
      'the McpBridge autoload entry could not be removed from project.godot (EPERM: operation not permitted)';
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      projectPath: '/p',
      output: [],
      errors: [],
      cleanupProblems: [problem],
    });
    const result = await handleStopProject(fake.asRunner);
    const payload = expectMatchesOutputSchema('stop_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([`Bridge cleanup incomplete: ${problem}`]);
    expect(payload.message).toMatch(/cleanup was incomplete/);
  });

  it('does not claim an exit-time cleanup that left a problem behind', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      projectPath: '/p',
      output: [],
      errors: [],
      alreadyExited: true,
      exitCode: 1,
      cleanupProblems: ['the bridge script could not be removed (EBUSY)'],
    });
    const payload = expectMatchesOutputSchema(
      'stop_project',
      await handleStopProject(fake.asRunner),
    );
    expect((payload.warnings as string[])[0]).toBe(
      'Bridge cleanup incomplete: the bridge script could not be removed (EBUSY)',
    );
    expect(payload.message).not.toMatch(/was cleaned up at that time/);
    expect(payload.message).toMatch(/cleanup at that time was incomplete/);
  });

  it('stop_project leads with a warning when the attached bridge did not acknowledge shutdown', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'attached',
      projectPath: '/p',
      output: null,
      errors: null,
      externalProcessPreserved: true,
      shutdownAcknowledged: false,
    });
    const payload = expectMatchesOutputSchema(
      'stop_project',
      await handleStopProject(fake.asRunner),
    );
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toMatch(
      /did not acknowledge shutdown, so it keeps listening on its port/,
    );
  });

  it('stop_project of an attached session returns null finalOutput and finalErrors', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'attached',
      projectPath: '/p',
      output: null,
      errors: null,
      externalProcessPreserved: true,
      shutdownAcknowledged: true,
    });
    const payload = expectMatchesOutputSchema(
      'stop_project',
      await handleStopProject(fake.asRunner),
    );
    expect(payload.finalOutput).toBeNull();
    expect(payload.finalErrors).toBeNull();
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([
      expect.stringMatching(/captures no stdout or stderr.*null, not empty/),
    ]);
  });

  it('carries no shutdown warning when the attached bridge acknowledged', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'attached',
      projectPath: '/p',
      output: [],
      errors: [],
      externalProcessPreserved: true,
      shutdownAcknowledged: true,
    });
    const payload = expectMatchesOutputSchema(
      'stop_project',
      await handleStopProject(fake.asRunner),
    );
    expect(JSON.stringify(payload.warnings ?? [])).not.toMatch(/acknowledge/);
    expect(payload.message).toBe('Attached project detached and MCP bridge state cleaned up');
  });
});

// ---------------------------------------------------------------------------
// computeInputTimeoutMs + handleSimulateInput
//
// The handler's whole job is shaping: caps before the bridge call, a derived
// timeout, and per-action error attribution onto the bridge's results[]. The
// bridge response is a fixture string here, so none of this needs Godot.
// ---------------------------------------------------------------------------

const TIMEOUT_BUFFER_MS = 10000;
/** Mirrors INPUT_PESSIMISTIC_FRAME_MS: a 10 fps floor, not a frame-rate guess. */
const PESSIMISTIC_FRAME_MS = 100;

describe('computeInputTimeoutMs', () => {
  it('charges the buffer plus one settle frame per action when there are no waits', () => {
    const ms = computeInputTimeoutMs([{ type: 'key', key: 'Space', pressed: true }]);
    expect(ms).toBe(TIMEOUT_BUFFER_MS + PESSIMISTIC_FRAME_MS);
  });

  it('sums wait.ms entries', () => {
    const actions = [
      { type: 'wait', ms: 5000 },
      { type: 'wait', ms: 2500 },
    ];
    // 7500 waited + 2 settle-frame charges + buffer
    expect(computeInputTimeoutMs(actions)).toBe(
      7500 + 2 * PESSIMISTIC_FRAME_MS + TIMEOUT_BUFFER_MS,
    );
  });

  it('charges wait.frames at the pessimistic per-frame cost', () => {
    const actions = [{ type: 'wait', frames: 10 }];
    expect(computeInputTimeoutMs(actions)).toBe(11 * PESSIMISTIC_FRAME_MS + TIMEOUT_BUFFER_MS);
  });

  it('gives a frames wait enough wall clock for a game running at 10 fps', () => {
    // The per-frame charge is a floor on the frame rate. A game under load, or
    // one whose window is minimized, must not time out a batch that is running.
    const SLOW_GAME_FPS = 10;
    const frames = 30;
    const realDurationMs = (frames / SLOW_GAME_FPS) * 1000;
    expect(computeInputTimeoutMs([{ type: 'wait', frames }])).toBeGreaterThan(realDurationMs);
  });

  it('sums hold_ms', () => {
    const actions = [{ type: 'key', key: 'W', hold_ms: 400 }];
    // hold_ms suppresses the tap-hold frame charge; one settle frame remains.
    expect(computeInputTimeoutMs(actions)).toBe(400 + PESSIMISTIC_FRAME_MS + TIMEOUT_BUFFER_MS);
  });

  it('charges text per character', () => {
    const actions = [{ type: 'text', text: 'hello' }];
    expect(computeInputTimeoutMs(actions)).toBe(5 + PESSIMISTIC_FRAME_MS + TIMEOUT_BUFFER_MS);
  });

  it('counts a tap but not an explicit press', () => {
    const tap = computeInputTimeoutMs([{ type: 'key', key: 'A' }]);
    const hold = computeInputTimeoutMs([{ type: 'key', key: 'A', pressed: true }]);
    // The tap pays its two tap-hold frames on top of the shared settle frame.
    expect(tap - hold).toBe(2 * PESSIMISTIC_FRAME_MS);
  });

  it('ignores negative wait and hold durations instead of subtracting them', () => {
    // hold_ms stays explicit (never omitted) across all three variants below:
    // an *omitted* hold_ms with no `pressed` field reclassifies the action as
    // a tap and adds INPUT_TAP_HOLD_FRAMES, which is a different, correct code
    // path and not what this test is about. Only wait.ms/wait.frames vary
    // between explicit and absent, since a `wait` action never counts as a tap.
    const withNegative = [
      { type: 'wait', ms: -5000, frames: -10 },
      { type: 'key', key: 'W', hold_ms: -400 },
    ];
    const withZero = [
      { type: 'wait', ms: 0, frames: 0 },
      { type: 'key', key: 'W', hold_ms: 0 },
    ];
    const withAbsent = [{ type: 'wait' }, { type: 'key', key: 'W', hold_ms: 0 }];

    const negativeMs = computeInputTimeoutMs(withNegative);
    expect(negativeMs).toBe(computeInputTimeoutMs(withZero));
    expect(negativeMs).toBe(computeInputTimeoutMs(withAbsent));

    // Never less than the base timeout: no positive wait/hold term survives
    // to shrink the buffer below the buffer itself.
    expect(negativeMs).toBeGreaterThanOrEqual(TIMEOUT_BUFFER_MS);
  });
});

describe('handleSimulateInput', () => {
  function setupActive(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: '/p',
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(
      JSON.stringify({
        success: true,
        results: [{ index: 0, type: 'key', ok: true, frame: 1, elapsed_ms: 7 }],
      }),
    );
    return fake;
  }

  it('rejects when actions is missing or empty', async () => {
    const fake = setupActive();
    expectErrorMatching(
      await handleSimulateInput(fake.asRunner, { actions: [] }),
      /actions must be an array of at least 1 item/i,
    );
    expectErrorMatching(
      await handleSimulateInput(fake.asRunner, {}),
      /actions must be an array of at least 1 item/i,
    );
  });

  it('passes the computed timeout to the bridge', async () => {
    const fake = setupActive();
    const actions = [
      { type: 'wait', ms: 5000 },
      { type: 'key', key: 'A', pressed: true },
    ];
    await handleSimulateInput(fake.asRunner, { actions });
    expect(fake.bridgeCalls).toHaveLength(1);
    expect(fake.bridgeCalls[0].timeoutMs).toBe(computeInputTimeoutMs(actions));
  });

  describe('Node-side caps reject before any bridge call', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'wait.frames over the cap',
        { actions: [{ type: 'wait', frames: 601 }] },
        /frames must be a number no greater than 600/i,
      ],
      [
        'hold_ms over the cap',
        { actions: [{ type: 'key', key: 'A', hold_ms: 10001 }] },
        /hold_ms must be a number no greater than 10000/i,
      ],
      [
        'hold_ms combined with pressed',
        { actions: [{ type: 'key', key: 'A', hold_ms: 100, pressed: true }] },
        /hold_ms cannot be combined with pressed/i,
      ],
      [
        'text over the cap',
        { actions: [{ type: 'text', text: 'x'.repeat(1001) }] },
        /text exceeds 1000 characters/i,
      ],
      [
        'watch over the cap',
        {
          actions: [{ type: 'key', key: 'A' }],
          watch: Array.from({ length: 17 }, (_unused, i) => `/root/N${i}:visible`),
        },
        /watch accepts at most 16 entries/i,
      ],
      [
        'wait with both ms and frames',
        { actions: [{ type: 'wait', ms: 10, frames: 1 }] },
        /set exactly one of ms or frames/i,
      ],
      [
        'wait with neither ms nor frames',
        { actions: [{ type: 'wait' }] },
        /set exactly one of ms or frames/i,
      ],
    ];

    it.each(cases)('%s', async (_label, args, pattern) => {
      const fake = setupActive();
      expectErrorMatching(await handleSimulateInput(fake.asRunner, args), pattern);
      expect(fake.bridgeCalls).toEqual([]);
    });
  });

  it('forwards watch only when non-empty and passes actions through byte-identical', async () => {
    // normalizeParameters does not recurse into arrays, so per-action
    // snake_case fields (hold_ms, relative_x, double_click) must survive
    // unrewritten all the way to the bridge frame.
    const fake = setupActive();
    const actions = [{ type: 'key', key: 'X', hold_ms: 50, double_click: false }];
    await handleSimulateInput(fake.asRunner, { actions });
    expect(fake.bridgeCalls[0].command).toBe('input');
    expect(fake.bridgeCalls[0].params).toEqual({ actions });

    const withWatch = createRuntimeFake();
    withWatch.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    withWatch.setBridgeResponse(JSON.stringify({ success: true, results: [] }));
    await handleSimulateInput(withWatch.asRunner, {
      actions,
      watch: ['/root/Main/Player:position:x'],
    });
    expect(withWatch.bridgeCalls[0].params).toEqual({
      actions,
      watch: ['/root/Main/Player:position:x'],
    });
  });

  it('maps a bridge pre-validation error to an error response', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(
      JSON.stringify({ error: "action 2 (key): unrecognized key name: 'Foo'" }),
    );
    expectErrorMatching(
      await handleSimulateInput(fake.asRunner, { actions: [{ type: 'key', key: 'Foo' }] }),
      /unrecognized key name/i,
    );
  });

  it('returns a non-error structured response for a partially failed batch', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(
      JSON.stringify({
        success: false,
        results: [
          { index: 0, type: 'click_element', ok: true, hit: '/root/HUD/Btn', signals: ['pressed'] },
          { index: 1, type: 'click_element', ok: false, error: 'occluded by /root/HUD/Modal' },
          { index: 2, type: 'key', skipped: true },
        ],
        still_held: ['key:W'],
      }),
    );
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'click_element', element: 'Btn' },
        { type: 'click_element', element: 'Other' },
        { type: 'key', key: 'W', pressed: true },
      ],
    });
    expect(hasError(result)).toBe(false);
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.still_held).toEqual(['key:W']);
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results[1]).toMatchObject({ index: 1, ok: false });
    expect(results[2]).toMatchObject({ index: 2, skipped: true });
  });

  it('attaches bucketed errors to the matching entry only', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(
      JSON.stringify({
        success: true,
        results: [
          { index: 0, type: 'key', ok: true },
          { index: 1, type: 'click_element', ok: true },
          { index: 2, type: 'key', ok: true },
        ],
      }),
    );
    fake.setActionErrorBuckets([[], ['SCRIPT ERROR: in _on_pressed'], []]);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'key', key: 'A' },
        { type: 'click_element', element: 'Btn' },
        { type: 'key', key: 'B' },
      ],
    });
    const results = (unwrap(result).structuredContent as Record<string, unknown>).results as Array<
      Record<string, unknown>
    >;
    expect(results[1].errors).toEqual(['SCRIPT ERROR: in _on_pressed']);
    expect(results[0]).not.toHaveProperty('errors');
    expect(results[2]).not.toHaveProperty('errors');
  });

  it('appends trailing errors to the last executed entry', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(
      JSON.stringify({
        success: false,
        results: [
          { index: 0, type: 'key', ok: false, error: 'boom' },
          { index: 1, type: 'key', skipped: true },
        ],
      }),
    );
    fake.setActionErrorBuckets([[]], ['SCRIPT ERROR: unattributed'], true);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'key', key: 'A' },
        { type: 'key', key: 'B' },
      ],
    });
    const results = (unwrap(result).structuredContent as Record<string, unknown>).results as Array<
      Record<string, unknown>
    >;
    expect(results[0].errors).toEqual(['SCRIPT ERROR: unattributed']);
    expect(results[1]).not.toHaveProperty('errors');
  });

  it('emits only success and results, dropping the retired count, warnings and tip fields', async () => {
    // Exact key set rather than three absence assertions: it also catches any
    // new top-level field arriving without a schema entry, and it keeps the
    // retired field names out of the tree entirely.
    const fake = setupActive();
    fake.setBridgeResponse(JSON.stringify({ success: true, results: [] }), [
      'SCRIPT ERROR: in _process',
    ]);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'key', key: 'A' }],
    });
    expect(hasError(result)).toBe(false);
    const payload = unwrap(result).structuredContent as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['projectPath', 'results', 'success']);
  });

  it('simulate_input leads with a warning when error attribution was partial', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(
      JSON.stringify({ success: true, results: [{ index: 0, type: 'key', ok: true }] }),
    );
    // The stderr drain ended before every action boundary had arrived.
    fake.setActionErrorBuckets([[]], [], true);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'key', key: 'A' }],
    });
    const payload = expectMatchesOutputSchema('simulate_input', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([
      expect.stringMatching(/may be attributed to the wrong action or be missing/),
    ]);
    expect((payload.warnings as string[])[0]).toMatch(/get_debug_output/);
  });
});

// ---------------------------------------------------------------------------
// Runtime-error lists: a cut is counted, never silent
// ---------------------------------------------------------------------------

describe('runtime error lists end with a count of what was cut', () => {
  const SHOWN_LINES = 30;
  const CUT_LINES = 5;
  const lines = Array.from(
    { length: SHOWN_LINES + CUT_LINES },
    (_unused, i) => `SCRIPT ERROR: failure ${i}`,
  );
  const CUT_ENTRY = `+${CUT_LINES} more runtime error lines (get_debug_output has the full log)`;

  function activeFake(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    return fake;
  }

  it('get_ui_elements warnings', async () => {
    const fake = activeFake();
    fake.setBridgeResponse(JSON.stringify({ elements: [] }), lines);
    const payload = expectMatchesOutputSchema(
      'get_ui_elements',
      await handleGetUiElements(fake.asRunner, {}),
    );
    const warnings = payload.warnings as string[];
    expect(warnings).toHaveLength(SHOWN_LINES + 1);
    expect(warnings.slice(0, SHOWN_LINES)).toEqual(lines.slice(0, SHOWN_LINES));
    expect(warnings[SHOWN_LINES]).toBe(CUT_ENTRY);
  });

  it('a simulate_input entry', async () => {
    const fake = activeFake();
    fake.setBridgeResponse(
      JSON.stringify({ success: true, results: [{ index: 0, type: 'click_element', ok: true }] }),
    );
    fake.setActionErrorBuckets([lines]);
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'click_element', element: 'Btn' }],
    });
    const results = (unwrap(result).structuredContent as Record<string, unknown>).results as Array<
      Record<string, unknown>
    >;
    const errors = results[0].errors as string[];
    expect(errors).toHaveLength(SHOWN_LINES + 1);
    expect(errors[SHOWN_LINES]).toBe(CUT_ENTRY);
  });

  it('a list at the limit is returned whole, with no count entry', async () => {
    const fake = activeFake();
    const atLimit = lines.slice(0, SHOWN_LINES);
    fake.setBridgeResponse(JSON.stringify({ elements: [] }), atLimit);
    const payload = expectMatchesOutputSchema(
      'get_ui_elements',
      await handleGetUiElements(fake.asRunner, {}),
    );
    expect(payload.warnings).toEqual(atLimit);
  });
});

// ---------------------------------------------------------------------------
// handleGetUiElements: defaulting + parameter renaming
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

  it('puts warnings first when the query raised runtime errors', async () => {
    const fake = setupActive();
    fake.setBridgeResponse(JSON.stringify({ elements: [] }), ['SCRIPT ERROR: boom']);
    const result = await handleGetUiElements(fake.asRunner, {});
    const payload = expectMatchesOutputSchema('get_ui_elements', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual(['SCRIPT ERROR: boom']);
  });
});

// ---------------------------------------------------------------------------
// handleRunScript: false-positive null-result detection + audit write
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.result).toBeNull();
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings[0]).toMatch(/GDScript does not propagate exceptions/);
    expect(Object.keys(parsed)[0]).toBe('warnings');
  });

  it('returns success without escalation when attached + result:null (stderr not captured)', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: dir });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expect(hasError(result)).toBe(false);
  });

  // An attached session captures no stderr, so a script that raised and one
  // that returned null are the same frame. The payload has to say so.
  it('run_script in an attached session leads with a warning when the result is null', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: dir });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toMatch(
      /returned null in an attached session\. Runtime errors cannot be observed there/,
    );
    expect(payload.result).toBeNull();
  });

  it('carries no attached-session warning when the attached script returned a value', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: dir });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 7 }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.result).toBe(7);
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.result).toBe(42);
    expect(parsed.warnings).toEqual(['SCRIPT ERROR: stale ref']);
    expect(Object.keys(parsed)[0]).toBe('warnings');
  });

  it('writes the script to .mcp/godot-runtime/scripts/{timestamp}.gd for forensic replay', async () => {
    const dir = tmp.makeProject('run-script-audit-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });

    const scriptsDir = auditScriptsDir(dir);
    expect(existsSync(scriptsDir)).toBe(true);
    const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.gd'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(scriptsDir, files[0]), 'utf8')).toBe(VALID_SCRIPT);
    // Filename is a numeric timestamp + UUID suffix to avoid collisions.
    expect(files[0]).toMatch(/^\d+-[0-9a-f-]+\.gd$/);
  });

  // Asserts the raw Result shape directly (not via the `unwrap` helper, which
  // tolerates both the Result wrapper and a raw ToolResponse and would mask a
  // regression back to the pre-Result-pattern return type).
  it('returns the Result<HandlerResult, ToolResponse> shape on success', async () => {
    const dir = tmp.makeProject('run-script-result-shape-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });
    expect(result).toHaveProperty('ok', true);
    expect((result as { ok: true; value: { content: unknown } }).value).toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// handleRunScript: security policy gate (Tier 1 / Tier 2 / Tier 3)
// ---------------------------------------------------------------------------

describe('handleRunScript security policy', () => {
  const TIER1_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree):\n\tOS.execute("rm", ["-rf", "/"])\n\treturn 0\n';
  const TIER2_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree):\n\tvar h = HTTPRequest.new()\n\treturn h\n';
  const TIER3_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree):\n\tvar r = load("res://main.tscn")\n\treturn r\n';

  function activeFake(dir: string): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    return fake;
  }

  it('hard-blocks Tier 1 OS.execute before reaching the bridge', async () => {
    const dir = tmp.makeProject('run-script-tier1-');
    const fake = activeFake(dir);
    const result = await handleRunScript(fake.asRunner, { script: TIER1_SCRIPT });
    expectErrorMatching(result, /Blocked.*OS\.execute/);
    expect(fake.bridgeCalls).toHaveLength(0);
    // Sidecar should record hard_block.
    const scriptsDir = auditScriptsDir(dir);
    const sidecarFile = readdirSync(scriptsDir).find((f) => f.endsWith('.policy.json'));
    expect(sidecarFile).toBeDefined();
    const sidecar = JSON.parse(readFileSync(join(scriptsDir, sidecarFile!), 'utf8'));
    expect(sidecar.decision).toBe('hard_block');
    expect(sidecar.tier).toBe(1);
  });

  it('GODOT_MCP_DISABLE_SECURITY: runs a Tier 1 script with no elicitation, no warnings, no sidecar', async () => {
    const dir = tmp.makeProject('run-script-disable-security-');
    const fake = activeFake(dir);
    let elicitCalls = 0;
    const countingElicitor: Elicitor = async () => {
      elicitCalls++;
      return { action: 'accept', content: { confirm: true } };
    };
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER1_SCRIPT },
      makeContext({ elicit: countingElicitor, disableSecurity: true }),
    );
    // Complete no-op: the Tier 1 script actually reaches the bridge and succeeds.
    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
    expect(elicitCalls).toBe(0);
    const value = unwrap(result) as { warnings?: string[] };
    expect(value.warnings).toBeUndefined();
    const scriptsDir = auditScriptsDir(dir);
    expect(existsSync(scriptsDir)).toBe(false);
  });

  it('elicits on Tier 2 HTTPRequest and proceeds on accept', async () => {
    const dir = tmp.makeProject('run-script-tier2-accept-');
    const fake = activeFake(dir);
    const result = await handleRunScript(fake.asRunner, { script: TIER2_SCRIPT }, makeContext());
    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes('HTTPRequest'))).toBe(true);
    // Sidecar must record elicit_accepted distinctly from a plain warn.
    const scriptsDir = auditScriptsDir(dir);
    const sidecarFile = readdirSync(scriptsDir).find((f) => f.endsWith('.policy.json'));
    expect(sidecarFile).toBeDefined();
    const sidecar = JSON.parse(readFileSync(join(scriptsDir, sidecarFile!), 'utf8'));
    expect(sidecar.decision).toBe('elicit_accepted');
    expect(sidecar.tier).toBe(2);
  });

  it('rejects Tier 2 on decline without reaching the bridge', async () => {
    const dir = tmp.makeProject('run-script-tier2-decline-');
    const fake = activeFake(dir);
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: declineElicitor }),
    );
    expectErrorMatching(result, /User declined.*HTTPRequest/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects Tier 2 when elicitor returns cancel (anything but accept is denial)', async () => {
    const dir = tmp.makeProject('run-script-tier2-cancel-');
    const fake = activeFake(dir);
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: cancelElicitor }),
    );
    expectErrorMatching(result, /User declined.*HTTPRequest/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects Tier 2 when accept carries content.confirm:false', async () => {
    const dir = tmp.makeProject('run-script-tier2-confirmfalse-');
    const fake = activeFake(dir);
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: confirmFalseElicitor }),
    );
    expectErrorMatching(result, /User declined.*HTTPRequest/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('falls back to denial when elicitation throws (older client)', async () => {
    const dir = tmp.makeProject('run-script-tier2-noclient-');
    const fake = activeFake(dir);
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: throwingElicitor }),
    );
    expectErrorMatching(result, /Elicitation unavailable/);
    expect(fake.bridgeCalls).toHaveLength(0);
    // Sidecar must record elicit_denied even on throw, preserving the audit trail.
    const scriptsDir = auditScriptsDir(dir);
    const sidecarFile = readdirSync(scriptsDir).find((f) => f.endsWith('.policy.json'));
    expect(sidecarFile).toBeDefined();
    const sidecar = JSON.parse(readFileSync(join(scriptsDir, sidecarFile!), 'utf8'));
    expect(sidecar.decision).toBe('elicit_denied');
  });

  it('proceeds on Tier 2 without eliciting when elicitation is disabled (GODOT_MCP_DISABLE_ELICITATION)', async () => {
    const dir = tmp.makeProject('run-script-tier2-noelicit-');
    const fake = activeFake(dir);
    // declineElicitor would deny if consulted; disableElicitation must bypass it and run.
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: declineElicitor, disableElicitation: true }),
    );
    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes('HTTPRequest'))).toBe(true);
    // Sidecar records elicit_bypassed, distinct from a user-confirmed accept.
    const scriptsDir = auditScriptsDir(dir);
    const sidecarFile = readdirSync(scriptsDir).find((f) => f.endsWith('.policy.json'));
    expect(sidecarFile).toBeDefined();
    const sidecar = JSON.parse(readFileSync(join(scriptsDir, sidecarFile!), 'utf8'));
    expect(sidecar.decision).toBe('elicit_bypassed');
    expect(sidecar.tier).toBe(2);
  });

  it('denies Tier 2 when invoked with no ctx (default null context auto-declines)', async () => {
    const dir = tmp.makeProject('run-script-tier2-nullctx-');
    const fake = activeFake(dir);
    // No context passed: handler builds its own null context whose elicitor
    // auto-declines. Must produce a "User declined" error without crashing.
    const result = await handleRunScript(fake.asRunner, { script: TIER2_SCRIPT });
    expectErrorMatching(result, /User declined.*HTTPRequest/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('strict mode promotes Tier 2 to hard block without elicitation', async () => {
    const dir = tmp.makeProject('run-script-strict-');
    const fake = activeFake(dir);
    let elicitCalled = false;
    const trackedAccept: Elicitor = async () => {
      elicitCalled = true;
      return { action: 'accept' };
    };
    const result = await handleRunScript(
      fake.asRunner,
      { script: TIER2_SCRIPT },
      makeContext({ elicit: trackedAccept, strict: true }),
    );
    expectErrorMatching(result, /Blocked.*HTTPRequest/);
    expect(elicitCalled).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('warns on Tier 3 literal load() and still executes', async () => {
    const dir = tmp.makeProject('run-script-tier3-');
    const fake = activeFake(dir);
    const result = await handleRunScript(fake.asRunner, { script: TIER3_SCRIPT });
    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes('load'))).toBe(true);
  });

  it('writes a .policy.json sidecar alongside the .gd file', async () => {
    const dir = tmp.makeProject('run-script-sidecar-');
    const fake = activeFake(dir);
    await handleRunScript(fake.asRunner, { script: TIER3_SCRIPT });
    const scriptsDir = auditScriptsDir(dir);
    const files = readdirSync(scriptsDir);
    const gd = files.find((f) => f.endsWith('.gd'));
    const sidecar = files.find((f) => f.endsWith('.policy.json'));
    expect(gd).toBeDefined();
    expect(sidecar).toBeDefined();
    // Same base name prefix.
    expect(gd!.replace(/\.gd$/, '')).toBe(sidecar!.replace(/\.policy\.json$/, ''));
    const parsed = JSON.parse(readFileSync(join(scriptsDir, sidecar!), 'utf8'));
    expect(parsed.decision).toBe('warn');
    expect(parsed.tier).toBe(3);
    expect(parsed.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleRunProject: security policy pre-flight scan + session gate
// ---------------------------------------------------------------------------

describe('handleRunProject security pre-flight', () => {
  function makeProjectWithAutoload(prefix: string, autoloadGd: string): string {
    const dir = tmp.makeProject(
      prefix,
      'config_version=5\n\n[application]\n[autoload]\nMyAuto="res://auto.gd"\n',
    );
    writeFileSync(join(dir, 'auto.gd'), autoloadGd, 'utf8');
    return dir;
  }

  it('attaches autoload Tier 1 findings as warnings in non-strict mode', async () => {
    const dir = makeProjectWithAutoload(
      'run-project-autoload-tier1-',
      'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, acceptingContext());
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.warnings?.some((w) => /OS\.execute/.test(w))).toBe(true);
    expect(Object.keys(payload)[0]).toBe('warnings');
  });

  it('strict mode hard-rejects when autoload contains Tier 1 primitives', async () => {
    const dir = makeProjectWithAutoload(
      'run-project-strict-tier1-',
      'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      acceptingContext({ strict: true }),
    );
    expectErrorMatching(result, /Strict mode: refusing to launch/);
    // Bridge must NOT be reached.
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('GODOT_MCP_DISABLE_SECURITY: launches with no pre-flight scan and no session-confirmation elicitation', async () => {
    const dir = makeProjectWithAutoload(
      'run-project-disable-security-',
      'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let elicitCalls = 0;
    const countingElicitor: Elicitor = async () => {
      elicitCalls++;
      return { action: 'accept', content: { confirm: true } };
    };
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: countingElicitor, disableSecurity: true }),
    );
    expect(hasError(result)).toBe(false);
    expect(elicitCalls).toBe(0);
    expect(runProjectPayload(result).warnings).toBeUndefined();
  });

  it("skips this server's own bridge autoload so a relaunch does not self-reject", async () => {
    // The injected bridge stays registered between a launch and its cleanup,
    // and it writes screenshots: so it matches the filesystem-write rules.
    const dir = tmp.makeProject(
      'run-project-own-bridge-',
      'config_version=5\n\n[application]\n[autoload]\n' +
        'McpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"\n',
    );
    mkdirSync(join(dir, '.mcp', 'godot-runtime', 'bridge'), { recursive: true });
    writeFileSync(
      join(dir, '.mcp', 'godot-runtime', 'bridge', 'mcp_bridge.gd'),
      'extends Node\nfunc _shot(image, p):\n' +
        '\tDirAccess.make_dir_recursive_absolute("res://.mcp")\n' +
        '\timage.save_png(p)\n',
      'utf8',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      acceptingContext({ strict: true }),
    );
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).not.toMatch(/save_png/);
    expect(warnings).not.toMatch(/make_dir_recursive_absolute/);
  });

  it('still scans an McpBridge autoload pointing at a path the server does not own', async () => {
    const dir = tmp.makeProject(
      'run-project-foreign-bridge-',
      'config_version=5\n\n[application]\n[autoload]\nMcpBridge="*res://game/mcp_bridge.gd"\n',
    );
    mkdirSync(join(dir, 'game'), { recursive: true });
    writeFileSync(
      join(dir, 'game', 'mcp_bridge.gd'),
      'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n',
      'utf8',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      acceptingContext({ strict: true }),
    );
    expectErrorMatching(result, /Strict mode: refusing to launch/);
  });

  it('strict mode allows launch when only Tier 3 findings present', async () => {
    const dir = makeProjectWithAutoload(
      'run-project-strict-tier3-',
      'extends Node\nfunc _ready():\n\tload("res://main.tscn")\n',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      acceptingContext({ strict: true }),
    );
    expect(hasError(result)).toBe(false);
  });

  it('skips scene-script scan and records a warning when no main_scene configured', async () => {
    const dir = tmp.makeProject('run-project-no-scene-', 'config_version=5\n\n[application]\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, acceptingContext());
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).toMatch(/No launchable scene found/);
  });

  it('session gate elicits once and skips on subsequent calls', async () => {
    const dir = tmp.makeProject('run-project-gate-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let elicitCount = 0;
    const counting: Elicitor = async () => {
      elicitCount++;
      return { action: 'accept', content: { confirm: true } };
    };
    const ctx = makeContext({ elicit: counting });
    await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    expect(elicitCount).toBe(1);
  });

  it('session gate decline blocks the launch', async () => {
    const dir = tmp.makeProject('run-project-gate-decline-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: declineElicitor }),
    );
    expectErrorMatching(result, /User declined run_project/);
  });

  it('session gate cancel blocks the launch but reports a distinct message from decline', async () => {
    const dir = tmp.makeProject('run-project-gate-cancel-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: cancelElicitor }),
    );
    // A `cancel` action is distinguished from an explicit `decline` and hints
    // at the Claude Desktop auto-cancel parity gap plus the opt-out flag.
    expectErrorMatching(result, /cancelled without an explicit choice/);
    const rendered = unwrap(result)
      .content.map((c: { text: string }) => c.text)
      .join('\n');
    expect(rendered).toMatch(/GODOT_MCP_DISABLE_ELICITATION/);
  });

  it('session gate is skipped when elicitation is disabled (GODOT_MCP_DISABLE_ELICITATION)', async () => {
    const dir = tmp.makeProject('run-project-gate-noelicit-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    // declineElicitor would block if consulted; disableElicitation must bypass it entirely.
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: declineElicitor, disableElicitation: true }),
    );
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).toMatch(/Elicitation disabled \(GODOT_MCP_DISABLE_ELICITATION\)/);
    expect(warnings).toMatch(/launching without user confirmation/);
  });

  it('session gate blocks the launch when accept carries content.confirm:false', async () => {
    const dir = tmp.makeProject('run-project-gate-confirmfalse-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: confirmFalseElicitor }),
    );
    expectErrorMatching(result, /User declined run_project/);
  });

  it('strict mode refuses launch when elicitor throws (no silent fallback)', async () => {
    const dir = tmp.makeProject('run-project-strict-elicitor-throw-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: throwingElicitor, strict: true }),
    );
    expectErrorMatching(result, /Elicitation unavailable/);
    expectErrorMatching(result, /strict mode refuses to launch/);
  });

  it('non-strict mode auto-accepts and launches when elicitor throws, warning in the response', async () => {
    const dir = tmp.makeProject('run-project-nonstrict-elicitor-throw-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir },
      makeContext({ elicit: throwingElicitor, strict: false }),
    );
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).toMatch(/Elicitation unavailable/);
    expect(warnings).toMatch(/launching without explicit user confirmation/);
  });

  it('scans the launched scene resolved from run/main_scene', async () => {
    const dir = tmp.makeProject(
      'run-project-main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(
      join(dir, 'attack.gd'),
      'extends Node\nfunc _ready():\n\tOS.execute("x")\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://attack.gd" id="1"]\n\n[node name="Main" type="Node2D"]\n',
      'utf8',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, acceptingContext());
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).toMatch(/attack\.gd:3.*OS\.execute/);
  });

  it('explicit scene arg overrides main_scene during scan', async () => {
    const dir = tmp.makeProject(
      'run-project-explicit-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(join(dir, 'clean.gd'), 'extends Node\n', 'utf8');
    writeFileSync(join(dir, 'attack.gd'), 'extends Node\n\tOS.execute("x")\n', 'utf8');
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://attack.gd" id="1"]\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'other.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://clean.gd" id="1"]\n',
      'utf8',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    // Explicit `other.tscn` should be scanned, NOT main.tscn: so no OS.execute warning.
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir, scene: 'other.tscn' },
      acceptingContext(),
    );
    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleRunProject: attach mode (attach: true)
// ---------------------------------------------------------------------------

describe('handleRunProject attach mode', () => {
  const PINNED_BRIDGE_PORT = 12345;
  const CONFLICTING_SERVER_PID = 4242;
  const TIER1_AUTOLOAD = 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n';

  function makeProjectWithAutoload(prefix: string, autoloadGd: string): string {
    const dir = tmp.makeProject(
      prefix,
      'config_version=5\n\n[application]\n[autoload]\nMyAuto="res://auto.gd"\n',
    );
    writeFileSync(join(dir, 'auto.gd'), autoloadGd, 'utf8');
    return dir;
  }

  /** A context whose elicitor counts its calls and would decline if consulted. */
  function decliningCountingContext(opts: { strict?: boolean; disableSecurity?: boolean } = {}): {
    ctx: McpContext;
    elicitCalls: () => number;
  } {
    let calls = 0;
    const elicit: Elicitor = async () => {
      calls++;
      return { action: 'decline' };
    };
    return { ctx: makeContext({ elicit, ...opts }), elicitCalls: () => calls };
  }

  it('reaches the attach path with no spawn and no Godot executable', async () => {
    const fake = createRuntimeFake();
    // godotPath stays empty: attach mode launches nothing, so it never needs one.
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
      bridgePort: PINNED_BRIDGE_PORT,
    });
    expect(hasError(result)).toBe(false);
    expect(fake.attachProjectCalls()).toBe(1);
    expect(fake.runProjectCalls()).toBe(0);
    const payload = runProjectPayload(result);
    expect(payload.sessionMode).toBe('attached');
    expect(payload.bridgePort).toBe(PINNED_BRIDGE_PORT);
  });

  it.each([
    ['scene', 'main.tscn'],
    ['background', true],
    ['profiling', true],
  ])('rejects the spawn-only parameter %s instead of ignoring it', async (param, value) => {
    const fake = createRuntimeFake();
    const { ctx, elicitCalls } = decliningCountingContext();
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, attach: true, [param]: value },
      ctx,
    );
    expectErrorMatching(result, new RegExp(`"${param}" applies only to a spawned session`));
    expect(fake.attachProjectCalls()).toBe(0);
    expect(fake.runProjectCalls()).toBe(0);
    expect(elicitCalls()).toBe(0);
  });

  it('accepts background: false and profiling: false, which are what attach mode does', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
      background: false,
      profiling: false,
    });
    expect(hasError(result)).toBe(false);
    expect(fake.attachProjectCalls()).toBe(1);
  });

  it('rejects a non-boolean attach', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: 'yes',
    });
    expectErrorMatching(result, /attach must be a boolean/);
    expect(fake.attachProjectCalls()).toBe(0);
    expect(fake.runProjectCalls()).toBe(0);
  });

  it('runs the pre-flight scan and never asks for the launch confirmation', async () => {
    const dir = makeProjectWithAutoload('attach-autoload-tier1-', TIER1_AUTOLOAD);
    const fake = createRuntimeFake();
    const { ctx, elicitCalls } = decliningCountingContext();
    const result = await handleRunProject(fake.asRunner, { projectPath: dir, attach: true }, ctx);
    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings?.some((w) => /OS\.execute/.test(w))).toBe(true);
    expect(elicitCalls()).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
  });

  it('scans the scripts of run/main_scene', async () => {
    const dir = tmp.makeProject(
      'attach-main-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(
      join(dir, 'attack.gd'),
      'extends Node\nfunc _ready():\n\tOS.execute("x")\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://attack.gd" id="1"]\n\n[node name="Main" type="Node2D"]\n',
      'utf8',
    );
    const fake = createRuntimeFake();
    const { ctx } = decliningCountingContext();
    const result = await handleRunProject(fake.asRunner, { projectPath: dir, attach: true }, ctx);
    expect(hasError(result)).toBe(false);
    const warnings = (runProjectPayload(result).warnings ?? []).join('\n');
    expect(warnings).toMatch(/attack\.gd:3.*OS\.execute/);
  });

  it('strict mode refuses before injecting when an autoload contains Tier 1 primitives', async () => {
    const dir = makeProjectWithAutoload('attach-strict-tier1-', TIER1_AUTOLOAD);
    const fake = createRuntimeFake();
    const { ctx } = decliningCountingContext({ strict: true });
    const result = await handleRunProject(fake.asRunner, { projectPath: dir, attach: true }, ctx);
    expectErrorMatching(result, /Strict mode: refusing to launch/);
    expect(fake.attachProjectCalls()).toBe(0);
  });

  it('GODOT_MCP_DISABLE_SECURITY: attaches with no scan and no elicitation', async () => {
    const dir = makeProjectWithAutoload('attach-disable-security-', TIER1_AUTOLOAD);
    const fake = createRuntimeFake();
    const { ctx, elicitCalls } = decliningCountingContext({ disableSecurity: true });
    const result = await handleRunProject(fake.asRunner, { projectPath: dir, attach: true }, ctx);
    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings).toBeUndefined();
    expect(elicitCalls()).toBe(0);
    expect(fake.attachProjectCalls()).toBe(1);
  });

  it('rejects missing projectPath', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, { attach: true });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, { projectPath: '../evil', attach: true });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, { projectPath: '/ghost', attach: true });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns "bridge is not ready" error and tears down when bridge wait fails', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeReady(false, 'attach timeout');
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });
    expectErrorMatching(result, /bridge is not ready/);
    expect(fake.stopCalls()).toBe(1);
  });

  it('names the assigned bridge port in the not-ready solutions, read before the teardown clears it', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeReady(false, 'attach timeout');
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
      bridgePort: PINNED_BRIDGE_PORT,
    });
    expectErrorMatching(result, /bridge is not ready/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain(`bridge port (${PINNED_BRIDGE_PORT})`);
    expect(solutionsText).not.toContain('null');
  });

  it.each([0, 65536, 8080.5])('rejects the out-of-range bridgePort %s', async (port) => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
      bridgePort: port,
    });
    expectErrorMatching(result, /Invalid bridgePort/);
    expect(fake.attachProjectCalls()).toBe(0);
  });

  it('reports the missing-autoload diagnosis when the entry never made it in', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeReady(false, 'attach timeout');
    fake.setBridgeAutoloadRegistered(false);
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });
    expectErrorMatching(result, /project\.godot has no McpBridge autoload entry/);
    expect(fake.stopCalls()).toBe(1);
  });

  it('refuses a second attach session on the project, naming the other server and stop_project', async () => {
    const fake = createRuntimeFake();
    fake.setAttachProjectError(
      new BridgeAttachConflictError(
        `Another MCP session (server pid ${CONFLICTING_SERVER_PID}, attached mode) is already attached to this project.`,
        {
          pid: CONFLICTING_SERVER_PID,
          instanceId: 'other-instance',
          hostname: 'other-host',
          mode: 'attached',
          startedAt: new Date(0).toISOString(),
          port: PINNED_BRIDGE_PORT,
        },
      ),
    );
    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });
    expectErrorMatching(result, /Failed to attach project/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain(String(CONFLICTING_SERVER_PID));
    expect(solutionsText).toMatch(/stop_project/);
  });
});

// ---------------------------------------------------------------------------
// run_project: the success payload against its declared outputSchema
// ---------------------------------------------------------------------------

describe('run_project outputSchema', () => {
  const runProjectDef = runtimeToolDefinitions.find((t) => t.name === 'run_project');
  if (!runProjectDef || !('outputSchema' in runProjectDef)) {
    throw new Error('run_project outputSchema not found');
  }
  const validate = new Ajv({ strict: false }).compile(runProjectDef.outputSchema as object);

  function expectValid(payload: unknown): void {
    const valid = validate(payload);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  }

  it('validates a spawn success payload with no warnings', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      makeContext({ disableSecurity: true }),
    );
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.warnings).toBeUndefined();
    expectValid(payload);
  });

  it('validates a spawn success payload that carries warnings', async () => {
    const dir = tmp.makeProject('run-project-schema-warnings-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, acceptingContext());
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.warnings?.length).toBeGreaterThan(0);
    expectValid(payload);
  });

  it('validates an attach success payload', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, attach: true },
      makeContext({ disableSecurity: true }),
    );
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.sessionMode).toBe('attached');
    expectValid(payload);
  });

  // A session that ended in the gap between the readiness check and the port
  // read has no port because there is no session. That is not a success.
  it('run_project is an error when the session ended as the bridge became ready', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeWaitHook(() => {
      fake.asRunner.activeBridgePort = null;
    });
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      makeContext({ disableSecurity: true }),
    );
    expectErrorMatching(result, /session ended as the bridge became ready; no session is running/);
    expect(fake.stopCalls()).toBe(1);
  });

  it('run_project with attach: true is an error when the session ended as the bridge became ready', async () => {
    const fake = createRuntimeFake();
    fake.setBridgeWaitHook(() => {
      fake.asRunner.activeBridgePort = null;
    });
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, attach: true },
      makeContext({ disableSecurity: true }),
    );
    expectErrorMatching(result, /session ended as the bridge became ready; no session is running/);
    expect(fake.stopCalls()).toBe(1);
  });

  it('rejects a payload whose bridgePort is null', () => {
    expect(
      validate({
        projectPath: fixtureProjectPath,
        sessionMode: 'spawned',
        bridgePort: null,
        message: 'Godot project started and the MCP bridge is ready.',
      }),
    ).toBe(false);
  });

  it('rejects a payload missing sessionMode', () => {
    expect(
      validate({
        projectPath: fixtureProjectPath,
        bridgePort: 19900,
        message: 'Godot project started and the MCP bridge is ready.',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleTakeScreenshot: bridge response shape branches
// ---------------------------------------------------------------------------

describe('handleTakeScreenshot bridge response shapes', () => {
  let fake: RuntimeFake;
  let projectPath: string;
  let screenshotDir: string;

  beforeEach(() => {
    projectPath = tmp.make('mcp-project-');
    screenshotDir = screenshotsDir(projectPath);
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

  function parseMetadata(result: unknown) {
    const textContent = unwrap(result).content.filter((entry) => entry.type === 'text');
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
    expect(unwrap(result).content[0]).toMatchObject({
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

  it('names the session project in the payload', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, width: 1280, height: 720 }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    expect(parseMetadata(result).projectPath).toBe(projectPath);
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
    expect(unwrap(result).content[0]).toMatchObject({
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
    expect(unwrap(result).content[0]).toMatchObject({
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
    expect(unwrap(result).content.some((entry) => entry.type === 'image')).toBe(false);
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

  it('refuses to read a bridge path outside .mcp/godot-runtime/screenshots/', async () => {
    fake.setBridgeResponse(JSON.stringify({ path: '/etc/passwd' }));
    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });
    expectErrorMatching(result, /outside \.mcp\/godot-runtime\/screenshots\//i);
  });

  it('refuses to read a bridge preview_path outside .mcp/godot-runtime/screenshots/', async () => {
    const screenshotPath = writeScreenshot('screenshot.png');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, preview_path: '/etc/passwd' }));
    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'preview' });
    expectErrorMatching(result, /preview path outside \.mcp\/godot-runtime\/screenshots\//i);
  });
});

// ---------------------------------------------------------------------------
// handleTakeScreenshot: pixel statistics
// ---------------------------------------------------------------------------

describe('handleTakeScreenshot pixel stats', () => {
  const screenshotDef = runtimeToolDefinitions.find((t) => t.name === 'take_screenshot');
  if (!screenshotDef || !('outputSchema' in screenshotDef)) {
    throw new Error('take_screenshot outputSchema not found');
  }
  const validate = new Ajv({ strict: false }).compile(screenshotDef.outputSchema as object);

  const BLACK: readonly [number, number, number, number] = [0, 0, 0, 255];
  const FOUR_BY_FOUR = 4;
  const TWO_BY_TWO = 2;
  const MIXED_FRAME_CHROMATIC = 0.75;

  let fake: RuntimeFake;
  let projectPath: string;
  let screenshotDir: string;

  beforeEach(() => {
    projectPath = tmp.make('mcp-project-');
    screenshotDir = screenshotsDir(projectPath);
    mkdirSync(screenshotDir, { recursive: true });
    fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath,
      process: makeRunningProcess(),
    });
  });

  function writeFile(name: string, content: Buffer | string): string {
    const path = join(screenshotDir, name);
    writeFileSync(path, content);
    return path;
  }

  function blackPng(): Buffer {
    return encodePng(FOUR_BY_FOUR, FOUR_BY_FOUR, solidRgba(FOUR_BY_FOUR, FOUR_BY_FOUR, BLACK));
  }

  function payloadOf(result: unknown): Record<string, unknown> {
    return unwrap(result).structuredContent as unknown as Record<string, unknown>;
  }

  function expectValid(payload: unknown): void {
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  }

  it.each(['full', 'preview', 'path_only'])('returns measured stats in %s mode', async (mode) => {
    const screenshotPath = writeFile('screenshot.png', blackPng());
    const bridgeResponse: Record<string, unknown> = {
      path: screenshotPath,
      width: FOUR_BY_FOUR,
      height: FOUR_BY_FOUR,
    };
    if (mode === 'preview') {
      bridgeResponse.preview_path = writeFile('preview.png', 'not a png');
      bridgeResponse.preview_width = FOUR_BY_FOUR;
      bridgeResponse.preview_height = FOUR_BY_FOUR;
    }
    fake.setBridgeResponse(JSON.stringify(bridgeResponse));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: mode });

    expect(hasError(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload.stats).toEqual({
      width: FOUR_BY_FOUR,
      height: FOUR_BY_FOUR,
      chromatic: 0,
      dominant: 1,
      distinct: 1,
      likelyBlank: true,
    });
    expect('warnings' in payload).toBe(false);
    expectValid(payload);
  });

  it('reports a rendered frame as not blank', async () => {
    const data = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const screenshotPath = writeFile('screenshot.png', encodePng(TWO_BY_TWO, TWO_BY_TWO, data));
    fake.setBridgeResponse(
      JSON.stringify({ path: screenshotPath, width: TWO_BY_TWO, height: TWO_BY_TWO }),
    );

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    const stats = payloadOf(result).stats as { likelyBlank: boolean; chromatic: number };
    expect(stats.likelyBlank).toBe(false);
    expect(stats.chromatic).toBe(MIXED_FRAME_CHROMATIC);
  });

  it('returns stats null with a leading warning when the saved PNG is corrupt', async () => {
    const screenshotPath = writeFile('screenshot.png', 'these bytes are not a png');
    const previewPath = writeFile('preview.png', 'preview-image');
    fake.setBridgeResponse(
      JSON.stringify({
        path: screenshotPath,
        preview_path: previewPath,
        width: FOUR_BY_FOUR,
        height: FOUR_BY_FOUR,
      }),
    );

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'preview' });

    expect(hasError(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload.stats).toBeNull();
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toMatch(
      /^Pixel stats were not measured: could not decode the PNG/,
    );
    expect(unwrap(result).content.some((entry) => entry.type === 'image')).toBe(true);
    expectValid(payload);
  });

  it('returns stats null with a leading warning when the saved PNG cannot be read', async () => {
    const directoryPath = join(screenshotDir, 'not-a-file.png');
    mkdirSync(directoryPath);
    fake.setBridgeResponse(JSON.stringify({ path: directoryPath }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload.stats).toBeNull();
    expect((payload.warnings as string[])[0]).toMatch(/could not read the PNG file/);
    expectValid(payload);
  });

  it('puts the stats warning ahead of runtime errors', async () => {
    const screenshotPath = writeFile('screenshot.png', 'these bytes are not a png');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath }), ['SCRIPT ERROR: boom']);

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    const warnings = payloadOf(result).warnings as string[];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Pixel stats were not measured: /);
    expect(warnings[1]).toContain('SCRIPT ERROR: boom');
  });

  it('leads with runtime errors when stats were measured', async () => {
    const screenshotPath = writeFile('screenshot.png', blackPng());
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath }), ['SCRIPT ERROR: boom']);

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    const payload = payloadOf(result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.stats).not.toBeNull();
    expectValid(payload);
  });
});

// ---------------------------------------------------------------------------
// Reads of the fields the auto-clear nulls
// ---------------------------------------------------------------------------

describe('session auto-clear interactions', () => {
  it('take_screenshot errors instead of resolving a null project path', async () => {
    const projectPath = tmp.make('mcp-autoclear-');
    const dir = screenshotsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const shot = join(dir, 'shot.png');
    writeFileSync(shot, 'png-data', 'utf8');

    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ path: shot, width: 1, height: 1 }));
    // The process exits while the screenshot command is in flight: the auto-clear nulls
    // activeProjectPath, and the containment check runs after the await.
    fake.setBridgeHook(() => {
      fake.setSession({
        mode: null,
        projectPath: null,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    });

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });
    expectErrorMatching(result, /session ended before the screenshot path/i);
  });

  it('run_project restarts after an auto-cleared session without double-cleaning', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setSession({
      mode: null,
      projectPath: null,
      process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
    });

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    expect(hasError(result)).toBe(false);
    expect(fake.asRunner.activeSessionMode).toBe('spawned');
    // The exit handler already cleaned this session up; nothing re-stops it.
    expect(fake.stopCalls()).toBe(0);
  });
});
