import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  BridgeAttachConflictError,
  BridgeAutoloadCollisionError,
  BridgeManager,
  BridgeRegistryUnreadableError,
} from '../../src/utils/bridge-manager.js';
import type { BridgeManagerOptions } from '../../src/utils/bridge-manager.js';
import {
  BRIDGE_SCRIPT_RES_PATH,
  LEGACY_BRIDGE_SCRIPT_FILENAME,
  bridgeDir,
  bridgeOwnersDir,
  bridgeScriptAbsPath,
} from '../../src/utils/artifact-paths.js';
import { removeAutoloadEntry } from '../../src/utils/autoload-ini.js';
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
function setupProject(
  opts: {
    projectGodot?: string;
    gitignore?: string;
    managerOptions?: BridgeManagerOptions;
  } = {},
): {
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

  const manager = new BridgeManager(bridgeSourcePath, opts.managerOptions);
  return { projectPath, manager, bridgeSourcePath };
}

function ownerFileNames(projectPath: string): string[] {
  const dir = bridgeOwnersDir(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

describe('BridgeManager.inject', () => {
  it('writes the bridge script under .mcp/godot-runtime/bridge/, registers the namespaced autoload, and writes .mcp/.gdignore', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const bridgeScript = bridgeScriptAbsPath(projectPath);
    expect(existsSync(bridgeScript)).toBe(true);
    // Spawned inject never bakes: the script matches the template unchanged.
    expect(readFileSync(bridgeScript, 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain('[autoload]');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });

  it('writes its own owner file under bridge/owners/', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    const names = ownerFileNames(projectPath);
    expect(names.length).toBe(1);
    const info = JSON.parse(readFileSync(join(bridgeOwnersDir(projectPath), names[0]!), 'utf8'));
    expect(info).toMatchObject({ mode: 'spawned', port: TEST_PORT });
    expect(typeof info.pid).toBe('number');
    expect(typeof info.instanceId).toBe('string');
    expect(typeof info.hostname).toBe('string');
    expect(info.token).toBeUndefined();
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

  it('is idempotent within a session: second inject does not duplicate the autoload entry', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches =
      projectGodot.match(/McpBridge="\*res:\/\/\.mcp\/godot-runtime\/bridge\/mcp_bridge\.gd"/g) ??
      [];
    expect(matches.length).toBe(1);
    // Restarting an already-injected session overwrites its own owner file
    // rather than accumulating a second one.
    expect(ownerFileNames(projectPath).length).toBe(1);
  });

  it('refreshes an existing bridge script from the current source (spawned: template, unbaked)', () => {
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
    expect(readFileSync(destScript, 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);

    // Autoload entry remains a single, canonical line.
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const matches =
      projectGodot.match(/McpBridge="\*res:\/\/\.mcp\/godot-runtime\/bridge\/mcp_bridge\.gd"/g) ??
      [];
    expect(matches.length).toBe(1);
  });

  it('spawned inject never bakes the port into the destination script', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, ALT_PORT);

    const destScript = bridgeScriptAbsPath(projectPath);
    expect(readFileSync(destScript, 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);
    expect(readFileSync(destScript, 'utf8')).toContain('const PORT := 9900');
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

  it('bakes the supplied port and token into the destination script for attach mode', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT, 'sekrit-token');

    const destScript = bridgeScriptAbsPath(projectPath);
    expect(readFileSync(destScript, 'utf8')).toBe(bakedContent(TEST_PORT, 'sekrit-token'));
  });

  it('rewrites the baked port/token when attach-mode inject is called again with different values', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT, 'first-token');
    manager.inject(projectPath, ALT_PORT, 'second-token');

    const destScript = bridgeScriptAbsPath(projectPath);
    const content = readFileSync(destScript, 'utf8');
    expect(content).toContain(`const PORT := ${ALT_PORT}`);
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

  it('restores the autoload entry on a restart-inject after it was removed out from under the session (the reported #61 failure)', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    // Simulate a sibling process (or an older server) stripping the entry
    // while this session is still live.
    removeAutoloadEntry(join(projectPath, 'project.godot'), 'McpBridge');
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');

    // Same session, restarted: run_project again without an intervening
    // stop_project. inject must not short-circuit on "already injected".
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
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

  it('allows a fresh inject after cleanup', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    manager.cleanup(projectPath);

    manager.inject(projectPath, TEST_PORT);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
  });
});

describe('BridgeManager on a project.godot written by hand', () => {
  /** A line feed with no carriage return before it: a mixed line ending in a CRLF file. */
  const BARE_LF_REGEX = /(?<!\r)\n/;
  const BRIDGE_LINE = `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`;
  const CRLF_PROJECT = [
    'config_version=5',
    '',
    '[autoload]',
    'OtherSingleton="*res://other.gd"',
    '',
    '[rendering]',
    'x="y"',
    '',
  ].join('\r\n');
  const COMMENTED_PROJECT =
    'config_version=5\n\n[autoload] ; x\nOtherSingleton="*res://other.gd"\n\n[rendering]\nx="y"\n';

  it('inject and cleanup on a CRLF project leave every other line byte-equal', () => {
    const { projectPath, manager } = setupProject({ projectGodot: CRLF_PROJECT });
    const projectFile = join(projectPath, 'project.godot');

    manager.inject(projectPath, TEST_PORT);
    const injected = readFileSync(projectFile, 'utf8');
    expect(injected).toBe(
      CRLF_PROJECT.replace(
        'OtherSingleton="*res://other.gd"\r\n',
        `OtherSingleton="*res://other.gd"\r\n${BRIDGE_LINE}\r\n`,
      ),
    );
    expect(injected).not.toMatch(BARE_LF_REGEX);

    expect(manager.cleanup(projectPath)).toEqual([]);
    expect(readFileSync(projectFile, 'utf8')).toBe(CRLF_PROJECT);
  });

  it('cleanup on a CRLF project whose only entry was the bridge writes no bare line feed', () => {
    const withoutAutoloads = 'config_version=5\r\n\r\n[rendering]\r\nx="y"\r\n';
    const { projectPath, manager } = setupProject({ projectGodot: withoutAutoloads });
    const projectFile = join(projectPath, 'project.godot');
    manager.inject(projectPath, TEST_PORT);
    expect(readFileSync(projectFile, 'utf8')).not.toMatch(BARE_LF_REGEX);

    manager.cleanup(projectPath);
    expect(readFileSync(projectFile, 'utf8')).toBe(withoutAutoloads);
  });

  it('inject under a commented [autoload] header adds no second header', () => {
    const { projectPath, manager } = setupProject({ projectGodot: COMMENTED_PROJECT });
    manager.inject(projectPath, TEST_PORT);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(
      COMMENTED_PROJECT.replace(
        'OtherSingleton="*res://other.gd"\n',
        `OtherSingleton="*res://other.gd"\n${BRIDGE_LINE}\n`,
      ),
    );
    expect(manager.isBridgeAutoloadRegistered(projectPath)).toBe(true);
  });

  it('cleanup under a commented [autoload] header removes the entry and nothing else', () => {
    const { projectPath, manager } = setupProject({ projectGodot: COMMENTED_PROJECT });
    manager.inject(projectPath, TEST_PORT);

    expect(manager.cleanup(projectPath)).toEqual([]);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(COMMENTED_PROJECT);
  });

  it('a second inject under a commented header sees the entry and does not add another', () => {
    const { projectPath, manager } = setupProject({ projectGodot: COMMENTED_PROJECT });
    manager.inject(projectPath, TEST_PORT);
    manager.inject(projectPath, TEST_PORT);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot.split(BRIDGE_LINE).length - 1).toBe(1);
    expect((projectGodot.match(/^\[autoload\]/gm) ?? []).length).toBe(1);
  });

  it('a user-owned McpBridge under a commented header still collides', () => {
    const { projectPath, manager } = setupProject({
      projectGodot:
        'config_version=5\n\n[autoload] ; x\nMcpBridge="*res://mine/bridge.gd" ; mine\n',
    });
    const before = readFileSync(join(projectPath, 'project.godot'), 'utf8');

    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(BridgeAutoloadCollisionError);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(before);
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
      // expected: assertions are about what survived
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

  // Even when the user-owned entry is the only "owner" on the project (this
  // server never registered itself as live here at all), cleanup still must
  // not touch it.
  it('cleanup leaves a user-owned entry alone even with no owner file registry at all', () => {
    const { projectPath, manager } = setupCollision();
    expect(existsSync(bridgeOwnersDir(projectPath))).toBe(false);

    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(USER_AUTOLOAD_LINE);
  });
});

// ---------------------------------------------------------------------------
// repairOrphaned: stranded artifacts from a hard-killed earlier process
// ---------------------------------------------------------------------------

describe('BridgeManager.repairOrphaned stranded artifacts', () => {
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

  // A hand-edited project.godot can carry spaces around the `=`. That is still
  // the entry Godot loads, so it is still a stranded one.
  it('finds a stranded entry written with spaces around the equals sign', () => {
    const { projectPath, manager } = setupProject({
      projectGodot: `config_version=5\n\n[autoload]\nMcpBridge = "*${BRIDGE_SCRIPT_RES_PATH}"\n`,
    });
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);

    manager.repairOrphaned(projectPath);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge');
  });

  // cleanup tells its caller the next headless call retries a removal it could
  // not confirm. Headless tools pass the path as the caller spelled it, while
  // inject and cleanup get the resolved one, so the retry only happens when
  // the "already checked" cache folds the two spellings together.
  it('retries a removal cleanup could not confirm when the next call spells the path differently', () => {
    let failRemoval = false;
    const { projectPath, manager } = setupProject({
      managerOptions: {
        removeAutoloadEntry: (projectFile, name) => {
          if (failRemoval) throw new Error('project.godot is locked');
          return removeAutoloadEntry(projectFile, name);
        },
      },
    });
    // Same directory, another spelling: forward slashes and a trailing slash.
    const respelled = `${projectPath.replace(/\\/g, '/')}/`;
    const projectFile = join(projectPath, 'project.godot');

    // A headless call on the clean project caches it as checked.
    manager.repairOrphaned(respelled);

    manager.inject(projectPath, TEST_PORT);
    failRemoval = true;
    const problems = manager.cleanup(projectPath);
    expect(problems.join(' ')).toContain('could not be removed from project.godot');
    expect(readFileSync(projectFile, 'utf8')).toContain('McpBridge=');

    failRemoval = false;
    manager.repairOrphaned(respelled);

    expect(readFileSync(projectFile, 'utf8')).not.toContain('McpBridge');
  });
});

// ---------------------------------------------------------------------------
// Concurrent sessions on one project: the core of issue #61. Two BridgeManager
// instances sharing one temp project simulate two MCP server processes. Both
// run in this one Vitest process, so they share a real pid; a manager
// representing a "dead" sibling gets a fake pid plus an injected
// isProcessAlive that reports that fake pid dead without contradicting the
// manager's own bookkeeping during its own inject/cleanup calls (which check
// liveness of the owner file they themselves just wrote).
// ---------------------------------------------------------------------------

describe('BridgeManager with concurrent sessions on one project', () => {
  it("A injects, B runs repairOrphaned -> A's script, entry and owner file all survive", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath);
    managerA.inject(projectPath, TEST_PORT);
    expect(ownerFileNames(projectPath).length).toBe(1);

    const managerB = new BridgeManager(bridgeSourcePath);
    managerB.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
    expect(ownerFileNames(projectPath).length).toBe(1);
  });

  it("A and B both inject; B cleans up leaving entry/script intact and A's owner remaining; A cleans up leaving nothing", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath);
    const managerB = new BridgeManager(bridgeSourcePath);
    managerA.inject(projectPath, TEST_PORT);
    managerB.inject(projectPath, ALT_PORT);
    expect(ownerFileNames(projectPath).length).toBe(2);

    managerB.cleanup(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
    expect(ownerFileNames(projectPath).length).toBe(1);

    managerA.cleanup(projectPath);

    expect(existsSync(bridgeOwnersDir(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });

  it('restart-inject after the entry was stripped restores it without an intervening stop (the exact reported #61 failure)', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath);
    managerA.inject(projectPath, TEST_PORT);

    removeAutoloadEntry(join(projectPath, 'project.godot'), 'McpBridge');
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');

    // Same session object, no cleanup() in between - mirrors GodotRunner.runProject
    // re-running on the same project without an intervening stop_project.
    managerA.inject(projectPath, TEST_PORT);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
  });

  it("A's owner is marked dead -> B's repairOrphaned (B not injected) prunes A's file and removes the artifacts", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const deadPid = 424242;
    // From A's own point of view it is alive (so its own inject bookkeeping
    // does not immediately prune the file it just wrote).
    const managerA = new BridgeManager(bridgeSourcePath, {
      pid: () => deadPid,
      isProcessAlive: () => true,
    });
    managerA.inject(projectPath, TEST_PORT);
    expect(ownerFileNames(projectPath).length).toBe(1);

    // B treats A's specific pid as dead, using the real pid for everything else.
    const managerB = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: (pid) => pid !== deadPid,
    });
    managerB.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeOwnersDir(projectPath))).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });

  it('an owner with a foreign hostname is treated as live and never pruned', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath, {
      hostname: () => 'some-other-machine',
    });
    managerA.inject(projectPath, TEST_PORT);
    expect(ownerFileNames(projectPath).length).toBe(1);

    // B runs with a *different* isProcessAlive that would report every pid
    // dead, to prove the hostname mismatch alone is what keeps A live: a
    // foreign host can't be probed, so it is conservatively kept.
    const managerB = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: () => false,
    });
    managerB.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(ownerFileNames(projectPath).length).toBe(1);
  });

  it('listOtherLiveOwners excludes self and dead owners', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const deadPid = 555555;
    const managerDead = new BridgeManager(bridgeSourcePath, {
      pid: () => deadPid,
      isProcessAlive: () => true,
    });
    managerDead.inject(projectPath, TEST_PORT);

    const managerSelf = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: (pid) => pid !== deadPid,
    });
    managerSelf.inject(projectPath, ALT_PORT);

    const managerLiveOther = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: (pid) => pid !== deadPid,
    });
    managerLiveOther.inject(projectPath, ALT_PORT + 1);

    const others = managerSelf.listOtherLiveOwners(projectPath);
    expect(others.length).toBe(1);
    expect(others[0]!.port).toBe(ALT_PORT + 1);
  });

  describe('attach mode: single-attach-owner rule', () => {
    it('a second attach session on the same project is refused with no writes', () => {
      const { projectPath, bridgeSourcePath } = setupProject();
      const managerA = new BridgeManager(bridgeSourcePath);
      managerA.inject(projectPath, TEST_PORT, 'token-a');
      const beforeScript = readFileSync(bridgeScriptAbsPath(projectPath), 'utf8');
      const beforeOwners = ownerFileNames(projectPath);

      const managerB = new BridgeManager(bridgeSourcePath);
      let thrown: unknown;
      try {
        managerB.inject(projectPath, ALT_PORT, 'token-b');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(BridgeAttachConflictError);
      expect(readFileSync(bridgeScriptAbsPath(projectPath), 'utf8')).toBe(beforeScript);
      expect(ownerFileNames(projectPath)).toEqual(beforeOwners);
    });

    it('an attach refused by an owner from another host names that host and the owner file to delete', () => {
      const { projectPath, bridgeSourcePath } = setupProject();
      const managerA = new BridgeManager(bridgeSourcePath, {
        hostname: () => 'some-other-machine',
      });
      managerA.inject(projectPath, TEST_PORT, 'token-a');
      const [foreignOwnerFile] = ownerFileNames(projectPath);

      const managerB = new BridgeManager(bridgeSourcePath, { hostname: () => 'this-machine' });
      let thrown: unknown;
      try {
        managerB.inject(projectPath, ALT_PORT, 'token-b');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(BridgeAttachConflictError);
      const conflict = thrown as BridgeAttachConflictError;
      expect(conflict.message).toContain(
        'registered from another host ("some-other-machine"; this host is "this-machine")',
      );
      expect(conflict.foreignHostSolution).toContain(
        join(bridgeOwnersDir(projectPath), foreignOwnerFile!),
      );
      // Naming the file changes nothing about who counts as live: the foreign
      // owner is still there.
      expect(ownerFileNames(projectPath)).toEqual([foreignOwnerFile]);
    });

    it('an attach refused by an owner on this host carries no foreign-host remedy', () => {
      const { projectPath, bridgeSourcePath } = setupProject();
      new BridgeManager(bridgeSourcePath).inject(projectPath, TEST_PORT, 'token-a');

      let thrown: unknown;
      try {
        new BridgeManager(bridgeSourcePath).inject(projectPath, ALT_PORT, 'token-b');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(BridgeAttachConflictError);
      expect((thrown as BridgeAttachConflictError).foreignHostSolution).toBeUndefined();
      expect((thrown as Error).message).not.toContain('another host');
    });

    it('a spawned inject alongside a live attach owner is allowed and does not disturb the baked port/token', () => {
      const { projectPath, bridgeSourcePath } = setupProject();
      const managerA = new BridgeManager(bridgeSourcePath);
      managerA.inject(projectPath, TEST_PORT, 'attach-token');

      const managerB = new BridgeManager(bridgeSourcePath);
      expect(() => managerB.inject(projectPath, ALT_PORT)).not.toThrow();

      const script = readFileSync(bridgeScriptAbsPath(projectPath), 'utf8');
      expect(script).toContain(`const PORT := ${TEST_PORT}`);
      expect(script).toContain('const SESSION_TOKEN_BAKED := "attach-token"');
      expect(ownerFileNames(projectPath).length).toBe(2);
    });

    it("the attach owner leaving resets the script to template defaults while the remaining spawned owner's entry stays", () => {
      const { projectPath, bridgeSourcePath } = setupProject();
      const managerA = new BridgeManager(bridgeSourcePath);
      managerA.inject(projectPath, TEST_PORT, 'attach-token');
      const managerB = new BridgeManager(bridgeSourcePath);
      managerB.inject(projectPath, ALT_PORT);

      managerA.cleanup(projectPath);

      const script = readFileSync(bridgeScriptAbsPath(projectPath), 'utf8');
      expect(script).toBe(BRIDGE_SOURCE_CONTENT);
      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
        `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
      );
      expect(ownerFileNames(projectPath).length).toBe(1);
    });
  });
});

describe('BridgeManager.ensureArtifactRoot', () => {
  it('creates .mcp/.gdignore and the .gitignore entry without touching project.godot', () => {
    const { projectPath } = setupProject();
    const projectGodotPath = join(projectPath, 'project.godot');
    const before = readFileSync(projectGodotPath);

    BridgeManager.ensureArtifactRoot(projectPath);

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
    expect(readFileSync(join(projectPath, '.gitignore'), 'utf8')).toContain('.mcp/');
    expect(readFileSync(projectGodotPath).equals(before)).toBe(true);
  });

  it('is idempotent and keeps an existing .gdignore', () => {
    const { projectPath } = setupProject();
    const gdignorePath = join(projectPath, '.mcp', '.gdignore');
    mkdirSync(join(projectPath, '.mcp'), { recursive: true });
    writeFileSync(gdignorePath, 'user content\n', 'utf8');

    BridgeManager.ensureArtifactRoot(projectPath);
    BridgeManager.ensureArtifactRoot(projectPath);

    expect(readFileSync(gdignorePath, 'utf8')).toBe('user content\n');
    const gitignore = readFileSync(join(projectPath, '.gitignore'), 'utf8');
    expect(gitignore.split('.mcp/').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cleanup reports the steps it could not confirm. It still never throws, and
// what it deletes, and in what order, is unchanged.
// ---------------------------------------------------------------------------

describe('BridgeManager.cleanup reports what it could not confirm', () => {
  const projectGodotOf = (projectPath: string): string =>
    readFileSync(join(projectPath, 'project.godot'), 'utf8');

  it('returns no problems when every artifact was removed', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    expect(manager.cleanup(projectPath)).toEqual([]);
    expect(projectGodotOf(projectPath)).not.toContain('McpBridge=');
  });

  it('returns no problems for a project it never injected into', () => {
    const { projectPath, manager } = setupProject();
    expect(manager.cleanup(projectPath)).toEqual([]);
  });

  // A locked or read-only project.godot is the costly case: the script goes,
  // the entry stays, and the project's own launches then fail on it.
  it('cleanup reports an autoload entry it could not remove', () => {
    const { projectPath, manager } = setupProject({
      managerOptions: {
        removeAutoloadEntry: () => {
          throw new Error('EPERM: operation not permitted, rename project.godot');
        },
      },
    });
    manager.inject(projectPath, TEST_PORT);

    const problems = manager.cleanup(projectPath);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'the McpBridge autoload entry could not be removed from project.godot (EPERM: operation not permitted, rename project.godot)',
    );
    expect(problems[0]).toContain('remove the McpBridge= line under [autoload] by hand');
    expect(problems[0]).toContain('run any headless tool on this project to retry');
    // What is deleted is unchanged: the script still goes, the entry stays.
    expect(projectGodotOf(projectPath)).toContain('McpBridge=');
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
  });

  it('reads project.godot back instead of trusting a removal that returned', () => {
    const { projectPath, manager } = setupProject({
      // Claims success and changes nothing.
      managerOptions: { removeAutoloadEntry: () => true },
    });
    manager.inject(projectPath, TEST_PORT);

    const problems = manager.cleanup(projectPath);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is still registered in project.godot after the removal');
    expect(projectGodotOf(projectPath)).toContain('McpBridge=');
  });

  it('a stranded entry that could not be removed is retried by the next repairOrphaned', () => {
    let failRemoval = true;
    const { projectPath, manager } = setupProject({
      managerOptions: {
        removeAutoloadEntry: (projectFile, name) => {
          if (failRemoval) throw new Error('EBUSY: resource busy or locked');
          return removeAutoloadEntry(projectFile, name);
        },
      },
    });
    manager.inject(projectPath, TEST_PORT);
    expect(manager.cleanup(projectPath)).toHaveLength(1);

    // Still failing: the project must not be remembered as clean.
    manager.repairOrphaned(projectPath);
    expect(projectGodotOf(projectPath)).toContain('McpBridge=');

    failRemoval = false;
    manager.repairOrphaned(projectPath);
    expect(projectGodotOf(projectPath)).not.toContain('McpBridge=');
  });
});

// ---------------------------------------------------------------------------
// The owner registry: only a missing directory is an empty registry. One that
// exists and cannot be read is unknown, and unknown must not read as "nobody
// is running this project".
//
// Portable triggers, no permission bits involved: a regular file where the
// owners directory should be makes the listing fail, and a directory named
// like an owner file makes that one read fail.
// ---------------------------------------------------------------------------

describe('BridgeManager owner registry read failures', () => {
  const UNREADABLE_OWNER_FILE = 'unreadable-owner.json';

  /** Put a regular file where `bridge/owners/` should be. */
  function blockOwnersDirectory(projectPath: string): void {
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(bridgeOwnersDir(projectPath), 'not a directory\n', 'utf8');
  }

  /** Add an entry to the registry that is listed but cannot be read as a file. */
  function addUnreadableOwnerFile(projectPath: string): string {
    const path = join(bridgeOwnersDir(projectPath), UNREADABLE_OWNER_FILE);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('a missing owners directory is still an empty registry', () => {
    const { projectPath, manager } = setupProject();
    expect(existsSync(bridgeOwnersDir(projectPath))).toBe(false);
    expect(manager.listOtherLiveOwners(projectPath)).toEqual([]);
  });

  it('an owners path that cannot be listed is not an empty registry', () => {
    const { projectPath, manager } = setupProject();
    blockOwnersDirectory(projectPath);

    let thrown: unknown;
    try {
      manager.listOtherLiveOwners(projectPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BridgeRegistryUnreadableError);
    expect((thrown as BridgeRegistryUnreadableError).reason).toMatch(/^cannot list /);
  });

  it('an owner file that cannot be read is neither pruned nor ignored', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath);
    managerA.inject(projectPath, TEST_PORT);
    const unreadable = addUnreadableOwnerFile(projectPath);

    const managerB = new BridgeManager(bridgeSourcePath);
    let thrown: unknown;
    try {
      managerB.listOtherLiveOwners(projectPath);
    } catch (err) {
      thrown = err;
    }

    // Not ignored: the answer is "unknown", not a list that leaves it out.
    expect(thrown).toBeInstanceOf(BridgeRegistryUnreadableError);
    expect((thrown as BridgeRegistryUnreadableError).reason).toMatch(/^cannot read /);
    // Not pruned: the entry, and the live owner beside it, are still there.
    expect(existsSync(unreadable)).toBe(true);
    expect(ownerFileNames(projectPath)).toHaveLength(2);
  });

  it('still prunes an owner file that was read and is not valid', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });
    const garbage = join(bridgeOwnersDir(projectPath), 'garbage.json');
    writeFileSync(garbage, '{ not json', 'utf8');

    expect(manager.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(existsSync(garbage)).toBe(false);
  });

  it('cleanup leaves the shared script and entry in place when the registry cannot be read', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);
    addUnreadableOwnerFile(projectPath);

    const problems = manager.cleanup(projectPath);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the bridge owner registry could not be read');
    expect(problems[0]).toContain('were left in place');
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
    // Its own claim is still withdrawn: that step does not depend on the read.
    expect(ownerFileNames(projectPath)).toEqual([UNREADABLE_OWNER_FILE]);
  });

  it('repairOrphaned leaves the artifacts alone when the registry cannot be read', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const managerA = new BridgeManager(bridgeSourcePath);
    managerA.inject(projectPath, TEST_PORT);
    addUnreadableOwnerFile(projectPath);

    const managerB = new BridgeManager(bridgeSourcePath, { isProcessAlive: () => false });
    expect(() => managerB.repairOrphaned(projectPath)).not.toThrow();

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('McpBridge=');
  });

  it('inject fails on an unreadable registry without leaving its own owner file behind', () => {
    const { projectPath, manager } = setupProject();
    addUnreadableOwnerFile(projectPath);

    expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(BridgeRegistryUnreadableError);

    expect(ownerFileNames(projectPath)).toEqual([UNREADABLE_OWNER_FILE]);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });
});
