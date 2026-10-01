/**
 * get_ui_elements `filter` against a live engine.
 *
 * The bridge matches the filter with `is_class`, which knows native classes
 * only. A mistyped name, a script `class_name`, or a class that is not a
 * Control can never match anything, and an empty `elements` list for those is
 * indistinguishable from "this scene has no such controls". The bridge checks
 * the name against ClassDB before the walk and answers with an error instead.
 *
 * Requires GODOT_PATH; skipped only when it is unset.
 */

import { describe, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { TestContext } from 'vitest';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { expectErrorMatching, hasError, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetUiElements } from '../../src/tools/runtime-tools.js';

const TEST_TIMEOUT_MS = 60000;
const TMP_ID_BYTES = 6;

interface UiElement {
  type: string;
  path: string;
}

let runner: GodotRunner;
const tmpDirs: string[] = [];

/** Run a private copy of the fixture project (one Label under a Node2D). */
async function startFixture(ctx: Pick<TestContext, 'skip'>): Promise<void> {
  const id = randomBytes(TMP_ID_BYTES).toString('hex');
  const project = join(tmpdir(), `godot-mcp-ui-filter-${id}`);
  cpSync(fixtureProjectPath, project, { recursive: true });
  tmpDirs.push(project);
  await runProjectOrSkip(runner, ctx, project);
}

/** The elements of a get_ui_elements success. Fails on an error response. */
function elementsOf(result: unknown): UiElement[] {
  expect(hasError(result), JSON.stringify(unwrap(result).content)).toBe(false);
  return (unwrap(result).structuredContent as { elements: UiElement[] }).elements;
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

afterEach(async () => {
  await runner.stopProject().catch(() => undefined);
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

describe('get_ui_elements filter validation (live engine)', () => {
  itGodot(
    'get_ui_elements with an unknown class filter is an error',
    async (ctx) => {
      await startFixture(ctx);

      const result = await handleGetUiElements(runner, { filter: 'Lable' });

      expectErrorMatching(result, /Unknown class for filter: 'Lable'/);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'get_ui_elements with a non-Control class filter is an error',
    async (ctx) => {
      await startFixture(ctx);

      const result = await handleGetUiElements(runner, { filter: 'Node2D' });

      expectErrorMatching(result, /filter 'Node2D' is not a Control class/);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'get_ui_elements with a real Control class still lists elements',
    async (ctx) => {
      await startFixture(ctx);

      const labels = elementsOf(await handleGetUiElements(runner, { filter: 'Label' }));
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((element) => element.type === 'Label')).toBe(true);

      // The base class itself is a valid filter and matches every Control.
      const controls = elementsOf(await handleGetUiElements(runner, { filter: 'Control' }));
      expect(controls.length).toBeGreaterThanOrEqual(labels.length);

      // A valid Control class with no instance in the scene is an empty list,
      // which now can only mean "none in the scene".
      expect(elementsOf(await handleGetUiElements(runner, { filter: 'Button' }))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
