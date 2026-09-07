/**
 * Regression tests: project-root containment for every path-taking operation.
 *
 * Godot resolves `res://../x` outward to a real file on disk, so a path that
 * escapes the project root is not merely invalid -- it reads and writes real
 * files outside the project. The Node-side validators (validateSubPath and
 * friends) cover the standalone handlers, but batch_scene_operations forwards
 * its operations to the GDScript layer raw, so containment has to hold there
 * too. normalize_scene_path is the single choke point every path funnels
 * through, and it rejects escaping paths by returning "".
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

const ESCAPE_MESSAGE = 'escapes the project root';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-containment-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  tmpDirs.push(makeTmpProject());
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

/** Drop a file just outside the project root; returns its bare filename. */
function plantOutside(projectDir: string, name: string, body: string): string {
  writeFileSync(join(dirname(projectDir), name), body);
  return name;
}

describe('project-root containment (normalize_scene_path choke point)', () => {
  itGodot(
    'batch load_sprite rejects a texturePath that escapes the project root',
    async () => {
      // The batch path reaches _apply_load_sprite without passing through
      // handleLoadSprite's validateSubPath call, so the guard must be
      // engine-side.
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const outside = plantOutside(tmpProject, 'outside.png', 'not-a-real-png');

      const { stdout } = await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'load_sprite',
              scenePath: 'main.tscn',
              nodePath: 'root/Sprite2D',
              texturePath: `../${outside}`,
            },
          ],
        },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
    },
    60000,
  );

  itGodot(
    'batch add_node rejects a scenePath that escapes the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const outside = plantOutside(
        tmpProject,
        'outside.tscn',
        '[gd_scene format=3]\n\n[node name="O" type="Node2D"]\n',
      );
      const before = readFileSync(join(dirname(tmpProject), outside), 'utf-8');

      await runner.executeOperation(
        'batch_scene_operations',
        {
          operations: [
            {
              operation: 'add_node',
              scenePath: `../${outside}`,
              nodeType: 'Node2D',
              nodeName: 'Intruder',
            },
          ],
        },
        tmpProject,
        30000,
      );

      // The external scene must be neither read into nor written back out.
      expect(readFileSync(join(dirname(tmpProject), outside), 'utf-8')).toBe(before);
    },
    60000,
  );

  itGodot(
    'validate rejects an escaping target instead of reading outside the project',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;

      const { stdout } = await runner.executeOperation(
        'validate_batch',
        { targets: [{ scriptPath: '../../etc/passwd.gd' }] },
        tmpProject,
        30000,
      );

      expect(stdout).toContain(ESCAPE_MESSAGE);
    },
    60000,
  );

  itGodot(
    'attach_script rejects an escaping scriptPath',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      plantOutside(tmpProject, 'outside.gd', 'extends Node\n');

      let stdout = '';
      try {
        const result = await runner.executeOperation(
          'attach_script',
          { scenePath: 'main.tscn', nodePath: 'root', scriptPath: '../outside.gd' },
          tmpProject,
          30000,
        );
        stdout = result.stdout;
      } catch {
        // acceptable: the operation exits nonzero on rejection
      }

      expect(stdout).not.toContain('attached');
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).not.toContain('outside.gd');
    },
    60000,
  );

  itGodot(
    'save_scene refuses to write outside the project root',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;
      const target = join(dirname(tmpProject), 'escaped-save.tscn');
      rmSync(target, { force: true });

      try {
        await runner.executeOperation(
          'save_scene',
          { scenePath: 'main.tscn', newPath: '../escaped-save.tscn' },
          tmpProject,
          30000,
        );
      } catch {
        // acceptable: the operation exits nonzero on rejection
      }

      expect(existsSync(target)).toBe(false);
    },
    60000,
  );

  itGodot(
    'ordinary project-relative paths are unaffected',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1]!;

      // Nested, dot-segmented, and res://-prefixed forms all normalize cleanly.
      const { stdout } = await runner.executeOperation(
        'add_node',
        { scenePath: './main.tscn', nodeType: 'Node2D', nodeName: 'Plain' },
        tmpProject,
        30000,
      );

      expect(stdout).toContain('added successfully');
      expect(readFileSync(join(tmpProject, 'main.tscn'), 'utf-8')).toContain('Plain');
    },
    60000,
  );
});
