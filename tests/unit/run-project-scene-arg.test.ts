import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const {
  MOCK_BRIDGE_PORT,
  spawnMock,
  findFreePortMock,
  injectMock,
  cleanupMock,
  validateSubPathMock,
} = vi.hoisted(() => {
  const port = 12345;
  return {
    MOCK_BRIDGE_PORT: port,
    spawnMock: vi.fn(),
    findFreePortMock: vi.fn(async () => port),
    injectMock: vi.fn(),
    cleanupMock: vi.fn(),
    validateSubPathMock: vi.fn(() => true),
  };
});

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
  return { ...actual, checkDisplayAvailable: () => true, validateSubPath: validateSubPathMock };
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

describe('runProject scene argument', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'gmr-scene-arg-'));
    writeFileSync(join(projectDir, 'project.godot'), '[application]');
    spawnMock.mockReset().mockReturnValue(fakeSpawnedProcess());
    injectMock.mockReset();
    validateSubPathMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('appends the scene path to the Godot argv after --path', async () => {
    validateSubPathMock.mockReturnValue(true);
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, 'scenes/level.tscn', true);
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    expect(spawnArgs[1]).toEqual(['--path', resolve(projectDir), 'scenes/level.tscn']);
  });

  it('omits the scene argument when validateSubPath rejects it', async () => {
    validateSubPathMock.mockReturnValue(false);
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, 'scenes/level.tscn', true);
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    expect(argv).toHaveLength(2);
    expect(argv).not.toContain('scenes/level.tscn');
  });

  it('omits the scene argument when no scene is passed', async () => {
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, undefined, true);
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    expect(argv).toHaveLength(2);
  });

  it('keeps the scene argument after the profiler flags', async () => {
    validateSubPathMock.mockReturnValue(true);
    const runner = new GodotRunner({ godotPath: process.execPath });
    await runner.runProject(projectDir, 'scenes/level.tscn', true, undefined, true);
    const spawnArgs = spawnMock.mock.calls[0] as unknown[];
    const argv = spawnArgs[1] as string[];
    const remoteDebugIndex = argv.indexOf('--remote-debug');
    const sceneIndex = argv.indexOf('scenes/level.tscn');
    expect(remoteDebugIndex).toBeGreaterThanOrEqual(0);
    expect(sceneIndex).toBeGreaterThan(remoteDebugIndex);
  });
});
