import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type { ResolvedProjectPath } from '../../../src/utils/path-validation.js';
import {
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  computeInputTimeoutMs,
  MAX_INPUT_BATCH_BUDGET_MS,
  PREVIEW_MAX_HEIGHT_LIMIT,
  PREVIEW_MAX_WIDTH_LIMIT,
  SCREENSHOT_INLINE_MAX_BYTES,
  handleGetUiElements,
  handleRunScript,
  handleRunProject,
  handleLaunchEditor,
  runtimeToolDefinitions,
} from '../../../src/tools/runtime-tools.js';
import { MAX_RUNTIME_TIMEOUT_MS } from '../../../src/utils/session-report.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { encodePng, solidRgba } from '../../helpers/png-fixtures.js';
import { screenshotsDir } from '../../../src/utils/artifact-paths.js';
import {
  BridgeAttachConflictError,
  BridgeRegistryUnreadableError,
} from '../../../src/utils/bridge-manager.js';
import {
  SessionStoppedError,
  StartBudgetExhaustedError,
  type AttachedProbeOutcome,
  type BridgeWaitResult,
  type GodotRunner,
  type GodotProcess,
  type RuntimeSessionInfo,
  type RuntimeSessionMode,
  type RuntimeStopResult,
} from '../../../src/utils/godot-runner.js';
import {
  NON_FINITE_COUNT_FIELD,
  OVERSIZE_RESPONSE_FIELD,
} from '../../../src/utils/bridge-protocol.js';
import { SessionQueueTimeoutError } from '../../../src/utils/session-queue.js';
import { projectPathKey } from '../../../src/utils/output-parsing.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { useTmpDirs } from '../../helpers/tmp.js';
import { fakeSessionApi } from '../../helpers/fake-sessions.js';
import { ElicitationUnsupportedError } from '../../../src/utils/mcp-context.js';
import type { Elicitor, McpContext } from '../../../src/utils/mcp-context.js';

/** Accepts every confirmation prompt, so a script goes to the bridge. */
const scriptCtx = makeContext();

// handleRunProject checks for a display before the launch confirmation; satisfy it on Linux CI (no X server).
let savedDisplay: string | undefined;
let displayWasSet = false;
beforeAll(() => {
  savedDisplay = process.env.DISPLAY;
  displayWasSet =
    process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (displayWasSet) process.env.DISPLAY = ':0';
});
afterAll(() => {
  if (!displayWasSet) return;
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
});

/** Test context with the given elicitor; the default accepts every prompt (the launch and the run_script confirmations). */
function makeContext(
  opts: {
    elicit?: Elicitor;
    disableElicitation?: boolean;
  } = {},
): McpContext {
  const defaultElicit: Elicitor = async () => ({
    action: 'accept',
    content: { confirm: true },
  });
  return {
    elicitor: opts.elicit ?? defaultElicit,
    disableElicitation: opts.disableElicitation === true,
    sessionState: { runProjectConfirmed: new Set<string>(), runScriptConfirmed: new Set<string>() },
  };
}

const acceptingContext = makeContext;
const declineElicitor: Elicitor = async () => ({ action: 'decline' });
const cancelElicitor: Elicitor = async () => ({ action: 'cancel' });
const confirmFalseElicitor: Elicitor = async () => ({
  action: 'accept',
  content: { confirm: false },
});
/** A client that did not declare the elicitation capability. */
const unsupportedElicitor: Elicitor = async () => {
  throw new ElicitationUnsupportedError();
};
/** A client that can prompt and never answered: the request timed out. */
const unansweredElicitor: Elicitor = async () => {
  throw new Error('Request timed out');
};

/** Pid of a game whose kill the fake reports as unconfirmed. */
const UNCONFIRMED_KILL_PID = 31337;
/** Side and color of the small valid PNG used where a screenshot has to decode. */
const INLINE_PNG_SIDE = 4;
const INLINE_PNG_COLOR = [10, 120, 200, 255] as const;
/** One-frame waits: 100 ms a frame, twice per action (wait and settle), passes the batch ceiling on count alone. */
const ACTIONS_PAST_BUDGET = 3000;
/** How long the fake says a caller waited before the session queue gave up on it. */
const QUEUE_WAITED_MS = 30000;
/** What a start that got its turn late reports: how long it waited, and what was left. */
const LATE_START_WAITED_MS = 29000;
const LATE_START_REMAINING_MS = 4000;

/** Every text block of a response, joined: the message and its solutions. */
function allText(result: unknown): string {
  return unwrap(result)
    .content.map((block) => block.text ?? '')
    .join('\n');
}

interface BridgeCall {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

interface RuntimeFake {
  asRunner: GodotRunner;
  bridgeCalls: BridgeCall[];
  stopCalls(): number;
  runProjectCalls(): number;
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
  /** Stands in for the boundary-sentinel attribution the real runner derives from stderr; defaults to no errors and no drain timeout. */
  setActionErrorBuckets(buckets: string[][], trailing?: string[], timedOut?: boolean): void;
  /** Models BridgeManager.isBridgeAutoloadRegistered for the bridge-not-ready
   *  timeout diagnostic. Defaults to true (autoload present). */
  setBridgeAutoloadRegistered(registered: boolean): void;
  /** What the started session's profiler says about its debugger stream. */
  setProfilerStreamProblem(problem: string | null): void;
  /** Makes every wait for the session queue give up, as if the named call
   *  held it. Null (the default): the queue is free. */
  setQueueBusyBehind(label: string | null): void;
  /** The call got its turn after waiting `waitedMs` behind `behind`. Null (the default): no wait. */
  setQueueWait(waitedMs: number | null, behind?: string): void;
  /** Makes attachProject report that this server's live attached session on
   *  the project was kept, listening on `port`. Null (the default): a fresh attach. */
  setAlreadyAttached(port: number | null): void;
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
  let lastRunProjectScene: ResolvedProjectPath | undefined;
  let attachProjectCallCount = 0;
  let actionErrorBuckets: string[][] = [];
  let actionErrorTrailing: string[] = [];
  let actionSentinelTimedOut = false;
  let queueBusyBehind: string | null = null;
  let queueWait: { waitedMs: number; behind: string } | null = null;
  let profilerStreamProblem: string | null = null;
  let alreadyAttachedPort: number | null = null;
  // Defaults model a healthy inject; tests override via setBridgeAutoloadRegistered / setOtherLiveOwners.
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
    // The session queue: one operation at a time. The fake runs the
    // operation at once, or fails the wait the way a busy queue does.
    async runExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
      if (queueBusyBehind !== null) {
        throw new SessionQueueTimeoutError(label, queueBusyBehind, QUEUE_WAITED_MS);
      }
      return operation();
    },
    queueTurn() {
      return queueWait === null
        ? null
        : { requestedAt: 0, waitedMs: queueWait.waitedMs, behind: queueWait.behind };
    },
    // The record a start created, read back through its reference. The fake
    // has one session, so the reference is its project path.
    describeSessionRef(ref: { projectPath: string }): RuntimeSessionInfo {
      // By project first, so a test that overrides getSessionInfo is seen;
      // a record whose game exited reports no path, so fall back to current.
      const info = fake.getSessionInfo(ref.projectPath) ?? fake.getCurrentSessionInfo();
      return {
        projectPath: ref.projectPath,
        mode: null,
        live: false,
        current: false,
        processExited: false,
        exitCode: null,
        hasRetainedLogs: false,
        profiling: false,
        ...(info ?? {}),
        bridgePort: fake.activeBridgePort,
      };
    },
    profilerStreamProblemFor(_ref: unknown): string | null {
      return profilerStreamProblem;
    },
    recentErrorsFor(_ref: unknown, count: number): string[] {
      return fake.getRecentErrors(count);
    },
    stopSessionRef(_ref: unknown) {
      return fake.stopProject();
    },
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
      // Bridge-failure paths tear down the session before returning; reset mode/project/port to mirror the real stopProject.
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
      scene?: ResolvedProjectPath,
      _background?: boolean,
      bridgePort?: number,
    ) {
      runProjectCallCount++;
      lastRunProjectScene = scene;
      if (runProjectError) throw runProjectError;
      state.activeSessionMode = 'spawned';
      state.activeProjectPath = projectPath;
      state.activeProcess = makeRunningProcess();
      fake.activeBridgePort = bridgePort ?? 19900;
      if (runProjectAfterHook) runProjectAfterHook(projectPath);
      return { projectPath };
    },
    async attachProject(projectPath: string, bridgePort?: number) {
      attachProjectCallCount++;
      if (attachProjectError) throw attachProjectError;
      if (alreadyAttachedPort !== null) {
        // The runner kept its live attached session: nothing new was baked.
        state.activeSessionMode = 'attached';
        state.activeProjectPath = projectPath;
        fake.activeBridgePort = alreadyAttachedPort;
        return { session: { projectPath }, alreadyAttached: true };
      }
      state.activeSessionMode = 'attached';
      state.activeProjectPath = projectPath;
      fake.activeBridgePort = bridgePort ?? 19901;
      return { session: { projectPath }, alreadyAttached: false };
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
    lastRunProjectScene() {
      return lastRunProjectScene;
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
    setProfilerStreamProblem(problem) {
      profilerStreamProblem = problem;
    },
    setBridgeAutoloadRegistered(registered) {
      bridgeAutoloadRegistered = registered;
    },
    setQueueBusyBehind(label) {
      queueBusyBehind = label;
    },
    setQueueWait(waitedMs, behind = 'run_project') {
      queueWait = waitedMs === null ? null : { waitedMs, behind };
    },
    setAlreadyAttached(port) {
      alreadyAttachedPort = port;
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

  it('never asks for confirmation when no Godot executable can be resolved', async () => {
    const fake = createRuntimeFake();
    let prompts = 0;
    const countingElicitor: Elicitor = async () => {
      prompts++;
      return { action: 'accept', content: { confirm: true } };
    };
    const ctx = makeContext({ elicit: countingElicitor });
    const result = await handleRunProject(fake.asRunner, { projectPath: fixtureProjectPath }, ctx);
    expectErrorMatching(result, /Could not find a valid Godot executable path/);
    expect(prompts).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
  });

  it('never asks for confirmation when no display is available', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    let prompts = 0;
    const countingElicitor: Elicitor = async () => {
      prompts++;
      return { action: 'accept', content: { confirm: true } };
    };
    const ctx = makeContext({ elicit: countingElicitor });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const { DISPLAY, WAYLAND_DISPLAY } = process.env;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const result = await handleRunProject(
        fake.asRunner,
        { projectPath: fixtureProjectPath },
        ctx,
      );
      expectErrorMatching(result, /No display server available/);
      const solutionsText = unwrap(result).content[1]?.text ?? '';
      expect(solutionsText).toMatch(/attach: true/);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (DISPLAY !== undefined) process.env.DISPLAY = DISPLAY;
      if (WAYLAND_DISPLAY !== undefined) process.env.WAYLAND_DISPLAY = WAYLAND_DISPLAY;
    }
    expect(prompts).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
    expect(fake.runProjectCalls()).toBe(0);
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

  it('names an unreadable owner registry and tells the caller to retry', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setRunProjectError(
      new BridgeRegistryUnreadableError('cannot read owners/1-a.json: EBUSY'),
    );
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /bridge owner registry could not be read: cannot read owners/);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toMatch(/Retry run_project/);
    expect(solutionsText).not.toMatch(/GODOT_PATH/);
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

describe('handleRunProject with profiling and an unreadable debugger stream', () => {
  const STREAM_PROBLEM = 'Godot sent 3 debugger message(s) and none could be read';

  async function startWith(args: Record<string, unknown>, problem: string | null) {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    fake.setProfilerStreamProblem(problem);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, ...args },
      acceptingContext(),
    );
    return expectMatchesOutputSchema('run_project', result);
  }

  it('leads the payload with the stream problem', async () => {
    const payload = await startWith({ profiling: true }, STREAM_PROBLEM);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toBe(STREAM_PROBLEM);
  });

  it('adds nothing while the stream has no problem to report', async () => {
    const payload = await startWith({ profiling: true }, null);
    expect(payload).not.toHaveProperty('warnings');
  });

  it('does not ask a session started without profiling', async () => {
    const payload = await startWith({}, STREAM_PROBLEM);
    expect(payload).not.toHaveProperty('warnings');
  });
});

describe('handleRunProject over an attached session on the same project', () => {
  const REPLACED_ATTACH_PORT = 24680;

  /** Make the fake report what the runner records when a spawn replaces an attached session. */
  function reportReplacedAttached(fake: RuntimeFake, shutdownAcknowledged: boolean): void {
    const runner = fake.asRunner as unknown as {
      getSessionInfo: (projectPath: string) => unknown;
    };
    const original = runner.getSessionInfo.bind(runner);
    runner.getSessionInfo = (projectPath: string) => ({
      ...(original(projectPath) as object),
      replacedAttached: { bridgePort: REPLACED_ATTACH_PORT, shutdownAcknowledged },
    });
  }

  it('says the attached session was detached and leads with a warning when its bridge did not acknowledge', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    reportReplacedAttached(fake, false);

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    const warning = (payload.warnings as string[])[0]!;
    expect(warning).toContain('did not acknowledge shutdown');
    expect(warning).toContain(`bridge port ${REPLACED_ATTACH_PORT}`);
    expect(payload.message as string).toContain('attached session on the project was detached');
  });

  it('carries no warning when the replaced bridge acknowledged, and still says it was detached', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    reportReplacedAttached(fake, true);

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.message as string).toContain('attached session on the project was detached');
  });

  it('says so on a failed start too', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'timeout after 5s');
    reportReplacedAttached(fake, false);

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    expectErrorMatching(result, /attached session on the project was detached/);
    expectErrorMatching(result, /did not acknowledge shutdown/);
  });

  it('says nothing about an attached session when none was replaced', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.message as string).not.toContain('attached session');
  });
});

