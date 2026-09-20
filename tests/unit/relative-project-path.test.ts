import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const { MOCK_BRIDGE_PORT, spawnMock, findFreePortMock, injectMock, cleanupMock } = vi.hoisted(
  () => {
    const port = 12345;
    return {
      MOCK_BRIDGE_PORT: port,
      spawnMock: vi.fn(),
      findFreePortMock: vi.fn(async () => port),
      injectMock: vi.fn(),
      cleanupMock: vi.fn(),
    };
  },
);

// Specifiers resolve relative to THIS file, so they must name the same module
// ids godot-runner.ts imports. A mismatch binds nothing, silently, and the real
// implementation runs instead.
vi.mock('child_process', async () => ({
  ...(await vi.importActual('child_process')),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('../../src/utils/bridge-protocol.js', async () => {
  const actual = await vi.importActual('../../src/utils/bridge-protocol.js');
  return { ...actual, findFreePort: findFreePortMock };
});
vi.mock('../../src/utils/path-validation.js', async () => {
  const actual = await vi.importActual('../../src/utils/path-validation.js');
  return { ...actual, checkDisplayAvailable: () => true, validateSubPath: () => false };
});
vi.mock('../../src/utils/bridge-manager.js', () => ({
  BridgeManager: class {
    inject = injectMock;
    cleanup = cleanupMock;
    getLastInjectedPort = () => MOCK_BRIDGE_PORT;
  },
}));

import { GodotRunner } from '../../src/utils/godot-runner.js';

function fakeSpawnedProcess() {
  return {
    pid: 4242,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
}

describe('runProject relative projectPath regression', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'gmr-rel-path-'));
    writeFileSync(join(projectDir, 'project.godot'), '[application]');
    spawnMock.mockReset().mockReturnValue(fakeSpawnedProcess());
    injectMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('stores the absolute path so pollBridge can match the bridge-reported project_path', async () => {
    // Regression: with a relative path ('.'), waitForBridge's path guard
    // compared the bridge-reported absolute project_path against '.' and
    // failed instantly: misreported as a generic 8s bridge timeout.
    const cwdSave = process.cwd();
    process.chdir(projectDir);
    try {
      const runner = new GodotRunner({ godotPath: process.execPath });
      await runner.runProject('.', undefined, true);
      expect(runner.activeProjectPath).toBe(resolve('.'));
      // spawn argv carries the resolved path: Godot loads the project from it
      const spawnArgs = spawnMock.mock.calls[0] as unknown[];
      expect(spawnArgs[1]).toContain('--path');
      expect(spawnArgs[1]).toContain(resolve('.'));
      expect(injectMock).toHaveBeenCalled();
      expect(runner.activeBridgePort).toBe(MOCK_BRIDGE_PORT);
    } finally {
      process.chdir(cwdSave);
    }
  });

  it('keeps absolute paths unchanged', async () => {
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, undefined, true);
    expect(runner.activeProjectPath).toBe(resolve(projectDir));
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    expect(spawnArgs[1]).toContain(resolve(projectDir));
    expect(injectMock).toHaveBeenCalled();
    expect(runner.activeBridgePort).toBe(MOCK_BRIDGE_PORT);
  });

  // CI runs the unit suite on ubuntu-latest with no xvfb, where the real
  // checkDisplayAvailable() rejects the launch. Fake it so an unbound
  // path-validation mock fails here instead of only in CI.
  it('runs under headless-CI conditions (linux, no DISPLAY)', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('DISPLAY', undefined);
    vi.stubEnv('WAYLAND_DISPLAY', undefined);
    try {
      const runner = new GodotRunner({ godotPath: process.execPath });
      await expect(runner.runProject(projectDir, undefined, true)).resolves.toBeDefined();
      expect(runner.activeProjectPath).toBe(resolve(projectDir));
    } finally {
      vi.unstubAllEnvs();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });
});
