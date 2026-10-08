import { describe, it, expect, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import {
  BridgeAttachConflictError,
  BridgeAutoloadCollisionError,
  BridgeManager,
  BridgeRegistryUnreadableError,
  foreignHostOwnerRemedy,
} from '../../src/utils/bridge-manager.js';
import type { BridgeManagerOptions, BridgeOwnerInfo } from '../../src/utils/bridge-manager.js';
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
const READ_ONLY_MODE = 0o444;
const READ_WRITE_MODE = 0o644;
/** Reader for a manager standing in for a process that does not exist: no pid to ask the OS about. */
const NO_START_IDENTITY = (): null => null;
/** A start time read this much after an owner's claim is still inside the allowed slack. */

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
    expect(ownerFileNames(projectPath).length).toBe(1);
  });

  it('refreshes an existing bridge script from the current source (spawned: template, unbaked)', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const firstManager = new BridgeManager(bridgeSourcePath);
    firstManager.inject(projectPath, TEST_PORT);

    const destScript = bridgeScriptAbsPath(projectPath);
    writeFileSync(destScript, '# mutated locally\n', 'utf8');

    const secondManager = new BridgeManager(bridgeSourcePath);
    secondManager.inject(projectPath, TEST_PORT);

    expect(readFileSync(destScript, 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);

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

  it('cleanup leaves a user-owned entry alone even with no owner file registry at all', () => {
    const { projectPath, manager } = setupCollision();
    expect(existsSync(bridgeOwnersDir(projectPath))).toBe(false);

    manager.cleanup(projectPath);

    const projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(projectGodot).toContain(USER_AUTOLOAD_LINE);
  });
});

describe('BridgeManager with a user McpBridge line and a server-owned one in the same file', () => {
  const USER_LINE = 'McpBridge="*res://game/my_own_bridge.gd"';
  const SERVER_LINE = `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`;
  const OTHER_LINE = 'Other="*res://other.gd"';

  function setupTwoLines(first: string, second: string) {
    return setupProject({
      projectGodot: `config_version=5\n\n[autoload]\n${first}\n${OTHER_LINE}\n${second}\n`,
    });
  }

  const userLineOnly = `config_version=5\n\n[autoload]\n${USER_LINE}\n${OTHER_LINE}\n`;
  const userLineOnlyAfterOther = `config_version=5\n\n[autoload]\n${OTHER_LINE}\n${USER_LINE}\n`;

  describe('server-owned line last (the entry the engine loads is ours)', () => {
    it('cleanup removes only the server-owned line, leaving the user line as the live entry', () => {
      const { projectPath, manager } = setupTwoLines(USER_LINE, SERVER_LINE);

      expect(manager.cleanup(projectPath)).toEqual([]);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(userLineOnly);
    });

    it('repairOrphaned removes only the server-owned line', () => {
      const { projectPath, manager } = setupTwoLines(USER_LINE, SERVER_LINE);

      manager.repairOrphaned(projectPath);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(userLineOnly);
    });

    it('inject treats the entry as its own, and the cleanup after it still keeps the user line', () => {
      const { projectPath, manager } = setupTwoLines(USER_LINE, SERVER_LINE);

      manager.inject(projectPath, TEST_PORT);
      expect(manager.isBridgeAutoloadRegistered(projectPath)).toBe(true);
      expect(manager.cleanup(projectPath)).toEqual([]);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(userLineOnly);
    });
  });

  describe('user line last (the entry the engine loads belongs to the user)', () => {
    it('inject refuses with a collision and changes nothing in project.godot', () => {
      const { projectPath, manager } = setupTwoLines(SERVER_LINE, USER_LINE);
      const before = readFileSync(join(projectPath, 'project.godot'), 'utf8');

      expect(() => manager.inject(projectPath, TEST_PORT)).toThrow(BridgeAutoloadCollisionError);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(before);
    });

    it('cleanup removes the overridden server-owned line and keeps the user line', () => {
      const { projectPath, manager } = setupTwoLines(SERVER_LINE, USER_LINE);

      expect(manager.cleanup(projectPath)).toEqual([]);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(userLineOnlyAfterOther);
    });

    it('repairOrphaned removes the overridden server-owned line and keeps the user line', () => {
      const { projectPath, manager } = setupTwoLines(SERVER_LINE, USER_LINE);

      manager.repairOrphaned(projectPath);

      expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(userLineOnlyAfterOther);
    });

    it('cleanup keeps a project-root mcp_bridge.gd, which is presumably user code', () => {
      const { projectPath, manager } = setupTwoLines(SERVER_LINE, USER_LINE);
      const rootScript = join(projectPath, LEGACY_BRIDGE_SCRIPT_FILENAME);
      writeFileSync(rootScript, '# user code that happens to share the name\n', 'utf8');

      manager.cleanup(projectPath);

      expect(existsSync(rootScript)).toBe(true);
    });
  });
});

