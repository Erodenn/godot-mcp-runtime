/**
 * Integration tests for render_movie against a real movie-writer run.
 *
 * The tool measures PNG frames the engine actually wrote, so the only way to
 * know the movie writer's output decodes, that a rendered frame and an empty
 * one are told apart, and that an animated scene differs from a static one is
 * to run Godot. The scenes are the fixture's main scene and its siblings:
 * blank.tscn, motion_animated.tscn and motion_static.tscn.
 *
 * Requires GODOT_PATH; skipped when it is unset, and skipped on a Linux
 * machine with no display server (the movie writer needs the real renderer).
 * Assertions are on the parsed payload and the filesystem only. Every run goes
 * through the handler's own timeout-and-kill; no test spawns Godot itself.
 *
 * Sibling scenes are launched by rewriting `run/main_scene` in a disposable
 * copy of the fixture project, the same convention as simulate-input-observed,
 * except where a test is about the `scene` parameter itself.
 *
 * The movie-writer run flow is adapted from PR 63 by Mickael Canevet.
 */

import { describe, beforeAll, afterAll, expect, type TestContext } from 'vitest';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot, isHeadlessEnvironmentError } from '../helpers/godot-skip.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { errorText, unwrap } from '../helpers/assertions.js';
import {
  blankScenePath,
  fixtureProjectPath,
  motionAnimatedScenePath,
  motionStaticScenePath,
} from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleRenderMovie } from '../../src/tools/render-tools.js';
import { bridgeScriptAbsPath, moviesDir } from '../../src/utils/artifact-paths.js';
import { checkDisplayAvailable } from '../../src/utils/path-validation.js';
import { decodePng } from '../../src/utils/png-decoder.js';

const TEST_TIMEOUT_MS = 90000;
const TEST_FRAMES = 15;
const MAX_INLINE_WIDTH = 960;
const MAX_INLINE_HEIGHT = 540;
const OGV_SUPPORTED_MAJOR = 4;
const OGV_SUPPORTED_MINOR = 6;

interface RenderPayload {
  mode: string;
  likelyBlank: boolean | null;
  motion: number | null;
  anyMotion: boolean | null;
  frameCount: number;
  measuredFrames: number;
  samples: Array<{ index: number; path?: string }>;
  framePaths?: string[];
  directory?: string;
  audioPath?: string;
  path?: string;
  byteSize?: number;
  statsAvailable: boolean;
}

interface ContentBlock {
  type: string;
  data?: string;
}

const tmpDirs: string[] = [];
const ctx = makeContext({ disableSecurity: true });

let runner: GodotRunner;

/**
 * A throwaway copy of the fixture project. With `mainScene`, `run/main_scene`
 * is rewritten to that scene so a sibling scene can be launched without
 * touching main.tscn.
 */
function makeProject(mainScene?: string): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-render-movie-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  if (mainScene !== undefined) {
    const projectFile = join(dst, 'project.godot');
    const content = readFileSync(projectFile, 'utf8').replace(
      'res://main.tscn',
      `res://${mainScene}`,
    );
    // Fails here rather than as a misleading result if the scene is renamed.
    expect(content, 'project.godot main scene must point at the requested scene').toContain(
      mainScene,
    );
    writeFileSync(projectFile, content, 'utf8');
  }
  tmpDirs.push(dst);
  return dst;
}

function projectFileBytes(projectDir: string): Buffer {
  return readFileSync(join(projectDir, 'project.godot'));
}

/** The render_movie call never edits project.godot and never leaves the bridge behind. */
function expectProjectUntouched(projectDir: string, before: Buffer): void {
  const after = projectFileBytes(projectDir);
  expect(after.equals(before), 'project.godot must be byte-identical after the call').toBe(true);
  expect(after.toString('utf8')).not.toContain('McpBridge');
  expect(existsSync(bridgeScriptAbsPath(projectDir))).toBe(false);
}

