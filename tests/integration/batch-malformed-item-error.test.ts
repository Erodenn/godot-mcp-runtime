/**
 * Integration test: batch_scene_operations error context for malformed items.
 *
 * Regression (observed in an agent-driven build session, 2026-09-11): an
 * operations[] item missing its `operation` key produced the bare error
 * "Unknown batch operation: " — empty operation name, no item index, no
 * hint. The agent (which cannot see the GDScript source) then retried the
 * same malformed batch twice before noticing the missing key, burning
 * three tool calls on an error message with no diagnostic content.
 *
 * The fix appends the offending item index and an inference hint when
 * `operation` is omitted: sibling keys (node_name/node_type, updates,
 * texture_path) identify the intended operation.
 *
 * Reachability note: although the tool's JSON schema declares
 * `required: ['operation']`, the MCP SDK does not validate arguments
 * server-side on this path — dispatch hands args straight through
 * conversion to the GDScript layer (a typo'd `Operation` key arrives as
 * `_operation`, `operation: null` as null). Non-schema-compliant callers
 * — the agent population this regression was observed on — reach the
 * guard, so the diagnostic is live code, not dead defense.
 *
 * Requires GODOT_PATH. Skipped in CI without it.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
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

type BatchResult = { operation?: string; error?: string; success?: boolean };

async function runBatch(operations: object[]): Promise<BatchResult[]> {
  const tmpProject = tmpDirs[tmpDirs.length - 1];
  const { stdout } = (await runner.executeOperation(
    'batch_scene_operations',
    { operations },
    tmpProject,
    30000,
  )) as { stdout: string };
  // The GDScript layer prints {"results": [...]} to stdout.
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as {
    results: BatchResult[];
  };
  return parsed.results;
}

describe('batch_scene_operations malformed-item error context', () => {
  itGodot(
    'missing operation key reports the item index and an add_node hint',
    async () => {
      const results = await runBatch([
        // Item 0: valid — proves later malformed items don't kill the run.
        { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Fine' },
        // Item 1: nodeName/nodeType present but `operation` omitted.
        {
          scenePath: 'main.tscn',
          nodeName: 'Background',
          nodeType: 'ColorRect',
          parentNodePath: 'root',
        },
      ]);
      expect(results[0].success).toBe(true);
      const err = results[1].error ?? '';
      expect(err).toContain('operations[1]');
      expect(err).toContain("'operation' key");
      // Precise: the inference hint, not the enumeration list text
      // ("one of: add_node, ...") which both contain the op name.
      expect(err).toContain("did you mean operation 'add_node'?");
    },
    60000,
  );

  itGodot(
    'missing operation with updates present hints set_node_properties',
    async () => {
      const results = await runBatch([
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: 'root', property: 'visible', value: true }],
        },
      ]);
      const err = results[0].error ?? '';
      expect(err).toContain("did you mean operation 'set_node_properties'?");
    },
    60000,
  );

  itGodot(
    'unknown non-empty operation name still errors, without the missing-key hint',
    async () => {
      const results = await runBatch([{ operation: 'delete_everything', scenePath: 'main.tscn' }]);
      const err = results[0].error ?? '';
      expect(err).toContain('delete_everything');
      expect(err).not.toContain("'operation' key");
    },
    60000,
  );
});
