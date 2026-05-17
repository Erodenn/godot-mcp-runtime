import { describe, it, expect, afterEach } from 'vitest';
import {
  cleanOutput,
  normalizeForCompare,
  validateProjectArgs,
  validateSceneArgs,
  checkDisplayAvailable,
  GodotRunner,
} from '../../src/utils/godot-runner.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

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

// ─── validateProjectArgs ─────────────────────────────────────────────────────

describe('validateProjectArgs', () => {
  const tmp = useTmpDirs();

  it('returns isError when projectPath is missing', () => {
    expectErrorMatching(validateProjectArgs({}), /projectPath is required/);
  });

  it('returns isError when projectPath contains ..', () => {
    expectErrorMatching(
      validateProjectArgs({ projectPath: '/some/../path' }),
      /Invalid project path/,
    );
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
    expectErrorMatching(validateProjectArgs({ projectPath: dir }), /Not a valid Godot project/);
  });

  it('returns validated shape with projectPath for a valid Godot project', () => {
    const result = validateProjectArgs({ projectPath: fixtureProjectPath });
    expect('isError' in result).toBe(false);
    expect((result as { projectPath: string }).projectPath).toBe(fixtureProjectPath);
  });
});

// ─── validateSceneArgs ───────────────────────────────────────────────────────

describe('validateSceneArgs', () => {
  const tmp = useTmpDirs();

  it('returns isError when projectPath is missing', () => {
    expectErrorMatching(validateSceneArgs({}), /projectPath is required/);
  });

  it('returns isError when projectPath contains ..', () => {
    expectErrorMatching(
      validateSceneArgs({ projectPath: '/some/../path' }),
      /Invalid project path/,
    );
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
    expectErrorMatching(validateSceneArgs({ projectPath: dir }), /Not a valid Godot project/);
  });

  it('returns isError when scenePath contains ..', () => {
    expectErrorMatching(
      validateSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: '../outside.tscn',
      }),
      /Invalid scene path/,
    );
  });

  it('returns isError when scenePath is an absolute path that escapes the project', () => {
    expectErrorMatching(
      validateSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: '/etc/passwd',
      }),
      /Invalid scene path/,
    );
  });

  it('returns isError when sceneRequired (default) and scene file does not exist', () => {
    expectErrorMatching(
      validateSceneArgs({
        projectPath: fixtureProjectPath,
        scenePath: 'nonexistent.tscn',
      }),
      /Scene file does not exist/,
    );
  });

  it('returns { projectPath, scenePath: "" } when sceneRequired:false and scenePath is absent', () => {
    const result = validateSceneArgs({ projectPath: fixtureProjectPath }, { sceneRequired: false });
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.projectPath).toBe(fixtureProjectPath);
    expect(typed.scenePath).toBe('');
  });

  it('returns validated shape for a valid project and scene', () => {
    const result = validateSceneArgs({
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
    });
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.projectPath).toBe(fixtureProjectPath);
    expect(typed.scenePath).toBe(fixtureScenePath);
  });

  it('does not check scene existence when sceneRequired:false and scenePath is provided', () => {
    // The implementation only stat-checks scene files when sceneRequired is true
    const result = validateSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: 'ghost.tscn' },
      { sceneRequired: false },
    );
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.scenePath).toBe('ghost.tscn');
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
    // doing so masks the user's intent.
    process.env.GODOT_PATH = '/nonexistent/godot-mcp-test-bogus-binary';
    const runner = new GodotRunner();
    await runner.detectGodotPath();
    expect(runner.getGodotPath()).toBeNull();
  });

  it('does not invent a hardcoded platform-default path when auto-detect finds nothing', async () => {
    // Pre-fix behavior set godotPath to `C:\Program Files\Godot\Godot.exe`
    // (Windows) / `/usr/bin/godot` (Linux) / `/Applications/Godot.app/...`
    // (macOS) when nothing was found, then later spawn calls failed against
    // that fabricated path. The runner must leave godotPath null instead.
    delete process.env.GODOT_PATH;
    const runner = new GodotRunner({ godotPath: '/nonexistent/godot-mcp-test-bogus-binary' });
    // Constructor sync-validation rejects the bogus path, so godotPath starts null.
    expect(runner.getGodotPath()).toBeNull();
    await runner.detectGodotPath();
    // After detection: still null unless this machine actually has Godot
    // somewhere in the auto-detect search list. In CI (no Godot), null.
    // Locally with Godot on PATH, this is a real working path — not the
    // fabricated platform default.
    const resolved = runner.getGodotPath();
    if (resolved !== null) {
      expect(resolved).not.toMatch(/Program Files\\Godot\\Godot\.exe$/);
    }
  });
});
