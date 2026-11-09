import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate } from '../../src/utils/launch-gate.js';
import { collectSceneScripts } from '../../src/utils/scene-parsing.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const LIBRARY_FILE = 'pieces.tres';
const BINARY_LIBRARY_FILE = 'pieces.res';
const BINARY_LIBRARY_BYTES = 'RSRC\u0000\u0001binary resource bytes';
const IDENTITY_TRANSFORM = 'Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)';

/** A MeshLibrary as the engine saves one to a `.tres`: a sub_resource per mesh and the items under `[resource]`. */
const PLAIN_LIBRARY_TEXT = [
  '[gd_resource type="MeshLibrary" load_steps=2 format=3]',
  '',
  '[sub_resource type="BoxMesh" id="BoxMesh_1"]',
  '',
  '[resource]',
  'item/0/name = "Wall"',
  'item/0/mesh = SubResource("BoxMesh_1")',
  `item/0/mesh_transform = ${IDENTITY_TRANSFORM}`,
  'item/0/shapes = []',
  'item/0/preview = null',
  '',
].join('\n');

/** The same library with a script riding along as an embedded sub_resource, the way a hand-edited file could carry one. */
const SCRIPTED_LIBRARY_TEXT = [
  '[gd_resource type="MeshLibrary" load_steps=3 format=3]',
  '',
  '[sub_resource type="GDScript" id="GDScript_1"]',
  'script/source = "extends Node\nfunc _ready():\n\tOS.execute(\\"rm\\", [])\n"',
  '',
  '[resource]',
  'item/0/name = "Wall"',
  '',
].join('\n');

const sceneReferencing = (libraryFile: string): string =>
  [
    '[gd_scene load_steps=2 format=3]',
    '',
    `[ext_resource type="MeshLibrary" path="res://${libraryFile}" id="1"]`,
    '',
    '[node name="Main" type="Node3D"]',
    '',
    '[node name="Grid" type="GridMap" parent="."]',
    'mesh_library = ExtResource("1")',
    '',
  ].join('\n');

function projectWith(prefix: string, libraryFile: string, libraryContent: string): string {
  const dir = tmp.makeProject(
    prefix,
    'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
  );
  writeFileSync(join(dir, 'main.tscn'), sceneReferencing(libraryFile), 'utf8');
  writeFileSync(join(dir, libraryFile), libraryContent, 'utf8');
  return dir;
}

async function gateWarnings(dir: string): Promise<string[]> {
  const result = await runLaunchGate(
    { projectPath: dir, confirm: false, launchedByServer: false, toolName: 'run_project' },
    makeContext({ strict: false }),
  );
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

describe('launch scan: a MeshLibrary exported as text is read like any text resource', () => {
  it('a .tres MeshLibrary a scene references is walked and leaves no not-scanned notice', async () => {
    const dir = projectWith('mesh-library-tres-', LIBRARY_FILE, PLAIN_LIBRARY_TEXT);

    const collected = collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned).toEqual([]);
    expect(collected.scripts).toEqual([]);

    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).not.toContain(LIBRARY_FILE);
  });

  it('a script embedded in the .tres MeshLibrary is scanned and produces its finding', async () => {
    const dir = projectWith('mesh-library-tres-script-', LIBRARY_FILE, SCRIPTED_LIBRARY_TEXT);

    const collected = collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.inlineScripts).toHaveLength(1);

    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(/pieces\.tres\[GDScript GDScript_1\]:\d+ OS\.execute/);
  });

  it('the same library as a binary .res is reported as not scanned', async () => {
    const dir = projectWith('mesh-library-res-', BINARY_LIBRARY_FILE, BINARY_LIBRARY_BYTES);

    const warnings = await gateWarnings(dir);
    expect(warnings.join('\n')).toMatch(
      /Not scanned: .*main\.tscn: resource res:\/\/pieces\.res is not scanned/,
    );
  });
});
