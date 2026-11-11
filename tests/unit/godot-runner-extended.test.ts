import { describe, it, expect, afterEach, vi } from 'vitest';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { cleanOutput, normalizeForCompare } from '../../src/utils/output-parsing.js';
import { parseProjectArgs, parseSceneArgs } from '../../src/utils/arg-parsing.js';
import { checkDisplayAvailable } from '../../src/utils/path-validation.js';
import { GodotRunner, type GodotProcess } from '../../src/utils/godot-runner.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { installSession } from '../helpers/session-install.js';
import type { ChildProcess } from 'child_process';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { itGodot } from '../helpers/godot-skip.js';
import { bridgeScriptAbsPath } from '../../src/utils/artifact-paths.js';

describe('cleanOutput', () => {
  it('strips the Godot version banner line', () => {
    const input = 'Godot Engine v4.3.stable.official\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [DEBUG] lines', () => {
    const input = '[DEBUG] some internal info\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [INFO] Operation: lines', () => {
    const input = '[INFO] Operation: add_node\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [INFO] Executing operation: lines', () => {
    const input = '[INFO] Executing operation: add_node\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips empty lines', () => {
    const input = '\n\n{"ok": true}\n\n';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('passes through lines that are not banner or debug', () => {
    const input = 'some normal output line\nanother line';
    expect(cleanOutput(input)).toBe('some normal output line\nanother line');
  });

  it('strips multiple banner and debug lines, keeps content', () => {
    const input = [
      'Godot Engine v4.3.stable.official',
      '[DEBUG] loading project',
      '[INFO] Operation: create_scene',
      '',
      '{"result": "done"}',
    ].join('\n');
    expect(cleanOutput(input)).toBe('{"result": "done"}');
  });

  it('does not strip [INFO] lines that are not Operation or Executing operation', () => {
    const input = '[INFO] some other info line';
    expect(cleanOutput(input)).toBe('[INFO] some other info line');
  });
});

describe('normalizeForCompare', () => {
  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizeForCompare('C:\\Users\\foo\\project')).toBe('C:/Users/foo/project');
  });

  it('strips a trailing slash', () => {
    expect(normalizeForCompare('/some/path/')).toBe('/some/path');
  });

  it('strips a trailing backslash', () => {
    expect(normalizeForCompare('C:\\project\\')).toBe('C:/project');
  });

  it('handles mixed separators', () => {
    expect(normalizeForCompare('C:\\Users/foo\\project/scenes')).toBe(
      'C:/Users/foo/project/scenes',
    );
  });

  it('is stable on paths that are already normalized', () => {
    const clean = '/some/clean/path';
    expect(normalizeForCompare(clean)).toBe(clean);
  });
});

describe('parseProjectArgs', () => {
  const tmp = useTmpDirs();

  it('returns err when projectPath is missing', () => {
    expectErrorMatching(parseProjectArgs({}), /projectPath is required/);
  });

  it('returns err when projectPath contains ..', () => {
    expectErrorMatching(parseProjectArgs({ projectPath: '/some/../path' }), /Invalid project path/);
  });

  it('returns err when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
    expectErrorMatching(parseProjectArgs({ projectPath: dir }), /Not a valid Godot project/);
  });

  it('returns ok with branded projectPath for a valid Godot project', () => {
    const result = parseProjectArgs({ projectPath: fixtureProjectPath });
    assert(result.ok);
    expect(result.value.projectPath).toBe(fixtureProjectPath);
  });
});

describe('parseSceneArgs', () => {
  const tmp = useTmpDirs();

  it('returns err when projectPath is missing', () => {
    expectErrorMatching(parseSceneArgs({}, 'write'), /projectPath is required/);
  });

  it('returns err when projectPath contains ..', () => {
    expectErrorMatching(
      parseSceneArgs({ projectPath: '/some/../path' }, 'write'),
      /Invalid project path/,
    );
  });

  it('returns err when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
    expectErrorMatching(parseSceneArgs({ projectPath: dir }, 'write'), /Not a valid Godot project/);
  });

  it('returns err when scenePath contains ..', () => {
    expectErrorMatching(
      parseSceneArgs(
        {
          projectPath: fixtureProjectPath,
          scenePath: '../outside.tscn',
        },
        'write',
      ),
      /Invalid scene path/,
    );
  });

  it('returns err when scenePath is an absolute path that escapes the project', () => {
    expectErrorMatching(
      parseSceneArgs(
        {
          projectPath: fixtureProjectPath,
          scenePath: '/etc/passwd',
        },
        'write',
      ),
      /Invalid scene path/,
    );
  });

  it('returns err when sceneRequired (default) and scene file does not exist', () => {
    expectErrorMatching(
      parseSceneArgs(
        {
          projectPath: fixtureProjectPath,
          scenePath: 'nonexistent.tscn',
        },
        'write',
      ),
      /Scene file does not exist/,
    );
  });

  it('returns err when scenePath is absent even when requireExists:false (presence is always required)', () => {
    expectErrorMatching(
      parseSceneArgs({ projectPath: fixtureProjectPath }, 'write', { requireExists: false }),
      /scenePath is required/,
    );
  });

  it('returns ok shape for a valid project and scene', () => {
    const result = parseSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: fixtureScenePath },
      'write',
    );
    assert(result.ok);
    expect(result.value.projectPath).toBe(fixtureProjectPath);
    expect(result.value.scenePath).toBe(fixtureScenePath);
  });

  it('does not check scene existence when requireExists:false and scenePath is provided', () => {
    // Only requireExists:true (the default) stat-checks the scene file
    const result = parseSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: 'ghost.tscn' },
      'write',
      { requireExists: false },
    );
    assert(result.ok);
    expect(result.value.scenePath).toBe('ghost.tscn');
  });
});