describe('handleRunProject bridge failure paths', () => {
  const PINNED_SPAWN_BRIDGE_PORT = 23456;

  it('returns "exited before MCP bridge could initialize" error when process exits during wait', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'process gone');
    // Mark the process exited so the handler takes the process-exited branch, not the timeout branch.
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
    // Nothing cleared this session (it still has a mode: the process never
    // started), so the handler tears it down and says the logs are gone.
    expect(fake.stopCalls()).toBe(1);
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).toContain('get_debug_output has nothing more');
  });

  it('keeps the logs of a game that exited by itself during startup, and a retry needs no stop_project', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(false, 'Process exited with code 1 before bridge was ready.');
    // The state the runner's own exit handler leaves: mode cleared, process
    // retained with its logs.
    const crashed = makeRunningProcess({ hasExited: true, exitCode: 1 });
    crashed.errors.push('SCRIPT ERROR: startup crash');
    fake.setRunProjectAfterHook(() => {
      fake.setSession({ mode: null, projectPath: null, process: crashed });
    });

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    expectErrorMatching(result, /exited before the MCP bridge could initialize/);
    expect(fake.stopCalls()).toBe(0);
    expect(unwrap(result).content[1]?.text ?? '').toContain('Call get_debug_output');
    const logs = handleGetDebugOutput(fake.asRunner, {});
    expect(hasError(logs)).toBe(false);
    expect(JSON.parse(unwrap(logs).content[0]!.text!).errors).toContain(
      'SCRIPT ERROR: startup crash',
    );

    fake.setBridgeReady(true);
    fake.setRunProjectAfterHook(null);
    const retry = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expect(hasError(retry)).toBe(false);
    expect(fake.stopCalls()).toBe(0);
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
    fake.setBridgeResponse(JSON.stringify({ error: 'irrelevant' }));
    await handleTakeScreenshot(fake.asRunner, {});
    expect(fake.bridgeCalls).toHaveLength(1);
  });
});

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

  it.each([
    [
      'Forward+/Mobile',
      "ERROR: Tried capturing more timestamps than the configured maximum (256). You can increase this limit in the project settings under 'Debug/Settings' called 'Max Timestamp Query Elements'.",
      '   at: capture_timestamp (servers/rendering/rendering_device.cpp:8705)',
    ],
    [
      'Compatibility',
      'ERROR: Condition "frames[frame].timestamp_count >= max_timestamp_query_elements" is true.',
      '   at: capture_timestamp (drivers/gles3/storage/utilities.cpp:330)',
    ],
  ])(
    'explains render timestamp overflow errors (%s) as a profiling side effect',
    (_renderer, error, at) => {
      const fake = createRuntimeFake();
      fake.setSession({
        mode: 'spawned',
        projectPath: '/p',
        process: makeRunningProcess({ errors: [error, at] }),
      });

      const parsed = JSON.parse(unwrap(handleGetDebugOutput(fake.asRunner, {})).content[0].text);
      expect(parsed.tip).toMatch(/not from the game/);
      expect(parsed.tip).toMatch(/earlier lines out of this log/);
      expect(parsed.tip).toMatch(/max_timestamp_query_elements=4096/);
      expect(parsed.tip).toMatch(/Compatibility/);
    },
  );

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

  it('returns isError when no session was active, and says no follow-up is needed', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult(null);
    const result = await handleStopProject(fake.asRunner);
    expectErrorMatching(result, /Nothing to stop: no runtime session is current/);
    const solutions = unwrap(result).content[1]?.text ?? '';
    expect(solutions).toContain('No follow-up is needed');
    // Nothing is running, so nothing sends the caller off to start a project.
    expect(solutions).not.toContain('run_project');
  });

  it('leads with a warning naming the pid when the kill was not confirmed', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      projectPath: '/p',
      output: [],
      errors: [],
      killUnconfirmed: true,
      pid: UNCONFIRMED_KILL_PID,
    });

    const result = await handleStopProject(fake.asRunner);

    const payload = expectMatchesOutputSchema('stop_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toContain(`pid ${UNCONFIRMED_KILL_PID}`);
    expect((payload.warnings as string[])[0]).toMatch(/may still be running/);
    expect(payload.killUnconfirmed).toBe(true);
    expect(payload.pid).toBe(UNCONFIRMED_KILL_PID);
    // The message reports a kill that was sent, not a stop that was seen.
    expect(payload.message as string).not.toMatch(/^Godot project stopped/);
    expect(payload.message as string).toContain('did not report its exit');
  });

  it('carries no killUnconfirmed field for a stop whose exit was observed', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({ mode: 'spawned', projectPath: '/p', output: [], errors: [] });

    const payload = expectMatchesOutputSchema(
      'stop_project',
      await handleStopProject(fake.asRunner),
    );

    expect(payload).not.toHaveProperty('killUnconfirmed');
    expect(payload).not.toHaveProperty('pid');
    expect(payload).not.toHaveProperty('warnings');
  });

  // A stop never queues: a wedged script or a long input batch can hold the
  // queue for minutes, and the game has to be stoppable meanwhile.
  it('stops at once while another call holds the session queue', async () => {
    const fake = createRuntimeFake();
    fake.setQueueBusyBehind('simulate_input');
    fake.setStopResult({ mode: 'spawned', projectPath: '/p', output: [], errors: [] });

    const result = await handleStopProject(fake.asRunner);

    const payload = expectMatchesOutputSchema('stop_project', result);
    expect(payload.message).toBe('Godot project stopped');
    expect(fake.stopCalls()).toBe(1);
  });

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
    // Every line is filtered, so this reaches the fallback: a bare 'Metal 4.0 - Forward+'
    // would survive the banner pattern.
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

const TIMEOUT_BUFFER_MS = 10000;
/** Mirrors INPUT_PESSIMISTIC_FRAME_MS: a 10 fps floor, not a frame-rate guess. */
const PESSIMISTIC_FRAME_MS = 100;

