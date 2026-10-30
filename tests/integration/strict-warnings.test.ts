// Both GDScript files must still load in a project that raises every warning the engine knows to error.
// Rationale: "GDScript warning settings" in docs/architecture.md.

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { removeTmpDir } from '../helpers/tmp.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

const execFileAsync = promisify(execFile);

const BRIDGE_WAIT_MS = 20000;
const BRIDGE_COMMAND_TIMEOUT_MS = 15000;
const CASE_TIMEOUT_MS = 60000;
const HEADLESS_RUN_TIMEOUT_MS = 30000;
const LIST_MARKER = 'STRICT_WARNING ';

const LIST_WARNINGS_SCRIPT = [
  'extends SceneTree',
  'func _init() -> void:',
  '\tfor p: Dictionary in ProjectSettings.get_property_list():',
  '\t\tvar n: String = p["name"]',
  '\t\tif n.begins_with("debug/gdscript/warnings/") and typeof(ProjectSettings.get_setting(n)) == TYPE_INT:',
  `\t\t\tprint("${LIST_MARKER}", n.trim_prefix("debug/gdscript/warnings/"))`,
  '\tquit()',
  '',
].join('\n');

/** Every warning-level setting the engine under test knows, read from its own ProjectSettings. */
async function engineWarnings(godotPath: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'godot-mcp-runtime-warnings-'));
  try {
    writeFileSync(join(dir, 'project.godot'), 'config_version=5\n', 'utf8');
    writeFileSync(join(dir, 'list_warnings.gd'), LIST_WARNINGS_SCRIPT, 'utf8');
    const { stdout } = await execFileAsync(
      godotPath,
      ['--headless', '--path', dir, '--script', 'res://list_warnings.gd'],
      { timeout: HEADLESS_RUN_TIMEOUT_MS },
    );
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(LIST_MARKER))
      .map((line) => line.slice(LIST_MARKER.length).trim());
  } finally {
    removeTmpDir(dir);
  }
}

/** A project with one script-free scene and every given warning set to error. */
function makeStrictProject(warnings: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'godot-mcp-runtime-strict-'));
  writeFileSync(
    join(dir, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      '',
      'config/name="godot-mcp-runtime strict warnings"',
      'run/main_scene="res://main.tscn"',
      '',
      '[debug]',
      '',
      ...warnings.map((w) => `gdscript/warnings/${w}=2`),
      '',
      '[rendering]',
      '',
      'renderer/rendering_method="gl_compatibility"',
      'renderer/rendering_method.mobile="gl_compatibility"',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'main.tscn'),
    '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    'utf8',
  );
  return dir;
}

describe('a project that raises every GDScript warning to error', () => {
  let runner: GodotRunner;
  let warnings: string[] = [];
  let project: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
    if (process.env.GODOT_PATH) {
      warnings = await engineWarnings(process.env.GODOT_PATH);
    }
  });

  afterEach(async () => {
    await runner.stopProject().catch(() => undefined);
    if (project) {
      removeTmpDir(project);
      project = null;
    }
  });

  itGodot('finds the engine warnings it raises, untyped_declaration among them', () => {
    expect(warnings).toContain('untyped_declaration');
  });

  itGodot(
    'still runs headless operations (godot_operations.gd)',
    async () => {
      project = makeStrictProject(warnings);
      const { stdout, stderr } = await runner.executeOperation(
        'validate_resource',
        { scenePath: 'main.tscn' },
        project,
        HEADLESS_RUN_TIMEOUT_MS,
      );
      expect(stderr).not.toMatch(/Parse Error/);
      const json = JSON.parse(extractJson(stdout));
      expect(json).toHaveProperty('valid', true);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'still loads the bridge autoload (mcp_bridge.gd)',
    async (ctx) => {
      project = makeStrictProject(warnings);
      await runProjectOrSkip(runner, ctx, project, { waitMs: BRIDGE_WAIT_MS });
      const pong = JSON.parse(await runner.sendCommand('ping', {}, BRIDGE_COMMAND_TIMEOUT_MS)) as {
        status?: string;
      };
      expect(pong.status).toBe('pong');
    },
    CASE_TIMEOUT_MS,
  );
});
