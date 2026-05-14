import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BridgeManager } from '../../src/utils/bridge-manager.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const BRIDGE_SOURCE_CONTENT =
  '# fake mcp_bridge.gd source for testing\nextends Node\nconst PORT := 9900\n';

const TEST_PORT = 9900;
const ALT_PORT = 23456;

function bakedContent(port: number): string {
  return BRIDGE_SOURCE_CONTENT.replace(/const PORT := \d+/, `const PORT := ${port}`);
}

/**
 * Set up a minimal project + a stand-in bridge source script. Returns the
 * project path and the BridgeManager pointed at the stand-in source.
 */
function setupProject(opts: { projectGodot?: string; gitignore?: string } = {}): {
  projectPath: string;
  manager: BridgeManager;
  bridgeSourcePath: string;
} {
  const projectPath = tmp.makeProject('mcp-bridge-', opts.projectGodot ?? 'config_version=5\n');
  if (opts.gitignore !== undefined) {
    writeFileSync(join(projectPath, '.gitignore'), opts.gitignore, 'utf8');
  }

  // Stand-in bridge source lives outside the project so copy is observable.
  const sourceDir = tmp.make('mcp-bridge-src-');
  const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
  writeFileSync(bridgeSourcePath, BRIDGE_SOURCE_CONTENT, 'utf8');

  const manager = new BridgeManager(bridgeSourcePath);
  return { projectPath, manager, bridgeSourcePath };
}

describe('BridgeManager.inject', () => {
  it('copies the bridge script, registers the autoload, and writes .mcp/.gdignore', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const bridgeScript = join(projectPath, 'mcp_bridge.gd');
    expect(existsSync(bridgeScript)).toBe(true);
    expect(readFileSync(bridgeScript, 'utf8')).toBe(bakedContent(TEST_PORT));

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });

  it('creates a .gitignore with .mcp/ when none exists', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.mcp/');
  });

  it('appends .mcp/ to an existing .gitignore that lacks it', () => {
    const { projectPath, manager } = setupProject({ gitignore: 'node_modules/\n' });
    manager.inject(projectPath, TEST_PORT);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.mcp/');
  });

  it('does not duplicate the .mcp/ entry on a second inject call', () => {
    const { projectPath, manager } = setupProject({ gitignore: '.mcp/\n' });
    manager.inject(projectPath, TEST_PORT);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    const matches = gitignore.match(/\.mcp\//g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('is idempotent within a session — second inject does not duplicate the autoload entry', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches = projectGodot.match(/McpBridge="\*res:\/\/mcp_bridge\.gd"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('refreshes an existing bridge script from the current source', () => {
    // First manager injects normally.
    const { projectPath, bridgeSourcePath } = setupProject();
    const firstManager = new BridgeManager(bridgeSourcePath);
    firstManager.inject(projectPath, TEST_PORT);

    // Mutate the in-project bridge script to detect the refresh.
    const destScript = join(projectPath, 'mcp_bridge.gd');
    writeFileSync(destScript, '# mutated locally\n', 'utf8');

    // Fresh manager (no in-memory cache) re-injects against the same project.
    const secondManager = new BridgeManager(bridgeSourcePath);
    secondManager.inject(projectPath, TEST_PORT);

    // The bridge script is runtime-owned, so a fresh inject refreshes it.
    expect(readFileSync(destScript, 'utf8')).toBe(bakedContent(TEST_PORT));

    // Autoload entry remains a single, canonical line.
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches = projectGodot.match(/McpBridge="\*res:\/\/mcp_bridge\.gd"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('bakes the supplied port into the destination script', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, ALT_PORT);

    const destScript = join(projectPath, 'mcp_bridge.gd');
    expect(readFileSync(destScript, 'utf8')).toContain(`const PORT := ${ALT_PORT}`);
    expect(readFileSync(destScript, 'utf8')).not.toContain('const PORT := 9900');
  });

  it('rewrites the baked port when inject is called again with a different port', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.inject(projectPath, ALT_PORT);

    const destScript = join(projectPath, 'mcp_bridge.gd');
    expect(readFileSync(destScript, 'utf8')).toContain(`const PORT := ${ALT_PORT}`);
  });

  it('throws if the template lacks the const PORT marker', () => {
    const projectPath = tmp.makeProject('mcp-bridge-bad-', 'config_version=5\n');
    const sourceDir = tmp.make('mcp-bridge-bad-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, '# no marker\nextends Node\n', 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);
    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(/const PORT := <int>/);
  });

  it('inserts McpBridge into an existing empty [autoload] section', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\n',
    });
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');
    const sectionCount = (projectGodot.match(/^\[autoload\]/gm) ?? []).length;
    expect(sectionCount).toBe(1);
  });
});

