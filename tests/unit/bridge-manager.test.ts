import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { BridgeAutoloadCollisionError, BridgeManager } from '../../src/utils/bridge-manager.js';
import {
  BRIDGE_SCRIPT_RES_PATH,
  LEGACY_BRIDGE_SCRIPT_FILENAME,
  bridgeDir,
  bridgeScriptAbsPath,
} from '../../src/utils/artifact-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const BRIDGE_SOURCE_CONTENT =
  '# fake mcp_bridge.gd source for testing\nextends Node\nconst PORT := 9900\nconst SESSION_TOKEN_BAKED := ""\n';

const TEST_PORT = 9900;
const ALT_PORT = 23456;

function bakedContent(port: number, token?: string): string {
  let content = BRIDGE_SOURCE_CONTENT.replace(/const PORT := \d+/, `const PORT := ${port}`);
  if (token !== undefined) {
    content = content.replace(
      /const SESSION_TOKEN_BAKED := "[^"]*"/,
      `const SESSION_TOKEN_BAKED := "${token}"`,
    );
  }
  return content;
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
  it('writes the bridge script under .mcp/godot-runtime/bridge/, registers the namespaced autoload, and writes .mcp/.gdignore', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const bridgeScript = bridgeScriptAbsPath(projectPath);
    expect(existsSync(bridgeScript)).toBe(true);
    expect(readFileSync(bridgeScript, 'utf8')).toBe(bakedContent(TEST_PORT));

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);

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
    const matches =
      projectGodot.match(/McpBridge="\*res:\/\/\.mcp\/godot-runtime\/bridge\/mcp_bridge\.gd"/g) ??
      [];
    expect(matches.length).toBe(1);
  });

  it('refreshes an existing bridge script from the current source', () => {
    // First manager injects normally.
    const { projectPath, bridgeSourcePath } = setupProject();
    const firstManager = new BridgeManager(bridgeSourcePath);
    firstManager.inject(projectPath, TEST_PORT);

    // Mutate the in-project bridge script to detect the refresh.
    const destScript = bridgeScriptAbsPath(projectPath);
    writeFileSync(destScript, '# mutated locally\n', 'utf8');

    // Fresh manager (no in-memory cache) re-injects against the same project.
    const secondManager = new BridgeManager(bridgeSourcePath);
    secondManager.inject(projectPath, TEST_PORT);

    // The bridge script is runtime-owned, so a fresh inject refreshes it.
    expect(readFileSync(destScript, 'utf8')).toBe(bakedContent(TEST_PORT));

    // Autoload entry remains a single, canonical line.
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches =
      projectGodot.match(/McpBridge="\*res:\/\/\.mcp\/godot-runtime\/bridge\/mcp_bridge\.gd"/g) ??
      [];
    expect(matches.length).toBe(1);
  });

  it('bakes the supplied port into the destination script', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, ALT_PORT);

    const destScript = bridgeScriptAbsPath(projectPath);
    expect(readFileSync(destScript, 'utf8')).toContain(`const PORT := ${ALT_PORT}`);
    expect(readFileSync(destScript, 'utf8')).not.toContain('const PORT := 9900');
  });

  it('rewrites the baked port when inject is called again with a different port', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.inject(projectPath, ALT_PORT);

    const destScript = bridgeScriptAbsPath(projectPath);
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

  it('throws if the template lacks the SESSION_TOKEN_BAKED marker', () => {
    const projectPath = tmp.makeProject('mcp-bridge-bad-token-', 'config_version=5\n');
    const sourceDir = tmp.make('mcp-bridge-bad-token-src-');
    const bridgeSourcePath = join(sourceDir, 'mcp_bridge.gd');
    writeFileSync(bridgeSourcePath, 'extends Node\nconst PORT := 9900\n', 'utf8');
    const manager = new BridgeManager(bridgeSourcePath);
    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(/SESSION_TOKEN_BAKED/);
  });

  it('leaves the default empty token when no bakedToken argument is passed', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const destScript = bridgeScriptAbsPath(projectPath);
    expect(readFileSync(destScript, 'utf8')).toContain('const SESSION_TOKEN_BAKED := ""');
  });

  it('bakes the supplied token into the destination script', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT, 'sekrit-token');

    const destScript = bridgeScriptAbsPath(projectPath);
    expect(readFileSync(destScript, 'utf8')).toBe(bakedContent(TEST_PORT, 'sekrit-token'));
  });

  it('rewrites the baked token when inject is called again with a different token', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT, 'first-token');
    manager.inject(projectPath, TEST_PORT, 'second-token');

    const destScript = bridgeScriptAbsPath(projectPath);
    const content = readFileSync(destScript, 'utf8');
    expect(content).toContain('const SESSION_TOKEN_BAKED := "second-token"');
    expect(content).not.toContain('first-token');
  });

  it('inserts McpBridge into an existing empty [autoload] section', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\n',
    });
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
    const sectionCount = (projectGodot.match(/^\[autoload\]/gm) ?? []).length;
    expect(sectionCount).toBe(1);
  });
});

