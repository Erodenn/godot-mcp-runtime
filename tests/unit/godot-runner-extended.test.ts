import { describe, it, expect, afterEach, vi } from 'vitest';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cleanOutput, normalizeForCompare } from '../../src/utils/output-parsing.js';
import { parseProjectArgs, parseSceneArgs } from '../../src/utils/arg-parsing.js';
import { checkDisplayAvailable } from '../../src/utils/path-validation.js';
import { GodotRunner, type GodotProcess } from '../../src/utils/godot-runner.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import type { ChildProcess } from 'child_process';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { itGodot } from '../helpers/godot-skip.js';

// ─── cleanOutput ─────────────────────────────────────────────────────────────

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

// ─── normalizeForCompare ──────────────────────────────────────────────────────

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

// ─── parseProjectArgs ────────────────────────────────────────────────────────

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

// ─── parseSceneArgs ──────────────────────────────────────────────────────────

describe('parseSceneArgs', () => {
  const tmp = useTmpDirs();

  it('returns err when projectPath is missing', () => {
    expectErrorMatching(parseSceneArgs({}), /projectPath is required/);
  });

  it('returns err when projectPath contains ..', () => {
    expectErrorMatching(parseSceneArgs({ projectPath: '/some/../path' }), /Invalid project path/);
  });

  it('returns err when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
    expectErrorMatching(parseSceneArgs({ projectPath: dir }), /Not a valid Godot project/);
  });

  it('returns err when scenePath contains ..', () => {
    expectErrorMatching(
      parseSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: '../outside.tscn',
      }),
      /Invalid scene path/,
    );
  });

  it('returns err when scenePath is an absolute path that escapes the project', () => {
    expectErrorMatching(
      parseSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: '/etc/passwd',
      }),
      /Invalid scene path/,
    );
  });

  it('returns err when sceneRequired (default) and scene file does not exist', () => {
    expectErrorMatching(
      parseSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: 'nonexistent.tscn',
      }),
      /Scene file does not exist/,
    );
  });

  it('returns err when scenePath is absent even when requireExists:false (presence is always required)', () => {
    expectErrorMatching(
      parseSceneArgs({ projectPath: fixtureProjectPath }, { requireExists: false }),
      /scenePath is required/,
    );
  });

  it('returns ok shape for a valid project and scene', () => {
    const result = parseSceneArgs({
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
    });
    assert(result.ok);
    expect(result.value.projectPath).toBe(fixtureProjectPath);
    expect(result.value.scenePath).toBe(fixtureScenePath);
  });

  it('does not check scene existence when requireExists:false and scenePath is provided', () => {
    // Only requireExists:true (the default) stat-checks the scene file
    const result = parseSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: 'ghost.tscn' },
      { requireExists: false },
    );
    assert(result.ok);
    expect(result.value.scenePath).toBe('ghost.tscn');
  });
});

// ─── checkDisplayAvailable ──────────────────────────────────────────────────

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

// ─── detectGodotPath ────────────────────────────────────────────────────────

describe('detectGodotPath', () => {
  const originalGodotPath = process.env.GODOT_PATH;

  afterEach(() => {
    if (originalGodotPath !== undefined) {
      process.env.GODOT_PATH = originalGodotPath;
    } else {
      delete process.env.GODOT_PATH;
    }
  });

  // Regression: issue #15 — a misconfigured GODOT_PATH used to be silently
  // swallowed and the runner fell back to platform defaults (e.g. on Windows
  // `C:\Program Files\Godot\Godot.exe`). Users who installed Godot elsewhere
  // got "file not found" errors against a path they never chose. An explicit
  // GODOT_PATH must now be authoritative — if it doesn't resolve, leave
  // godotPath null so the caller can produce an actionable error instead.
  it('leaves godotPath null when GODOT_PATH points to a non-existent file', async () => {
    process.env.GODOT_PATH = '/nonexistent/godot-mcp-test-bogus-binary';
    const runner = new GodotRunner();
    await runner.detectGodotPath();
    expect(runner.getGodotPath()).toBeNull();
  });

  it('leaves godotPath null when GODOT_PATH is set but invalid, even if auto-detect would succeed', async () => {
    // Even on a developer machine where `godot` is on PATH, an explicit
    // (broken) GODOT_PATH must not silently fall through to the PATH binary —
    // doing so masks the user's intent. We stub isValidGodotPath so auto-detect
    // would unambiguously succeed for `godot`; the assertion proves the
    // explicit-invalid branch short-circuits before auto-detect runs.
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
    // Sanity: the auto-detect candidates were never probed — the explicit
    // GODOT_PATH branch short-circuited before reaching auto-detect.
    const probed = spy.mock.calls.map((c) => c[0]);
    expect(probed).not.toContain('godot');
    spy.mockRestore();
  });

  it('does not invent a hardcoded platform-default path when auto-detect finds nothing', async () => {
    // Pre-fix behavior set godotPath to `C:\Program Files\Godot\Godot.exe`
    // (Windows) / `/usr/bin/godot` (Linux) / `/Applications/Godot.app/...`
    // (macOS) when nothing was found, then later spawn calls failed against
    // that fabricated path. The runner must leave godotPath null instead OR
    // resolve a real path — never the fabricated default.
    delete process.env.GODOT_PATH;
    const runner = new GodotRunner({ godotPath: '/nonexistent/godot-mcp-test-bogus-binary' });
    // Constructor sync-validation rejects the bogus path, so godotPath starts null.
    expect(runner.getGodotPath()).toBeNull();
    await runner.detectGodotPath();
    const resolved = runner.getGodotPath();
    // Unconditional contract: detectGodotPath never returns the fabricated
    // platform default. Either null (CI) or a real path found via auto-detect.
    expect(resolved === null || typeof resolved === 'string').toBe(true);
  });

  itGodot('resolves a real Godot binary when GODOT_PATH points at one', async () => {
    // Gated on GODOT_PATH presence (itGodot skips otherwise). With a valid
    // GODOT_PATH, the runner must resolve to that exact path — never silently
    // substitute the historical platform-default fabrication.
    const runner = new GodotRunner();
    await runner.detectGodotPath();
    const resolved = runner.getGodotPath();
    expect(resolved).not.toBeNull();
    expect(resolved).not.toMatch(/Program Files\\Godot\\Godot\.exe$/);
  });
});

