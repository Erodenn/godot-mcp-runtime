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
  return { ...actual, checkDisplayAvailable: () => true };
});
vi.mock('../../src/utils/bridge-manager.js', () => ({
  BridgeManager: class {
    precheckInject = () => '';
    inject = injectMock;
    cleanup = cleanupMock;
    getLastInjectedPort = () => MOCK_BRIDGE_PORT;
  },
}));

import { GodotRunner } from '../../src/utils/godot-runner.js';
import { resolveProjectPath } from '../../src/utils/path-validation.js';

function fakeSpawnedProcess() {
  return {
    pid: 4242,
    stdout: { on: vi.fn(), once: vi.fn() },
    stderr: { on: vi.fn(), once: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
}

describe('runProject scene argument', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'gmr-scene-arg-'));
    writeFileSync(join(projectDir, 'project.godot'), '[application]');
    spawnMock.mockReset().mockReturnValue(fakeSpawnedProcess());
    injectMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('appends the scene res:// path to the Godot argv after --path', async () => {
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(
      projectDir,
      resolveProjectPath(projectDir, 'scenes/level.tscn', 'read')!,
      true,
    );
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    expect(spawnArgs[1]).toEqual(['--path', resolve(projectDir), 'res://scenes/level.tscn']);
  });

  it('omits the scene argument when no scene is passed', async () => {
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, undefined, true);
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    expect(argv).toHaveLength(2);
  });

  it('keeps the scene argument after the profiler flags', async () => {
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(
      projectDir,
      resolveProjectPath(projectDir, 'scenes/level.tscn', 'read')!,
      true,
      undefined,
      true,
    );
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    const remoteDebugIndex = argv.indexOf('--remote-debug');
    const sceneIndex = argv.indexOf('res://scenes/level.tscn');
    expect(remoteDebugIndex).toBeGreaterThanOrEqual(0);
    expect(sceneIndex).toBeGreaterThan(remoteDebugIndex);
  });
});
