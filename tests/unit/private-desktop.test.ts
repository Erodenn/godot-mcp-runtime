import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  LAUNCH_TARGET_ENV_VAR,
  resolvePrivateDesktopLauncher,
  type PrivateDesktopDeps,
} from '../helpers/private-desktop.js';

const SYSTEM_ROOT = 'C:\\Windows';
const REPO_ROOT = join('fake', 'repo');
const FAKE_PID = 4242;
const CSC_PATH = join(SYSTEM_ROOT, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const CSC_32_PATH = join(SYSTEM_ROOT, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
const SOURCE_PATH = join('fake', 'private-desktop-launcher.cs');
const CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'godot-mcp-runtime-tests');
// sha256 of the fake source below, first 16 hex characters.
const SOURCE_TEXT = 'class Fake {}';
const SOURCE_HASH = '0da8d0bf1280a3fa';
const HASH_HEX_CHARS = 16;

function makeDeps(
  existing: string[],
  overrides: Partial<PrivateDesktopDeps> = {},
): { deps: Partial<PrivateDesktopDeps>; files: Set<string>; spawn: ReturnType<typeof vi.fn> } {
  const files = new Set([...existing, join(REPO_ROOT, 'node_modules')]);
  const spawn = vi.fn(() => ({ status: 0 }));
  const deps: Partial<PrivateDesktopDeps> = {
    platform: 'win32',
    env: { SystemRoot: SYSTEM_ROOT, GODOT_PATH: 'D:/Godot/godot.exe' },
    existsSync: (path) => files.has(path),
    readFileSync: () => Buffer.from(SOURCE_TEXT),
    spawnSync: spawn,
    renameSync: (from, to) => {
      files.delete(from);
      files.add(to);
    },
    mkdirSync: vi.fn(),
    unlinkSync: (path) => {
      files.delete(path);
    },
    pid: FAKE_PID,
    tmpdir: () => join('fake', 'tmp'),
    repoRoot: REPO_ROOT,
    sourcePath: SOURCE_PATH,
    ...overrides,
  };
  // The compiler "creates" its output so a following rename has something to move.
  spawn.mockImplementation((command: string, args: string[]) => {
    if (command === CSC_PATH || command === CSC_32_PATH) {
      const out = args.find((a) => a.startsWith('/out:'));
      if (out) files.add(out.slice('/out:'.length));
    }
    return { status: 0 };
  });
  return { deps, files, spawn };
}

const finalExe = join(CACHE_DIR, `private-desktop-launcher-${SOURCE_HASH}.exe`);

describe('resolvePrivateDesktopLauncher', () => {
  it('names the variable the launcher reads', () => {
    expect(LAUNCH_TARGET_ENV_VAR).toBe('GODOT_MCP_TEST_LAUNCH_TARGET');
  });

  it('gives null off Windows', () => {
    const { deps, spawn } = makeDeps([CSC_PATH], { platform: 'linux' });
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result).toEqual({ exe: null, reason: 'not Windows' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gives null when the show-windows opt-out is set', () => {
    const { deps } = makeDeps([CSC_PATH], {
      env: { SystemRoot: SYSTEM_ROOT, GODOT_PATH: 'x', GODOT_MCP_TEST_SHOW_WINDOWS: '1' },
    });
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBeNull();
    expect(result).toMatchObject({
      reason: expect.stringContaining('GODOT_MCP_TEST_SHOW_WINDOWS'),
    });
  });

  it('gives null when GODOT_PATH is unset', () => {
    const { deps } = makeDeps([CSC_PATH], { env: { SystemRoot: SYSTEM_ROOT } });
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result).toEqual({ exe: null, reason: 'GODOT_PATH is not set' });
  });

  it('gives null when no compiler exists', () => {
    const { deps, spawn } = makeDeps([]);
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBeNull();
    expect(result).toMatchObject({ reason: expect.stringContaining('csc.exe') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the 32-bit framework directory for the compiler', () => {
    const { deps, spawn } = makeDeps([CSC_32_PATH]);
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBe(finalExe);
    expect(spawn.mock.calls[0]?.[0]).toBe(CSC_32_PATH);
  });

  it('compiles to a pid-named temp file, renames it, then self-tests', () => {
    const { deps, files, spawn } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result).toEqual({ exe: finalExe, note: finalExe });
    expect(files.has(finalExe)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    const [compileCommand, compileArgs, compileOptions] = spawn.mock.calls[0] as [
      string,
      string[],
      { windowsHide: boolean; timeout: number },
    ];
    expect(compileCommand).toBe(CSC_PATH);
    expect(compileArgs).toContain(
      `/out:${join(CACHE_DIR, `private-desktop-launcher-${SOURCE_HASH}.${FAKE_PID}.tmp.exe`)}`,
    );
    expect(compileArgs).toContain(SOURCE_PATH);
    expect(compileOptions.windowsHide).toBe(true);
    expect(spawn.mock.calls[1]?.slice(0, 2)).toEqual([finalExe, ['--self-test']]);
  });

  it('uses a 16 hex character content hash in the exe name', () => {
    const { deps } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher(deps);
    const name = (result.exe ?? '').split(/[\\/]/).pop() ?? '';
    expect(name).toMatch(
      new RegExp(`^private-desktop-launcher-[0-9a-f]{${HASH_HEX_CHARS}}\\.exe$`),
    );
  });

  it('falls back to the temp directory when node_modules is absent', () => {
    const { deps } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher({
      ...deps,
      existsSync: (path) => path === CSC_PATH || path.endsWith('.exe'),
    });
    expect(result.exe).toBe(join('fake', 'tmp', `private-desktop-launcher-${SOURCE_HASH}.exe`));
  });

  it('gives null when the compile fails', () => {
    const { deps, spawn } = makeDeps([CSC_PATH]);
    spawn.mockImplementation(() => ({ status: 1 }));
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBeNull();
    expect(result).toMatchObject({ reason: expect.stringContaining('compile failed') });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('gives null when the self-test fails', () => {
    const { deps, spawn } = makeDeps([CSC_PATH, finalExe]);
    spawn.mockImplementation(() => ({ status: 1 }));
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBeNull();
    expect(result).toMatchObject({ reason: expect.stringContaining('self-test failed') });
  });

  it('gives null when the self-test times out (null status)', () => {
    const { deps, spawn } = makeDeps([CSC_PATH, finalExe]);
    spawn.mockImplementation(() => ({ status: null }));
    expect(resolvePrivateDesktopLauncher(deps).exe).toBeNull();
  });

  it('skips the compile on a cache hit and still self-tests', () => {
    const { deps, spawn } = makeDeps([CSC_PATH, finalExe]);
    const result = resolvePrivateDesktopLauncher(deps);
    expect(result.exe).toBe(finalExe);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe(finalExe);
  });

  it('treats a rename failure as success when the final file now exists', () => {
    const { deps, files } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher({
      ...deps,
      renameSync: () => {
        files.add(finalExe);
        throw new Error('EPERM');
      },
    });
    expect(result.exe).toBe(finalExe);
  });

  it('gives null when the rename fails and no final file exists', () => {
    const { deps } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher({
      ...deps,
      renameSync: () => {
        throw new Error('EPERM');
      },
    });
    expect(result.exe).toBeNull();
  });

  it('never throws, even when a dependency does', () => {
    const { deps } = makeDeps([CSC_PATH]);
    const result = resolvePrivateDesktopLauncher({
      ...deps,
      readFileSync: () => {
        throw new Error('EACCES');
      },
    });
    expect(result).toMatchObject({ exe: null, reason: expect.stringContaining('EACCES') });
  });
});
