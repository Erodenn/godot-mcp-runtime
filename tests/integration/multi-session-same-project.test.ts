/** Two GodotRunner instances (two MCP servers) sharing one project, exercising the on-disk owner registry and the last-leaver cleanup rule. */

import { describe, beforeEach, afterEach, expect } from 'vitest';
import { cpSync, existsSync, readdirSync, readFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
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
// Vitest's 5 s default undercuts a single launch's own wait budget, so the case budget must exceed the budgets inside it.
const CASE_TIMEOUT_MS = 120000;

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
    removeTmpDir(dir);
  }
});

describe('two GodotRunner sessions sharing one project', () => {
  itGodot(
    'A runs a session, restarts it without stopping, and B can act as a second concurrent session',
    async (ctx) => {
      await runProjectOrSkip(runnerA, ctx, projectPath, {
        waitMs: BRIDGE_WAIT_MS,
      });

      await runnerB.executeOperation('get_scene_tree', { scenePath: 'main.tscn' }, projectPath);
      expect(projectGodotEntry()).toContain('McpBridge=');

      await runProjectOrSkip(runnerA, ctx, projectPath, {
        waitMs: BRIDGE_WAIT_MS,
      });

      await runProjectOrSkip(runnerB, ctx, projectPath, {
        waitMs: BRIDGE_WAIT_MS,
      });
      expect(ownerFileCount()).toBe(2);

      const pingA = await runnerA.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      const pingB = await runnerB.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      expect(JSON.parse(pingA).status).toBe('pong');
      expect(JSON.parse(pingB).status).toBe('pong');

      expect(runnerA.otherLiveSessionsOnProject(projectPath).length).toBe(1);
      expect(runnerB.otherLiveSessionsOnProject(projectPath).length).toBe(1);

      await runnerB.stopProject();
      const stillPingA = await runnerA.sendCommand('ping', {}, BRIDGE_CMD_TIMEOUT_MS);
      expect(JSON.parse(stillPingA).status).toBe('pong');
      expect(projectGodotEntry()).toContain('McpBridge=');
      expect(ownerFileCount()).toBe(1);
      expect(runnerA.otherLiveSessionsOnProject(projectPath).length).toBe(0);

      await runnerA.stopProject();
      expect(projectGodotEntry()).not.toContain('McpBridge=');
      expect(existsSync(bridgeDir(projectPath))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
