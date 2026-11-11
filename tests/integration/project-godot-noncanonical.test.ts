// Each form Godot 4.6 reads but the editor never writes must load its planted target in the real engine and be named in the get_project_settings and list_autoloads warnings.
// One junk-line-before-repeated-header form was observed on 4.6.2 to plant nothing; its engine check pins that, and the warning still names the line.

import { describe, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { itGodot } from '../helpers/godot-skip.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetSceneTree } from '../../src/tools/node-tools.js';
import { handleGetProjectSettings } from '../../src/tools/project-tools.js';
import { handleListAutoloads } from '../../src/tools/autoload-tools.js';

const tmp = useTmpDirs();

const CASE_TIMEOUT_MS = 120000;
const BENIGN_MAIN_SCENE = 'res://main.tscn';
const PLANTED_MAIN_SCENE = 'res://evil.tscn';
const PROBE_OUTPUT_FILE = 'probe_out.json';
const PLANTED_AUTOLOAD_MARKER_FILE = 'evil_loaded.txt';

const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n';
const INERT_SCRIPT = 'extends Node\n';

/** Runs in `_init`, early enough to be in place before a headless operation is dispatched. */
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

/** `nothing_observed`: the engine was seen to load nothing from this form. */
type Planted = 'main_scene' | 'autoload' | 'nothing_observed';

const PROBE_ONLY_AUTOLOAD_SETTINGS = ['autoload/Probe'];
const NON_CANONICAL_WARNING =
  /project\.godot has \d+ line\(s\) that are not in the form Godot writes/;

interface NonCanonicalForm {
  name: string;
  extra: string;
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
  {
    name: 'a junk token before an autoload entry',
    extra: '[autoload]\nx\nEvil="*res://evil.gd"\n',
    plants: 'autoload',
  },
];

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

function warningsOf(result: unknown): string[] {
  const payload = unwrap(result).structuredContent as { warnings?: string[] } | undefined;
  return payload?.warnings ?? [];
}

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

  it('control: the readers report a canonical project without a warning', async () => {
    const dir = makeProject(CANONICAL_HEAD, false);

    expect(warningsOf(await handleGetProjectSettings({ projectPath: dir }))).toEqual([]);
    expect(warningsOf(handleListAutoloads({ projectPath: dir }))).toEqual([]);
  });

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

      it('the readers name the line in their warnings', async () => {
        const dir = makeProject(`${CANONICAL_HEAD}${form.extra}`, false);

        const settingsWarnings = warningsOf(await handleGetProjectSettings({ projectPath: dir }));
        expect(settingsWarnings.join(' ')).toMatch(NON_CANONICAL_WARNING);
        if (form.plants === 'autoload') {
          const autoloadWarnings = warningsOf(handleListAutoloads({ projectPath: dir }));
          expect(autoloadWarnings.join(' ')).toMatch(NON_CANONICAL_WARNING);
        }
      });
    });
  }
});