describe('handleStopProject on a record that holds only a finished profiler capture', () => {
  it('reports the release as a success with null logs and a leading warning', async () => {
    const fake = createRuntimeFake();
    fake.setStopResult({
      mode: 'spawned',
      projectPath: '/p',
      output: null,
      errors: null,
      alreadyExited: true,
      cleanupProblems: [],
      releasedCaptureOnly: true,
    });

    const result = await handleStopProject(fake.asRunner);

    expect(hasError(result)).toBe(false);
    const payload = expectMatchesOutputSchema('stop_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toMatch(
      /finalOutput and finalErrors are null, not empty/,
    );
    expect(payload.projectPath).toBe('/p');
    expect(payload.message).toMatch(/Released the finished profiler capture/);
    expect(payload.sessionMode).toBe('spawned');
    expect(payload.alreadyExited).toBe(true);
    expect(payload.externalProcessPreserved).toBe(false);
    expect(payload.finalOutput).toBeNull();
    expect(payload.finalErrors).toBeNull();
    expect(payload).not.toHaveProperty('exitCode');
  });
});

describe('a bridge frame missing what its command always sends is an error, not an empty success', () => {
  const VALID_SCRIPT = 'extends RefCounted\nfunc execute(scene_tree):\n\treturn 1\n';

  function activeSession(response: unknown): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify(response));
    return fake;
  }

  it('simulate_input: a frame with no results array', async () => {
    const fake = activeSession({ success: true });
    const result = await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', ms: 1 }] });
    expectErrorMatching(result, /Invalid response from bridge \(simulate_input\)/);
    expectErrorMatching(result, /what was injected is not known/);
  });

  it('simulate_input: a results entry that is not an object', async () => {
    const fake = activeSession({ success: true, results: [{ index: 0, type: 'wait' }, 'oops'] });
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [
        { type: 'wait', ms: 1 },
        { type: 'wait', ms: 1 },
      ],
    });
    expectErrorMatching(result, /Invalid response from bridge \(simulate_input\)/);
  });

  // The bridge sends this instead of a reply that passed the frame limit, after the actions ran.
  // Its flat `error` must not be read as the pre-validation refusal (fix the batch and resend).
  it('simulate_input: an oversize reply says the batch ran, never that nothing was injected', async () => {
    const fake = activeSession({
      error:
        'The response is 20000000 bytes, over the 16777216 byte frame limit, and was not sent.',
      [OVERSIZE_RESPONSE_FIELD]: true,
    });

    const result = await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', ms: 1 }] });

    expectErrorMatching(result, /The batch ran: its actions were injected and are not undone/);
    expectErrorMatching(result, /too large to deliver: The response is 20000000 bytes/);
    const text = allText(result);
    expect(text).toContain('Do not resend the batch');
    expect(text).not.toContain('nothing was injected');
    expect(text).not.toContain('resend the batch -');
  });

  it('simulate_input: a flat error without the oversize mark is still the refusal that injected nothing', async () => {
    const fake = activeSession({ error: 'action 0 (key): unknown key name' });

    const result = await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', ms: 1 }] });

    expectErrorMatching(result, /Input simulation error: action 0 \(key\): unknown key name/);
    expect(allText(result)).toContain('nothing was injected');
  });

  // Red when the handler stops naming the Controls whose rect came back with a
  // null number, or the schema stops admitting null there.
  it('get_ui_elements leads with the Controls whose rect is not finite', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    const sound = { name: 'Ok', path: '/root/Ok', type: 'Button', visible: true };
    const broken = { name: 'Bad', path: '/root/Bad', type: 'Label', visible: true };
    fake.setBridgeResponse(
      JSON.stringify({
        elements: [
          { ...sound, rect: { x: 1, y: 2, width: 30, height: 40 } },
          { ...broken, rect: { x: null, y: 2, width: 30, height: null } },
        ],
      }),
      ['SCRIPT ERROR: seen during the read'],
    );
    const payload = expectMatchesOutputSchema(
      'get_ui_elements',
      await handleGetUiElements(fake.asRunner, {}),
    );
    expect(payload.warnings).toEqual([
      '1 Control(s) have a non-finite position or size (INF, NAN), so those rect numbers are null: /root/Bad',
      'SCRIPT ERROR: seen during the read',
    ]);
    const elements = payload.elements as Array<{ rect: Record<string, unknown> }>;
    expect(elements[1]?.rect).toEqual({ x: null, y: 2, width: 30, height: null });
  });

  it('get_ui_elements with every rect finite carries no warning', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeResponse(
      JSON.stringify({
        elements: [{ name: 'Ok', path: '/root/Ok', rect: { x: 0, y: 0, width: 0, height: 0 } }],
      }),
    );
    const payload = expectMatchesOutputSchema(
      'get_ui_elements',
      await handleGetUiElements(fake.asRunner, {}),
    );
    expect(payload).not.toHaveProperty('warnings');
  });

  it('get_ui_elements: a frame with no elements array', async () => {
    const fake = activeSession({ status: 'ok' });
    const result = await handleGetUiElements(fake.asRunner, {});
    expectErrorMatching(result, /Invalid response from bridge \(get_ui_elements\)/);
  });

  it('run_script: a frame with neither success nor an error', async () => {
    const dir = tmp.makeProject('run-script-bad-frame-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: dir, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ result: 5 }));
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    expectErrorMatching(result, /Invalid response from bridge \(run_script\)/);
    expectErrorMatching(result, /not known whether the script ran/);
  });

  it('run_script: an invalid timeout is refused before the prompt or the send', async () => {
    const dir = tmp.makeProject('run-script-bad-timeout-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: dir, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }));
    const result = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT, timeout: 'soon' },
      scriptCtx,
    );
    expectErrorMatching(result, /timeout must be a finite number/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });
});

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
    // hold_ms stays explicit across the three variants: omitting it with no `pressed` field reclassifies
    // the action as a tap and adds INPUT_TAP_HOLD_FRAMES. Only wait.ms/wait.frames vary.
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
    // normalizeParameters does not recurse into arrays: per-action snake_case fields
    // (hold_ms, relative_x, double_click) must reach the bridge frame unrewritten.
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
    // Exact key set, not absence assertions: catches any new top-level field without a schema entry.
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

  it('forwards root to the bridge unchanged and omits it when not provided', async () => {
    const fake = setupActive();
    await handleGetUiElements(fake.asRunner, { root: '/root/InputProbe/FreeMe' });
    expect(fake.bridgeCalls[0].params).toEqual({
      visible_only: true,
      root: '/root/InputProbe/FreeMe',
    });
    await handleGetUiElements(fake.asRunner, {});
    expect(fake.bridgeCalls[1].params).not.toHaveProperty('root');
  });

  it('rejects a root that is not a string before anything is sent', async () => {
    const fake = setupActive();
    const result = await handleGetUiElements(fake.asRunner, { root: 7 });
    expect(hasError(result)).toBe(true);
    expect(fake.bridgeCalls).toHaveLength(0);
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
      await handleRunScript(fake.asRunner, { script: '' }, scriptCtx),
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
      await handleRunScript(
        fake.asRunner,
        { script: 'extends RefCounted\n# no execute\n' },
        scriptCtx,
      ),
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
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
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
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed).not.toHaveProperty('success');
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
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    expect(hasError(result)).toBe(false);
  });

  // An attached session captures no stderr, so a script that raised and one
  // that returned null are the same frame. The payload has to say so.
  it('run_script in an attached session leads with a warning when the result is null', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: dir });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
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
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(payload).not.toHaveProperty('warnings');
    expect(payload.result).toBe(7);
    // get_debug_output captures nothing in an attached session, so the tip
    // must not send the caller there for print() output.
    expect(payload.tip as string).toContain('get_debug_output has nothing to show');
  });

  it('points a spawned session at get_debug_output for print() output', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: dir, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 7 }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(payload.tip as string).toContain('get_debug_output to review print() output');
  });

  // The mode is the one captured at the gate: read after the await it is null once the game exited,
  // and a script that raised on its way out would read as a plain success.
  it('still reports a runtime error when the spawned game exits while the script is in flight', async () => {
    const dir = tmp.makeProject('run-script-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: dir, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: null }), [
      'SCRIPT ERROR: raised on the way out',
    ]);
    fake.setBridgeHook(() => {
      fake.setSession({
        mode: null,
        projectPath: null,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    });

    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);

    expectErrorMatching(result, /Script runtime error detected[\s\S]*raised on the way out/);
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
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.result).toBe(42);
    expect(parsed.warnings).toEqual(['SCRIPT ERROR: stale ref']);
    expect(Object.keys(parsed)[0]).toBe('warnings');
  });

  // Asserts the raw Result shape, not via `unwrap`, which tolerates a raw ToolResponse and would mask
  // a regression to the old return type.
  it('returns the Result<HandlerResult, ToolResponse> shape on success', async () => {
    const dir = tmp.makeProject('run-script-result-shape-');
    const fake = createRuntimeFake();
    fake.setSession({
      mode: 'spawned',
      projectPath: dir,
      process: makeRunningProcess(),
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, scriptCtx);
    expect(result).toHaveProperty('ok', true);
    expect((result as { ok: true; value: { content: unknown } }).value).toHaveProperty('content');
  });
});

