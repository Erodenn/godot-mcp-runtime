/**
 * Feature tests for import_assets.
 *
 * Context: on a fresh project, `.godot/imported` does not exist and headless
 * Godot runs no import step. Resource-touching operations fail even though
 * the asset files are on disk — observed in a harness benchmark run where a
 * subagent burned ~6 minutes and 4 denied shell probes on
 * `res://assets/paddle.svg` before concluding (wrongly) that texture loading
 * was broken in the runtime.
 *
 * The feature: `import_assets` runs `godot --headless --import --path <p>`,
 * producing `.godot/imported`, after which texture resources load.
 *
 * Rules:
 * - a fresh project with a new PNG asset: ResourceLoader.load fails before
 *   the import step has run
 * - after import_assets, the same load succeeds and .godot/imported exists
 * - re-running import on an already-imported project succeeds (idempotent)
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, afterAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

/** 1x1 transparent PNG. */
function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Minimal SceneTree script that prints LOAD_OK or LOAD_FAILED for a resource. */
function loadCheckScript(resPath: string): string {
  return `extends SceneTree
func _init():
	var res = ResourceLoader.load("${resPath}")
	if res == null:
		print("LOAD_FAILED")
	else:
		print("LOAD_OK")
	quit()
`;
}

function headlessLoad(godotPath: string, project: string, scriptPath: string): string {
  const result = spawnSync(godotPath, ['--headless', '--path', project, '--script', scriptPath], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return result.stdout ?? '';
}

const tmpDirs: string[] = [];
let runner: GodotRunner;
let godotPath: string;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
  godotPath = (runner as unknown as { godotPath: string }).godotPath;
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('import_assets (integration)', () => {
  itGodot(
    'makes a fresh-project texture loadable after import (and is idempotent)',
    async () => {
      const project = makeTmpProject();
      tmpDirs.push(project);

      // New asset that was never imported.
      const assetsDir = join(project, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'test_import.png'), minimalPng());

      // Fresh copy: strip any committed .godot/imported so the project starts cold.
      rmSync(join(project, '.godot', 'imported'), { recursive: true, force: true });

      const scriptPath = join(project, 'load_check.gd');
      writeFileSync(scriptPath, loadCheckScript('res://assets/test_import.png'));

      // Pre-condition: without the import step, the load fails.
      const before = headlessLoad(godotPath, project, scriptPath);
      expect(before).toContain('LOAD_FAILED');
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(false);

      // Import, then load succeeds.
      await runner.importAssets(project);
      expect(existsSync(join(project, '.godot', 'imported'))).toBe(true);
      const after = headlessLoad(godotPath, project, scriptPath);
      expect(after).toContain('LOAD_OK');

      // Idempotent re-run.
      await runner.importAssets(project);
      expect(headlessLoad(godotPath, project, scriptPath)).toContain('LOAD_OK');
    },
    180000,
  );
});
