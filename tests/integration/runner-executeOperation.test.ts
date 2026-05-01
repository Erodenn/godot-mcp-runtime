/**
 * Integration tests for GodotRunner.executeOperation and validation/project handlers.
 *
 * The validate handler merges GDScript stdout (valid/invalid signal) with Godot's
 * stderr (detailed parse errors). Testing through the handler gives us the correct
 * end-to-end contract. Tests for executeOperation directly use the scene-validate
 * path where stdout JSON is the sole signal.
 *
 * Requires a real Godot binary. Set GODOT_PATH to run these locally.
 * They are skipped in CI where Godot is not installed.
 */

import { describe, beforeAll } from 'vitest';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { GodotRunner, extractJson } from '../../src/utils/godot-runner.js';
import { handleValidate } from '../../src/tools/validate-tools.js';
import { handleGetProjectInfo } from '../../src/tools/project-tools.js';

describe('GodotRunner.executeOperation', () => {
  let runner: GodotRunner;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  describe('validate operation', () => {
    itGodot(
      'executeOperation returns valid:true for the committed fixture scene',
      async () => {
        // Test executeOperation directly for the scene-validate path —
        // stdout JSON is the sole signal for scene files.
        const { stdout } = await runner.executeOperation(
          'validate_resource',
          { scenePath: fixtureScenePath },
          fixtureProjectPath,
          30000,
        );
        const json = JSON.parse(extractJson(stdout));
        expect(json).toHaveProperty('valid', true);
        expect(Array.isArray(json.errors)).toBe(true);
      },
      40000,
    );

    itGodot(
      'handleValidate surfaces parse errors in the errors array for a broken GDScript',
      async () => {
        // The validate handler uses the `source` field: it writes a tmp file,
        // runs validate_resource, then merges stderr parse errors into the result.
        // Godot 4.x reports parse errors to stderr ("SCRIPT ERROR: Parse Error: ...").
        // Depending on whether load() returns non-null, `valid` may be true in some
        // Godot versions — but the errors must always be surfaced in the errors array.
        const result = await handleValidate(runner, {
          projectPath: fixtureProjectPath,
          source: 'extends Node\nfunc broken(\n  # unclosed paren\n',
        });

        expect(result).not.toHaveProperty('isError', true);
        const text = (result as { content: Array<{ type: string; text: string }> }).content[0]
          ?.text;
        expect(text).toBeDefined();
        const parsed = JSON.parse(text);
        // The errors array must contain at least one entry describing the parse problem
        expect(Array.isArray(parsed.errors)).toBe(true);
        expect(parsed.errors.length).toBeGreaterThan(0);
        const errorMessages: string[] = parsed.errors.map((e: { message: string }) => e.message);
        const hasParseMention = errorMessages.some((m) => /parse|expected|closing/i.test(m));
        expect(hasParseMention).toBe(true);
      },
      40000,
    );
  });

  describe('get_project_info handler', () => {
    itGodot(
      'returns the project name and godotVersion from the fixture project',
      async () => {
        const result = await handleGetProjectInfo(runner, { projectPath: fixtureProjectPath });

        expect(result).not.toHaveProperty('isError');
        const text = (result as { content: Array<{ type: string; text: string }> }).content[0]
          ?.text;
        expect(text).toBeDefined();
        const info = JSON.parse(text);
        // The fixture's project.godot has: config/name="godot-mcp-runtime test fixture"
        expect(info).toHaveProperty('name', 'godot-mcp-runtime test fixture');
        expect(info).toHaveProperty('path', fixtureProjectPath);
        expect(info).toHaveProperty('godotVersion');
        expect(typeof info.godotVersion).toBe('string');
      },
      40000,
    );
  });
});