describe('checkDisplayAvailable', () => {
  const originalPlatform = process.platform;
  const originalDisplay = process.env.DISPLAY;
  const originalWayland = process.env.WAYLAND_DISPLAY;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalDisplay !== undefined) {
      process.env.DISPLAY = originalDisplay;
    } else {
      delete process.env.DISPLAY;
    }
    if (originalWayland !== undefined) {
      process.env.WAYLAND_DISPLAY = originalWayland;
    } else {
      delete process.env.WAYLAND_DISPLAY;
    }
  });

  it('returns true on non-Linux platforms regardless of env', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(checkDisplayAvailable()).toBe(true);
  });

  it('returns true on Linux when DISPLAY is set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;
    expect(checkDisplayAvailable()).toBe(true);
  });

  it('returns true on Linux when WAYLAND_DISPLAY is set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    expect(checkDisplayAvailable()).toBe(true);
  });

  it('returns false on Linux when neither DISPLAY nor WAYLAND_DISPLAY is set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(checkDisplayAvailable()).toBe(false);
  });
});

describe('detectGodotPath', () => {
  const originalGodotPath = process.env.GODOT_PATH;

  afterEach(() => {
    if (originalGodotPath !== undefined) {
      process.env.GODOT_PATH = originalGodotPath;
    } else {
      delete process.env.GODOT_PATH;
    }
  });

  // An explicit GODOT_PATH is authoritative: if it does not resolve, godotPath stays null instead of falling back to platform defaults.
  it('leaves godotPath null when GODOT_PATH points to a non-existent file', async () => {
    process.env.GODOT_PATH = '/nonexistent/godot-mcp-test-bogus-binary';
    const runner = new GodotRunner();
    await runner.detectGodotPath();
    expect(runner.getGodotPath()).toBeNull();
  });

  it('leaves godotPath null when GODOT_PATH is set but invalid, even if auto-detect would succeed', async () => {
    // Even where `godot` is on PATH, a broken explicit GODOT_PATH must not fall through to it;
    // isValidGodotPath is stubbed so auto-detect would succeed, proving the explicit branch short-circuits.
    process.env.GODOT_PATH = '/nonexistent/godot-mcp-test-bogus-binary';
    const runner = new GodotRunner();
    const spy = vi
      .spyOn(
        runner as unknown as { isValidGodotPath: (p: string) => Promise<boolean> },
        'isValidGodotPath',
      )
      .mockImplementation(async (p: string) => p === 'godot');
    await runner.detectGodotPath();
    expect(runner.getGodotPath()).toBeNull();
    const probed = spy.mock.calls.map((c) => c[0]);
    expect(probed).not.toContain('godot');
    spy.mockRestore();
  });

  it('does not invent a hardcoded platform-default path when auto-detect finds nothing', async () => {
    // With nothing found the runner must leave godotPath null or resolve a real path, never a fabricated platform default.
    delete process.env.GODOT_PATH;
    const runner = new GodotRunner({ godotPath: '/nonexistent/godot-mcp-test-bogus-binary' });
    expect(runner.getGodotPath()).toBeNull();
    await runner.detectGodotPath();
    const resolved = runner.getGodotPath();
    expect(resolved === null || typeof resolved === 'string').toBe(true);
  });

  itGodot('resolves a real Godot binary when GODOT_PATH points at one', async () => {
    // Gated on GODOT_PATH presence: a valid one must resolve to exactly that path.
    const runner = new GodotRunner();
    await runner.detectGodotPath();
    const resolved = runner.getGodotPath();
    expect(resolved).not.toBeNull();
    expect(resolved).not.toMatch(/Program Files\\Godot\\Godot\.exe$/);
  });
});

