/**
 * Integration tests for the pixel statistics take_screenshot returns, against a
 * real Godot window.
 *
 * The stats are measured by the Node handler from the PNG the engine actually
 * wrote, so the only way to know the decoder accepts Godot's output and the
 * verdict separates a rendered frame from an empty one is to look at real
 * frames: the fixture's main scene, and its sibling blank.tscn.
 *
 * Requires GODOT_PATH; skipped when it is unset. Assertions are on the parsed
 * payload only.
 *
 * The blank scene is launched by rewriting `run/main_scene` in a disposable
 * copy of the fixture project, the same convention as simulate-input-observed.
 */

import { describe, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath, blankScenePath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleSimulateInput, handleTakeScreenshot } from '../../src/tools/runtime-tools.js';

/** Frames to let the scene render before the screenshot. */
const SETTLE_FRAMES = 5;
const TEST_TIMEOUT_MS = 60000;

interface ScreenshotStats {
  width: number;
  height: number;
  chromatic: number;
  dominant: number;
  distinct: number;
  likelyBlank: boolean;
}

interface ScreenshotPayload {
  warnings?: string[];
  path: string;
  size: { width: number; height: number };
  stats: ScreenshotStats | null;
}

const tmpDirs: string[] = [];

let runner: GodotRunner;

/**
 * A throwaway copy of the fixture project. With `mainScene`, `run/main_scene`
 * is rewritten to that scene so a sibling scene can be launched without
 * touching main.tscn or relying on runProject's positional scene argument.
 */
function makeProject(mainScene?: string): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-shot-stats-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  if (mainScene !== undefined) {
    const projectFile = join(dst, 'project.godot');
    const content = readFileSync(projectFile, 'utf8').replace(
      'res://main.tscn',
      `res://${mainScene}`,
    );
    // Fails here rather than as a misleading stats result if the scene is renamed.
    expect(content, 'project.godot main scene must point at the requested scene').toContain(
      mainScene,
    );
    writeFileSync(projectFile, content, 'utf8');
  }
  tmpDirs.push(dst);
  return dst;
}

/** Let the scene render, then take a screenshot and return its parsed payload. */
async function screenshot(responseMode: 'preview' | 'path_only'): Promise<ScreenshotPayload> {
  const settled = await handleSimulateInput(runner, {
    actions: [{ type: 'wait', frames: SETTLE_FRAMES }],
  });
  expect(settled.ok, 'the settle wait must succeed').toBe(true);

  const result = await handleTakeScreenshot(runner, { responseMode });
  if (!result.ok) {
    throw new Error(`take_screenshot returned an error response: ${JSON.stringify(result.error)}`);
  }
  const structured = result.value.structuredContent;
  expect(structured, 'a take_screenshot success must carry structuredContent').toBeDefined();
  return structured as unknown as ScreenshotPayload;
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
    } catch {
      // best-effort cleanup
    }
  }
});

describe('take_screenshot pixel stats (live engine)', () => {
  itGodot(
    'take_screenshot reports the fixture main scene as not blank',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, makeProject());

      const payload = await screenshot('preview');

      const stats = payload.stats;
      expect(stats, JSON.stringify(payload.warnings)).not.toBeNull();
      expect(stats!.likelyBlank, JSON.stringify(stats)).toBe(false);
      // Measured from the full-resolution PNG, never from the downscaled preview.
      expect(stats!.width).toBe(payload.size.width);
      expect(stats!.height).toBe(payload.size.height);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'take_screenshot reports the blank sibling scene as likely blank',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, makeProject(blankScenePath));

      const payload = await screenshot('path_only');

      const stats = payload.stats;
      expect(stats, JSON.stringify(payload.warnings)).not.toBeNull();
      expect(stats!.likelyBlank, JSON.stringify(stats)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
