/** get_ui_elements `root` limits the walk to one Control and its descendants, resolved the way click_element resolves a target, while filter, visibleOnly and the clipping by ancestors above the root keep working inside the scope. */

import { describe, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { cpSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { TestContext } from 'vitest';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import {
  fixtureProjectPath,
  inputProbeScenePath,
  inputScrollScenePath,
} from '../helpers/fixture-paths.js';
import { expectErrorMatching, hasError, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetUiElements } from '../../src/tools/runtime-tools.js';

const TEST_TIMEOUT_MS = 60000;
const TMP_ID_BYTES = 6;
const PROBE = '/root/InputProbe';
const FREE_ME = `${PROBE}/FreeMe`;
const HIDDEN_PANEL = `${PROBE}/HiddenPanel`;
const PARTIAL = '/root/ScrollProbe/ClipPanel/Partial';

interface UiElement {
  path: string;
  type: string;
  visibleRect?: unknown;
}

let runner: GodotRunner;
const tmpDirs: string[] = [];

async function startFixture(ctx: Pick<TestContext, 'skip'>, scene: string): Promise<void> {
  const id = randomBytes(TMP_ID_BYTES).toString('hex');
  const project = join(tmpdir(), `godot-mcp-ui-root-${id}`);
  cpSync(fixtureProjectPath, project, { recursive: true });
  tmpDirs.push(project);
  await runProjectOrSkip(runner, ctx, project, { scene });
}

function elementsOf(result: unknown): UiElement[] {
  expect(hasError(result), JSON.stringify(unwrap(result).content)).toBe(false);
  return (unwrap(result).structuredContent as { elements: UiElement[] }).elements;
}

function pathsOf(result: unknown): string[] {
  return elementsOf(result).map((element) => element.path);
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
      removeTmpDir(dir);
    } catch {}
  }
});

describe('get_ui_elements root scope (live engine)', () => {
  itGodot(
    'lists the root and its descendants only, whether it is named by path or by node name',
    async (ctx) => {
      await startFixture(ctx, inputProbeScenePath);

      const unscoped = pathsOf(await handleGetUiElements(runner, {}));
      expect(unscoped).toContain(`${PROBE}/PlainBtn`);

      const byPath = pathsOf(await handleGetUiElements(runner, { root: FREE_ME }));
      expect(byPath).toEqual([FREE_ME, `${FREE_ME}/FreeSelfBtn`]);

      const byName = pathsOf(await handleGetUiElements(runner, { root: 'FreeMe' }));
      expect(byName).toEqual(byPath);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'applies filter inside the scope and keeps an empty list for a class with no match there',
    async (ctx) => {
      await startFixture(ctx, inputProbeScenePath);

      const buttons = await handleGetUiElements(runner, { root: FREE_ME, filter: 'Button' });
      expect(pathsOf(buttons)).toEqual([`${FREE_ME}/FreeSelfBtn`]);

      expect(
        elementsOf(await handleGetUiElements(runner, { root: FREE_ME, filter: 'Label' })),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'applies visibleOnly inside the scope, including a root hidden by itself',
    async (ctx) => {
      await startFixture(ctx, inputProbeScenePath);

      expect(elementsOf(await handleGetUiElements(runner, { root: HIDDEN_PANEL }))).toEqual([]);

      const all = await handleGetUiElements(runner, { root: HIDDEN_PANEL, visibleOnly: false });
      expect(pathsOf(all)).toEqual([
        HIDDEN_PANEL,
        `${HIDDEN_PANEL}/PanelLabel`,
        `${HIDDEN_PANEL}/InnerBtn`,
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'an unresolvable root is an error naming it, not an empty list',
    async (ctx) => {
      await startFixture(ctx, inputProbeScenePath);

      const result = await handleGetUiElements(runner, { root: 'NoSuchControl' });

      expectErrorMatching(result, /could not find UI element: NoSuchControl/);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'clipping by an ancestor above the root still applies to the scoped control',
    async (ctx) => {
      await startFixture(ctx, inputScrollScenePath);

      const unscoped = elementsOf(await handleGetUiElements(runner, {}));
      const unscopedPartial = unscoped.find((element) => element.path === PARTIAL);
      expect(unscopedPartial?.visibleRect).toBeDefined();

      const scoped = elementsOf(await handleGetUiElements(runner, { root: PARTIAL }));
      expect(scoped).toHaveLength(1);
      expect(scoped[0]).toEqual(unscopedPartial);

      // Hidden is clipped out entirely by ClipPanel, so scoping to it cannot bring it back.
      const hidden = await handleGetUiElements(runner, {
        root: `${PARTIAL.replace('Partial', 'Hidden')}`,
      });
      expect(elementsOf(hidden)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
