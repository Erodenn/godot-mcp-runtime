/**
 * End-to-end profiling against a real engine: `run_project({ profiling: true })`
 * has to bind the debugger port, survive Godot's own `--remote-debug` handshake,
 * and come back with the fixture's hot function ranked at the top.
 *
 * The frame layout the receiver parses is the engine's, not ours, so this is
 * the only test that can catch a layout change in a future Godot release.
 *
 * Requires GODOT_PATH and a display server. Skipped in CI.
 */

import { describe, beforeAll, afterEach, expect } from 'vitest';
import type { TestContext } from 'vitest';
import { join } from 'path';
import { cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { profilingFixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  handleProfileProject,
  handleStartProfiler,
  handleStopProfiler,
} from '../../src/tools/profiler-tools.js';
import { hasError, unwrap } from '../helpers/assertions.js';

interface CaptureShape {
  frames: number;
  frame: Record<'frameMs' | 'processMs' | 'scriptMs', { avg: number; max: number }>;
  servers: Array<{ name: string; msPerFrame: number; functions: Array<{ name: string }> }>;
  worstFrame: { frame: number; frameMs: number; scriptMs: number };
  rows: Array<{
    function: string;
    file: string;
    line: number;
    calls: number;
    selfMs: number;
    percentOfFrame: number;
  }>;
}

describe('profiler smoke', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {
      // already stopped
    }
    if (tmpProject) {
      try {
        rmSync(tmpProject, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      tmpProject = null;
    }
  });

  async function launchProfilingSession(ctx: TestContext): Promise<void> {
    const id = randomBytes(6).toString('hex');
    tmpProject = join(tmpdir(), `godot-mcp-profiling-${id}`);
    cpSync(profilingFixtureProjectPath, tmpProject, { recursive: true });

    await runProjectOrSkip(runner, ctx, tmpProject, { profiling: true });
    expect(runner.activeProfiler).not.toBeNull();
  }

  itGodot(
    'profile_project ranks the fixture hot loop with its source location',
    async (ctx) => {
      await launchProfilingSession(ctx);

      const result = await handleProfileProject(runner, { seconds: 2, top: 10 });
      expect(hasError(result)).toBe(false);

      const capture = unwrap(result).structuredContent as unknown as CaptureShape;
      expect(capture.frames).toBeGreaterThan(0);
      const burn = capture.rows.find((row) => row.function === 'burn');
      expect(
        burn,
        `no "burn" row in ${capture.rows.map((r) => r.function).join(', ')}`,
      ).toBeDefined();
      expect(burn!.file).toBe('res://hot_loop.gd');
      expect(burn!.line).toBeGreaterThan(0);
      expect(burn!.calls).toBeGreaterThan(0);
      expect(burn!.selfMs).toBeGreaterThan(0);
      // Own time dominates the frame, so the default ranking puts it first.
      expect(capture.rows[0]!.function).toBe('burn');
      expect(burn!.percentOfFrame).toBeGreaterThan(0);

      // The editor's "Frame Time" category and its server rows.
      expect(capture.frame.frameMs.avg).toBeGreaterThan(0);
      expect(capture.frame.frameMs.max).toBeGreaterThanOrEqual(capture.frame.frameMs.avg);
      expect(capture.frame.scriptMs.avg).toBeGreaterThan(0);
      expect(capture.worstFrame.frameMs).toBeGreaterThan(0);
      expect(
        capture.servers.length,
        `no server categories in ${JSON.stringify(capture.servers)}`,
      ).toBeGreaterThan(0);
      expect(capture.servers[0]!.functions.length).toBeGreaterThan(0);
    },
    90000,
  );

  itGodot(
    'start_profiler records while other runtime tools drive the game, stop_profiler reports',
    async (ctx) => {
      await launchProfilingSession(ctx);

      const started = await handleStartProfiler(runner, { seconds: 10 });
      expect(hasError(started)).toBe(false);
      expect(unwrap(started).structuredContent).toMatchObject({ active: true });

      // A capture must survive normal bridge traffic in the middle of it.
      await runner.sendCommand('get_ui_elements', {});

      const stopped = await handleStopProfiler(runner, { top: 5, sort: 'calls' });
      expect(hasError(stopped)).toBe(false);
      const capture = unwrap(stopped).structuredContent as unknown as CaptureShape;
      expect(capture.frames).toBeGreaterThan(0);
      expect(capture.rows.map((row) => row.function)).toContain('burn');
    },
    90000,
  );
});
