/**
 * Test-suite-only resolver for the private-desktop launcher.
 *
 * Godot's startup calls SetForegroundWindow on its main window, so even a
 * hidden game window takes keyboard focus. A process started on a private Win32
 * desktop cannot. Node's `spawn` cannot choose a desktop, so on Windows the
 * suite compiles `private-desktop-launcher.cs` once (cached under
 * node_modules/.cache) and substitutes the launcher for the Godot executable:
 * `GODOT_PATH` becomes the launcher and `GODOT_MCP_TEST_LAUNCH_TARGET` carries
 * the real Godot path (see `private-desktop-global-setup.ts`). Product code
 * never learns about any of this.
 *
 * Nothing here throws: every failure is a `null` launcher plus a reason, and
 * the suite then runs exactly as it did before.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOW_WINDOWS_ENV_VAR } from './run-project-or-skip.js';

/** Read by the launcher (same name in the .cs): the program to run on the private desktop. */
export const LAUNCH_TARGET_ENV_VAR = 'GODOT_MCP_TEST_LAUNCH_TARGET';

const GODOT_PATH_ENV_VAR = 'GODOT_PATH';
const SPAWN_TIMEOUT_MS = 10_000;
const HASH_HEX_CHARS = 16;
const LAUNCHER_STEM = 'private-desktop-launcher';
const SELF_TEST_FLAG = '--self-test';
const CACHE_SUBDIR = join('node_modules', '.cache', 'godot-mcp-runtime-tests');
const DOTNET_FRAMEWORK_DIRS = ['Framework64', 'Framework'];
const DOTNET_FRAMEWORK_VERSION = 'v4.0.30319';
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

const helpersDir = fileURLToPath(new URL('.', import.meta.url));
const defaultRepoRoot = join(helpersDir, '..', '..');
const defaultSourcePath = join(helpersDir, `${LAUNCHER_STEM}.cs`);

export type LauncherResolution = { exe: string; note: string } | { exe: null; reason: string };

export interface PrivateDesktopDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  spawnSync: (
    command: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number },
  ) => { status: number | null };
  renameSync: (from: string, to: string) => void;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  unlinkSync: (path: string) => void;
  pid: number;
  tmpdir: () => string;
  repoRoot: string;
  sourcePath: string;
}

const realDeps: PrivateDesktopDeps = {
  platform: process.platform,
  env: process.env,
  existsSync,
  readFileSync: (path) => readFileSync(path),
  spawnSync: (command, args, options) => spawnSync(command, args, options),
  renameSync,
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  unlinkSync,
  pid: process.pid,
  tmpdir,
  repoRoot: defaultRepoRoot,
  sourcePath: defaultSourcePath,
};

function findCompiler(deps: PrivateDesktopDeps): string | null {
  const systemRoot = deps.env.SystemRoot ?? deps.env.windir ?? DEFAULT_SYSTEM_ROOT;
  for (const dir of DOTNET_FRAMEWORK_DIRS) {
    const candidate = join(systemRoot, 'Microsoft.NET', dir, DOTNET_FRAMEWORK_VERSION, 'csc.exe');
    if (deps.existsSync(candidate)) return candidate;
  }
  return null;
}

function cacheDirectory(deps: PrivateDesktopDeps): string {
  const hasNodeModules = deps.existsSync(join(deps.repoRoot, 'node_modules'));
  return hasNodeModules ? join(deps.repoRoot, CACHE_SUBDIR) : deps.tmpdir();
}

/**
 * The launcher exe to put in `GODOT_PATH`, or null with the reason it is not
 * used. `deps` is for tests; callers pass nothing (or a partial override).
 */
export function resolvePrivateDesktopLauncher(
  overrides: Partial<PrivateDesktopDeps> = {},
): LauncherResolution {
  const deps: PrivateDesktopDeps = { ...realDeps, ...overrides };
  try {
    if (deps.platform !== 'win32') {
      return { exe: null, reason: 'not Windows' };
    }
    if (deps.env[SHOW_WINDOWS_ENV_VAR] === '1') {
      return { exe: null, reason: `${SHOW_WINDOWS_ENV_VAR}=1 (windows shown on purpose)` };
    }
    if (!deps.env[GODOT_PATH_ENV_VAR]) {
      return { exe: null, reason: `${GODOT_PATH_ENV_VAR} is not set` };
    }
    const csc = findCompiler(deps);
    if (csc === null) {
      return { exe: null, reason: 'no csc.exe in the .NET Framework directories' };
    }

    const hash = createHash('sha256')
      .update(deps.readFileSync(deps.sourcePath))
      .digest('hex')
      .slice(0, HASH_HEX_CHARS);
    const dir = cacheDirectory(deps);
    const exe = join(dir, `${LAUNCHER_STEM}-${hash}.exe`);

    if (!deps.existsSync(exe)) {
      deps.mkdirSync(dir, { recursive: true });
      const tempExe = join(dir, `${LAUNCHER_STEM}-${hash}.${deps.pid}.tmp.exe`);
      const compiled = deps.spawnSync(
        csc,
        [
          '/nologo',
          '/optimize',
          '/target:exe',
          '/platform:anycpu',
          `/out:${tempExe}`,
          deps.sourcePath,
        ],
        { windowsHide: true, timeout: SPAWN_TIMEOUT_MS },
      );
      if (compiled.status !== 0) {
        return { exe: null, reason: `launcher compile failed (exit ${String(compiled.status)})` };
      }
      try {
        deps.renameSync(tempExe, exe);
      } catch {
        // A parallel run may have installed the same file first; that is success.
        if (!deps.existsSync(exe)) {
          return { exe: null, reason: 'could not move the compiled launcher into the cache' };
        }
        try {
          deps.unlinkSync(tempExe);
        } catch {
          // Best effort: a stray temp file in the cache is harmless.
        }
      }
    }

    const selfTest = deps.spawnSync(exe, [SELF_TEST_FLAG], {
      windowsHide: true,
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (selfTest.status !== 0) {
      return { exe: null, reason: `launcher self-test failed (exit ${String(selfTest.status)})` };
    }
    return { exe, note: exe };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exe: null, reason: `launcher setup threw: ${message}` };
  }
}