describe('handleRunScript confirmation', () => {
  const VALID_SCRIPT = 'extends RefCounted\nfunc execute(scene_tree):\n\treturn null\n';
  const OS_EXECUTE_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree):\n\tOS.execute("rm", ["-rf", "/"])\n\treturn 0\n';
  /** Where 3.x kept a `.gd` copy and a `.policy.json` per script. */
  const SCRIPT_COPY_DIR_NAME = 'scripts';
  const SCRIPT_PROMPT_START = 'run_script will run GDScript written by the agent';
  const DECLINED_SCRIPT_ADVICE = 'do not call run_script on this project again';

  function activeFake(dir: string, mode: RuntimeSessionMode = 'spawned'): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({
      mode,
      projectPath: dir,
      process: mode === 'spawned' ? makeRunningProcess() : null,
    });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    return fake;
  }

  /** An elicitor that accepts and records every message it was shown. */
  function recordingElicitor(): { elicit: Elicitor; messages: string[] } {
    const messages: string[] = [];
    const elicit: Elicitor = async (request) => {
      messages.push(request.message);
      return { action: 'accept', content: { confirm: true } };
    };
    return { elicit, messages };
  }

  // Breaks when the confirmed set is not consulted (a second call prompts again) or never filled, or when the prompt text stops naming the project and the permissions.
  it('prompts on the first call on a project and not on the second', async () => {
    const dir = tmp.makeProject('run-script-once-');
    const fake = activeFake(dir);
    const { elicit, messages } = recordingElicitor();
    const ctx = makeContext({ elicit });

    const first = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);
    const second = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(hasError(first)).toBe(false);
    expect(hasError(second)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      `${SCRIPT_PROMPT_START} inside the running game at ${resolve(dir)}`,
    );
    expect(messages[0]).toContain('runs with your user permissions');
    expect(fake.bridgeCalls).toHaveLength(2);
  });

  // Breaks when a decline is read as an accept, when the refusal stops saying the script was not run, or when the advice not to retry goes.
  it('refuses a decline with no bridge command sent, and tells the agent not to retry', async () => {
    const dir = tmp.makeProject('run-script-decline-');
    const fake = activeFake(dir);

    const result = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT },
      makeContext({ elicit: declineElicitor }),
    );

    expectErrorMatching(result, /User declined run_script\. The script was not run\./);
    expect(unwrap(result).content[1]?.text ?? '').toContain(DECLINED_SCRIPT_ADVICE);
    expect(unwrap(result).content[1]?.text ?? '').not.toContain('GODOT_MCP_DISABLE_ELICITATION');
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when an accept whose confirm is false is let through.
  it('refuses an accept that carries confirm: false', async () => {
    const dir = tmp.makeProject('run-script-confirmfalse-');
    const fake = activeFake(dir);

    const result = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT },
      makeContext({ elicit: confirmFalseElicitor }),
    );

    expectErrorMatching(result, /User declined run_script/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when a cancel is worded as a decline, or when its refusal stops naming the opt-out flag.
  it('refuses a cancel apart from a decline and names the opt-out', async () => {
    const dir = tmp.makeProject('run-script-cancel-');
    const fake = activeFake(dir);

    const result = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT },
      makeContext({ elicit: cancelElicitor }),
    );

    expectErrorMatching(
      result,
      /run_script confirmation was cancelled without an explicit choice[\s\S]*The script was not run\./,
    );
    expect(unwrap(result).content[0]?.text ?? '').not.toContain('User declined');
    expect(unwrap(result).content[1]?.text ?? '').toContain('GODOT_MCP_DISABLE_ELICITATION=true');
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when an elicitor throw other than the unsupported-client error is read as an accept, or worded as a missing capability.
  it('refuses when the prompt went unanswered, and prompts again on the next call', async () => {
    const dir = tmp.makeProject('run-script-unanswered-');
    const fake = activeFake(dir);
    let prompts = 0;
    const ctx = makeContext({
      elicit: async (request) => {
        prompts++;
        return unansweredElicitor(request);
      },
    });

    const first = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);
    const second = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expectErrorMatching(
      first,
      /run_script confirmation was not answered \(Request timed out\)\. The script was not run\./,
    );
    expect(JSON.stringify(first)).not.toMatch(/does not support elicitation/);
    expect(hasError(second)).toBe(true);
    expect(prompts).toBe(2);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when an unsupported client is refused (no fail-open), when its warning repeats, or when it is asked again.
  it('runs with one warning for a client that cannot be asked, and does not ask again', async () => {
    const dir = tmp.makeProject('run-script-unsupported-');
    const fake = activeFake(dir);
    let prompts = 0;
    const ctx = makeContext({
      elicit: async (request) => {
        prompts++;
        return unsupportedElicitor(request);
      },
    });

    const first = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);
    const second = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(hasError(first)).toBe(false);
    const warnings = (JSON.parse(unwrap(first).content[0].text) as { warnings?: string[] })
      .warnings;
    expect(warnings).toEqual([
      'Elicitation unavailable (the client does not support elicitation); running the script without explicit user confirmation.',
    ]);
    expect(JSON.parse(unwrap(second).content[0].text)).not.toHaveProperty('warnings');
    expect(prompts).toBe(1);
    expect(fake.bridgeCalls).toHaveLength(2);
  });

  // Breaks when disableElicitation stops skipping the prompt (the throwing elicitor is called), or when its one warning repeats.
  it('runs with one warning under disableElicitation, and does not ask later', async () => {
    const dir = tmp.makeProject('run-script-noelicit-');
    const fake = activeFake(dir);
    const ctx = makeContext({
      disableElicitation: true,
      elicit: async () => {
        throw new Error('the prompt must not be shown');
      },
    });

    const first = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);
    const second = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(hasError(first)).toBe(false);
    const warnings = (JSON.parse(unwrap(first).content[0].text) as { warnings?: string[] })
      .warnings;
    expect(warnings).toEqual([
      'Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION); running the script without user confirmation.',
    ]);
    expect(JSON.parse(unwrap(second).content[0].text)).not.toHaveProperty('warnings');
    expect(fake.bridgeCalls).toHaveLength(2);
  });

  // Breaks when the confirmed set is keyed by anything but the project, so one accept covers another project.
  it('prompts again for a second project', async () => {
    const first = tmp.makeProject('run-script-project-a-');
    const second = tmp.makeProject('run-script-project-b-');
    const fake = activeFake(first);
    const { elicit, messages } = recordingElicitor();
    const ctx = makeContext({ elicit });

    await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);
    fake.setSession({ mode: 'spawned', projectPath: second, process: makeRunningProcess() });
    await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(resolve(first));
    expect(messages[1]).toContain(resolve(second));
  });

  // Breaks when run_script shares the launch confirmation's set, so a run_project accept admits a script.
  it('still prompts on a project already confirmed for run_project', async () => {
    const dir = tmp.makeProject('run-script-after-launch-');
    const fake = activeFake(dir);
    const { elicit, messages } = recordingElicitor();
    const ctx = makeContext({ elicit });
    ctx.sessionState.runProjectConfirmed.add(projectPathKey(resolve(dir)));

    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(hasError(result)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(SCRIPT_PROMPT_START);
  });

  // Breaks when an attached session is exempted from the script prompt: it never prompts at launch, so this is its only one.
  it('prompts on an attached session', async () => {
    const dir = tmp.makeProject('run-script-attached-');
    const fake = activeFake(dir, 'attached');
    const { elicit, messages } = recordingElicitor();
    const ctx = makeContext({ elicit });

    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT }, ctx);

    expect(hasError(result)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(fake.bridgeCalls).toHaveLength(1);
  });

  // Breaks when a declined attached session runs the script anyway.
  it('refuses a decline on an attached session', async () => {
    const dir = tmp.makeProject('run-script-attached-decline-');
    const fake = activeFake(dir, 'attached');

    const result = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT },
      makeContext({ elicit: declineElicitor }),
    );

    expectErrorMatching(result, /User declined run_script/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when the default context stops declining, so a handler called without one runs code unasked.
  it('declines under the default null context', async () => {
    const dir = tmp.makeProject('run-script-nullctx-');
    const fake = activeFake(dir);

    const result = await handleRunScript(fake.asRunner, { script: VALID_SCRIPT });

    expectErrorMatching(result, /User declined run_script/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Breaks when a pre-send scan or policy comes back: the script is blocked or flagged, or a copy or sidecar is written.
  it('sends a script calling OS.execute after an accept, with no scan warning and nothing written under scripts/', async () => {
    const dir = tmp.makeProject('run-script-os-execute-');
    const fake = activeFake(dir);

    const result = await handleRunScript(
      fake.asRunner,
      { script: OS_EXECUTE_SCRIPT },
      makeContext(),
    );

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
    expect(fake.bridgeCalls[0]?.params.source).toBe(OS_EXECUTE_SCRIPT);
    expect(JSON.parse(unwrap(result).content[0].text)).not.toHaveProperty('warnings');
    expect(existsSync(join(dir, '.mcp', 'godot-runtime', SCRIPT_COPY_DIR_NAME))).toBe(false);
  });

  // Breaks when the prompt moves ahead of the cheap argument checks, so a call that cannot be sent asks a human.
  it('asks nothing for a script missing func execute or with an unusable timeout', async () => {
    const dir = tmp.makeProject('run-script-no-prompt-');
    const fake = activeFake(dir);
    const { elicit, messages } = recordingElicitor();
    const ctx = makeContext({ elicit });

    const noExecute = await handleRunScript(
      fake.asRunner,
      { script: 'extends RefCounted\n# no execute\n' },
      ctx,
    );
    const badTimeout = await handleRunScript(
      fake.asRunner,
      { script: VALID_SCRIPT, timeout: 'soon' },
      ctx,
    );

    expect(hasError(noExecute)).toBe(true);
    expect(hasError(badTimeout)).toBe(true);
    expect(messages).toHaveLength(0);
    expect(ctx.sessionState.runScriptConfirmed.size).toBe(0);
  });
});

describe('handleRunProject launch confirmation', () => {
  const OS_EXECUTE_AUTOLOAD = 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n';

  function makeProjectWithAutoload(prefix: string, autoloadGd: string): string {
    const dir = tmp.makeProject(
      prefix,
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nMyAuto="res://auto.gd"\n',
    );
    writeFileSync(join(dir, 'auto.gd'), autoloadGd, 'utf8');
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    return dir;
  }

  // Breaks when a second launch of the project asks again, when the message names a finding or scan, or when it stops naming the project and the permissions.
  it('asks once per project with a message that names no findings', async () => {
    const dir = makeProjectWithAutoload('run-project-message-', OS_EXECUTE_AUTOLOAD);
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const messages: string[] = [];
    const ctx = makeContext({
      elicit: async (request) => {
        messages.push(request.message);
        return { action: 'accept', content: { confirm: true } };
      },
    });

    await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`run_project will start the Godot project at ${resolve(dir)}`);
    expect(messages[0]).toContain('run with your user permissions');
    expect(messages[0]).not.toMatch(/finding|tier|scan|OS\.execute/i);
  });

  // Breaks when a pre-launch scan of the project's scripts comes back: the autoload is read, flagged, or blocks the launch.
  it('launches a project whose autoload calls OS.execute with no scan warning', async () => {
    const dir = makeProjectWithAutoload('run-project-autoload-execute-', OS_EXECUTE_AUTOLOAD);
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);

    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, makeContext());

    expect(hasError(result)).toBe(false);
    expect(fake.runProjectCalls()).toBe(1);
    expect(runProjectPayload(result).warnings).toBeUndefined();
  });

  // Breaks when a launch with no main scene and no scene argument gains a scan notice, or is refused.
  it('launches a project with no main scene and no warning', async () => {
    const dir = tmp.makeProject('run-project-no-scene-', 'config_version=5\n\n[application]\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);

    const result = await handleRunProject(fake.asRunner, { projectPath: dir }, makeContext());

    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings).toBeUndefined();
  });

  // Breaks when an unsupported client is refused (the old strict branch), when its warning repeats, or when it is asked again.
  it('launches with one warning when the client lacks elicitation, and does not ask again', async () => {
    const dir = tmp.makeProject('run-project-unsupported-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let prompts = 0;
    const ctx = makeContext({
      elicit: async (request) => {
        prompts++;
        return unsupportedElicitor(request);
      },
    });

    const first = await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    const second = await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);

    expect(hasError(first)).toBe(false);
    expect(runProjectPayload(first).warnings).toEqual([
      'Elicitation unavailable (the client does not support elicitation); launching without explicit user confirmation.',
    ]);
    expect(runProjectPayload(second).warnings).toBeUndefined();
    expect(prompts).toBe(1);
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

  // Breaks when an elicitor throw other than the unsupported-client error is read as an accept, or recorded so the next call does not ask.
  it('refuses the launch when the prompt went unanswered, and prompts again on the next call', async () => {
    const dir = tmp.makeProject(
      'run-project-elicitor-timeout-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let prompts = 0;
    const ctx = makeContext({
      elicit: async () => {
        prompts++;
        return unansweredElicitor({
          message: '',
          requestedSchema: { type: 'object', properties: {} },
        });
      },
    });
    const first = await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    expectErrorMatching(first, /run_project confirmation was not answered \(Request timed out\)/);
    expectErrorMatching(first, /The project was not launched/);
    expect(fake.runProjectCalls()).toBe(0);
    const second = await handleRunProject(fake.asRunner, { projectPath: dir }, ctx);
    expect(hasError(second)).toBe(true);
    expect(prompts).toBe(2);
  });

  it.each([
    ['res://', () => 'res://other.tscn'],
    ['absolute', (dir: string) => join(dir, 'other.tscn')],
  ])('accepts a %s scene and launches that file', async (_label, spell) => {
    const dir = tmp.makeProject(
      'run-project-scene-spelling-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(join(dir, 'main.tscn'), '[gd_scene format=3]\n');
    writeFileSync(join(dir, 'other.tscn'), '[gd_scene format=3]\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir, scene: spell(dir) },
      acceptingContext(),
    );
    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings).toBeUndefined();
    expect(fake.lastRunProjectScene()?.resPath).toBe('res://other.tscn');
  });

  // The engine runs a positional argument as the scene only when it ends in a scene extension;
  // otherwise run/main_scene launches instead of the scene named.
  it.each([
    ['a file that is not a scene', 'icon.svg'],
    ['a scene path with its extension forgotten', 'scenes/level'],
    ['an upper-case extension, which the engine does not match', 'Other.TSCN'],
  ])('refuses %s as scene before the prompt and the launch', async (_label, scene) => {
    const dir = tmp.makeProject(
      'run-project-not-a-scene-',
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(join(dir, 'main.tscn'), '[gd_scene format=3]\n');
    writeFileSync(join(dir, scene.replace('scenes/', '')), 'not a scene');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let elicitCalls = 0;
    const counting: Elicitor = async () => {
      elicitCalls++;
      return { action: 'accept', content: { confirm: true } };
    };

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: dir, scene },
      makeContext({ elicit: counting }),
    );

    expectErrorMatching(result, /does not end in \.tscn, \.scn, \.escn, \.tres, \.res/);
    expectErrorMatching(result, /main scene runs instead/);
    expect(elicitCalls).toBe(0);
    expect(fake.runProjectCalls()).toBe(0);
  });

  // Breaks when a resource or binary scene extension is refused again, or launches with a not-scanned notice.
  it.each(['other.tres', 'other.res', 'other.escn', 'level.scn'])(
    'launches %s as the scene with no warning',
    async (scene) => {
      const dir = tmp.makeProject('run-project-resource-scene-', 'config_version=5\n');
      writeFileSync(join(dir, scene), 'not read');
      const fake = createRuntimeFake();
      fake.setGodotPath('/usr/bin/godot');
      fake.setBridgeReady(true);

      const result = await handleRunProject(
        fake.asRunner,
        { projectPath: dir, scene },
        acceptingContext(),
      );

      expect(hasError(result)).toBe(false);
      expect(runProjectPayload(result).warnings).toBeUndefined();
      expect(fake.runProjectCalls()).toBe(1);
    },
  );

  // A launch that cannot happen must never ask for confirmation, and must not
  // leave the project recorded as confirmed.
  it.each([
    ['an out-of-range bridgePort', { bridgePort: 70000 }, /Invalid bridgePort/],
    ['a non-boolean background', { background: 'yes' }, /background must be a boolean/],
    ['a non-boolean profiling', { profiling: 1 }, /profiling must be a boolean/],
  ])('rejects %s before the confirmation prompt', async (_label, extra, pattern) => {
    const dir = tmp.makeProject('run-project-args-before-gate-', 'config_version=5\n');
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setBridgeReady(true);
    let elicitCalls = 0;
    const counting: Elicitor = async () => {
      elicitCalls++;
      return { action: 'accept', content: { confirm: true } };
    };
    const ctx = makeContext({ elicit: counting });

    const result = await handleRunProject(fake.asRunner, { projectPath: dir, ...extra }, ctx);

    expectErrorMatching(result, pattern);
    expect(elicitCalls).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
    expect(fake.runProjectCalls()).toBe(0);
  });
});

describe('handleRunProject attach mode', () => {
  const PINNED_BRIDGE_PORT = 12345;
  const CONFLICTING_SERVER_PID = 4242;
  const OS_EXECUTE_AUTOLOAD = 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n';

  function makeProjectWithAutoload(prefix: string, autoloadGd: string): string {
    const dir = tmp.makeProject(
      prefix,
      'config_version=5\n\n[application]\n[autoload]\nMyAuto="res://auto.gd"\n',
    );
    writeFileSync(join(dir, 'auto.gd'), autoloadGd, 'utf8');
    return dir;
  }

  /** A context whose elicitor counts its calls and would decline if consulted. */
  function decliningCountingContext(): {
    ctx: McpContext;
    elicitCalls: () => number;
  } {
    let calls = 0;
    const elicit: Elicitor = async () => {
      calls++;
      return { action: 'decline' };
    };
    return { ctx: makeContext({ elicit }), elicitCalls: () => calls };
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

  // Breaks when attach asks the launch confirmation (it spawns nothing), or when a scan notice for the autoload comes back.
  it('asks no launch confirmation and reports no scan warning for an autoload calling OS.execute', async () => {
    const dir = makeProjectWithAutoload('attach-autoload-execute-', OS_EXECUTE_AUTOLOAD);
    const fake = createRuntimeFake();
    const { ctx, elicitCalls } = decliningCountingContext();
    const result = await handleRunProject(fake.asRunner, { projectPath: dir, attach: true }, ctx);
    expect(hasError(result)).toBe(false);
    expect(runProjectPayload(result).warnings).toBeUndefined();
    expect(elicitCalls()).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
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
    // The teardown removed the bridge and a retry bakes a new token, so the
    // advice must not say a Godot launched meanwhile can simply be retried on.
    const solutionsText = unwrap(result).content[1]?.text ?? '';
    expect(solutionsText).not.toContain('idempotent');
    expect(solutionsText).toContain('launch Godot while that call is waiting');
    expect(solutionsText).toContain('the token changes with every attach');
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
      makeContext(),
    );
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.warnings).toBeUndefined();
    expectValid(payload);
  });

  it('validates a spawn success payload that carries warnings', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      makeContext({ disableElicitation: true }),
    );
    expect(hasError(result)).toBe(false);
    const payload = runProjectPayload(result);
    expect(payload.warnings).toEqual([
      'Elicitation disabled (GODOT_MCP_DISABLE_ELICITATION); launching without user confirmation.',
    ]);
    expectValid(payload);
  });

  it('validates an attach success payload', async () => {
    const fake = createRuntimeFake();
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath, attach: true },
      makeContext(),
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
      makeContext(),
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
      makeContext(),
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
    const png = encodePng(
      INLINE_PNG_SIDE,
      INLINE_PNG_SIDE,
      solidRgba(INLINE_PNG_SIDE, INLINE_PNG_SIDE, INLINE_PNG_COLOR),
    );
    const screenshotPath = join(screenshotDir, 'screenshot.png');
    writeFileSync(screenshotPath, png);
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, width: 1280, height: 720 }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'full' });

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls[0]).toMatchObject({
      command: 'screenshot',
      params: {},
    });
    expect(unwrap(result).content[0]).toMatchObject({
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    expect(parseMetadata(result)).toMatchObject({
      responseMode: 'full',
      path: screenshotPath,
      size: { width: 1280, height: 720 },
    });
  });

  it('does not inline a full screenshot that is not a decodable PNG, and leads with why', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'not a png at all');
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, width: 1280, height: 720 }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'full' });

    expect(hasError(result)).toBe(false);
    expect(unwrap(result).content.some((entry) => entry.type === 'image')).toBe(false);
    const metadata = parseMetadata(result);
    expect(Object.keys(metadata)[0]).toBe('warnings');
    expect(metadata.stats).toBeNull();
    expect((metadata.warnings as string[]).join('\n')).toMatch(
      /not returned inline: the saved file could not be decoded as a PNG/,
    );
    expect(metadata.path).toBe(screenshotPath);
  });

  it('does not inline a full screenshot over the inline byte limit, and still returns its path and stats', async () => {
    const png = encodePng(
      INLINE_PNG_SIDE,
      INLINE_PNG_SIDE,
      solidRgba(INLINE_PNG_SIDE, INLINE_PNG_SIDE, INLINE_PNG_COLOR),
    );
    // A valid PNG followed by padding: decoders stop at IEND, the file size does not.
    const oversize = Buffer.concat([png, Buffer.alloc(SCREENSHOT_INLINE_MAX_BYTES)]);
    const screenshotPath = join(screenshotDir, 'screenshot.png');
    writeFileSync(screenshotPath, oversize);
    fake.setBridgeResponse(JSON.stringify({ path: screenshotPath, width: 1280, height: 720 }));

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'full' });

    expect(hasError(result)).toBe(false);
    expect(unwrap(result).content.some((entry) => entry.type === 'image')).toBe(false);
    const metadata = parseMetadata(result);
    expect(Object.keys(metadata)[0]).toBe('warnings');
    expect((metadata.warnings as string[])[0]).toContain(
      `over the ${SCREENSHOT_INLINE_MAX_BYTES} byte inline limit`,
    );
    expect((metadata.warnings as string[])[0]).toContain('responseMode "preview"');
    expect(metadata.path).toBe(screenshotPath);
    expect(metadata.stats).not.toBeNull();
  });

  it('does not inline a preview over the inline byte limit', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    const previewPath = join(screenshotDir, 'preview.png');
    writeFileSync(previewPath, Buffer.alloc(SCREENSHOT_INLINE_MAX_BYTES + 1));
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
    expect(unwrap(result).content.some((entry) => entry.type === 'image')).toBe(false);
    const warnings = parseMetadata(result).warnings as string[];
    expect(
      warnings.some((warning) => warning.startsWith('The preview was not returned inline')),
    ).toBe(true);
    expect(parseMetadata(result).previewPath).toBe(previewPath);
  });

  it('clamps preview bounds above the limit instead of passing them to the game', async () => {
    const screenshotPath = writeScreenshot('screenshot.png', 'full-image');
    const previewPath = writeScreenshot('preview.png', 'preview-image');
    fake.setBridgeResponse(
      JSON.stringify({
        path: screenshotPath,
        preview_path: previewPath,
        width: 3840,
        height: 2160,
        preview_width: PREVIEW_MAX_WIDTH_LIMIT,
        preview_height: PREVIEW_MAX_HEIGHT_LIMIT,
      }),
    );

    await handleTakeScreenshot(fake.asRunner, {
      previewMaxWidth: PREVIEW_MAX_WIDTH_LIMIT * 10,
      previewMaxHeight: PREVIEW_MAX_HEIGHT_LIMIT * 10,
    });

    expect(fake.bridgeCalls[0]?.params).toEqual({
      preview_max_width: PREVIEW_MAX_WIDTH_LIMIT,
      preview_max_height: PREVIEW_MAX_HEIGHT_LIMIT,
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

describe('session auto-clear interactions', () => {
  it('take_screenshot validates the path against the session captured at the gate when the game exits mid-call', async () => {
    const projectPath = tmp.make('mcp-autoclear-');
    const dir = screenshotsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const shot = join(dir, 'shot.png');
    writeFileSync(shot, 'png-data', 'utf8');

    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ path: shot, width: 1, height: 1 }));
    // The process exits mid-screenshot: the auto-clear nulls activeProjectPath before the containment check,
    // but the bridge answered, so the saved file is this session's screenshot.
    fake.setBridgeHook(() => {
      fake.setSession({
        mode: null,
        projectPath: null,
        process: makeRunningProcess({ hasExited: true, exitCode: 1 }),
      });
    });

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });
    expect(hasError(result)).toBe(false);
    const payload = JSON.parse(unwrap(result).content[0]!.text!) as Record<string, unknown>;
    expect(payload.projectPath).toBe(projectPath);
    expect(payload.path).toBe(shot);
  });

  it('take_screenshot never validates against a session that became current after the gate', async () => {
    const gateProject = tmp.make('mcp-gate-');
    const otherProject = tmp.make('mcp-other-');
    const otherDir = screenshotsDir(otherProject);
    mkdirSync(otherDir, { recursive: true });
    const otherShot = join(otherDir, 'shot.png');
    writeFileSync(otherShot, 'png-data', 'utf8');

    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: gateProject, process: makeRunningProcess() });
    // A path under another project's screenshots directory, and that project
    // is the current one by the time the answer is read.
    fake.setBridgeResponse(JSON.stringify({ path: otherShot, width: 1, height: 1 }));
    fake.setBridgeHook(() => {
      fake.setSession({
        mode: 'spawned',
        projectPath: otherProject,
        process: makeRunningProcess(),
      });
    });

    const result = await handleTakeScreenshot(fake.asRunner, { responseMode: 'path_only' });
    expectErrorMatching(result, /outside \.mcp\/godot-runtime\/screenshots\//);
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
    expect(fake.stopCalls()).toBe(0);
  });
});

