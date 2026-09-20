/**
 * Integration tests for per-target checks inside the batch validate operation
 * (GDScript op validate_batch with a checks[] array on a targets[] item).
 *
 * These assert the two properties the wire shape exists for: the whole batch,
 * checks included, runs in one Godot process, and a target that cannot be
 * loaded reports on itself without costing the other targets their result.
 *
 * Requires GODOT_PATH.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

const OP_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 60000;

interface BatchResult {
  target: string;
  valid: boolean;
  errors: Array<{ message?: string }>;
  checkErrors?: Array<{ check?: string; path?: string; message?: string }>;
}

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

let runner: GodotRunner;

describe('validate - batch targets with checks', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
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

  itGodot(
    'runs checks for every target in one Godot process',
    async () => {
      // input_probe.tscn's root is a Node, so the third target's Control
      // schema is a deliberate mismatch and the only failing target.
      const { stdout } = await runner.executeOperation(
        'validate_batch',
        {
          targets: [
            { scriptPath: 'placeholder.gd' },
            {
              scenePath: 'main.tscn',
              checks: [{ type: 'structure', schema: { type: 'Node2D' } }, { type: 'signals' }],
            },
            {
              scenePath: 'input_probe.tscn',
              checks: [{ type: 'structure', schema: { type: 'Control' } }],
            },
          ],
        },
        tmpProject,
        OP_TIMEOUT_MS,
      );

      const parsed = JSON.parse(extractJson(stdout)) as { results: BatchResult[] };
      expect(parsed.results).toHaveLength(3);
      expect(parsed.results[0]).toEqual({ target: 'placeholder.gd', valid: true, errors: [] });
      expect(parsed.results[1]).toEqual({
        target: 'main.tscn',
        valid: true,
        errors: [],
        checkErrors: [],
      });
      const mismatched = parsed.results[2]!;
      expect(mismatched.target).toBe('input_probe.tscn');
      expect(mismatched.valid).toBe(false);
      expect(mismatched.errors).toEqual([]);
      expect(mismatched.checkErrors).toHaveLength(1);
      expect(mismatched.checkErrors![0]!.check).toBe('structure');
      expect(String(mismatched.checkErrors![0]!.message)).toContain('Control');
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'isolates a target whose scene is missing from the other targets',
    async () => {
      const { stdout } = await runner.executeOperation(
        'validate_batch',
        {
          targets: [
            {
              scenePath: 'main.tscn',
              checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
            },
            {
              scenePath: 'ghost.tscn',
              checks: [{ type: 'structure', schema: { type: 'Node2D' } }],
            },
          ],
        },
        tmpProject,
        OP_TIMEOUT_MS,
      );

      const parsed = JSON.parse(extractJson(stdout)) as { results: BatchResult[] };
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0]).toEqual({
        target: 'main.tscn',
        valid: true,
        errors: [],
        checkErrors: [],
      });
      expect(parsed.results[1]).toEqual({
        target: 'ghost.tscn',
        valid: false,
        errors: [{ message: 'File not found: res://ghost.tscn' }],
        checkErrors: [{ message: 'Scene checks skipped: could not load scene ghost.tscn' }],
      });
    },
    TEST_TIMEOUT_MS,
  );
});
