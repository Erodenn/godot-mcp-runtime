import {
  sessionKey,
  type RuntimeSessionInfo,
  type RuntimeSessionMode,
  type RuntimeSessionStatus,
} from '../../src/utils/godot-runner.js';

export const FAKE_RETAINED_PROJECT_PATH = '/fake/retained-project';

export interface FakeCurrentSession {
  mode: RuntimeSessionMode | null;
  projectPath: string | null;
  process: { hasExited: boolean; exitCode?: number | null } | null;
  profiling?: boolean;
}

export function liveSessionInfo(
  projectPath: string,
  overrides: Partial<RuntimeSessionInfo> = {},
): RuntimeSessionInfo {
  return {
    projectPath,
    mode: 'spawned',
    live: true,
    current: false,
    bridgePort: null,
    processExited: false,
    exitCode: null,
    hasRetainedLogs: true,
    profiling: false,
    ...overrides,
  };
}

function describeFakeCurrent(c: FakeCurrentSession): RuntimeSessionInfo | null {
  if (c.mode === null && c.process === null && c.profiling !== true) return null;
  const exited = c.process !== null && c.process.hasExited;
  return {
    projectPath: c.projectPath ?? FAKE_RETAINED_PROJECT_PATH,
    mode: c.mode,
    live: c.mode === 'attached' || (c.mode === 'spawned' && c.process !== null && !exited),
    current: true,
    bridgePort: null,
    processExited: exited,
    exitCode: exited ? (c.process?.exitCode ?? null) : null,
    hasRetainedLogs: c.process !== null,
    profiling: c.profiling === true,
  };
}

export function fakeSessionApi(
  read: () => { current: FakeCurrentSession; others?: RuntimeSessionInfo[] },
) {
  const snapshot = () => {
    const { current, others = [] } = read();
    return { info: describeFakeCurrent(current), others };
  };
  const listSessions = (): RuntimeSessionInfo[] => {
    const { info, others } = snapshot();
    return info ? [info, ...others] : [...others];
  };
  return {
    getCurrentSessionInfo: (): RuntimeSessionInfo | null => snapshot().info,
    listSessions,
    listLiveSessions: (): RuntimeSessionInfo[] => listSessions().filter((s) => s.live),
    getSessionInfo: (projectPath: string): RuntimeSessionInfo | null => {
      const key = sessionKey(projectPath);
      return listSessions().find((s) => sessionKey(s.projectPath) === key) ?? null;
    },
    getRuntimeSessionStatus: (): RuntimeSessionStatus => {
      const { info, others } = snapshot();
      const otherLiveSessions = others.filter((s) => s.live);
      if (info === null) return { state: 'none', current: null, otherLiveSessions };
      return { state: info.live ? 'live' : 'exited', current: info, otherLiveSessions };
    },
  };
}