describe('BridgeManager.repairOrphaned stranded artifacts', () => {
  // Accepted gap: with no `McpBridge=` entry, repairOrphaned removes a project-root `mcp_bridge.gd` on the assumption it is ours.
  // This pins that behavior so a change to it fails loudly.
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

  // Headless tools pass the path as the caller spelled it; inject and cleanup get the resolved one.
  // The retry happens only when the "already checked" cache folds the two spellings together.
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
    const respelled = `${projectPath.replace(/\\/g, '/')}/`;
    const projectFile = join(projectPath, 'project.godot');

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

// Two managers in one process share a real pid; a "dead" sibling gets a fake pid and an isProcessAlive that reports only that pid dead.

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

    // Same session object, no cleanup() in between, as runProject re-running without stop_project.
    managerA.inject(projectPath, TEST_PORT);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain(
      `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
    );
  });

  it("A's owner is marked dead -> B's repairOrphaned (B not injected) prunes A's file and removes the artifacts", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const deadPid = 424242;
    const managerA = new BridgeManager(bridgeSourcePath, {
      pid: () => deadPid,
      isProcessAlive: () => true,
      processStartIdentity: NO_START_IDENTITY,
    });
    managerA.inject(projectPath, TEST_PORT);
    expect(ownerFileNames(projectPath).length).toBe(1);

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

    // B's isProcessAlive reports every pid dead, so only the hostname mismatch keeps A live:
    // a foreign host cannot be probed.
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
      processStartIdentity: NO_START_IDENTITY,
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

  it('peekOtherLiveOwners gives the same answer and leaves a dead owner file in place', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const deadPid = 555555;
    const isProcessAlive = (pid: number) => pid !== deadPid;
    const managerSelf = new BridgeManager(bridgeSourcePath, { isProcessAlive });
    new BridgeManager(bridgeSourcePath, { isProcessAlive }).inject(projectPath, ALT_PORT);
    // Registered last, by a manager that takes every pid for alive, so no
    // earlier registry read has pruned it.
    new BridgeManager(bridgeSourcePath, {
      pid: () => deadPid,
      isProcessAlive: () => true,
      processStartIdentity: NO_START_IDENTITY,
    }).inject(projectPath, TEST_PORT);
    const filesBefore = ownerFileNames(projectPath);
    expect(filesBefore).toHaveLength(2);

    const peeked = managerSelf.peekOtherLiveOwners(projectPath);

    expect(peeked.map((owner) => owner.port)).toEqual([ALT_PORT]);
    expect(ownerFileNames(projectPath)).toEqual(filesBefore);
    expect(managerSelf.listOtherLiveOwners(projectPath)).toEqual(peeked);
    expect(ownerFileNames(projectPath)).toHaveLength(1);
  });

  it('peekOtherLiveOwners throws on an unreadable registry, as the pruning read does', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    // A file where the owners directory should be: it exists and cannot be listed.
    writeFileSync(bridgeOwnersDir(projectPath), 'not a directory', 'utf8');

    expect(() => manager.peekOtherLiveOwners(projectPath)).toThrow(BridgeRegistryUnreadableError);
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

    manager.repairOrphaned(projectPath);
    expect(projectGodotOf(projectPath)).toContain('McpBridge=');

    failRemoval = false;
    manager.repairOrphaned(projectPath);
    expect(projectGodotOf(projectPath)).not.toContain('McpBridge=');
  });
});

// Portable triggers, no permission bits: a regular file where the owners dir should be fails the listing,
// and a directory named like an owner file fails that one read.

describe('BridgeManager owner registry read failures', () => {
  const UNREADABLE_OWNER_FILE = 'unreadable-owner.json';

  function blockOwnersDirectory(projectPath: string): void {
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(bridgeOwnersDir(projectPath), 'not a directory\n', 'utf8');
  }

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

    expect(thrown).toBeInstanceOf(BridgeRegistryUnreadableError);
    expect((thrown as BridgeRegistryUnreadableError).reason).toMatch(/^cannot read /);
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

describe('BridgeManager.precheckInject', () => {
  const projectGodotOf = (projectPath: string): string =>
    readFileSync(join(projectPath, 'project.godot'), 'utf8');

  it('passes on a healthy project and writes nothing', () => {
    const { projectPath, manager } = setupProject();
    const before = projectGodotOf(projectPath);

    expect(manager.precheckInject(projectPath, false)).toBe(BRIDGE_SOURCE_CONTENT);
    expect(manager.precheckInject(projectPath, true)).toBe(BRIDGE_SOURCE_CONTENT);

    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);
    expect(existsSync(join(projectPath, '.gitignore'))).toBe(false);
    expect(projectGodotOf(projectPath)).toBe(before);
  });

  it('refuses an attach while another session holds the attach slot, and a spawned start is not refused by it', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const attached = new BridgeManager(bridgeSourcePath);
    attached.inject(projectPath, TEST_PORT, 'token-of-the-attached-session');
    const scriptBefore = readFileSync(bridgeScriptAbsPath(projectPath), 'utf8');

    const other = new BridgeManager(bridgeSourcePath);
    expect(() => other.precheckInject(projectPath, true)).toThrow(BridgeAttachConflictError);
    expect(() => other.precheckInject(projectPath, false)).not.toThrow();

    expect(ownerFileNames(projectPath)).toHaveLength(1);
    expect(readFileSync(bridgeScriptAbsPath(projectPath), 'utf8')).toBe(scriptBefore);
  });

  it("does not count this instance's own attached session as a conflict", () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT, 'first-token');
    expect(() => manager.precheckInject(projectPath, true)).not.toThrow();
  });

  it("refuses on a user's own McpBridge autoload", () => {
    const { projectPath, manager } = setupProject({
      projectGodot: 'config_version=5\n\n[autoload]\n\nMcpBridge="*res://game/own_bridge.gd"\n',
    });
    expect(() => manager.precheckInject(projectPath, false)).toThrow(BridgeAutoloadCollisionError);
    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);
  });

  it('refuses a spawned start too when the owner registry cannot be read', () => {
    const { projectPath, manager } = setupProject();
    mkdirSync(bridgeDir(projectPath), { recursive: true });
    writeFileSync(bridgeOwnersDir(projectPath), 'not a directory\n', 'utf8');

    expect(() => manager.precheckInject(projectPath, false)).toThrow(BridgeRegistryUnreadableError);
    expect(() => manager.precheckInject(projectPath, true)).toThrow(BridgeRegistryUnreadableError);
  });

  it('refuses when the shipped template is missing a marker', () => {
    const { projectPath, manager, bridgeSourcePath } = setupProject();
    writeFileSync(bridgeSourcePath, 'extends Node\n', 'utf8');
    expect(() => manager.precheckInject(projectPath, false)).toThrow(/missing the 'const PORT/);
  });

  it('does not refuse a read-only project.godot: the write is a rename, which the directory decides', () => {
    const { projectPath, manager } = setupProject();
    const projectFile = join(projectPath, 'project.godot');
    chmodSync(projectFile, READ_ONLY_MODE);
    try {
      expect(() => manager.precheckInject(projectPath, false)).not.toThrow();
      expect(() => manager.precheckInject(projectPath, true)).not.toThrow();
    } finally {
      chmodSync(projectFile, READ_WRITE_MODE);
    }
  });

  // On Windows the read-only attribute blocks the rename over the file, and
  // the inject fails there; the caller then withdraws what it wrote.
  it.skipIf(process.platform === 'win32')(
    'injects into a read-only project.godot in a writable directory',
    () => {
      const { projectPath, manager } = setupProject();
      const projectFile = join(projectPath, 'project.godot');
      chmodSync(projectFile, READ_ONLY_MODE);
      try {
        manager.inject(projectPath, TEST_PORT);
        expect(readFileSync(projectFile, 'utf8')).toContain('McpBridge=');
      } finally {
        chmodSync(projectFile, READ_WRITE_MODE);
      }
    },
  );
});

describe('BridgeManager owner identity', () => {
  /** A pid some other process is taken to hold; the liveness probe is faked. */
  const OTHER_SERVER_PID = 424242;
  const WATCHER_PID = 515151;
  const HALF_MINUTE_MS = 30_000;
  const OWNER_IDENTITY = 'test:owner-process';
  const NEWCOMER_IDENTITY = 'test:process-that-reused-the-pid';

  function registerOtherOwner(projectPath: string, bridgeSourcePath: string): void {
    const other = new BridgeManager(bridgeSourcePath, {
      pid: () => OTHER_SERVER_PID,
      isProcessAlive: () => true,
      processStartIdentity: () => OWNER_IDENTITY,
    });
    other.inject(projectPath, TEST_PORT);
  }

  function observer(bridgeSourcePath: string, options: BridgeManagerOptions): BridgeManager {
    return new BridgeManager(bridgeSourcePath, {
      pid: () => WATCHER_PID,
      isProcessAlive: () => true,
      ...options,
    });
  }

  function readOwnerFile(projectPath: string): Record<string, unknown> {
    const [fileName] = ownerFileNames(projectPath);
    return JSON.parse(
      readFileSync(join(bridgeOwnersDir(projectPath), fileName!), 'utf8'),
    ) as Record<string, unknown>;
  }

  function rewriteOwnerFile(
    projectPath: string,
    change: (info: Record<string, unknown>) => void,
  ): void {
    const [fileName] = ownerFileNames(projectPath);
    const info = readOwnerFile(projectPath);
    change(info);
    writeFileSync(join(bridgeOwnersDir(projectPath), fileName!), JSON.stringify(info), 'utf8');
  }

  it("records the owner process's own start identity in the owner file at inject", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    expect(readOwnerFile(projectPath).processStart).toBe(OWNER_IDENTITY);
  });

  it('leaves the field out when the identity cannot be read at inject', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    new BridgeManager(bridgeSourcePath, {
      pid: () => OTHER_SERVER_PID,
      isProcessAlive: () => true,
      processStartIdentity: () => null,
    }).inject(projectPath, TEST_PORT);
    expect(readOwnerFile(projectPath)).not.toHaveProperty('processStart');
  });

  it('counts an owner as dead when the process holding its pid has another start identity', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    // The pid answers the liveness probe, but it was handed to a new process.
    const watcher = observer(bridgeSourcePath, { processStartIdentity: () => NEWCOMER_IDENTITY });

    expect(watcher.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(ownerFileNames(projectPath)).toEqual([]);
  });

  it('repairs the bridge such an owner stranded, where the pid alone would have kept it forever', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const watcher = observer(bridgeSourcePath, { processStartIdentity: () => NEWCOMER_IDENTITY });

    watcher.repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
  });

  it('counts an owner as live when the process holding its pid has the identity it recorded', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const watcher = observer(bridgeSourcePath, { processStartIdentity: () => OWNER_IDENTITY });

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    expect(ownerFileNames(projectPath)).toHaveLength(1);
  });

  it.each([
    ['far in the past', '1999-01-01T00:00:00.000Z'],
    ['far in the future', '2099-01-01T00:00:00.000Z'],
    ['not a time at all', 'not-a-timestamp'],
  ])(
    'never judges a live owner by the wall clock: a startedAt %s leaves it live',
    (_label, startedAt) => {
      const { projectPath, bridgeSourcePath } = setupProject();
      registerOtherOwner(projectPath, bridgeSourcePath);
      // A clock stepped between the owner's start and its inject leaves a `startedAt` that matches no time;
      // only the identity is compared.
      rewriteOwnerFile(projectPath, (info) => {
        info.startedAt = startedAt;
      });
      const watcher = observer(bridgeSourcePath, { processStartIdentity: () => OWNER_IDENTITY });

      expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
      expect(ownerFileNames(projectPath)).toHaveLength(1);
    },
  );

  it('keeps the pid-only answer when the identity cannot be read now', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const watcher = observer(bridgeSourcePath, { processStartIdentity: () => null });

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
  });

  it('keeps the pid-only answer for an owner file an older build wrote, without asking', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    rewriteOwnerFile(projectPath, (info) => {
      delete info.processStart;
    });
    const processStartIdentity = vi.fn(() => NEWCOMER_IDENTITY);
    const watcher = observer(bridgeSourcePath, { processStartIdentity });

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    expect(processStartIdentity).not.toHaveBeenCalled();
  });

  it('does not ask for the identity of a pid that is not running at all', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const processStartIdentity = vi.fn(() => null);
    const watcher = new BridgeManager(bridgeSourcePath, {
      pid: () => WATCHER_PID,
      isProcessAlive: () => false,
      processStartIdentity,
    });

    expect(watcher.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(processStartIdentity).not.toHaveBeenCalled();
  });

  it("keeps this instance's own owner file whatever the reader says later, and reads its identity once", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const processStartIdentity = vi.fn(() => OWNER_IDENTITY);
    const self = new BridgeManager(bridgeSourcePath, {
      pid: () => OTHER_SERVER_PID,
      isProcessAlive: () => true,
      processStartIdentity,
    });
    self.inject(projectPath, TEST_PORT);
    processStartIdentity.mockReturnValue(NEWCOMER_IDENTITY);

    self.listOtherLiveOwners(projectPath);
    self.repairOrphaned(projectPath);
    self.inject(projectPath, TEST_PORT);

    expect(processStartIdentity).toHaveBeenCalledTimes(1);
    expect(ownerFileNames(projectPath)).toHaveLength(1);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readOwnerFile(projectPath).processStart).toBe(OWNER_IDENTITY);
  });

  it('reuses an answer for a while where asking runs a program, then asks again', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    let now = Date.now();
    const processStartIdentity = vi.fn(() => OWNER_IDENTITY);
    const watcher = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: true,
      now: () => now,
    });

    watcher.listOtherLiveOwners(projectPath);
    watcher.listOtherLiveOwners(projectPath);
    watcher.listOtherLiveOwners(projectPath);
    expect(processStartIdentity).toHaveBeenCalledTimes(1);

    // The owner can die and its pid be reused between two reads, so the
    // answer is not kept for good.
    now += HALF_MINUTE_MS + 1;
    processStartIdentity.mockReturnValue(NEWCOMER_IDENTITY);

    expect(watcher.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(processStartIdentity).toHaveBeenCalledTimes(2);
    expect(ownerFileNames(projectPath)).toEqual([]);
  });

  it('reuses an unknown answer too: a helper that cannot answer is not run on every read', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    let now = Date.now();
    const processStartIdentity = vi.fn((): string | null => null);
    const watcher = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: true,
      now: () => now,
    });

    for (let read = 0; read < 5; read += 1) {
      expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    }
    watcher.repairOrphaned(projectPath);
    expect(processStartIdentity).toHaveBeenCalledTimes(1);

    now += HALF_MINUTE_MS + 1;
    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    expect(processStartIdentity).toHaveBeenCalledTimes(2);
  });

  it('asks afresh, inside the window, about a new owner that got the same pid', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const processStartIdentity = vi.fn(() => OWNER_IDENTITY);
    const watcher = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: true,
    });
    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);

    // The first server died and a new one, with the same pid, registered.
    // The answer in hand is about the first one's identity, not this one's.
    rewriteOwnerFile(projectPath, (info) => {
      info.processStart = NEWCOMER_IDENTITY;
    });
    processStartIdentity.mockReturnValue(NEWCOMER_IDENTITY);

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    expect(processStartIdentity).toHaveBeenCalledTimes(2);
  });

  it('asks on every read where the identity is read from a file', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const processStartIdentity = vi.fn(() => OWNER_IDENTITY);
    const watcher = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: false,
    });

    watcher.listOtherLiveOwners(projectPath);
    watcher.listOtherLiveOwners(projectPath);

    expect(processStartIdentity).toHaveBeenCalledTimes(2);
  });

  it('runs no helper from the exit-time cleanup, and leaves the artifacts to an owner it cannot judge', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const processStartIdentity = vi.fn(() => NEWCOMER_IDENTITY);
    const leaving = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: true,
    });

    expect(leaving.cleanupAtExit(projectPath)).toEqual([]);

    expect(processStartIdentity).not.toHaveBeenCalled();
    expect(ownerFileNames(projectPath)).toHaveLength(1);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);

    leaving.cleanup(projectPath);
    expect(processStartIdentity).toHaveBeenCalledTimes(1);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
  });

  it('uses an answer already in hand from the exit-time cleanup', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerOtherOwner(projectPath, bridgeSourcePath);
    const processStartIdentity = vi.fn(() => OWNER_IDENTITY);
    const leaving = observer(bridgeSourcePath, {
      processStartIdentity,
      cacheProcessStartIdentity: true,
    });
    leaving.peekOtherLiveOwners(projectPath);
    expect(processStartIdentity).toHaveBeenCalledTimes(1);

    leaving.cleanupAtExit(projectPath);

    expect(processStartIdentity).toHaveBeenCalledTimes(1);
    expect(ownerFileNames(projectPath)).toHaveLength(1);
  });

  it("drops an owner file an earlier process left under this instance's pid, reading its own identity once", () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    new BridgeManager(bridgeSourcePath, {
      pid: () => WATCHER_PID,
      isProcessAlive: () => true,
      processStartIdentity: () => OWNER_IDENTITY,
    }).inject(projectPath, TEST_PORT);
    const processStartIdentity = vi.fn(() => NEWCOMER_IDENTITY);
    const watcher = observer(bridgeSourcePath, { processStartIdentity });

    expect(watcher.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(watcher.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(processStartIdentity).toHaveBeenCalledTimes(1);
    expect(processStartIdentity).toHaveBeenCalledWith(WATCHER_PID);
    expect(ownerFileNames(projectPath)).toEqual([]);
  });

  it('keeps another instance in this same process', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const options: BridgeManagerOptions = { processStartIdentity: () => OWNER_IDENTITY };
    const sibling = new BridgeManager(bridgeSourcePath, options);
    sibling.inject(projectPath, TEST_PORT);
    const watcher = new BridgeManager(bridgeSourcePath, options);

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
  });

  it('keeps an owner file under this pid that carries no identity', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });
    writeFileSync(
      join(bridgeOwnersDir(projectPath), `${process.pid}-0123456789abcdef.json`),
      JSON.stringify({
        pid: process.pid,
        instanceId: '0123456789abcdef',
        hostname: hostname(),
        mode: 'spawned',
        startedAt: '2001-01-01T00:00:00.000Z',
        port: TEST_PORT,
      }),
      'utf8',
    );
    const processStartIdentity = vi.fn(() => NEWCOMER_IDENTITY);
    const watcher = new BridgeManager(bridgeSourcePath, { processStartIdentity });

    expect(watcher.listOtherLiveOwners(projectPath)).toHaveLength(1);
    expect(processStartIdentity).not.toHaveBeenCalled();
  });
});

describe('BridgeManager removal racing a sibling inject', () => {
  const SIBLING_INSTANCE_ID = 'fedcba9876543210';
  const projectGodotOf = (projectPath: string): string =>
    readFileSync(join(projectPath, 'project.godot'), 'utf8');

  /** A sibling's inject landing after the remover's registry read: an owner file only,
   * because the shared script and entry were still in place. */
  function registerSiblingOwner(projectPath: string): void {
    mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });
    writeFileSync(
      join(bridgeOwnersDir(projectPath), `${process.pid}-${SIBLING_INSTANCE_ID}.json`),
      JSON.stringify({
        pid: process.pid,
        instanceId: SIBLING_INSTANCE_ID,
        hostname: hostname(),
        mode: 'spawned',
        startedAt: new Date().toISOString(),
        port: ALT_PORT,
      }),
      'utf8',
    );
  }

  function managerRacedBySibling(bridgeSourcePath: string, projectPath: string): BridgeManager {
    return new BridgeManager(bridgeSourcePath, {
      removeAutoloadEntry: (projectFile, name) => {
        registerSiblingOwner(projectPath);
        return removeAutoloadEntry(projectFile, name);
      },
    });
  }

  it('cleanup puts the script and the entry back for a session that registered during the removal', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const leaving = managerRacedBySibling(bridgeSourcePath, projectPath);
    leaving.inject(projectPath, TEST_PORT);

    const problems = leaving.cleanup(projectPath);

    expect(readFileSync(bridgeScriptAbsPath(projectPath), 'utf8')).toBe(BRIDGE_SOURCE_CONTENT);
    expect(projectGodotOf(projectPath)).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
    expect(projectGodotOf(projectPath).match(/McpBridge=/g)).toHaveLength(1);
    expect(ownerFileNames(projectPath)).toEqual([`${process.pid}-${SIBLING_INSTANCE_ID}.json`]);
    expect(problems).toEqual([]);
  });

  it('repairOrphaned does the same for a session that registered while it was removing stranded artifacts', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const stranded = new BridgeManager(bridgeSourcePath);
    stranded.inject(projectPath, TEST_PORT);
    for (const name of ownerFileNames(projectPath)) {
      unlinkSync(join(bridgeOwnersDir(projectPath), name));
    }

    managerRacedBySibling(bridgeSourcePath, projectPath).repairOrphaned(projectPath);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(projectGodotOf(projectPath)).toContain(`McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`);
  });

  it('restores the baked port and token when the session that registered is an attach session', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const attachToken = 'token-of-the-racing-attach';
    const leaving = new BridgeManager(bridgeSourcePath, {
      removeAutoloadEntry: (projectFile, name) => {
        mkdirSync(bridgeOwnersDir(projectPath), { recursive: true });
        writeFileSync(
          join(bridgeOwnersDir(projectPath), `${process.pid}-${SIBLING_INSTANCE_ID}.json`),
          JSON.stringify({
            pid: process.pid,
            instanceId: SIBLING_INSTANCE_ID,
            hostname: hostname(),
            mode: 'attached',
            startedAt: new Date().toISOString(),
            port: ALT_PORT,
            token: attachToken,
          }),
          'utf8',
        );
        return removeAutoloadEntry(projectFile, name);
      },
    });
    leaving.inject(projectPath, TEST_PORT);

    leaving.cleanup(projectPath);

    expect(readFileSync(bridgeScriptAbsPath(projectPath), 'utf8')).toBe(
      bakedContent(ALT_PORT, attachToken),
    );
  });

  it('still removes everything when nobody registered meanwhile', () => {
    const { projectPath, manager } = setupProject();
    manager.inject(projectPath, TEST_PORT);

    expect(manager.cleanup(projectPath)).toEqual([]);

    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(bridgeDir(projectPath))).toBe(false);
    expect(projectGodotOf(projectPath)).not.toContain('McpBridge=');
  });
});

describe('BridgeManager.repairOrphaned beside a live owner', () => {
  it('repairs a bridge whose owner died after an earlier check had found it alive', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    const ownerPid = 434343;
    let ownerAlive = true;
    const owner = new BridgeManager(bridgeSourcePath, {
      pid: () => ownerPid,
      isProcessAlive: () => true,
      processStartIdentity: NO_START_IDENTITY,
    });
    owner.inject(projectPath, TEST_PORT);
    const other = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: (pid) => pid !== ownerPid || ownerAlive,
      processStartIdentity: NO_START_IDENTITY,
    });

    other.repairOrphaned(projectPath);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('McpBridge=');

    ownerAlive = false;
    other.repairOrphaned(projectPath);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(ownerFileNames(projectPath)).toEqual([]);
  });
});

describe('BridgeManager.cleanup when its own owner file cannot be removed', () => {
  const LOCKED = 'EBUSY: resource busy or locked';

  /** A manager whose unlink fails for the one path the test names after inject. */
  function setupWithLockedOwnerFile(): {
    projectPath: string;
    manager: BridgeManager;
    bridgeSourcePath: string;
    ownerFile: string;
  } {
    const locked: { path: string | null } = { path: null };
    const setup = setupProject({
      managerOptions: {
        unlink: (filePath) => {
          if (filePath === locked.path) throw new Error(LOCKED);
          unlinkSync(filePath);
        },
      },
    });
    setup.manager.inject(setup.projectPath, TEST_PORT);
    const [fileName] = ownerFileNames(setup.projectPath);
    const ownerFile = join(bridgeOwnersDir(setup.projectPath), fileName!);
    locked.path = ownerFile;
    return { ...setup, ownerFile };
  }

  it('still removes the script and the entry, and names the owner file it left', () => {
    const { projectPath, manager, ownerFile } = setupWithLockedOwnerFile();

    const problems = manager.cleanup(projectPath);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpBridge=');
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(false);
    expect(existsSync(ownerFile)).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ownerFile);
    expect(problems[0]).toContain(LOCKED);
  });

  it("leaves the script and the entry to another live session, whatever became of this one's file", () => {
    const { projectPath, manager, bridgeSourcePath } = setupWithLockedOwnerFile();
    const sibling = new BridgeManager(bridgeSourcePath, {
      processStartIdentity: NO_START_IDENTITY,
    });
    sibling.inject(projectPath, TEST_PORT);

    manager.cleanup(projectPath);

    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('McpBridge=');
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
  });
});

describe('BridgeManager with an owner from another platform on this hostname', () => {
  const OWNER_PID = 454545;
  const LINUX_IDENTITY = 'linux:0f0e0d0c-boot:12345';

  function registerLinuxOwner(projectPath: string, bridgeSourcePath: string): void {
    const owner = new BridgeManager(bridgeSourcePath, {
      pid: () => OWNER_PID,
      isProcessAlive: () => true,
      processStartIdentity: () => LINUX_IDENTITY,
      platform: 'linux',
    });
    owner.inject(projectPath, TEST_PORT);
  }

  it('counts it as live and never prunes it, though its pid is not in this pid table', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerLinuxOwner(projectPath, bridgeSourcePath);
    const windowsServer = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: () => false,
      processStartIdentity: () => 'win32:133500000000000000',
      platform: 'win32',
    });

    const owners = windowsServer.listOtherLiveOwners(projectPath);
    windowsServer.repairOrphaned(projectPath);

    expect(owners.map((info) => info.pid)).toEqual([OWNER_PID]);
    expect(ownerFileNames(projectPath)).toHaveLength(1);
    expect(existsSync(bridgeScriptAbsPath(projectPath))).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('McpBridge=');
  });

  it('still prunes a dead owner that recorded an identity on this platform', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerLinuxOwner(projectPath, bridgeSourcePath);
    const linuxServer = new BridgeManager(bridgeSourcePath, {
      isProcessAlive: () => false,
      processStartIdentity: NO_START_IDENTITY,
      platform: 'linux',
    });

    expect(linuxServer.listOtherLiveOwners(projectPath)).toEqual([]);
    expect(ownerFileNames(projectPath)).toEqual([]);
  });

  it('tells a blocked caller why the owner cannot be checked and which file to delete', () => {
    const { projectPath, bridgeSourcePath } = setupProject();
    registerLinuxOwner(projectPath, bridgeSourcePath);
    const [fileName] = ownerFileNames(projectPath);
    const info = JSON.parse(
      readFileSync(join(bridgeOwnersDir(projectPath), fileName!), 'utf8'),
    ) as BridgeOwnerInfo;

    const remedy = foreignHostOwnerRemedy(info, projectPath, info.hostname, 'win32');

    expect(remedy?.note).toContain('"linux"');
    expect(remedy?.note).toContain('"win32"');
    expect(remedy?.solution).toContain(join(bridgeOwnersDir(projectPath), fileName!));
    expect(foreignHostOwnerRemedy(info, projectPath, info.hostname, 'linux')).toBeNull();
  });
});
