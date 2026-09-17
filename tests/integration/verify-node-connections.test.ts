/**
 * Integration tests for verify_node_connections.
 *
 * Covers the four check classes against real Godot: clean scene verifies,
 * method_missing_on_target (connection to a method the target lacks),
 * naming_convention (handler not starting with _on_), orphaned_handler
 * (script-defined _on_* method with no incoming connection), and the
 * nodePath subtree scope (issues outside the scope are not reported, and
 * handlers connected to targets outside the scope are not false orphans).
 *
 * Requires GODOT_PATH. Skipped in CI.
 */

import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

function cleanup(dirs: string[]) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  dirs.length = 0;
}

async function verify(runner: GodotRunner, project: string, nodePath?: string) {
  const params: Record<string, string> = { scenePath: 'main.tscn' };
  if (nodePath) params.nodePath = nodePath;
  const { stdout } = await runner.executeOperation(
    'verify_node_connections',
    params,
    project,
    30000,
  );
  return JSON.parse(extractJson(stdout));
}

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

describe('verify_node_connections', () => {
  const tmpDirs: string[] = [];
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = makeTmpProject();
    tmpDirs.push(tmpProject);
  });

  afterAll(() => cleanup(tmpDirs));

  itGodot(
    'verifies a clean scene',
    async () => {
      const result = await verify(runner, tmpProject);
      expect(result.verified).toBe(true);
      expect(result.issueCount).toBe(0);
      expect(result.issues).toEqual([]);
    },
    60000,
  );

  itGodot(
    'reports method_missing_on_target when the handler does not exist on the target',
    async () => {
      // connect_signal refuses to wire a nonexistent method, so write the
      // malformed [connection] directly into the .tscn - the state a broken
      // code-generated or hand-edited scene ends up in.
      const tscn = join(tmpProject, 'main.tscn');
      let content = readFileSync(tscn, 'utf8');
      content +=
        '\n[connection signal="ready" from="." to="Label" method="definitely_not_a_real_method"]\n';
      writeFileSync(tscn, content);

      const result = await verify(runner, tmpProject);
      expect(result.verified).toBe(false);
      const issue = result.issues.find(
        (i: { problem: string }) => i.problem === 'method_missing_on_target',
      );
      expect(issue).toBeDefined();
      expect(issue.node).toBe('root');
      expect(issue.signal).toBe('ready');
      expect(issue.target).toBe('root/Label');
      expect(issue.method).toBe('definitely_not_a_real_method');
    },
    60000,
  );

  itGodot(
    'reports naming_convention when the handler does not begin with _on_',
    async () => {
      // queue_free exists on Label, so only the naming check fires.
      await runner.executeOperation(
        'connect_signal',
        {
          scenePath: 'main.tscn',
          nodePath: 'root',
          signal: 'ready',
          targetNodePath: 'root/Label',
          method: 'queue_free',
        },
        tmpProject,
        30000,
      );

      const result = await verify(runner, tmpProject);
      expect(result.verified).toBe(false);
      const issue = result.issues.find(
        (i: { problem: string }) => i.problem === 'naming_convention',
      );
      expect(issue).toBeDefined();
      expect(issue.method).toBe('queue_free');
    },
    60000,
  );

  itGodot(
    'reports orphaned_handler for script-defined _on_* methods with no incoming connection',
    async () => {
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'orphaned.gd'),
        'extends Label\nfunc _on_label_pressed():\n\ttext = "clicked"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/orphaned.gd' },
        tmpProject,
        30000,
      );

      const result = await verify(runner, tmpProject);
      expect(result.verified).toBe(false);
      const issue = result.issues.find(
        (i: { problem: string }) => i.problem === 'orphaned_handler',
      );
      expect(issue).toBeDefined();
      expect(issue.node).toBe('root/Label');
      expect(issue.method).toBe('_on_label_pressed');
    },
    60000,
  );

  itGodot(
    'a partially-wired node only reports the unwired _on_* method as orphaned',
    async () => {
      // One node with two _on_* methods where only one is connected: the
      // connected one must not be flagged just because a sibling method is.
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'partial.gd'),
        'extends Label\n' +
          'func _on_first_connected():\n' +
          '\ttext = "one"\n' +
          'func _on_second_orphaned():\n' +
          '\ttext = "two"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/partial.gd' },
        tmpProject,
        30000,
      );
      await runner.executeOperation(
        'connect_signal',
        {
          scenePath: 'main.tscn',
          nodePath: 'root',
          signal: 'ready',
          targetNodePath: 'root/Label',
          method: '_on_first_connected',
        },
        tmpProject,
        30000,
      );

      const result = await verify(runner, tmpProject);
      const orphans = result.issues.filter(
        (i: { problem: string }) => i.problem === 'orphaned_handler',
      );
      expect(orphans.length).toBe(1);
      expect(orphans[0].method).toBe('_on_second_orphaned');
      // The connected handler must appear nowhere in the issues.
      expect(
        result.issues.some((i: { method?: string }) => i.method === '_on_first_connected'),
      ).toBe(false);
    },
    60000,
  );

  itGodot(
    'does not report a connected handler as orphaned',
    async () => {
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'wired.gd'),
        'extends Label\nfunc _on_main_ready():\n\ttext = "ready"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/wired.gd' },
        tmpProject,
        30000,
      );
      await runner.executeOperation(
        'connect_signal',
        {
          scenePath: 'main.tscn',
          nodePath: 'root',
          signal: 'ready',
          targetNodePath: 'root/Label',
          method: '_on_main_ready',
        },
        tmpProject,
        30000,
      );

      const result = await verify(runner, tmpProject);
      expect(
        result.issues.find((i: { problem: string }) => i.problem === 'orphaned_handler'),
      ).toBeUndefined();
      expect(
        result.issues.find((i: { problem: string }) => i.problem === 'naming_convention'),
      ).toBeUndefined();
    },
    60000,
  );

  itGodot(
    'scopes to the nodePath subtree',
    async () => {
      // Orphaned handler on Label, scope verification to Sprite2D: no issues.
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'orphaned.gd'),
        'extends Label\nfunc _on_label_pressed():\n\ttext = "clicked"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/orphaned.gd' },
        tmpProject,
        30000,
      );

      const result = await verify(runner, tmpProject, 'root/Sprite2D');
      expect(result.verified).toBe(true);
      expect(result.issues).toEqual([]);
    },
    60000,
  );

  itGodot(
    'errors when the nodePath is not found',
    async () => {
      const { stderr } = await runner.executeOperation(
        'verify_node_connections',
        { scenePath: 'main.tscn', nodePath: 'root/Missing' },
        tmpProject,
        30000,
      );
      expect(stderr).toContain('Node not found');
    },
    60000,
  );
});
