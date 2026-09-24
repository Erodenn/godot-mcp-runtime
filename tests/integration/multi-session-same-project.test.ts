/**
 * Two GodotRunner instances (two MCP server processes, in effect) sharing one
 * project. Exercises the on-disk owner registry end to end against a real
 * Godot process: the exact scenario issue #61 reported (a same-project
 * restart without an intervening stop losing the bridge autoload) and the
 * last-leaver cleanup rule.
 *
 * Requires GODOT_PATH; skipped when it is unset, same as every other file
 * under tests/integration/. The main session runs this with Godot installed;
 * it is not run as part of this change.
 */

import { describe, beforeEach, afterEach, expect } from 'vitest';
import { cpSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { bridgeDir, bridgeOwnersDir } from '../../src/utils/artifact-paths.js';

const BRIDGE_CMD_TIMEOUT_MS = 15000;
const BRIDGE_WAIT_MS = 20000;

const tmpDirs: string[] = [];
let projectPath: string;
let runnerA: GodotRunner;
let runnerB: GodotRunner;

function makeProjectCopy(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-multisession-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  tmpDirs.push(dst);
  return dst;
}

function projectGodotEntry(): string {
  const projectFile = join(projectPath, 'project.godot');
  return existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : '';
}

function ownerFileCount(): number {
  const dir = bridgeOwnersDir(projectPath);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f: string) => f.endsWith('.json')).length;
}

beforeEach(() => {
  projectPath = makeProjectCopy();
  runnerA = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  runnerB = new GodotRunner({ godotPath: process.env.GODOT_PATH });
});

afterEach(async () => {
  await runnerA.stopProject().catch(() => undefined);
  await runnerB.stopProject().catch(() => undefined);
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('two GodotRunner sessions sharing one project', () => {
  itGodot(
    'A runs a session, restarts it without stopping, and B can act as a second concurrent session',
    async (ctx) => {
      // 1. A runProject (background) + waitForBridge ready.
      await runProjectOrSkip(runnerA, ctx, projectPath, {
        background: true,
        waitMs: BRIDGE_WAIT_MS,
      });

      // 2. B executeOperation (read-only) -> A's McpBridge entry survives.
      await runnerB.executeOperation('get_scene_tree', { scenePath: 'main.tscn' }, projectPath);
      expect(projectGodotEntry()).toContain('McpBridge=');

      // 3. A runProject again WITHOUT stopping -> waitForBridge ready.
      //    This is the exact #61 failure: a same-project restart used to skip
      //    re-adding the autoload entry and die on a bridge timeout.
      await runProjectOrSkip(runnerA, ctx, projectPath, {
        background: true,
        waitMs: BRIDGE_WAIT_MS,
      });

      // 4. B runProject too -> both ready; each answers ping.
      await runProjectOrSkip(runnerB, ctx, projectPath, {
        background: true,
        waitMs: BRIDGE_WAIT_MS,
      });
      expect(ownerFileCount()).toBe(2);

      const pingA = await runnerA.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      const pingB = await runnerB.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      expect(JSON.parse(pingA).status).toBe('pong');
      expect(JSON.parse(pingB).status).toBe('pong');

      // Each session sees the other as a live, non-self owner.
      expect(runnerA.otherLiveSessionsOnProject(projectPath).length).toBe(1);
      expect(runnerB.otherLiveSessionsOnProject(projectPath).length).toBe(1);

      // 5. B stopProject -> A still answers ping, the entry is still present.
      await runnerB.stopProject();
      const stillPingA = await runnerA.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      expect(JSON.parse(stillPingA).status).toBe('pong');
      expect(projectGodotEntry()).toContain('McpBridge=');
      expect(ownerFileCount()).toBe(1);
      expect(runnerA.otherLiveSessionsOnProject(projectPath).length).toBe(0);

      // 6. A stopProject -> entry gone, bridge/ dir gone.
      await runnerA.stopProject();
      expect(projectGodotEntry()).not.toContain('McpBridge=');
      expect(existsSync(bridgeDir(projectPath))).toBe(false);
    },
  );
});
