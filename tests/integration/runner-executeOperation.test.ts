/** The validate handler merges GDScript stdout (valid/invalid) with Godot's stderr parse errors; direct executeOperation tests use the scene-validate path where stdout JSON is the sole signal. */

import { describe, beforeAll, afterAll, expect } from 'vitest';
import { resolve } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { unwrap } from '../helpers/assertions.js';
import { copyProjectToTmp, removeTmpDir } from '../helpers/tmp.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';
import { handleValidate } from '../../src/tools/validate-tools.js';
import { handleCheckProject } from '../../src/tools/project-tools.js';

describe('GodotRunner.executeOperation', () => {
  let runner: GodotRunner;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  const tmpProjects: string[] = [];

  afterAll(() => {
    for (const dir of tmpProjects.splice(0)) {
      removeTmpDir(dir);
    }
  });

  describe('validate operation', () => {
    itGodot(
      'executeOperation returns valid:true for the committed fixture scene',
      async () => {
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
        // `valid` may be true on some Godot versions, but parse errors must always surface in the errors array.
        // An inline source is written under the project's .mcp/, so this runs on a copy.
        const projectPath = copyProjectToTmp(fixtureProjectPath, 'mcp-validate-source-');
        tmpProjects.push(projectPath);
        const result = await handleValidate(runner, {
          projectPath,
          source: 'extends Node\nfunc broken(\n  # unclosed paren\n',
        });

        expect(result).not.toHaveProperty('isError', true);
        const text = unwrap(result).content[0]?.text;
        expect(text).toBeDefined();
        const parsed = JSON.parse(text);
        expect(Array.isArray(parsed.errors)).toBe(true);
        expect(parsed.errors.length).toBeGreaterThan(0);
        const errorMessages: string[] = parsed.errors.map((e: { message: string }) => e.message);
        const hasParseMention = errorMessages.some((m) => /parse|expected|closing/i.test(m));
        expect(hasParseMention).toBe(true);
      },
      40000,
    );
  });

  describe('check_project handler', () => {
    itGodot(
      'returns the project name and godotVersion from the fixture project',
      async () => {
        const result = await handleCheckProject(runner, { projectPath: fixtureProjectPath });

        expect(result).not.toHaveProperty('isError');
        const text = unwrap(result).content[0]?.text;
        expect(text).toBeDefined();
        const info = JSON.parse(text);
        expect(info).toHaveProperty('name', 'godot-mcp-runtime test fixture');
        expect(info).toHaveProperty('projectPath', resolve(fixtureProjectPath));
        expect(info).toHaveProperty('godotVersion');
        expect(typeof info.godotVersion).toBe('string');
        expect(info.runtime).toEqual({
          activeSession: false,
          projectPath: null,
          liveSessions: [],
          project: { projectPath: resolve(fixtureProjectPath), session: 'none', current: false },
        });
      },
      40000,
    );
  });
});