describe('a stop that lands on a runtime call or a start', () => {
  /** Replace what the fake's bridge wait reports. */
  function setBridgeWait(fake: RuntimeFake, result: BridgeWaitResult): void {
    const runner = fake.asRunner as unknown as {
      waitForBridge: () => Promise<BridgeWaitResult>;
      waitForBridgeAttached: () => Promise<BridgeWaitResult>;
    };
    runner.waitForBridge = async () => result;
    runner.waitForBridgeAttached = async () => result;
  }

  const STOPPED_WAIT: BridgeWaitResult = {
    ready: false,
    stopped: true,
    error: 'The session was stopped while it was starting.',
  };

  it('simulate_input cut off by a stop says the session was stopped and that its inputs may have landed', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeHook(() => {
      throw new SessionStoppedError('/p', 'input', true);
    });

    const result = await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', ms: 1 }] });

    expectErrorMatching(
      result,
      /Failed to simulate input: The session on \/p was stopped while 'input' was running/,
    );
    const text = allText(result);
    expect(text).toContain('Do not assume the call did nothing');
    expect(text).toContain('not by a crash');
    // The advice for a crashed game does not apply to a session ended on purpose.
    expect(text).not.toContain('crash backtraces');
  });

  it('a call whose turn came after the stop says nothing was sent', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeHook(() => {
      throw new SessionStoppedError('/p', 'get_ui_elements', false);
    });

    const result = await handleGetUiElements(fake.asRunner, {});

    expectErrorMatching(result, /was stopped, so 'get_ui_elements' was not sent/);
    expect(allText(result)).toContain('Nothing was sent to the game for this call');
  });

  it('a spawned start whose session was stopped under its bridge wait is reported as abandoned, with no second stop', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    setBridgeWait(fake, STOPPED_WAIT);

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      makeContext(),
    );

    expectErrorMatching(result, /was stopped while it was starting/);
    expectErrorMatching(result, /this start was abandoned/);
    expect(allText(result)).toContain('no stop_project is needed');
    // Not the bridge-timeout narrative, and not a teardown of its own.
    expect(allText(result)).not.toContain('did not respond within');
    expect(fake.stopCalls()).toBe(0);
  });

  it('an attach whose session was stopped under its bridge wait is reported the same way', async () => {
    const fake = createRuntimeFake();
    setBridgeWait(fake, STOPPED_WAIT);

    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });

    expectErrorMatching(result, /this start was abandoned/);
    expect(allText(result)).toContain('run_project with attach: true');
    expect(fake.stopCalls()).toBe(0);
  });
});

