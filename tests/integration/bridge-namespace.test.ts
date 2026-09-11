/**
 * The bridge autoload lives under `.mcp/godot-runtime/bridge/`, inside a
 * directory carrying a `.gdignore`. That suppresses the resource importer for
 * the whole subtree, so this file exists to prove the autoload still loads:
 * Godot resolves autoloads through `load()`, not the importer, and no `.uid`
 * sidecar is generated for the script at the new location.
 *
 * Also covers the sibling artifact directories: a screenshot and a
 * run_script audit pair land under the namespace and survive `stopProject`,
 * which only removes `bridge/`.
 *
 * Requires GODOT_PATH.
 */

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleRunScript } from '../../src/tools/runtime-tools.js';
import { hasError } from '../helpers/assertions.js';
import {
  BRIDGE_SCRIPT_RES_PATH,
  auditScriptsDir,
  bridgeDir,
  bridgeScriptAbsPath,
  mcpDir,
  screenshotsDir,
} from '../../src/utils/artifact-paths.js';

const BRIDGE_WAIT_MS = 20000;
const BRIDGE_COMMAND_TIMEOUT_MS = 15000;
const CASE_TIMEOUT_MS = 60000;

/** Directory Godot owns; never contains our artifacts and can be huge. */
const GODOT_CACHE_DIR = '.godot';

/** Recursively collect files matching `name`, skipping Godot's own cache. */
function findFilesNamed(root: string, name: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === GODOT_CACHE_DIR) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      hits.push(...findFilesNamed(full, name));
    } else if (entry.name === name) {
      hits.push(full);
    }
  }
  return hits;
}

describe('bridge artifact namespace', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {
      // already stopped
    }
    if (tmpProject) {
      try {
        rmSync(tmpProject, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      tmpProject = null;
    }
  });

  itGodot(
    'loads the autoload from under .gdignore and cleans only bridge/ on stop',
    async (ctx) => {
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-namespace-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      await runProjectOrSkip(runner, ctx, tmpProject, { waitMs: BRIDGE_WAIT_MS });

      // 1. The script sits at the namespaced path, not the project root.
      expect(existsSync(bridgeScriptAbsPath(tmpProject))).toBe(true);
      expect(existsSync(join(tmpProject, 'mcp_bridge.gd'))).toBe(false);

      // 2. project.godot registers exactly the namespaced res:// path.
      const projectGodotPath = join(tmpProject, 'project.godot');
      expect(readFileSync(projectGodotPath, 'utf8')).toContain(
        `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
      );

      // 3. The importer-suppression marker stays at the .mcp/ level.
      expect(existsSync(join(mcpDir(tmpProject), '.gdignore'))).toBe(true);

      // 4. No .uid sidecar anywhere — .gdignore keeps the importer out.
      expect(findFilesNamed(tmpProject, 'mcp_bridge.gd.uid')).toEqual([]);

      // 5. The autoload actually loaded and is answering. waitForBridge
      //    implies this; asserting it explicitly makes a failure read as
      //    "autoload did not load" rather than "timeout".
      const pong = JSON.parse(await runner.sendCommand('ping', {}, BRIDGE_COMMAND_TIMEOUT_MS)) as {
        status?: string;
      };
      expect(pong.status).toBe('pong');

      // Sibling artifact dirs are written under the namespace.
      const shotResponse = JSON.parse(
        await runner.sendCommand('screenshot', {}, BRIDGE_COMMAND_TIMEOUT_MS),
      ) as { path?: string; error?: string };
      if (shotResponse.error) {
        throw new Error(`Screenshot bridge error: ${shotResponse.error}`);
      }
      const shotPath =
        process.platform === 'win32'
          ? (shotResponse.path as string).replace(/\//g, '\\')
          : (shotResponse.path as string);
      expect(existsSync(shotPath)).toBe(true);
      expect(existsSync(screenshotsDir(tmpProject))).toBe(true);
      expect(readdirSync(screenshotsDir(tmpProject)).length).toBeGreaterThan(0);

      await runner.stopProject();

      // Session cleanup removes bridge/ and the autoload entry, nothing else.
      expect(existsSync(bridgeDir(tmpProject))).toBe(false);
      expect(readFileSync(projectGodotPath, 'utf8')).not.toContain('McpBridge=');
      expect(existsSync(join(mcpDir(tmpProject), '.gdignore'))).toBe(true);
      expect(existsSync(shotPath)).toBe(true);
      expect(existsSync(screenshotsDir(tmpProject))).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'run_script audit pairs land under .mcp/godot-runtime/scripts/ and survive stopProject',
    async (ctx) => {
      const id = randomBytes(6).toString('hex');
      tmpProject = join(tmpdir(), `godot-mcp-runtime-audit-${id}`);
      cpSync(fixtureProjectPath, tmpProject, { recursive: true });

      await runProjectOrSkip(runner, ctx, tmpProject, { waitMs: BRIDGE_WAIT_MS });

      const result = await handleRunScript(runner, {
        script:
          'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn {"ok": true}\n',
      });
      expect(hasError(result)).toBe(false);

      const scriptsDir = auditScriptsDir(tmpProject);
      expect(existsSync(scriptsDir)).toBe(true);
      const sidecars = readdirSync(scriptsDir).filter((f) => f.endsWith('.policy.json'));
      expect(sidecars.length).toBeGreaterThan(0);

      await runner.stopProject();

      expect(existsSync(scriptsDir)).toBe(true);
      expect(readdirSync(scriptsDir).filter((f) => f.endsWith('.policy.json')).length).toBe(
        sidecars.length,
      );
    },
    CASE_TIMEOUT_MS,
  );
});
