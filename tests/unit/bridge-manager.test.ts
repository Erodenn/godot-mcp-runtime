import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BridgeManager } from '../../src/utils/bridge-manager.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const BRIDGE_SOURCE_CONTENT = '# fake mcp_bridge.gd source for testing\nextends Node\n';

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
    manager.inject(projectPath);

    const bridgeScript = join(projectPath, 'mcp_bridge.gd');
    expect(existsSync(bridgeScript)).toBe(true);
    expect(readFileSync(bridgeScript, 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });

  it('creates a .gitignore with .mcp/ when none exists', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.mcp/');
  });

  it('appends .mcp/ to an existing .gitignore that lacks it', () => {
    const { projectPath, manager } = setupProject({ gitignore: 'node_modules/\n' });
    manager.inject(projectPath);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.mcp/');
  });

  it('does not duplicate the .mcp/ entry on a second inject call', () => {
    const { projectPath, manager } = setupProject({ gitignore: '.mcp/\n' });
    manager.inject(projectPath);

    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    const matches = gitignore.match(/\.mcp\//g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('is idempotent within a session — second inject does not duplicate the autoload entry', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath);
    manager.inject(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches = projectGodot.match(/McpBridge="\*res:\/\/mcp_bridge\.gd"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('inserts McpBridge into an existing empty [autoload] section', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\n',
    });
    manager.inject(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');
    const sectionCount = (projectGodot.match(/^\[autoload\]/gm) ?? []).length;
    expect(sectionCount).toBe(1);
  });
});

describe('BridgeManager.cleanup', () => {
  it('removes the autoload entry, the bridge script, and the .uid sidecar', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath);
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
    manager.inject(projectPath);
    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('[autoload]');
  });

  it('preserves other autoload entries when removing the bridge', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\nOtherSingleton="*res://other.gd"\n',
    });
    manager.inject(projectPath);
    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain('OtherSingleton="*res://other.gd"');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('allows a fresh inject after cleanup (clears injected-cache)', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath);
    manager.cleanup(projectPath);

    manager.inject(projectPath);

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
    manager.inject(projectPath);

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

describe('BridgeManager legacy cleanup', () => {
  it('on inject, removes the legacy McpScreenshotServer autoload if present', () => {
    const projectPath = tmp.makeProject(
      'mcp-legacy-',
      'config_version=5\n\n[autoload]\nMcpScreenshotServer="*res://mcp_screenshot_server.gd"\n',
    );
    // Simulate the legacy script file being present.
    writeFileSync(join(projectPath, 'mcp_screenshot_server.gd'), '# legacy', 'utf8');

    const sourceDir = tmp.make('mcp-bridge-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, BRIDGE_SOURCE_CONTENT, 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);

    manager.inject(projectPath);

    expect(existsSync(join(projectPath, 'mcp_screenshot_server.gd'))).toBe(false);
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('McpScreenshotServer');
    expect(projectGodot).toContain('McpBridge="*res://mcp_bridge.gd"');
  });
});

describe('BridgeManager handles project layouts', () => {
  it('creates the .mcp directory if it does not exist', () => {
    const { projectPath, manager } = setupProject();
    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);

    manager.inject(projectPath);

    expect(existsSync(join(projectPath, '.mcp'))).toBe(true);
    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });

  it('does not error when .mcp exists already', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(join(projectPath, '.mcp'), { recursive: true });

    expect(() => manager.inject(projectPath)).not.toThrow();
    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });
});
