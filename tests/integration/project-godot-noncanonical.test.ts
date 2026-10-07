/**
 * Integration test: statements Godot reads from project.godot but never writes.
 *
 * Godot 4.6 loads its main scene and its autoloads from several spellings the
 * editor never produces (a header and an assignment on one line, two
 * statements on one line, a blank inside a key, a quoted key, an autoload on
 * the header line, a `#` line under [autoload], a second entry trailing the
 * first). The launch scan has to see what the engine will load, so each form
 * is checked twice:
 *
 *   1. against the real engine, which must actually load the planted target
 *      (otherwise the form is not a real bypass and the next check proves
 *      nothing), and
 *   2. against the launch gate, which must count the statement as one it
 *      could not read reliably and refuse the launch under strict mode.
 *
 * One form is different. A junk line before a repeated header was expected to
 * plant a main scene and, on its first run against 4.6.2, did not: the engine
 * kept the benign one. Its engine check asserts that observed result, so a
 * version that starts reading the form the other way is noticed, and its gate
 * check is unchanged: the line is not one Godot writes, and the reader fails
 * closed on it whatever the engine makes of it.
 *
 * The engine check reads two things back from a headless run: a probe
 * autoload (registered on a canonical line, so it loads whatever the planted
 * line does) records the main scene the engine resolved, and the planted
 * autoload script writes a marker file when the engine instantiates it. Both
 * are plain files, so the assertions do not depend on any engine text format.
 *
 * The gate check needs no engine, but lives here so one table drives both.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

import { describe, beforeAll, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { expectErrorMatching } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetSceneTree } from '../../src/tools/node-tools.js';
import { runLaunchGate } from '../../src/utils/launch-gate.js';

const tmp = useTmpDirs();

const CASE_TIMEOUT_MS = 120000;
const BENIGN_MAIN_SCENE = 'res://main.tscn';
const PLANTED_MAIN_SCENE = 'res://evil.tscn';
const PROBE_OUTPUT_FILE = 'probe_out.json';
const PLANTED_AUTOLOAD_MARKER_FILE = 'evil_loaded.txt';

const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n';
/** A script the launch scan has nothing to say about. */
const INERT_SCRIPT = 'extends Node\n';

/**
 * Records, from inside the engine, what it resolved from project.godot. Runs
 * in `_init`, which is early enough to be in place before a headless
 * operation is dispatched.
 */
const PROBE_SCRIPT = [
  'extends Node',
  '',
  'func _init() -> void:',
  '\tvar autoloads: Array = []',
  '\tfor info in ProjectSettings.get_property_list():',
  '\t\tvar setting_name: String = info["name"]',
  '\t\tif setting_name.begins_with("autoload/"):',
  '\t\t\tautoloads.append(setting_name)',
  '\tvar out := {',
  '\t\t"mainScene": str(ProjectSettings.get_setting("application/run/main_scene", "")),',
  '\t\t"autoloadSettings": autoloads,',
  '\t}',
  `\tvar file := FileAccess.open("res://${PROBE_OUTPUT_FILE}", FileAccess.WRITE)`,
  '\tif file != null:',
  '\t\tfile.store_string(JSON.stringify(out))',
  '\t\tfile.close()',
  '',
].join('\n');

/** The planted autoload: proves, by writing a file, that the engine instantiated it. */
const PLANTED_AUTOLOAD_SCRIPT = [
  'extends Node',
  '',
  'func _init() -> void:',
  `\tvar file := FileAccess.open("res://${PLANTED_AUTOLOAD_MARKER_FILE}", FileAccess.WRITE)`,
  '\tif file != null:',
  '\t\tfile.store_string("loaded")',
  '\t\tfile.close()',
  '',
].join('\n');

/** The project.godot lines every form is appended to: canonical, and loading the probe. */
const CANONICAL_HEAD = [
  'config_version=5',
  '',
  '[autoload]',
  '',
  'Probe="*res://probe.gd"',
  '',
  '[application]',
  '',
  `run/main_scene="${BENIGN_MAIN_SCENE}"`,
  '',
].join('\n');

/**
 * `nothing_observed` is a form the engine was seen to load nothing from: the
 * main scene stays the benign one and no setting under `autoload/` is added.
 */
type Planted = 'main_scene' | 'autoload' | 'nothing_observed';

/** The `autoload/` settings of a project whose only autoload is the probe. */
const PROBE_ONLY_AUTOLOAD_SETTINGS = ['autoload/Probe'];

interface NonCanonicalForm {
  name: string;
  /** Appended to the canonical head. */
  extra: string;
  /** What the form makes the engine load. */
  plants: Planted;
}

