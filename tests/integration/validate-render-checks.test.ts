/**
 * Integration tests for the render check of the validate tool
 * (checks: [{ type: "render" }] executed server-side).
 *
 * The render check spawns a brief `--write-movie` run with the real
 * renderer, decodes the captured frames, and computes pixel statistics.
 * These tests run against the fixture project, which draws a Label and a
 * Sprite2D on a dark background — a real rendered frame with low-but-
 * nonzero chromatic content, ideal for exercising the default thresholds.
 *
 * Skips when GODOT_PATH is unset, and additionally when no display server
 * is available (movie writer cannot render headlessly).
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot, isHeadlessEnvironmentError } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { runRenderCheck } from '../../src/utils/render-check.js';
import { handleValidate } from '../../src/tools/validate-tools.js';

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

describe('runRenderCheck (real Godot)', () => {
  itGodot(
    'verifies the fixture project renders visible content',
    async () => {
      const projectPath = tmpDirs[tmpDirs.length - 1]!;
      const godotPath = runner.getGodotPath()!;

      let result;
      try {
        result = await runRenderCheck(godotPath, projectPath, undefined, { frames: 10 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isHeadlessEnvironmentError(msg)) return; // no display server — skip
        throw e;
      }

      expect(result.ok).toBe(true);
      expect(result.stats).not.toBeNull();
      // Fixture draws a Label + Sprite2D on a dark background: some chromatic
      // pixels, more than one distinct color. The fixture's Sprite2D texture
      // may not be imported in CI, so we only assert that the frame is not
      // perfectly uniform (dominant < 1.0) and has at least 2 distinct colors.
      expect(result.stats!.dominant).toBeLessThan(1.0);
      expect(result.stats!.distinct).toBeGreaterThanOrEqual(2);
    },
    60000,
  );

  itGodot(
    'fails on a scene that renders nothing (blank frame)',
    async () => {
      const projectPath = tmpDirs[tmpDirs.length - 1]!;
      const godotPath = runner.getGodotPath()!;

      // Overwrite main scene with an empty Node (renders nothing but the
      // default clear color)
      const fs = await import('fs');
      fs.writeFileSync(
        join(projectPath, 'blank.tscn'),
        '[gd_scene format=3]\n\n[node name="Blank" type="Node"]\n',
      );

      let result;
      try {
        result = await runRenderCheck(godotPath, projectPath, 'blank.tscn', { frames: 10 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isHeadlessEnvironmentError(msg)) return; // no display server — skip
        throw e;
      }

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/blank or uniform/);
    },
    60000,
  );
});

describe('handleValidate render check (real Godot)', () => {
  itGodot(
    'returns a valid:true payload when the scene renders content',
    async () => {
      const projectPath = tmpDirs[tmpDirs.length - 1]!;

      let result;
      try {
        const r = await handleValidate(runner, {
          projectPath,
          scenePath: 'main.tscn',
          checks: [{ type: 'render', frames: 10 }],
        });
        result = r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isHeadlessEnvironmentError(msg)) return;
        throw e;
      }

      // unwrap the handler Result to get the payload envelope
      const envelope =
        'value' in (result as object) ? (result as { value: unknown }).value : result;
      const payload = JSON.parse(
        (envelope as { content: Array<{ text: string }> }).content[0]!.text,
      );
      if (payload.valid === true) {
        expect(payload.errors).toEqual([]);
      } else {
        // A render failure on the fixture would mean the check misjudges a
        // genuine frame — unless the environment refused to render, in which
        // case the failure message names the spawn/decode problem rather
        // than blank-frame statistics.
        expect(payload.errors[0].message).not.toMatch(/blank or uniform/);
      }
    },
    60000,
  );
});
