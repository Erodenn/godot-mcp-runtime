/**
 * Two projects running at once on one GodotRunner (one MCP server), against
 * real Godot processes: switch_project, per-project UI content, the edit guard
 * on a project that is live but not current, stop and self-exit without any
 * fallback to the other session.
 *
 * Each project is a temp copy of the committed fixture plus a sibling marker
 * scene whose label names the project, so what get_ui_elements returns shows
 * which session answered. The committed fixture and its main.tscn are never
 * touched.
 *
 * Requires GODOT_PATH; skipped when it is unset, same as every other file
 * under tests/integration/.
 */

import { describe, beforeEach, afterEach, expect } from 'vitest';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
// Two sequential launches, several bridge round trips, a stop and a kill. The
// case budget has to exceed the budgets inside it.
const CASE_TIMEOUT_MS = 180000;
const MARKER_SCENE = 'marker.tscn';
const LABEL_A = 'project-a';
const LABEL_B = 'project-b';
const MAIN_SCENE = 'main.tscn';

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
    background: true,
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

function liveProjectPaths(): string[] {
  return runner.listLiveSessions().map((info) => info.projectPath);
}

beforeEach(() => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
});

afterEach(async () => {
  // Bounded and never throws, so it runs after a skip or a failed assertion
  // and no Godot process outlives the test.
  await runner.stopAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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

      // 1. Start A, then B: both live, B current.
      await startSession(ctx, projectA);
      await startSession(ctx, projectB);
      expect(liveProjectPaths()).toEqual([a, b]);
      expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);

      // 2. The runtime tools act on B.
      const uiB = await handleGetUiElements(runner, {});
      expect(payloadOf(uiB).projectPath).toBe(b);
      expect(labels(uiB)).toContain(LABEL_B);
      expect(labels(uiB)).not.toContain(LABEL_A);

      // 3. Switch to A.
      const switched = payloadOf(await handleSwitchProject(runner, { projectPath: projectA }));
      expect(switched.projectPath).toBe(a);
      expect(switched.previousProjectPath).toBe(b);
      expect(switched.live).toBe(true);
      expect(switched.bridgeResponsive).toBe(true);

      // 4. Now they act on A.
      const uiA = await handleGetUiElements(runner, {});
      expect(payloadOf(uiA).projectPath).toBe(a);
      expect(labels(uiA)).toContain(LABEL_A);
      expect(labels(uiA)).not.toContain(LABEL_B);

      // 5. check_project: A is current, B's own session is reported too.
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

      // 6. A headless edit on B is refused while B is live and not current.
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

      // 7. stop_project stops A only; B keeps running and its bridge stays.
      const stopped = payloadOf(await handleStopProject(runner));
      expect(stopped.projectPath).toBe(a);
      expect(stopped.message as string).toContain(b);
      expect(existsSync(bridgeDir(projectA))).toBe(false);
      expect(existsSync(bridgeDir(projectB))).toBe(true);

      // 8. Nothing is current now, and no tool falls back to B.
      const noFallback = await handleGetUiElements(runner, {});
      expect(hasError(noFallback)).toBe(true);
      expect(errorText(noFallback)).toMatch(/No current runtime session/);
      expect(fullText(noFallback)).toContain(b);
      expect(fullText(noFallback)).toContain('switch_project');
      expect(runner.hasLiveSessionOnProject(projectB)).toBe(true);
      expect(runner.getCurrentSessionInfo()).toBeNull();

      // 9. Switch to B, use it, stop it.
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

      // 1. Start A, then B, and kill B's process from outside, the way a crash
      //    or a closed window would.
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

      // 2. The next runtime call says the game exited and lists A; it does not use A.
      const afterExit = await handleGetUiElements(runner, {});
      expect(hasError(afterExit)).toBe(true);
      expect(errorText(afterExit)).toMatch(/spawned Godot process has exited/);
      const exitText = fullText(afterExit);
      expect(exitText).toContain(b);
      expect(exitText).toContain(a);
      expect(exitText).toContain('switch_project');
      expect(runner.getCurrentSessionInfo()?.projectPath).toBe(b);

      // 3. The exited game's logs are still readable.
      const logs = payloadOf(handleGetDebugOutput(runner, {}));
      expect(logs.running).toBe(false);
      expect(logs.projectPath).toBe(b);

      // 4. A is still live and reachable through switch_project.
      const toA = payloadOf(await handleSwitchProject(runner, { projectPath: projectA }));
      expect(toA.live).toBe(true);
      expect(labels(await handleGetUiElements(runner, {}))).toContain(LABEL_A);

      // 5. Switching back to the exited session works and says it is not live.
      const back = payloadOf(await handleSwitchProject(runner, { projectPath: projectB }));
      expect(back.live).toBe(false);
      expect(back.bridgeResponsive).toBeNull();
      expect((back.warnings as string[])[0]).toMatch(/exited/);
      const logsAgain = payloadOf(handleGetDebugOutput(runner, {}));
      expect(logsAgain.running).toBe(false);
      expect(logsAgain.projectPath).toBe(b);
      expect(logsAgain.exitCode).not.toBeUndefined();

      // 6. stop_project frees the exited session and leaves A running.
      const stopped = payloadOf(await handleStopProject(runner));
      expect(stopped.alreadyExited).toBe(true);
      expect(stopped.projectPath).toBe(b);
      expect(runner.hasLiveSessionOnProject(projectA)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
