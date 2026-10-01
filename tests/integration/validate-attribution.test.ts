/**
 * Integration tests for how batch validate ties an engine diagnostic to the
 * target that caused it. Godot reports a script's parse error against its
 * simplified res:// path, so a target the caller wrote another way ("./a.gd",
 * a directory containing a space) used to match no diagnostic and come back
 * valid. These run the real handler against a tmp copy of the fixture project
 * and assert on parsed payloads only.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleValidate } from '../../src/tools/validate-tools.js';

const CASE_TIMEOUT_MS = 120000;

/** A GDScript with a parse error: an unclosed parameter list. */
const BROKEN_SCRIPT = 'extends Node\nfunc broken(\n\t# unclosed parameter list\n';
/** An abstract script with no errors. It loads and instantiates, and is still valid. */
const ABSTRACT_SCRIPT = '@abstract\nclass_name AttributionAbstractProbe\nextends Node\n';

interface BatchEntry {
  target: string;
  valid: boolean;
  errors: Array<{ message: string; line?: number }>;
}

let runner: GodotRunner;
let projectPath: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

beforeEach(() => {
  projectPath = join(tmpdir(), `godot-mcp-validate-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, projectPath, { recursive: true });
  tmpDirs.push(projectPath);
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

/** Validate one script target through the batch path and return its entry. */
async function validateScriptTarget(scriptPath: string): Promise<BatchEntry> {
  const result = await handleValidate(runner, {
    projectPath,
    targets: [{ scriptPath }],
  });
  const payload = expectMatchesOutputSchema('validate', result);
  const results = payload.results as BatchEntry[];
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe('validate batch attribution against a real engine', () => {
  itGodot(
    'a script with a parse error is invalid when its path is written ./name.gd',
    async () => {
      writeFileSync(join(projectPath, 'broken.gd'), BROKEN_SCRIPT);
      const entry = await validateScriptTarget('./broken.gd');
      expect(entry.target).toBe('./broken.gd');
      expect(entry.valid).toBe(false);
      expect(entry.errors.length).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'the same script under a directory with a space is invalid',
    async () => {
      mkdirSync(join(projectPath, 'my scripts'), { recursive: true });
      writeFileSync(join(projectPath, 'my scripts', 'broken.gd'), BROKEN_SCRIPT);
      const entry = await validateScriptTarget('my scripts/broken.gd');
      expect(entry.valid).toBe(false);
      expect(entry.errors.length).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'an @abstract script without errors is valid',
    async () => {
      writeFileSync(join(projectPath, 'abstract_probe.gd'), ABSTRACT_SCRIPT);
      const entry = await validateScriptTarget('abstract_probe.gd');
      expect(entry.valid).toBe(true);
      expect(entry.errors).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
