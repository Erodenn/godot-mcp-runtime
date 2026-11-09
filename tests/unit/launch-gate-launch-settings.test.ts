import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate } from '../../src/utils/launch-gate.js';
import { resolveProjectPath } from '../../src/utils/path-validation.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const DANGEROUS_SCRIPT = 'extends SceneTree\nfunc _initialize():\n\tOS.execute("rm", ["-rf"])\n';
const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
const SCENE_WITH_SCRIPT =
  '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://level.gd" id="1"]\n\n[node name="Level" type="Node"]\nscript = ExtResource("1")\n';
const LEVEL_SCRIPT = 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n';

function project(applicationLines: string, files: Record<string, string> = {}): string {
  const dir = tmp.makeProject(
    'gate-launch-settings-',
    `config_version=5\n\n[application]\n\nrun/main_scene="res://main.tscn"\n${applicationLines}`,
  );
  writeFileSync(join(dir, 'main.tscn'), SCRIPTLESS_SCENE, 'utf8');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8');
  return dir;
}

function gate(dir: string, strict: boolean, scene?: string) {
  return runLaunchGate(
    {
      projectPath: dir,
      scene:
        scene === undefined ? undefined : (resolveProjectPath(dir, scene, 'read') ?? undefined),
      confirm: false,
      launchedByServer: true,
      toolName: 'run_project',
    },
    makeContext({ strict }),
  );
}

function warnings(result: Awaited<ReturnType<typeof gate>>): string {
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings.join('\n');
}

describe('application/run/main_loop_type', () => {
  it('scans the script declaring the class_name it names', async () => {
    const dir = project('run/main_loop_type="EvilLoop"\n', {
      'evil_loop.gd': `class_name EvilLoop\n${DANGEROUS_SCRIPT}`,
    });
    expect(warnings(await gate(dir, false))).toMatch(/^evil_loop\.gd:4 OS\.execute - /m);
    expectErrorMatching(
      await gate(dir, true),
      /main loop or launched-scene scripts contain Tier 1/,
    );
  });

  it('scans a res:// script path, and a class named only by a feature override', async () => {
    const byPath = project('run/main_loop_type="res://loop.gd"\n', {
      'loop.gd': DANGEROUS_SCRIPT,
    });
    expect(warnings(await gate(byPath, false))).toMatch(/^loop\.gd:3 OS\.execute - /m);

    const byOverride = project('run/main_loop_type.windows="EvilLoop"\n', {
      'evil_loop.gd': `class_name EvilLoop\n${DANGEROUS_SCRIPT}`,
    });
    expect(warnings(await gate(byOverride, false))).toMatch(/^evil_loop\.gd:4 OS\.execute - /m);
  });

  it('reports a class no project GDScript declares, and strict mode refuses it', async () => {
    const dir = project('run/main_loop_type="CSharpLoop"\n');
    expect(warnings(await gate(dir, false))).toMatch(
      /^Main loop CSharpLoop \(application\/run\/main_loop_type\) was not scanned: it is not SceneTree, MainLoop or a class_name declared by a project GDScript/m,
    );
    const strict = await gate(dir, true);
    expectErrorMatching(strict, /refusing to launch project because the main loop it names/);
    expectErrorMatching(strict, /Main loop CSharpLoop/);
  });

  it('reports a script path that leaves the project, and strict mode refuses it', async () => {
    const dir = project('run/main_loop_type.web="res://../outside.gd"\n');
    expectErrorMatching(
      await gate(dir, true),
      /Main loop res:\/\/\.\.\/outside\.gd \(application\/run\/main_loop_type\.web\) was not scanned/,
    );
  });

  it('leaves the engine main loop classes alone, even in strict mode', async () => {
    const dir = project('run/main_loop_type="SceneTree"\nrun/main_loop_type.mobile="MainLoop"\n');
    expect(warnings(await gate(dir, true))).not.toMatch(/Main loop/);
  });
});

describe('application/run/main_scene feature overrides', () => {
  it('scans the scene an override names, for a tag that is not this platform', async () => {
    const dir = project('run/main_scene.mobile="res://level.tscn"\n', {
      'level.tscn': SCENE_WITH_SCRIPT,
      'level.gd': LEVEL_SCRIPT,
    });
    expect(warnings(await gate(dir, false))).toMatch(/^level\.gd:3 OS\.execute - /m);
    expectErrorMatching(await gate(dir, true), /Tier 1/);
  });

  it('refuses in strict mode an override naming a scene that cannot be found', async () => {
    const dir = project('run/main_scene.windows="res://../outside.tscn"\n');
    const strict = await gate(dir, true);
    expectErrorMatching(strict, /scene to launch could not be found or resolved/);
    expectErrorMatching(strict, /application\/run\/main_scene\.windows/);
  });

  it('counts an override alone as a configured launch scene', async () => {
    const dir = tmp.makeProject(
      'gate-launch-settings-',
      'config_version=5\n\n[application]\n\nrun/main_scene.windows="res://main.tscn"\n',
    );
    writeFileSync(join(dir, 'main.tscn'), SCRIPTLESS_SCENE, 'utf8');
    expect(warnings(await gate(dir, true))).not.toMatch(/No launchable scene/);
  });

  it('is not scanned when a scene argument decides what runs', async () => {
    const dir = project('run/main_scene.mobile="res://level.tscn"\n', {
      'level.tscn': SCENE_WITH_SCRIPT,
      'level.gd': LEVEL_SCRIPT,
    });
    expect(warnings(await gate(dir, false, 'main.tscn'))).not.toMatch(/OS\.execute/);
  });
});