const FORMS: ReadonlyArray<NonCanonicalForm> = [
  {
    name: 'a header and an assignment on one line',
    extra: `[application] run/main_scene="${PLANTED_MAIN_SCENE}"\n`,
    plants: 'main_scene',
  },
  {
    name: 'two statements on one line',
    extra: `config/name="x" run/main_scene="${PLANTED_MAIN_SCENE}"\n`,
    plants: 'main_scene',
  },
  {
    name: 'whitespace inside a key',
    extra: `run/main_ scene="${PLANTED_MAIN_SCENE}"\n`,
    plants: 'main_scene',
  },
  {
    name: 'a quoted key',
    extra: `"run/main_scene"="${PLANTED_MAIN_SCENE}"\n`,
    plants: 'main_scene',
  },
  {
    name: 'a junk token before a repeated header',
    extra: `x\n[application]\nrun/main_scene="${PLANTED_MAIN_SCENE}"\n`,
    plants: 'nothing_observed',
  },
  {
    name: 'an autoload on the header line',
    extra: '[autoload] Evil="*res://evil.gd"\n',
    plants: 'autoload',
  },
  {
    name: 'a # line under [autoload]',
    extra: '[autoload]\n#Evil="*res://evil.gd"\n',
    plants: 'autoload',
  },
  {
    name: 'an autoload trailing another on one line',
    extra: '[autoload]\nA="*res://a.gd" Evil="*res://evil.gd"\n',
    plants: 'autoload',
  },
];

/**
 * A project laid out around `projectGodot`. `instrumented` writes the probe
 * and the marker-writing planted autoload; otherwise both are inert scripts,
 * so a launch scan has no finding of its own and any refusal comes from the
 * unreadable statement.
 */
function makeProject(projectGodot: string, instrumented: boolean): string {
  const dir = tmp.makeProject('godot-mcp-noncanonical-', projectGodot);
  writeFileSync(join(dir, 'main.tscn'), SCRIPTLESS_SCENE, 'utf8');
  writeFileSync(join(dir, 'evil.tscn'), SCRIPTLESS_SCENE, 'utf8');
  writeFileSync(join(dir, 'a.gd'), INERT_SCRIPT, 'utf8');
  writeFileSync(join(dir, 'probe.gd'), instrumented ? PROBE_SCRIPT : INERT_SCRIPT, 'utf8');
  writeFileSync(
    join(dir, 'evil.gd'),
    instrumented ? PLANTED_AUTOLOAD_SCRIPT : INERT_SCRIPT,
    'utf8',
  );
  return dir;
}

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

interface ProbeOutput {
  mainScene: string;
  autoloadSettings: string[];
}

/** Run one headless operation, so the engine loads project.godot and its autoloads. */
async function runEngineOver(dir: string): Promise<ProbeOutput> {
  const result = await handleGetSceneTree(runner, { projectPath: dir, scenePath: 'main.tscn' });
  const probePath = join(dir, PROBE_OUTPUT_FILE);
  expect(
    existsSync(probePath),
    `the probe autoload wrote nothing; the headless call returned ${JSON.stringify(result)}`,
  ).toBe(true);
  return JSON.parse(readFileSync(probePath, 'utf8')) as ProbeOutput;
}

describe('project.godot statements the engine reads and the editor never writes', () => {
  itGodot(
    'control: a canonical project resolves its own main scene and plants nothing',
    async () => {
      const dir = makeProject(CANONICAL_HEAD, true);
      const probed = await runEngineOver(dir);

      expect(probed.mainScene, JSON.stringify(probed)).toBe(BENIGN_MAIN_SCENE);
      expect(existsSync(join(dir, PLANTED_AUTOLOAD_MARKER_FILE))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  itGodot(
    'control: the launch gate reads a canonical project cleanly and strict mode launches it',
    async () => {
      const dir = makeProject(CANONICAL_HEAD, false);
      const result = await runLaunchGate(
        { projectPath: dir, confirm: false, launchedByServer: true, toolName: 'run_project' },
        makeContext({ strict: true }),
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect(result.value.warnings).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  for (const form of FORMS) {
    describe(form.name, () => {
      itGodot(
        form.plants === 'nothing_observed'
          ? 'the engine keeps the benign main scene and adds no autoload'
          : 'the engine loads the planted target',
        async () => {
          const dir = makeProject(`${CANONICAL_HEAD}${form.extra}`, true);
          const probed = await runEngineOver(dir);
          const seen = JSON.stringify(probed);

          if (form.plants === 'main_scene') {
            expect(probed.mainScene, seen).toBe(PLANTED_MAIN_SCENE);
          } else if (form.plants === 'autoload') {
            expect(existsSync(join(dir, PLANTED_AUTOLOAD_MARKER_FILE)), seen).toBe(true);
          } else {
            expect(probed.mainScene, seen).toBe(BENIGN_MAIN_SCENE);
            expect(probed.autoloadSettings, seen).toEqual(PROBE_ONLY_AUTOLOAD_SETTINGS);
          }
        },
        CASE_TIMEOUT_MS,
      );

      itGodot(
        'the launch gate counts the statement and strict mode refuses',
        async () => {
          const dir = makeProject(`${CANONICAL_HEAD}${form.extra}`, false);

          const lenient = await runLaunchGate(
            { projectPath: dir, confirm: false, launchedByServer: true, toolName: 'run_project' },
            makeContext({ strict: false }),
          );
          expect(lenient.ok, JSON.stringify(lenient)).toBe(true);
          if (lenient.ok) {
            expect(lenient.value.warnings.join('\n')).toMatch(
              /project\.godot has \d+ line\(s\) that are not in the form Godot writes/,
            );
          }

          const strict = await runLaunchGate(
            { projectPath: dir, confirm: false, launchedByServer: true, toolName: 'run_project' },
            makeContext({ strict: true }),
          );
          expectErrorMatching(strict, /Strict mode: refusing to launch/);
        },
        CASE_TIMEOUT_MS,
      );
    });
  }
});