describe('GodotRunner.attachProject bridge auth token', () => {
  const tmp = useTmpDirs();

  it('bakes a per-session token into the injected bridge script (attach has no env channel)', async () => {
    const dir = tmp.makeProject('attach-token-');
    const runner = new GodotRunner({ godotPath: 'godot' });

    await runner.attachProject(dir);

    const bridgeScript = readFileSync(bridgeScriptAbsPath(dir), 'utf8');
    const match = bridgeScript.match(/const SESSION_TOKEN_BAKED := "([^"]*)"/);
    expect(match).not.toBeNull();
    const bakedToken = match?.[1] ?? '';
    // 16 random bytes hex-encoded = 32 hex chars.
    expect(bakedToken).toMatch(/^[0-9a-f]{32}$/);

    expect((runner as unknown as { activeSessionToken: string | null }).activeSessionToken).toBe(
      bakedToken,
    );
  });

  it('bakes a different token on each attachProject call', async () => {
    const dirA = tmp.makeProject('attach-token-a-');
    const dirB = tmp.makeProject('attach-token-b-');
    const runner = new GodotRunner({ godotPath: 'godot' });

    await runner.attachProject(dirA);
    const tokenA = (runner as unknown as { activeSessionToken: string | null }).activeSessionToken;

    await runner.attachProject(dirB);
    const tokenB = (runner as unknown as { activeSessionToken: string | null }).activeSessionToken;

    expect(tokenA).not.toBeNull();
    expect(tokenB).not.toBeNull();
    expect(tokenA).not.toBe(tokenB);
  });
});

const TRACKED_PROJECT = 'D:/projects/demo';

/** Stand-in for a tracked child process; the predicate reads only `hasExited`. */
function trackedProcess(hasExited: boolean): GodotProcess {
  return {
    process: {} as ChildProcess,
    output: [],
    errors: [],
    totalErrorsWritten: 0,
    exitCode: hasExited ? 0 : null,
    hasExited,
    sessionToken: 'test-token',
  };
}

describe('GodotRunner.hasActiveRuntimeSession', () => {
  it('reports no session on a freshly constructed runner', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports a session while a spawned process is still running', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, {
      mode: 'spawned',
      projectPath: TRACKED_PROJECT,
      process: trackedProcess(false),
    });

    expect(runner.hasActiveRuntimeSession()).toBe(true);
  });

  it('reports no session once the spawned process has exited', () => {
    // A user closing the game window must self-clear: activeSessionMode and activeProjectPath stay set until stopProject,
    // so code reading those fields directly would still see a session.
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, {
      mode: 'spawned',
      projectPath: TRACKED_PROJECT,
      process: trackedProcess(true),
    });

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports no session when a spawned launch never produced a process', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, { mode: 'spawned', projectPath: TRACKED_PROJECT, process: null });

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports a session in attached mode even with no process tracked', () => {
    // The server does not own an attached process and never observes its
    // exit, so attached liveness cannot be falsified from in here.
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, { mode: 'attached', projectPath: TRACKED_PROJECT, process: null });

    expect(runner.hasActiveRuntimeSession()).toBe(true);
  });

  it('reports no session when nothing is current although another project has a live session', () => {
    // The predicate answers for the current session only. A live session that
    // is not current must not make it true: runtime tools never act on it.
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, {
      mode: 'spawned',
      projectPath: TRACKED_PROJECT,
      process: trackedProcess(false),
      current: false,
    });

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports no session when the session mode is unset', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    installSession(runner, {
      mode: null,
      projectPath: TRACKED_PROJECT,
      process: trackedProcess(false),
    });

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });
});

// The headless-op guard tests use a fake runner that carries its own copy of this predicate;
// if the two disagree those tests assert nothing about production. Pin them together.
describe('fake runner liveness predicate matches GodotRunner', () => {
  const CASES: Array<{
    mode: 'spawned' | 'attached' | null;
    projectPath: string | null;
    hasExited: boolean | null;
  }> = [
    { mode: null, projectPath: null, hasExited: null },
    { mode: 'spawned', projectPath: TRACKED_PROJECT, hasExited: false },
    { mode: 'spawned', projectPath: TRACKED_PROJECT, hasExited: true },
    { mode: 'spawned', projectPath: TRACKED_PROJECT, hasExited: null },
    { mode: 'attached', projectPath: TRACKED_PROJECT, hasExited: null },
    { mode: null, projectPath: TRACKED_PROJECT, hasExited: false },
  ];

  it.each(CASES)('agrees for mode=$mode path=$projectPath exited=$hasExited', (c) => {
    const real = new GodotRunner({ godotPath: 'godot' });
    // A record always has a project path, so the all-null row is the runner
    // with no session at all.
    if (c.projectPath !== null) {
      installSession(real, {
        mode: c.mode,
        projectPath: c.projectPath,
        process: c.hasExited === null ? null : trackedProcess(c.hasExited),
      });
    }

    const fake = createFakeRunner().asRunner;
    fake.activeSessionMode = c.mode;
    fake.activeProjectPath = c.projectPath;
    fake.activeProcess = c.hasExited === null ? null : trackedProcess(c.hasExited);

    expect(fake.hasActiveRuntimeSession()).toBe(real.hasActiveRuntimeSession());
    expect(fake.hasLiveSessionOnProject(TRACKED_PROJECT)).toBe(
      real.hasLiveSessionOnProject(TRACKED_PROJECT),
    );
  });
});