// ─── attachProject bridge auth token ────────────────────────────────────────

describe('GodotRunner.attachProject bridge auth token', () => {
  const tmp = useTmpDirs();

  it('bakes a per-session token into the injected bridge script (attach has no env channel)', async () => {
    const dir = tmp.makeProject('attach-token-');
    const runner = new GodotRunner({ godotPath: 'godot' });

    await runner.attachProject(dir);

    const bridgeScript = readFileSync(join(dir, 'mcp_bridge.gd'), 'utf8');
    const match = bridgeScript.match(/const SESSION_TOKEN_BAKED := "([^"]*)"/);
    expect(match).not.toBeNull();
    const bakedToken = match?.[1] ?? '';
    // 16 random bytes hex-encoded = 32 hex chars.
    expect(bakedToken).toMatch(/^[0-9a-f]{32}$/);

    // The runner's in-memory token matches what was baked, so sendCommand's
    // frames authenticate against exactly this script.
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

// ─── GodotRunner.hasActiveRuntimeSession ─────────────────────────────────────

const TRACKED_PROJECT = 'D:/projects/demo';

/**
 * Minimal stand-in for a tracked child process. The predicate reads only
 * `hasExited`; the rest of GodotProcess is structural padding.
 */
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
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = TRACKED_PROJECT;
    runner.activeProcess = trackedProcess(false);

    expect(runner.hasActiveRuntimeSession()).toBe(true);
  });

  it('reports no session once the spawned process has exited', () => {
    // A user closing the game window is the case that has to self-clear:
    // activeSessionMode and activeProjectPath stay set until stopProject
    // runs, so anything reading those fields directly would still see a
    // session here.
    const runner = new GodotRunner({ godotPath: 'godot' });
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = TRACKED_PROJECT;
    runner.activeProcess = trackedProcess(true);

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports no session when a spawned launch never produced a process', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = TRACKED_PROJECT;
    runner.activeProcess = null;

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports a session in attached mode even with no process tracked', () => {
    // The server does not own an attached process and never observes its
    // exit, so attached liveness cannot be falsified from in here.
    const runner = new GodotRunner({ godotPath: 'godot' });
    runner.activeSessionMode = 'attached';
    runner.activeProjectPath = TRACKED_PROJECT;
    runner.activeProcess = null;

    expect(runner.hasActiveRuntimeSession()).toBe(true);
  });

  it('reports no session when the project path is unset', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = null;
    runner.activeProcess = trackedProcess(false);

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });

  it('reports no session when the session mode is unset', () => {
    const runner = new GodotRunner({ godotPath: 'godot' });
    runner.activeSessionMode = null;
    runner.activeProjectPath = TRACKED_PROJECT;
    runner.activeProcess = trackedProcess(false);

    expect(runner.hasActiveRuntimeSession()).toBe(false);
  });
});

// The guard tests in headless-op.test.ts drive the fake runner, not a real
// GodotRunner, so the fake carries its own copy of this predicate. If the two
// ever disagree, those tests go on passing while asserting nothing about
// production behavior. Pin them together across the whole input space.
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
    { mode: 'spawned', projectPath: null, hasExited: false },
    { mode: null, projectPath: TRACKED_PROJECT, hasExited: false },
  ];

  it.each(CASES)('agrees for mode=$mode path=$projectPath exited=$hasExited', (c) => {
    const real = new GodotRunner({ godotPath: 'godot' });
    real.activeSessionMode = c.mode;
    real.activeProjectPath = c.projectPath;
    real.activeProcess = c.hasExited === null ? null : trackedProcess(c.hasExited);

    const fake = createFakeRunner().asRunner;
    fake.activeSessionMode = c.mode;
    fake.activeProjectPath = c.projectPath;
    fake.activeProcess = c.hasExited === null ? null : trackedProcess(c.hasExited);

    expect(fake.hasActiveRuntimeSession()).toBe(real.hasActiveRuntimeSession());
  });
});