describe('BridgeManager.cleanup', () => {
  it('removes the autoload entry, the bridge script, and the .uid sidecar', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    // Simulate a .uid sidecar that Godot would create.
    writeFileSync(`${bridgeScriptAbsPath(projectPath)}.uid`, 'uid://fake', 'utf8');

    manager.cleanup(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(`${bridgeScriptAbsPath(projectPath)}.uid`)).toBe(false);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('removes an empty bridge/ directory but keeps one holding an unexpected file', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    const strayFile = join(bridgeDir(projectPath), 'stray.txt');
    writeFileSync(strayFile, 'not ours\n', 'utf8');

    manager.cleanup(projectPath);

    // The script still goes; only the rmdir of the now-non-empty dir is skipped.
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(true);
    expect(existsSync(strayFile)).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');

    // With the stray file gone, a second cleanup reclaims the empty directory.
    unlinkSync(strayFile);
    manager.cleanup(projectPath);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
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

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
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
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);

    manager.repairOrphaned(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).not.toContain('McpBridge=');
  });

  it('is a no-op when the script file is present (no false-positive cleanup)', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    manager.repairOrphaned(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
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
    const destScript = bridgeScriptAbsPath(projectPath);
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

  it('leaves an existing .mcp/.gdignore untouched instead of truncating it', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(join(projectPath, '.mcp'), { recursive: true });
    const gdignorePath = join(projectPath, '.mcp', '.gdignore');
    const preseeded = '# do not delete this comment\nsomething-else\n';
    writeFileSync(gdignorePath, preseeded, 'utf8');

    manager.inject(projectPath, TEST_PORT);

    expect(readFileSync(gdignorePath, 'utf8')).toBe(preseeded);
  });
});

// ---------------------------------------------------------------------------
// Migration off the legacy project-root script, and the guard against a
// user's own autoload registered under the reserved McpBridge name.
// ---------------------------------------------------------------------------

describe('BridgeManager migration from the legacy root script', () => {
  it('rewrites a legacy root autoload entry to the namespaced path and relocates the script', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\nMcpBridge="*res://mcp_bridge.gd"\n',
    });
    const legacyScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
    writeFileSync(legacyScript, BRIDGE_SOURCE_CONTENT, 'utf8');

    manager.inject(projectPath, TEST_PORT);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
    expect(projectGodot).not.toContain('McpBridge="*res://mcp_bridge.gd"');
  });

  it('removes the legacy root script and its .uid on cleanup', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\nMcpBridge="*res://mcp_bridge.gd"\n',
    });
    const legacyScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
    writeFileSync(legacyScript, BRIDGE_SOURCE_CONTENT, 'utf8');
    writeFileSync(`${legacyScript}.uid`, 'uid://fake', 'utf8');

    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
    expect(existsSync(legacyScript)).toBe(false);
    expect(existsSync(`${legacyScript}.uid`)).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });

  it('leaves .mcp/.gdignore in place after cleanup', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });
});