function movieEntries(projectDir: string): string[] {
  const dir = moviesDir(projectDir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function skipWhenNoDisplay(testCtx: Pick<TestContext, 'skip'>, text: string): void {
  if (!checkDisplayAvailable() && isHeadlessEnvironmentError(text)) {
    testCtx.skip(`display server unavailable (${text})`);
  }
}

/** Call render_movie; skip for a missing display server, throw for any other error. */
async function renderOrSkip(
  testCtx: Pick<TestContext, 'skip'>,
  args: Record<string, unknown>,
): Promise<{ payload: RenderPayload; content: ContentBlock[] }> {
  const result = await handleRenderMovie(runner, args, ctx);
  if (!result.ok) {
    const text = errorText(result) ?? JSON.stringify(result.error);
    skipWhenNoDisplay(testCtx, text);
    throw new Error(`render_movie returned an error response: ${text}`);
  }
  const envelope = unwrap(result);
  expect(
    envelope.structuredContent,
    'a render_movie success must carry structuredContent',
  ).toBeDefined();
  return {
    payload: envelope.structuredContent as unknown as RenderPayload,
    content: envelope.content as ContentBlock[],
  };
}

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
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

describe('render_movie (live engine)', () => {
  itGodot(
    'check on the fixture main scene is not blank and returns an inline image',
    async (testCtx) => {
      const project = makeProject();
      const before = projectFileBytes(project);

      const { payload, content } = await renderOrSkip(testCtx, { projectPath: project });

      expect(payload.likelyBlank, JSON.stringify(payload.samples)).toBe(false);
      expect(payload.frameCount).toBeGreaterThan(0);
      const images = content.filter((block) => block.type === 'image');
      expect(images.length).toBeGreaterThanOrEqual(1);
      for (const image of images) {
        const decoded = decodePng(Buffer.from(image.data!, 'base64'));
        expect(decoded.width).toBeLessThanOrEqual(MAX_INLINE_WIDTH);
        expect(decoded.height).toBeLessThanOrEqual(MAX_INLINE_HEIGHT);
      }
      expect(movieEntries(project)).toEqual([]);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'check on the blank sibling scene is likely blank',
    async (testCtx) => {
      const project = makeProject(blankScenePath);
      const before = projectFileBytes(project);

      const { payload } = await renderOrSkip(testCtx, {
        projectPath: project,
        frames: TEST_FRAMES,
      });

      expect(payload.likelyBlank, JSON.stringify(payload.samples)).toBe(true);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'check honors the scene parameter',
    async (testCtx) => {
      const project = makeProject();
      const before = projectFileBytes(project);

      const { payload } = await renderOrSkip(testCtx, {
        projectPath: project,
        scene: blankScenePath,
        frames: TEST_FRAMES,
      });

      expect(payload.likelyBlank, JSON.stringify(payload.samples)).toBe(true);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'check on the animated sibling scene reports motion',
    async (testCtx) => {
      const project = makeProject(motionAnimatedScenePath);
      const before = projectFileBytes(project);

      const { payload } = await renderOrSkip(testCtx, {
        projectPath: project,
        frames: TEST_FRAMES,
      });

      expect(payload.anyMotion, JSON.stringify(payload)).toBe(true);
      expect(payload.motion).toBeGreaterThan(0);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'check on the static sibling scene reports no motion',
    async (testCtx) => {
      const project = makeProject(motionStaticScenePath);
      const before = projectFileBytes(project);

      const { payload } = await renderOrSkip(testCtx, {
        projectPath: project,
        frames: TEST_FRAMES,
      });

      expect(payload.anyMotion, JSON.stringify(payload)).toBe(false);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'frames keeps the PNG sequence at the returned paths',
    async (testCtx) => {
      const project = makeProject();
      const before = projectFileBytes(project);

      const { payload, content } = await renderOrSkip(testCtx, {
        projectPath: project,
        mode: 'frames',
        frames: TEST_FRAMES,
      });

      expect(payload.framePaths).toBeDefined();
      expect(payload.framePaths!.length).toBe(payload.frameCount);
      for (const framePath of payload.framePaths!) expect(existsSync(framePath)).toBe(true);
      expect(payload.directory!.startsWith(moviesDir(project))).toBe(true);
      for (const sample of payload.samples) expect(existsSync(sample.path!)).toBe(true);
      expect(payload.measuredFrames).toBeGreaterThanOrEqual(1);
      expect(content.filter((block) => block.type === 'image')).toHaveLength(0);
      if (payload.audioPath !== undefined) expect(existsSync(payload.audioPath)).toBe(true);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'video with avi leaves a non-empty file',
    async (testCtx) => {
      const project = makeProject();
      const before = projectFileBytes(project);

      const { payload } = await renderOrSkip(testCtx, {
        projectPath: project,
        mode: 'video',
        frames: TEST_FRAMES,
      });

      expect(statSync(payload.path!).size).toBeGreaterThan(0);
      expect(payload.byteSize).toBe(statSync(payload.path!).size);
      expect(payload.statsAvailable).toBe(false);
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );

  itGodot(
    'video with ogv writes a file or names the format and engine version',
    async (testCtx) => {
      const project = makeProject();
      const before = projectFileBytes(project);
      const version = await runner.getVersion();
      const match = /^(\d+)\.(\d+)/.exec(version);
      expect(match, `unparseable engine version: ${version}`).not.toBeNull();
      const major = Number(match![1]);
      const minor = Number(match![2]);
      const shouldSupportOgv =
        major > OGV_SUPPORTED_MAJOR ||
        (major === OGV_SUPPORTED_MAJOR && minor >= OGV_SUPPORTED_MINOR);

      const result = await handleRenderMovie(
        runner,
        { projectPath: project, mode: 'video', format: 'ogv', frames: TEST_FRAMES },
        ctx,
      );
      if (result.ok) {
        const payload = unwrap(result).structuredContent as unknown as RenderPayload;
        expect(statSync(payload.path!).size).toBeGreaterThan(0);
      } else {
        const text = errorText(result) ?? JSON.stringify(result.error);
        skipWhenNoDisplay(testCtx, text);
        expect(text).toContain('ogv');
        expect(text).toContain(version);
        expect(shouldSupportOgv, `ogv failed on engine ${version}: ${text}`).toBe(false);
      }
      expectProjectUntouched(project, before);
    },
    TEST_TIMEOUT_MS,
  );
});
