/**
 * The launch gate when a uid search ends before every file was read. The cap
 * is thousands of files, so these tests lower it: the real search runs, with a
 * limit small enough to hit in a temp project.
 */

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type * as launchSceneModule from '../../src/utils/launch-scene.js';

const FILE_CAP = 2;

vi.mock('../../src/utils/launch-scene.js', async (importOriginal) => {
  const actual = await importOriginal<typeof launchSceneModule>();
  return {
    ...actual,
    findFilesByUid: (projectDir: string, uid: string) =>
      actual.findFilesByUid(projectDir, uid, FILE_CAP),
    resolveLaunchScene: (projectDir: string) => actual.resolveLaunchScene(projectDir, FILE_CAP),
  };
});

import { runLaunchGate } from '../../src/utils/launch-gate.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const AUTOLOAD_UID = 'uid://autoloadscript01';
const SCENE_UID = 'uid://mainscene0000001';
const OTHER_UID = 'uid://somethingelse001';
const TIER1_BODY = 'extends Node\nfunc _ready():\n\tOS.execute("rm", [])\n';

function sceneWithUid(uid: string): string {
  return `[gd_scene format=3 uid="${uid}"]\n\n[node name="Main" type="Node"]\n`;
}

/** Fill the project with `count` scenes that sort first and carry another uid. */
function writeFillerScenes(dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `a_filler_${i}.tscn`), sceneWithUid(OTHER_UID), 'utf8');
  }
}

function gate(dir: string, strict: boolean) {
  return runLaunchGate(
    { projectPath: dir, confirm: false, launchedByServer: false, toolName: 'run_project' },
    makeContext({ strict }),
  );
}

async function warningsOf(dir: string): Promise<string[]> {
  const result = await gate(dir, false);
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

describe('a uid autoload the search did not reach', () => {
  function project(): string {
    const dir = tmp.makeProject(
      'gate-uid-autoload-cut-',
      `config_version=5\n\n[autoload]\nBoot="*${AUTOLOAD_UID}"\n`,
    );
    writeFillerScenes(dir, FILE_CAP);
    writeFileSync(join(dir, 'z_boot.gd'), TIER1_BODY, 'utf8');
    writeFileSync(join(dir, 'z_boot.gd.uid'), `${AUTOLOAD_UID}\n`, 'utf8');
    return dir;
  }

  it('is reported as not scanned because the search was cut short', async () => {
    const warnings = await warningsOf(project());
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /^Autoload Boot \(uid:\/\/autoloadscript01\) was not scanned: the uid search was cut short .* before a file carrying it was found$/,
      ),
    );
    expect(warnings.join('\n')).not.toMatch(/OS\.execute/);
  });

  it('makes strict mode refuse, as an unresolved main scene does', async () => {
    const result = await gate(project(), true);
    expectErrorMatching(result, /could not read or resolve scripts or scenes/);
    expectErrorMatching(result, /Autoload Boot .* the uid search was cut short/);
  });

  it('is only a warning in strict mode when the whole project was read and nothing carries it', async () => {
    const dir = tmp.makeProject(
      'gate-uid-autoload-absent-',
      `config_version=5\n\n[autoload]\nBoot="*${AUTOLOAD_UID}"\n`,
    );
    const result = await gate(dir, true);
    expect(result.ok).toBe(true);
  });
});

describe('a uid found before the search was cut short', () => {
  it('reports the autoload search as incomplete, and still scans what it found', async () => {
    const dir = tmp.makeProject(
      'gate-uid-autoload-partial-',
      `config_version=5\n\n[autoload]\nBoot="*${AUTOLOAD_UID}"\n`,
    );
    writeFileSync(join(dir, 'a_boot.gd'), TIER1_BODY, 'utf8');
    writeFileSync(join(dir, 'a_boot.gd.uid'), `${AUTOLOAD_UID}\n`, 'utf8');
    writeFillerScenes(dir, FILE_CAP);

    const warnings = await warningsOf(dir);
    const text = warnings.join('\n');
    expect(text).toMatch(/a_boot\.gd:3 OS\.execute/);
    expect(text).toMatch(
      /Autoload Boot \(uid:\/\/autoloadscript01\): the uid search was cut short .* another file may carry this uid and was not scanned/,
    );
  });

  it('reports the main scene search as incomplete instead of claiming every carrier was scanned', async () => {
    const dir = tmp.makeProject(
      'gate-uid-main-partial-',
      `config_version=5\n\n[application]\nrun/main_scene="${SCENE_UID}"\n`,
    );
    writeFileSync(join(dir, 'a_0_main.tscn'), sceneWithUid(SCENE_UID), 'utf8');
    writeFillerScenes(dir, FILE_CAP);

    const text = (await warningsOf(dir)).join('\n');
    expect(text).toMatch(/The search for uid:\/\/mainscene0000001 was cut short/);
    expect(text).not.toMatch(/all of them were scanned/);
  });
});