describe('BridgeManager guards a user-registered McpBridge autoload', () => {
  const USER_AUTOLOAD_LINE = 'McpBridge="*res://game/my_own_bridge.gd"';

  function setupCollision() {
    return setupProject({
      projectGodot: `config_version=5\n\n[autoload]\n${USER_AUTOLOAD_LINE}\n`,
    });
  }

  it('inject fails with a collision error naming the registered path', () => {
    const { projectPath, manager } = setupCollision();
    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(/res:\/\/game\/my_own_bridge\.gd/);
    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(/reserved/i);
  });

  // The collision is the one inject failure a caller must surface rather than
  // degrade past, so it is a distinct type rather than a bare Error.
  it('throws BridgeAutoloadCollisionError carrying the registered path', () => {
    const { projectPath, manager } = setupCollision();
    let thrown: unknown;
    try {
      manager.inject(projectPath, TEST_PORT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BridgeAutoloadCollisionError);
    expect((thrown as BridgeAutoloadCollisionError).registeredPath).toBe(
      'res://game/my_own_bridge.gd',
    );
  });

  it('inject leaves the user entry untouched and writes no autoload of its own', () => {
    const { projectPath, manager } = setupCollision();
    try {
      manager.inject(projectPath, TEST_PORT);
    } catch {
      // expected — assertions are about what survived
    }
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(USER_AUTOLOAD_LINE);
    expect(projectGodot).not.toContain(BRIDGE_SCRIPT_RES_PATH);
  });

  it('cleanup does not remove a user-owned McpBridge entry', () => {
    const { projectPath, manager } = setupCollision();
    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(USER_AUTOLOAD_LINE);
  });

  it('cleanup does not delete a root mcp_bridge.gd shadowed by a user-owned entry', () => {
    const { projectPath, manager } = setupCollision();
    const rootScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
    writeFileSync(rootScript, '# user code that happens to share the name\n', 'utf8');

    manager.cleanup(projectPath);

    expect(existsSync(rootScript)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repairOrphaned: stranded artifacts from a hard-killed earlier process
// ---------------------------------------------------------------------------

describe('BridgeManager.repairOrphaned stranded artifacts', () => {
  it('removes script and entry when both exist and this instance never injected', () => {
    const { projectPath, manager, bridgeSourcePath } = setupProject();
    // A previous process injected, then was hard-killed: artifacts survive.
    const previousManager = new BridgeManager(bridgeSourcePath);
    previousManager.inject(projectPath, TEST_PORT);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);

    manager.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });

  it('leaves artifacts alone once this instance has injected them', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    manager.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
  });

  // Accepted gap (see the `removeBridgeArtifacts` docstring): with no
  // `McpBridge=` entry at all, repairOrphaned has nothing to test ownership
  // against, so a project-root file named exactly `mcp_bridge.gd` is removed
  // on the assumption it is ours - even when it is actually a user's own
  // script that happens to share the legacy filename. This pins that exact
  // behavior so a future change that alters it fails loudly instead of
  // silently, rather than asserting it should be safe.
  it('accepted gap: deletes a project-root mcp_bridge.gd with no autoload entry to test ownership against', () => {
    const { projectPath, manager } = setupProject();
    const rootScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
    writeFileSync(rootScript, "# user's own script, unrelated to this server\n", 'utf8');
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');

    manager.repairOrphaned(projectPath);

    expect(existsSync(rootScript)).toBe(false);
  });

  it('leaves a user-owned McpBridge entry alone', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\nMcpBridge="*res://game/my_own_bridge.gd"\n',
    });

    manager.repairOrphaned(projectPath);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      'McpBridge="*res://game/my_own_bridge.gd"',
    );
  });
});
