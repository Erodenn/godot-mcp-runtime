/** The MCP SDK does not validate arguments server-side on this path, so a missing `operation` (a typo'd key arrives as `_operation`, `operation: null` as null) reaches the GDScript guard. */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

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
      removeTmpDir(dir);
    } catch {}
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
  const parsed = JSON.parse(extractJson(stdout)) as {
    results: BatchResult[];
  };
  return parsed.results;
}

describe('batch_scene_operations malformed-item error context', () => {
  itGodot(
    'missing operation key reports the item index and an add_node hint',
    async () => {
      const results = await runBatch([
        { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Fine' },
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
      // Asserts the inference hint, not the enumeration text ("one of: add_node, ...") which also contains the op name.
      expect(err).toContain("did you mean operation 'add_node'?");
    },
    60000,
  );

  itGodot(
    'explicit null operation reports the item index and an add_node hint, without crashing the batch',
    async () => {
      const results = await runBatch([
        { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Fine' },
        {
          operation: null,
          scenePath: 'main.tscn',
          nodeName: 'Background',
          nodeType: 'ColorRect',
          parentNodePath: 'root',
        },
      ]);
      expect(results[0].success).toBe(true);
      const err = results[1].error ?? '';
      expect(err).toContain('operations[1]');
      expect(err).toContain("is missing the required 'operation' key");
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
