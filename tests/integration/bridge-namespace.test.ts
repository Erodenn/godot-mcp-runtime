// The bridge lives under a `.gdignore` directory, which suppresses the importer; Godot resolves autoloads through `load()` and generates no `.uid` for the script there.
// Screenshot and run_script audit artifacts land under the namespace and survive `stopProject`, which removes only `bridge/`.

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
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

/** Godot's own directory: never holds our artifacts and can be huge. */
const GODOT_CACHE_DIR = '.godot';

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
    } catch {}
    if (tmpProject) {
      try {
        removeTmpDir(tmpProject);
      } catch {}
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

      expect(existsSync(bridgeScriptAbsPath(tmpProject))).toBe(true);
      expect(existsSync(join(tmpProject, 'mcp_bridge.gd'))).toBe(false);

      const projectGodotPath = join(tmpProject, 'project.godot');
      expect(readFileSync(projectGodotPath, 'utf8')).toContain(
        `McpBridge="*${BRIDGE_SCRIPT_RES_PATH}"`,
      );

      expect(existsSync(join(mcpDir(tmpProject), '.gdignore'))).toBe(true);

      expect(findFilesNamed(tmpProject, 'mcp_bridge.gd.uid')).toEqual([]);

      const pong = JSON.parse(await runner.sendCommand('ping', {}, BRIDGE_COMMAND_TIMEOUT_MS)) as {
        status?: string;
      };
      expect(pong.status).toBe('pong');

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