describe('a start that got its turn too late to wait for the bridge', () => {
  it('run_project reports how long it waited and behind what, and that nothing was touched', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setRunProjectError(
      new StartBudgetExhaustedError(
        LATE_START_WAITED_MS,
        'simulate_input',
        LATE_START_REMAINING_MS,
      ),
    );

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      makeContext(),
    );

    expectErrorMatching(
      result,
      new RegExp(`this start waited ${LATE_START_WAITED_MS} ms behind simulate_input`),
    );
    expectErrorMatching(result, /Nothing was stopped or launched/);
    const text = allText(result);
    expect(text).toContain('Retry once simulate_input has returned');
    // Not the generic launch failure, whose advice is about the Godot install.
    expect(text).not.toContain('Failed to run Godot project');
    expect(fake.stopCalls()).toBe(0);
  });

  it('an attach reports it the same way', async () => {
    const fake = createRuntimeFake();
    fake.setAttachProjectError(
      new StartBudgetExhaustedError(LATE_START_WAITED_MS, null, LATE_START_REMAINING_MS),
    );

    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });

    expectErrorMatching(result, new RegExp(`this start waited ${LATE_START_WAITED_MS} ms`));
    expect(allText(result)).toContain('Retry: nothing was stopped or launched');
  });
});

describe('an attach over a session this server already holds, by what its bridge did with the probe', () => {
  const KEPT_PORT = 19944;

  function keptWith(probe: AttachedProbeOutcome): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setAlreadyAttached(KEPT_PORT);
    const runner = fake.asRunner as unknown as {
      attachProject: (projectPath: string) => Promise<unknown>;
    };
    const keep = runner.attachProject.bind(runner);
    runner.attachProject = async (projectPath) => ({
      ...((await keep(projectPath)) as object),
      existingBridge: probe,
    });
    return fake;
  }

  it('a probe that timed out keeps the session and says a busy game looks the same', async () => {
    const result = await handleRunProject(keptWith('silent').asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toMatch(/did not answer a ping within \d+ ms/);
    expect((payload.warnings as string[])[0]).toContain('the existing session was kept');
    expect(payload.message).toMatch(/did not answer the probe in time/);
    expect(payload.bridgePort).toBe(KEPT_PORT);
  });

  it('a probe that was answered says so', async () => {
    const result = await handleRunProject(keptWith('answered').asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(payload.message).toMatch(/the MCP bridge is answering/);
    expect((payload.warnings as string[])[0]).not.toMatch(/did not answer/);
  });
});

describe('runtime calls made while another holds the session queue', () => {
  const BUSY_BEHIND = 'run_project';

  function busyFake(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setQueueBusyBehind(BUSY_BEHIND);
    return fake;
  }

  it('take_screenshot names the call it waited behind and sends nothing', async () => {
    const fake = busyFake();
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /take_screenshot waited \d+ ms for run_project to finish/);
    expect(unwrap(result).content[1]?.text ?? '').toContain('one operation at a time');
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('simulate_input, get_ui_elements and run_script do the same', async () => {
    const fake = busyFake();
    const benign =
      'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1\n';
    const results = [
      await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', frames: 1 }] }),
      await handleGetUiElements(fake.asRunner, {}),
      await handleRunScript(fake.asRunner, { script: benign }, scriptCtx),
    ];
    for (const result of results) {
      expectErrorMatching(result, /waited \d+ ms for run_project to finish/);
    }
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('run_project does not start anything while it cannot get its turn', async () => {
    const fake = busyFake();
    fake.setQueueBusyBehind('simulate_input');
    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );
    expectErrorMatching(result, /run_project waited \d+ ms for simulate_input to finish/);
    expect(fake.runProjectCalls()).toBe(0);
  });
});

describe('run_script runs only on the session it was confirmed for', () => {
  const BENIGN_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1\n';

  it('refuses when the current session changed while the confirmation prompt was open', async () => {
    const admitted = tmp.makeProject('run-script-admitted-');
    const other = tmp.makeProject('run-script-other-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: admitted, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    // The prompt is answered yes, but by then another project's session is current.
    const elicit: Elicitor = async () => {
      fake.setSession({ mode: 'spawned', projectPath: other, process: makeRunningProcess() });
      return { action: 'accept', content: { confirm: true } };
    };

    const result = await handleRunScript(
      fake.asRunner,
      { script: BENIGN_SCRIPT },
      makeContext({ elicit }),
    );

    expectErrorMatching(result, /current session changed while this call was waiting/);
    expectErrorMatching(result, /The script was not executed/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('a script that never got its turn is refused and nothing is sent', async () => {
    const admitted = tmp.makeProject('run-script-queue-busy-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: admitted, process: makeRunningProcess() });
    fake.setQueueBusyBehind('simulate_input');

    const result = await handleRunScript(fake.asRunner, { script: BENIGN_SCRIPT }, makeContext());

    expectErrorMatching(result, /run_script waited \d+ ms for simulate_input to finish/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('refuses when the session ended while the confirmation prompt was open', async () => {
    const admitted = tmp.makeProject('run-script-ended-');
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: admitted, process: makeRunningProcess() });
    const elicit: Elicitor = async () => {
      fake.setSession({ mode: null, projectPath: null, process: null });
      return { action: 'accept', content: { confirm: true } };
    };

    const result = await handleRunScript(
      fake.asRunner,
      { script: BENIGN_SCRIPT },
      makeContext({ elicit }),
    );

    expectErrorMatching(result, /No active runtime session/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });
});

describe('simulate_input batch time budget', () => {
  function activeFake(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeResponse(
      JSON.stringify({ success: true, results: [{ index: 0, type: 'wait', ok: true }] }),
    );
    return fake;
  }

  it('rejects a single wait longer than the batch ceiling before anything is injected', async () => {
    const fake = activeFake();
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'wait', ms: MAX_INPUT_BATCH_BUDGET_MS }],
    });
    expectErrorMatching(result, /time budget is \d+ ms, over the 600000 ms ceiling/);
    expect(unwrap(result).content[1]?.text ?? '').toContain('nothing was injected');
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects a wait so long that its timer would have fired at once', async () => {
    const fake = activeFake();
    const pastTimerMaximum = 2 ** 31;
    const result = await handleSimulateInput(fake.asRunner, {
      actions: [{ type: 'wait', ms: pastTimerMaximum }],
    });
    expectErrorMatching(result, /time budget/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('rejects a batch whose many small actions add up past the ceiling', async () => {
    const fake = activeFake();
    // Each action is far under every per-action cap; only the count is over.
    const actions = Array.from({ length: ACTIONS_PAST_BUDGET }, () => ({
      type: 'wait',
      frames: 1,
    }));
    expect(computeInputTimeoutMs(actions)).toBeGreaterThan(MAX_INPUT_BATCH_BUDGET_MS);

    const result = await handleSimulateInput(fake.asRunner, { actions });

    expectErrorMatching(result, /time budget/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('sends a long batch that is still inside the ceiling', async () => {
    const fake = activeFake();
    const actions = [{ type: 'wait', ms: MAX_INPUT_BATCH_BUDGET_MS / 2 }];
    expect(computeInputTimeoutMs(actions)).toBeLessThanOrEqual(MAX_INPUT_BATCH_BUDGET_MS);

    const result = await handleSimulateInput(fake.asRunner, { actions });

    expect(hasError(result)).toBe(false);
    expect(fake.bridgeCalls).toHaveLength(1);
  });
});

describe('run_project reports what its start could not confirm', () => {
  const KEPT_ATTACH_PORT = 24111;
  const REQUESTED_ATTACH_PORT = 24222;

  it('answers an attach over a live attached session from that session, with a leading warning', async () => {
    const fake = createRuntimeFake();
    fake.setAlreadyAttached(KEPT_ATTACH_PORT);
    // A wait would be the bug: the bridge already answered.
    fake.setBridgeReady(false, 'the wait must not run');

    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
    });

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toContain('already attached to this project');
    expect(payload.sessionMode).toBe('attached');
    expect(payload.bridgePort).toBe(KEPT_ATTACH_PORT);
    expect(fake.stopCalls()).toBe(0);
  });

  it('says a requested bridgePort was not applied to the session that was kept', async () => {
    const fake = createRuntimeFake();
    fake.setAlreadyAttached(KEPT_ATTACH_PORT);

    const result = await handleRunProject(fake.asRunner, {
      projectPath: fixtureProjectPath,
      attach: true,
      bridgePort: REQUESTED_ATTACH_PORT,
    });

    const payload = expectMatchesOutputSchema('run_project', result);
    expect((payload.warnings as string[])[0]).toContain(
      `requested bridgePort ${REQUESTED_ATTACH_PORT} was not applied`,
    );
    expect(payload.bridgePort).toBe(KEPT_ATTACH_PORT);
  });

  it('leads a spawned start with the warning that the game it replaced may still be running', async () => {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    const unconfirmed =
      'The game this start replaced (pid 4321) was sent a kill and did not report its exit.';
    const runner = fake.asRunner as unknown as {
      getSessionInfo: (projectPath: string) => unknown;
    };
    const original = runner.getSessionInfo.bind(runner);
    runner.getSessionInfo = (projectPath: string) => ({
      ...(original(projectPath) as object),
      startWarnings: [unconfirmed],
    });

    const result = await handleRunProject(
      fake.asRunner,
      { projectPath: fixtureProjectPath },
      acceptingContext(),
    );

    const payload = expectMatchesOutputSchema('run_project', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toBe(unconfirmed);
  });

  // Breaks when attachSession stops reading the started record's startWarnings.
  describe('an attach that replaced a session whose bridge cleanup was incomplete', () => {
    const incomplete =
      'Bridge cleanup for the session this start replaced (C:/Game) was incomplete: the McpBridge autoload entry is still in project.godot';

    function fakeWithStartWarning(): RuntimeFake {
      const fake = createRuntimeFake();
      const runner = fake.asRunner as unknown as {
        getSessionInfo: (projectPath: string) => unknown;
      };
      const original = runner.getSessionInfo.bind(runner);
      runner.getSessionInfo = (projectPath: string) => ({
        ...(original(projectPath) as object),
        startWarnings: [incomplete],
      });
      return fake;
    }

    it('leads the attached payload with that warning', async () => {
      const result = await handleRunProject(fakeWithStartWarning().asRunner, {
        projectPath: fixtureProjectPath,
        attach: true,
      });

      const payload = expectMatchesOutputSchema('run_project', result);
      expect(payload.sessionMode).toBe('attached');
      expect(Object.keys(payload)[0]).toBe('warnings');
      expect((payload.warnings as string[])[0]).toBe(incomplete);
    });

    it('says so in the error when the bridge never became ready', async () => {
      const fake = fakeWithStartWarning();
      fake.setBridgeReady(false, 'timeout after 20s');

      const result = await handleRunProject(fake.asRunner, {
        projectPath: fixtureProjectPath,
        attach: true,
      });

      expect(hasError(result)).toBe(true);
      expect(allText(result)).toContain(incomplete);
    });
  });
});

describe('the queue wait is charged against the command it delayed', () => {
  const BENIGN_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1\n';
  const WAITED_MS = 20000;
  const RUN_SCRIPT_DEFAULT_MS = 30000;
  const SCREENSHOT_DEFAULT_MS = 10000;
  /** Leaves a run_script timeout of 1000 ms, under the 2000 ms floor. */
  const WAITED_PAST_FLOOR_MS = 29000;
  /** A one-frame input batch (a 10.2 s worst case) plus this wait passes the 60 s request timeout. */
  const WAITED_PAST_REQUEST_MS = 55000;
  const SHORT_WAIT_MS = 1000;
  const LONG_BATCH_WAITS = 2;
  const LONG_BATCH_WAIT_MS = 45000;
  const ONE_FRAME_BATCH = [{ type: 'wait', frames: 1 }];
  const BAD_TIMEOUTS = [0, -1, 1.5, MAX_RUNTIME_TIMEOUT_MS + 1];
  const BAD_LIMITS = [0, -1, 1.5];

  function spawnedFake(projectPath = '/p'): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setSession({ mode: 'spawned', projectPath, process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    return fake;
  }

  // Red when the send passes the requested timeout through unchanged.
  it('run_script sends with its timeout less the time it waited', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(WAITED_MS);
    await handleRunScript(fake.asRunner, { script: BENIGN_SCRIPT }, makeContext());
    expect(fake.bridgeCalls[0]?.timeoutMs).toBe(RUN_SCRIPT_DEFAULT_MS - WAITED_MS);
  });

  it('take_screenshot sends with its timeout less the time it waited', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(SHORT_WAIT_MS);
    await handleTakeScreenshot(fake.asRunner, {});
    expect(fake.bridgeCalls[0]?.timeoutMs).toBe(SCREENSHOT_DEFAULT_MS - SHORT_WAIT_MS);
  });

  // Red when the chargeQueueWait call is removed from run_script: the script is sent.
  it('run_script waited past the floor is refused and nothing is sent', async () => {
    const projectDir = tmp.makeProject('run-script-charged-');
    const fake = spawnedFake(projectDir);
    fake.setQueueWait(WAITED_PAST_FLOOR_MS, 'simulate_input');
    const result = await handleRunScript(fake.asRunner, { script: BENIGN_SCRIPT }, makeContext());
    expectErrorMatching(result, /run_script waited 29000 ms for simulate_input to finish/);
    expectErrorMatching(result, /Nothing was sent; retry/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Red when the chargeQueueWait call is removed from take_screenshot.
  it('take_screenshot waited past the floor is refused and nothing is sent', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(SCREENSHOT_DEFAULT_MS - SHORT_WAIT_MS);
    const result = await handleTakeScreenshot(fake.asRunner, {});
    expectErrorMatching(result, /take_screenshot waited 9000 ms for run_project to finish/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  // Red when the chargeQueueWait call is removed from simulate_input.
  it('simulate_input whose worst case fits the request timeout is refused when the wait breaks it', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(WAITED_PAST_REQUEST_MS);
    const result = await handleSimulateInput(fake.asRunner, { actions: ONE_FRAME_BATCH });
    expectErrorMatching(result, /simulate_input waited 55000 ms/);
    expectErrorMatching(result, /Nothing was sent/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('simulate_input that still fits the request timeout after a short wait is sent', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(SHORT_WAIT_MS);
    fake.setBridgeResponse(JSON.stringify({ success: true, results: [] }), []);
    await handleSimulateInput(fake.asRunner, { actions: ONE_FRAME_BATCH });
    expect(fake.bridgeCalls[0]?.timeoutMs).toBe(computeInputTimeoutMs(ONE_FRAME_BATCH));
  });

  it('simulate_input already over the request timeout is not refused for having waited', async () => {
    const fake = spawnedFake();
    fake.setQueueWait(WAITED_PAST_REQUEST_MS);
    fake.setBridgeResponse(JSON.stringify({ success: true, results: [] }), []);
    const actions = Array.from({ length: LONG_BATCH_WAITS }, () => ({
      type: 'wait',
      ms: LONG_BATCH_WAIT_MS,
    }));
    await handleSimulateInput(fake.asRunner, { actions });
    expect(fake.bridgeCalls).toHaveLength(1);
    expect(fake.bridgeCalls[0]?.timeoutMs).toBe(computeInputTimeoutMs(actions));
  });

  // Red when the integer test is dropped from parseTimeoutMsArg.
  it.each(BAD_TIMEOUTS)(
    'run_script and take_screenshot refuse timeout %s naming the parameter',
    async (bad) => {
      const fake = spawnedFake();
      const script = await handleRunScript(
        fake.asRunner,
        { script: BENIGN_SCRIPT, timeout: bad },
        makeContext(),
      );
      const shot = await handleTakeScreenshot(fake.asRunner, { timeout: bad });
      const message = new RegExp(
        `timeout must be a whole number from 1 to ${MAX_RUNTIME_TIMEOUT_MS}, got ${bad}`,
      );
      expectErrorMatching(script, message);
      expectErrorMatching(shot, message);
      expect(fake.bridgeCalls).toHaveLength(0);
    },
  );

  // Red when the margin check is dropped from either handler: a timeout of 59900 ms is sent and its answer lands after a 60 s client gave up.
  it('run_script and take_screenshot refuse a timeout that leaves no room to answer inside the request timeout, sending nothing', async () => {
    const EDGE_TIMEOUT_MS = 59900;
    const fake = spawnedFake();
    const script = await handleRunScript(
      fake.asRunner,
      { script: BENIGN_SCRIPT, timeout: EDGE_TIMEOUT_MS },
      makeContext(),
    );
    const shot = await handleTakeScreenshot(fake.asRunner, { timeout: EDGE_TIMEOUT_MS });
    expectErrorMatching(script, /run_script timeout 59900 ms leaves under 1000 ms/);
    expectErrorMatching(shot, /take_screenshot timeout 59900 ms leaves under 1000 ms/);
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it.each(BAD_LIMITS)('get_debug_output refuses limit %s naming the parameter', (bad) => {
    const fake = spawnedFake();
    const result = handleGetDebugOutput(fake.asRunner, { limit: bad });
    expectErrorMatching(
      result,
      new RegExp(`limit must be a whole number of 1 or more, got ${bad}`),
    );
  });

  // Red when the limit is parsed after the attached-session answer again.
  it('get_debug_output refuses a bad limit in an attached session too', () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'attached', projectPath: '/p' });
    const result = handleGetDebugOutput(fake.asRunner, { limit: 0 });
    expectErrorMatching(result, /limit must be a whole number of 1 or more, got 0/);
  });

  // Red when optionalNumber starts coercing strings, or the parser stops going through it.
  it.each(['5000', 'abc', null, true])(
    'timeout and limit given as %j are refused, not coerced',
    async (bad) => {
      const fake = spawnedFake();
      const script = await handleRunScript(
        fake.asRunner,
        { script: BENIGN_SCRIPT, timeout: bad },
        makeContext(),
      );
      const shot = await handleTakeScreenshot(fake.asRunner, { timeout: bad });
      expectErrorMatching(script, /timeout must be a finite number/);
      expectErrorMatching(shot, /timeout must be a finite number/);
      expectErrorMatching(
        handleGetDebugOutput(fake.asRunner, { limit: bad }),
        /limit must be a finite number/,
      );
      expect(fake.bridgeCalls).toHaveLength(0);
    },
  );

  it('accepts the largest timeout and a limit of 1', async () => {
    const fake = spawnedFake();
    await handleRunScript(
      fake.asRunner,
      { script: BENIGN_SCRIPT, timeout: MAX_RUNTIME_TIMEOUT_MS },
      makeContext(),
    );
    expect(fake.bridgeCalls[0]?.timeoutMs).toBe(MAX_RUNTIME_TIMEOUT_MS);
    expect(hasError(handleGetDebugOutput(fake.asRunner, { limit: 1 }))).toBe(false);
  });

  // Red when `success` comes back into the run_script payload.
  it('run_script carries no success field and validates against its outputSchema', async () => {
    const fake = spawnedFake();
    const result = await handleRunScript(fake.asRunner, { script: BENIGN_SCRIPT }, makeContext());
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(payload).not.toHaveProperty('success');
    expect(payload.result).toBe(1);
  });
});

describe('the bridge reports a non-finite count the tools turn into a warning', () => {
  const BENIGN_SCRIPT =
    'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1\n';

  function spawnedFake(): RuntimeFake {
    const fake = createRuntimeFake();
    fake.setGodotPath('/usr/bin/godot');
    fake.setSession({ mode: 'spawned', projectPath: '/p', process: makeRunningProcess() });
    fake.setBridgeResponse(JSON.stringify({ success: true, result: 1 }), []);
    return fake;
  }

  // Red when the Node side stops reading the bridge's non-finite count: the field would not reach
  // the payload, or a nulled result would read as a script failure.
  it('run_script leads with the non-finite warning and strips the internal field', async () => {
    const fake = spawnedFake();
    fake.setBridgeResponse(
      JSON.stringify({ success: true, result: null, [NON_FINITE_COUNT_FIELD]: 2 }),
    );
    const result = await handleRunScript(fake.asRunner, { script: BENIGN_SCRIPT }, makeContext());
    const payload = expectMatchesOutputSchema('run_script', result);
    expect(payload.warnings).toEqual(['2 non-finite numbers (INF, NAN) were returned as null']);
    expect(payload.result).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(NON_FINITE_COUNT_FIELD);
  });

  it('simulate_input leads its warnings with the non-finite warning', async () => {
    const fake = spawnedFake();
    fake.setBridgeResponse(
      JSON.stringify({ success: true, results: [], [NON_FINITE_COUNT_FIELD]: 1 }),
    );
    const result = await handleSimulateInput(fake.asRunner, { actions: [{ type: 'wait', ms: 1 }] });
    const payload = expectMatchesOutputSchema('simulate_input', result);
    expect(payload.warnings).toEqual(['1 non-finite numbers (INF, NAN) were returned as null']);
    expect(JSON.stringify(payload)).not.toContain(NON_FINITE_COUNT_FIELD);
  });
});