describe('BridgeManager.cleanup', () => {
  it('removes the autoload entry, the bridge script, and the .uid sidecar', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    // Simulate a .uid sidecar that Godot would create.
    writeFileSync(join(projectPath, 'mcp_bridge.gd.uid'), 'uid://fake', 'utf8');

    manager.cleanup(projectPath);

    expect(existsSync(join(projectPath, 'mcp_bridge.gd'))).toBe(false);
    expect(existsSync(join(projectPath, 'mcp_bridge.gd.uid'))).toBe(false);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('drops the [autoload] section when the bridge was the only entry', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('[autoload]');
  });

  it('preserves other autoload entries when removing the bridge', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\nOtherSingleton="*res://other.gd"\n',
    });
    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain('OtherSingleton="*res://other.gd"');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('allows a fresh inject after cleanup (clears injected-cache)', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    manager.inject(projectPath, TEST_PORT);

    expect(existsSync(join(projectPath, 'mcp_bridge.gd'))).toBe(true);
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');
  });
});

describe('BridgeManager.repairOrphaned', () => {
  it('removes a stale McpBridge autoload entry when the script file is missing', () => {
    const projectPath = tmp.makeProject(
      'mcp-orphan-',
      'config_version=5\n\n[autoload]\nMcpBridge="*res://mcp_bridge.gd"\n',
    );
    const sourceDir = tmp.make('mcp-bridge-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, BRIDGE_SOURCE_CONTENT, 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);

    // Precondition: autoload entry exists, but no script file in project.
    expect(existsSync(join(projectPath, 'mcp_bridge.gd'))).toBe(false);

    manager.repairOrphaned(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('is a no-op when the script file is present (no false-positive cleanup)', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    manager.repairOrphaned(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');
    expect(existsSync(join(projectPath, 'mcp_bridge.gd'))).toBe(true);
  });

  it('is a no-op when project.godot has no McpBridge entry', () => {
    const projectPath = tmp.makeProject('mcp-clean-');
    const sourceDir = tmp.make('mcp-bridge-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, BRIDGE_SOURCE_CONTENT, 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);

    const beforeContent = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    manager.repairOrphaned(projectPath);
    const afterContent = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(afterContent).toBe(beforeContent);
  });
});

describe('BridgeManager.readBakedPort', () => {
  it('returns the port that was baked into the destination script', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, ALT_PORT);
    expect(manager.readBakedPort(projectPath)).toBe(ALT_PORT);
  });

  it('returns null when the script file is missing', () => {
    const projectPath = tmp.makeProject('mcp-bridge-missing-');
    const sourceDir = tmp.make('mcp-bridge-missing-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, BRIDGE_SOURCE_CONTENT, 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);
    expect(manager.readBakedPort(projectPath)).toBeNull();
  });

  it('returns null when the const PORT line is corrupted', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    const destScript = join(projectPath, 'mcp_bridge.gd');
    writeFileSync(destScript, '# corrupted - no port marker\nextends Node\n', 'utf8');
    expect(manager.readBakedPort(projectPath)).toBeNull();
  });
});

describe('BridgeManager handles project layouts', () => {
  it('creates the .mcp directory if it does not exist', () => {
    const { projectPath, manager } = setupProject();
    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);

    manager.inject(projectPath, TEST_PORT);

    expect(existsSync(join(projectPath, '.mcp'))).toBe(true);
    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });

  it('does not error when .mcp exists already', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(join(projectPath, '.mcp'), { recursive: true });

    expect(() => manager.inject(projectPath, TEST_PORT)).not.toThrow();
    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });
});
