import { describe, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { cpSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
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
      removeTmpDir(dir);
    } catch {}
  }
  dirs.length = 0;
}

async function verify(runner: GodotRunner, project: string, nodePath?: string) {
  const check: Record<string, string> = { type: 'signals' };
  if (nodePath) check.nodePath = nodePath;
  const params: Record<string, unknown> = {
    scenePath: 'main.tscn',
    checks: [check],
  };
  const { stdout } = await runner.executeOperation('validate_checks', params, project, 30000);
  // Adapts the validate_checks shape ({ valid, errors }) to issue-oriented assertions.
  const parsed = JSON.parse(extractJson(stdout)) as {
    valid: boolean;
    errors: Array<{
      check?: string;
      node?: string;
      signal?: string;
      target?: string;
      method?: string;
      problem?: string;
    }>;
  };
  const signals = parsed.errors.filter((e) => e.check === 'signals');
  return {
    verified: parsed.valid,
    issueCount: parsed.errors.length,
    issues: signals,
  };
}

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

describe('validate: signals checks', () => {
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
      // connect_signal refuses a nonexistent method, so the malformed [connection] is written straight into the .tscn.
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
      // The connected handler must not be flagged just because a sibling method is.
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
    'reports method_missing_on_target for a misspelled private handler on a scripted node',
    async () => {
      // The handler has no _on_ prefix so it cannot register as an orphan; the misspelled connection is then the only possible issue.
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'handlers.gd'),
        'extends Label\n\n\nfunc handle_press() -> void:\n\ttext = "ok"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/handlers.gd' },
        tmpProject,
        30000,
      );
      // connect_signal refuses a method the target lacks, so the misspelling is written straight into the .tscn.
      const tscn = join(tmpProject, 'main.tscn');
      writeFileSync(
        tscn,
        readFileSync(tscn, 'utf8') +
          '\n[connection signal="ready" from="." to="Label" method="_hanlde_press"]\n',
      );

      const result = await verify(runner, tmpProject);
      expect(result.verified).toBe(false);
      expect(result.issues).toEqual([
        {
          check: 'signals',
          node: 'root',
          signal: 'ready',
          target: 'root/Label',
          method: '_hanlde_press',
          problem: 'method_missing_on_target',
          message: 'method_missing_on_target',
        },
      ]);
    },
    60000,
  );

  itGodot(
    'reports no issues for a scripted node whose handlers are all wired',
    async () => {
      // False-positive guard: whole-array comparison prints any engine-internal connection that leaks through instead of filtering it.
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts', 'all_wired.gd'),
        'extends Label\n\n\nfunc _on_main_ready() -> void:\n\ttext = "ready"\n',
      );
      await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Label', scriptPath: 'scripts/all_wired.gd' },
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
      expect(result.issues).toEqual([]);
      expect(result.verified).toBe(true);
    },
    60000,
  );

  itGodot(
    'scopes to the nodePath subtree',
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

      const result = await verify(runner, tmpProject, 'root/Sprite2D');
      expect(result.verified).toBe(true);
      expect(result.issues).toEqual([]);
    },
    60000,
  );

  itGodot(
    'errors when the nodePath is not found',
    async () => {
      const { stdout } = await runner.executeOperation(
        'validate_checks',
        { scenePath: 'main.tscn', checks: [{ type: 'signals', nodePath: 'root/Missing' }] },
        tmpProject,
        30000,
      );
      expect(stdout).toContain('Node not found');
    },
    60000,
  );
});
