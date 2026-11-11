/** Each project is a temp copy plus a sibling marker scene whose label names the project, so get_ui_elements shows which session answered. */

import { describe, beforeEach, afterEach, expect } from 'vitest';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { errorText, hasError, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { bridgeDir } from '../../src/utils/artifact-paths.js';
import {
  handleGetDebugOutput,
  handleGetUiElements,
  handleStopProject,
  handleSwitchProject,
} from '../../src/tools/runtime-tools.js';
import { handleCheckProject } from '../../src/tools/project-tools.js';
import { handleAddNode } from '../../src/tools/scene-tools.js';

const BRIDGE_WAIT_MS = 20000;
const EXIT_WAIT_MS = 15000;
// Two sequential launches, bridge round trips, a stop and a kill: the case budget must exceed the budgets inside it.
const CASE_TIMEOUT_MS = 180000;
const MARKER_SCENE = 'marker.tscn';
const LABEL_A = 'project-a';
const LABEL_B = 'project-b';
const MAIN_SCENE = 'main.tscn';
// On a loaded CI runner with two software-rendered games a probe can miss the ping budget with nothing wrong, so the idempotent switch is retried before the bridge is called unresponsive.
const SWITCH_PROBE_ATTEMPTS = 3;

const tmpDirs: string[] = [];
let runner: GodotRunner;

function markerSceneText(label: string): string {
  return [
    '[gd_scene format=3]',
    '',
    '[node name="Marker" type="Control"]',
    '',
    '[node name="ProjectLabel" type="Label" parent="."]',
    `text = "${label}"`,
    '',
  ].join('\n');
}

function makeProject(label: string): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-multiproject-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  writeFileSync(join(dst, MARKER_SCENE), markerSceneText(label), 'utf8');
  tmpDirs.push(dst);
  return dst;
}

async function startSession(
  ctx: Parameters<typeof runProjectOrSkip>[1],
  projectPath: string,
): Promise<void> {
  await runProjectOrSkip(runner, ctx, projectPath, {
    scene: MARKER_SCENE,
    waitMs: BRIDGE_WAIT_MS,
  });
}

function payloadOf(result: unknown): Record<string, unknown> {
  expect(hasError(result), String(errorText(result))).toBe(false);
  return unwrap(result).structuredContent as Record<string, unknown>;
}

function fullText(result: unknown): string {
  return unwrap(result)
    .content.map((entry) => entry.text ?? '')
    .join('\n');
}

function labels(result: unknown): string[] {
  const elements = payloadOf(result).elements as Array<{ text?: string }>;
  return elements.map((element) => element.text).filter((text): text is string => !!text);
}

async function probeAnswers(projectPath: string, first: Record<string, unknown>): Promise<boolean> {
  let payload = first;
  for (let attempt = 1; attempt < SWITCH_PROBE_ATTEMPTS; attempt += 1) {
    if (payload.bridgeResponsive === true) break;
    payload = payloadOf(await handleSwitchProject(runner, { projectPath }));
  }
  return payload.bridgeResponsive === true;
}

function liveProjectPaths(): string[] {
  return runner.listLiveSessions().map((info) => info.projectPath);
}

beforeEach(() => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
});

afterEach(async () => {
  // Bounded and never throws, so no Godot process outlives a skipped or failed test.
  await runner.stopAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    removeTmpDir(dir);
  }
});

