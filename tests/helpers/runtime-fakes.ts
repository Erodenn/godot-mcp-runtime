/**
 * Fakes for runtime-session handler tests (simulate_input, check_project's
 * runtime probe, ...).
 *
 * Unlike the generic fake-runner.ts (headless executeOperation), these model
 * the live-bridge command path: sendCommandWithErrors + the public session
 * fields handlers guard on (activeSessionMode, activeProjectPath,
 * activeProcess).
 */

import type {
  GodotRunner,
  GodotProcess,
  RuntimeSessionMode,
  RuntimeStopResult,
} from '../../src/utils/godot-runner.js';
import type { Elicitor, McpContext } from '../../src/utils/mcp-context.js';

export interface BridgeCall {
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface RuntimeFake {
  asRunner: GodotRunner;
  bridgeCalls: BridgeCall[];
  stopCalls(): number;
  setSession(opts: {
    mode: RuntimeSessionMode | null;
    projectPath?: string | null;
    process?: Partial<GodotProcess> | null;
    hasExited?: boolean;
  }): void;
  setBridgeResponse(response: unknown, runtimeErrors?: string[]): void;
  setSendCommandError(error: Error | null): void;
  setBridgeHook(hook: (() => void) | null): void;
  /**
   * Stand in for the per-action stderr attribution the real runner derives from
   * boundary sentinels, so handler tests can drive the attachment logic without
   * a process. Defaults to no errors and no timeout.
   */
  setActionErrorBuckets(buckets: string[][], trailing?: string[], timedOut?: boolean): void;
}

export function makeContext(
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

export function createRuntimeFake(): RuntimeFake {
  const bridgeCalls: BridgeCall[] = [];
  let stopCallsCount = 0;
  let bridgeResponse: unknown = {};
  let bridgeRuntimeErrors: string[] = [];
  let sendCommandError: Error | null = null;
  let bridgeHook: (() => void) | null = null;
  let actionErrorBuckets: string[][] = [];
  let actionErrorTrailing: string[] = [];
  let actionSentinelTimedOut = false;

  let state = {
    activeSessionMode: null as RuntimeSessionMode | null,
    activeProjectPath: null as string | null,
    activeProcess: null as GodotProcess | null,
  };

  const runner = {
    get activeSessionMode() {
      return state.activeSessionMode;
    },
    get activeProjectPath() {
      return state.activeProjectPath;
    },
    get activeProcess() {
      return state.activeProcess;
    },
    detectGodotPath: async () => '/usr/local/bin/godot',
    getVersion: async () => '4.7.2.stable.official',
    sendCommandWithErrors: async (
      command: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ) => {
      if (sendCommandError) throw sendCommandError;
      if (bridgeHook) bridgeHook();
      bridgeCalls.push({ command, params, timeoutMs });
      return {
        response:
          typeof bridgeResponse === 'string' ? bridgeResponse : JSON.stringify(bridgeResponse),
        runtimeErrors: bridgeRuntimeErrors,
        stderrWindow: '',
      };
    },
    sendCommandWithReconnect: async (
      command: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ) => {
      return runner.sendCommandWithErrors(command, params, timeoutMs);
    },
    stopProject: async (): Promise<RuntimeStopResult> => {
      stopCallsCount++;
      state.activeSessionMode = null;
      state.activeProjectPath = null;
      state.activeProcess = null;
      return { success: true };
    },
    getErrorCount: () => 0,
    beginActionErrorCapture: () => ({ marker: 0 }),
    collectActionErrors: async (_capture: unknown, expectedSentinels: number) => ({
      buckets: Array.from(
        { length: Math.max(0, expectedSentinels) },
        (_unused, i) => actionErrorBuckets[i] ?? [],
      ),
      trailing: actionErrorTrailing,
      sentinelTimedOut: actionSentinelTimedOut,
    }),
  } as unknown as GodotRunner;

  return {
    asRunner: runner,
    bridgeCalls,
    stopCalls: () => stopCallsCount,
    setSession(opts) {
      const proc =
        opts.process !== undefined
          ? (opts.process as GodotProcess | null)
          : opts.hasExited !== undefined
            ? ({
                output: [],
                errors: [],
                hasExited: opts.hasExited,
                exitCode: null,
                sessionToken: 'test-token',
                totalErrorsWritten: 0,
              } as GodotProcess)
            : null;
      state = {
        ...state,
        activeSessionMode: opts.mode,
        activeProjectPath: opts.projectPath ?? null,
        activeProcess: proc,
      };
    },
    setBridgeResponse(response: unknown, runtimeErrors?: string[]) {
      bridgeResponse = response;
      bridgeRuntimeErrors = runtimeErrors ?? [];
    },
    setSendCommandError(error: Error | null) {
      sendCommandError = error;
    },
    setBridgeHook(hook: (() => void) | null) {
      bridgeHook = hook;
    },
    setActionErrorBuckets(buckets: string[][], trailing?: string[], timedOut?: boolean) {
      actionErrorBuckets = buckets;
      actionErrorTrailing = trailing ?? [];
      actionSentinelTimedOut = timedOut === true;
    },
  };
}