describe('two projects on one runner', () => {
  itGodot(
    'two projects run at once and the runtime tools follow switch_project',
    async (ctx) => {
      const projectA = makeProject(LABEL_A);
      const projectB = makeProject(LABEL_B);
      const a = resolve(projectA);
      const b = resolve(projectB);

      await startSession(ctx, projectA);
      await startSession(ctx, projectB);
      expect(liveProjectPaths()).toEqual([a, b]);
      expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);

      const uiB = await handleGetUiElements(runner, {});
      expect(payloadOf(uiB).projectPath).toBe(b);
      expect(labels(uiB)).toContain(LABEL_B);
      expect(labels(uiB)).not.toContain(LABEL_A);

      const switched = payloadOf(await handleSwitchProject(runner, { projectPath: projectA }));
      expect(switched.projectPath).toBe(a);
      expect(switched.previousProjectPath).toBe(b);
      expect(switched.live).toBe(true);
      expect(await probeAnswers(projectA, switched)).toBe(true);

      const uiA = await handleGetUiElements(runner, {});
      expect(payloadOf(uiA).projectPath).toBe(a);
      expect(labels(uiA)).toContain(LABEL_A);
      expect(labels(uiA)).not.toContain(LABEL_B);

      const checked = payloadOf(await handleCheckProject(runner, { projectPath: projectB }));
      const runtime = checked.runtime as {
        activeSession: boolean;
        projectPath: string;
        liveSessions: Array<{ current: boolean }>;
        project: Record<string, unknown>;
      };
      expect(runtime.activeSession).toBe(true);
      expect(runtime.projectPath).toBe(a);
      expect(runtime.liveSessions).toHaveLength(2);
      expect(runtime.liveSessions.filter((session) => session.current)).toHaveLength(1);
      expect(runtime.project).toEqual({
        projectPath: b,
        session: 'live',
        current: false,
        sessionMode: 'spawned',
      });

      const mainSceneB = join(projectB, MAIN_SCENE);
      const before = readFileSync(mainSceneB);
      const refused = await handleAddNode(runner, {
        projectPath: projectB,
        scenePath: MAIN_SCENE,
        nodeType: 'Node2D',
        nodeName: 'ShouldNotLand',
      });
      expect(hasError(refused)).toBe(true);
      expect(errorText(refused)).toMatch(/not the current one/);
      expect(fullText(refused)).toContain('switch_project');
      expect(readFileSync(mainSceneB).equals(before)).toBe(true);

      const stopped = payloadOf(await handleStopProject(runner));
      expect(stopped.projectPath).toBe(a);
      expect(stopped.message as string).toContain(b);
      expect(existsSync(bridgeDir(projectA))).toBe(false);
      expect(existsSync(bridgeDir(projectB))).toBe(true);

      const noFallback = await handleGetUiElements(runner, {});
      expect(hasError(noFallback)).toBe(true);
      expect(errorText(noFallback)).toMatch(/No current runtime session/);
      expect(fullText(noFallback)).toContain(b);
      expect(fullText(noFallback)).toContain('switch_project');
      expect(runner.hasLiveSessionOnProject(projectB)).toBe(true);
      expect(runner.getCurrentSessionInfo()).toBeNull();

      payloadOf(await handleSwitchProject(runner, { projectPath: projectB }));
      expect(labels(await handleGetUiElements(runner, {}))).toContain(LABEL_B);
      expect(payloadOf(await handleStopProject(runner)).projectPath).toBe(b);
      expect(runner.listSessions()).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'a current game that exits is reported without falling back, and its logs stay reachable',
    async (ctx) => {
      const projectA = makeProject(LABEL_A);
      const projectB = makeProject(LABEL_B);
      const a = resolve(projectA);
      const b = resolve(projectB);

      await startSession(ctx, projectA);
      await startSession(ctx, projectB);
      const spawned = runner.activeProcess!;
      const exited = new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Godot process did not exit within timeout')),
          EXIT_WAIT_MS,
        );
        spawned.process.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
      spawned.process.kill('SIGKILL');
      await exited;

      const afterExit = await handleGetUiElements(runner, {});
      expect(hasError(afterExit)).toBe(true);
      expect(errorText(afterExit)).toMatch(/spawned Godot process has exited/);
      const exitText = fullText(afterExit);
      expect(exitText).toContain(b);
      expect(exitText).toContain(a);
      expect(exitText).toContain('switch_project');
      expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);

      const logs = payloadOf(handleGetDebugOutput(runner, {}));
      expect(logs.running).toBe(false);
      expect(logs.projectPath).toBe(b);

      const toA = payloadOf(await handleSwitchProject(runner, { projectPath: projectA }));
      expect(toA.live).toBe(true);
      expect(labels(await handleGetUiElements(runner, {}))).toContain(LABEL_A);

      const back = payloadOf(await handleSwitchProject(runner, { projectPath: projectB }));
      expect(back.live).toBe(false);
      expect(back.bridgeResponsive).toBeNull();
      expect((back.warnings as string[])[0]).toMatch(/exited/);
      const logsAgain = payloadOf(handleGetDebugOutput(runner, {}));
      expect(logsAgain.running).toBe(false);
      expect(logsAgain.projectPath).toBe(b);
      expect(logsAgain.exitCode).not.toBeUndefined();

      const stopped = payloadOf(await handleStopProject(runner));
      expect(stopped.alreadyExited).toBe(true);
      expect(stopped.projectPath).toBe(b);
      expect(runner.hasLiveSessionOnProject(projectA)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
