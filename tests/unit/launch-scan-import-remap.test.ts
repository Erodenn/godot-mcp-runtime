import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate } from '../../src/utils/launch-gate.js';
import { resolveProjectPath } from '../../src/utils/path-validation.js';
import { collectSceneScripts, readImportRemap } from '../../src/utils/scene-parsing.js';
import { importRemapFixtureProjectPath as fixture } from '../helpers/fixture-paths.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const PAYLOAD_FINDING = /payload\.gd:5 OS\.execute/;
const TEXTURE_SCENE = (asset: string): string =>
  `[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://${asset}" id="1"]\n\n[node name="Main" type="Sprite2D"]\ntexture = ExtResource("1")\n`;
const SCRIPTED_RESOURCE =
  '[gd_resource type="Resource" format=3]\n\n[ext_resource type="Script" path="res://payload.gd" id="1"]\n\n[resource]\nscript = ExtResource("1")\n';
const TIER1_SCRIPT = 'extends Resource\n\n\nfunc _init() -> void:\n\tOS.execute("echo", [])\n';

function gate(dir: string, scene: string, strict: boolean): ReturnType<typeof runLaunchGate> {
  const resolved = resolveProjectPath(dir, scene, 'read');
  if (resolved === null) throw new Error(`fixture scene ${scene} did not resolve`);
  return runLaunchGate(
    {
      projectPath: dir,
      scene: resolved,
      confirm: false,
      launchedByServer: true,
      toolName: 'run_project',
    },
    makeContext({ strict }),
  );
}

async function gateWarnings(dir: string, scene: string, strict = false): Promise<string[]> {
  const result = await gate(dir, scene, strict);
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

/** A project whose main.tscn references `icon.png`, with the given `.import` text beside it. */
function projectWithImport(prefix: string, importText: string): string {
  const dir = tmp.makeProject(prefix);
  writeFileSync(join(dir, 'main.tscn'), TEXTURE_SCENE('icon.png'), 'utf8');
  writeFileSync(join(dir, 'icon.png'), '', 'utf8');
  writeFileSync(join(dir, 'icon.png.import'), importText, 'utf8');
  writeFileSync(join(dir, 'payload.gd'), TIER1_SCRIPT, 'utf8');
  writeFileSync(join(dir, 'payload.tres'), SCRIPTED_RESOURCE, 'utf8');
  return dir;
}

describe('launch scan: an imported asset is scanned through its .import remap', () => {
  it.each([
    ['variant A, a remap to a project .tres', 'variant_a.tscn'],
    ['variant B, a remap to a text .tres under .godot/imported', 'variant_b.tscn'],
  ])('%s: the payload script is collected and is a finding', async (_label, scene) => {
    const collected = collectSceneScripts(join(fixture, scene), fixture);
    expect(collected.scripts).toEqual([join(fixture, 'payload.gd')]);
    expect(collected.unscanned).toEqual([]);

    expect((await gateWarnings(fixture, scene)).join('\n')).toMatch(PAYLOAD_FINDING);
    const strict = await gate(fixture, scene, true);
    expectErrorMatching(strict, /Strict mode: refusing to launch/);
    expectErrorMatching(strict, PAYLOAD_FINDING);
  });

  it('a texture imported as .ctex is inert: no finding, no notice, strict launches', async () => {
    const collected = collectSceneScripts(join(fixture, 'clean.tscn'), fixture);
    expect(collected).toEqual({ scripts: [], inlineScripts: [], unscanned: [] });

    expect(await gateWarnings(fixture, 'clean.tscn')).toEqual([]);
    expect(await gateWarnings(fixture, 'clean.tscn', true)).toEqual([]);
  });

  it('a remap to a binary .res gets the not-scanned notice a direct .res gets, and strict does not refuse it', async () => {
    const collected = collectSceneScripts(join(fixture, 'res_target.tscn'), fixture);
    expect(collected.scripts).toEqual([]);
    expect(collected.unscanned).toHaveLength(1);
    const [notice] = collected.unscanned;
    expect(notice!.reason).toMatch(
      /resource res:\/\/\.godot\/imported\/res_target\.png-f16\.res, which res:\/\/res_target\.png is imported as, is not scanned/,
    );
    expect(notice!.malformed).toBeUndefined();
    expect(notice!.readFailed).toBeUndefined();
    expect(notice!.unresolved).toBeUndefined();

    const warnings = await gateWarnings(fixture, 'res_target.tscn', true);
    expect(warnings.join('\n')).toMatch(/Not scanned: res_target\.png\.import: resource /);
  });

  it('a .import whose path is not one plain string is reported as malformed, and strict refuses', async () => {
    const collected = collectSceneScripts(join(fixture, 'malformed.tscn'), fixture);
    expect(collected.unscanned).toEqual([
      {
        scenePath: join(fixture, 'malformed.png.import'),
        reason: '[remap] path is not one plain string',
        malformed: true,
      },
    ]);

    const strict = await gate(fixture, 'malformed.tscn', true);
    expectErrorMatching(strict, /could not read or resolve/);
    expectErrorMatching(strict, /malformed\.png\.import: \[remap\] path is not one plain string/);
  });

  it('an asset without a .import is trusted by extension, as before', () => {
    const dir = tmp.makeProject('import-remap-none-');
    writeFileSync(join(dir, 'main.tscn'), TEXTURE_SCENE('icon.png'), 'utf8');
    expect(collectSceneScripts(join(dir, 'main.tscn'), dir).unscanned).toEqual([]);
  });

  it('a .import that exists and cannot be read refuses under strict', async () => {
    const dir = tmp.makeProject('import-remap-unreadable-');
    writeFileSync(join(dir, 'main.tscn'), TEXTURE_SCENE('icon.png'), 'utf8');
    mkdirSync(join(dir, 'icon.png.import'));

    const [item] = collectSceneScripts(join(dir, 'main.tscn'), dir).unscanned;
    expect(item!.readFailed).toBe(true);
    expectErrorMatching(
      await gate(dir, 'main.tscn', true),
      /icon\.png\.import: import file could not be read/,
    );
  });

  it('a remap target outside the project is not followed and refuses under strict', async () => {
    const dir = projectWithImport(
      'import-remap-outside-',
      '[remap]\n\npath="res://../payload.tres"\n',
    );

    const [item] = collectSceneScripts(join(dir, 'main.tscn'), dir).unscanned;
    expect(item!.unresolved).toBe(true);
    expect(item!.reason).toMatch(/remap target res:\/\/\.\.\/payload\.tres could not be resolved/);
    expectErrorMatching(await gate(dir, 'main.tscn', true), /could not read or resolve/);
  });

  it('a path assigned twice is malformed, since the engine keeps the first and the scanner the last', () => {
    const dir = projectWithImport(
      'import-remap-repeated-',
      '[remap]\n\npath="res://payload.tres"\npath="res://.godot/imported/icon.png-x.ctex"\n',
    );

    const collected = collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.unscanned).toEqual([
      {
        scenePath: join(dir, 'icon.png.import'),
        reason: '[remap] path is assigned more than once',
        malformed: true,
      },
    ]);
  });

  it('a remap back into the scene that references the asset terminates and scans once', () => {
    const dir = projectWithImport('import-remap-cycle-', '[remap]\n\npath="res://main.tscn"\n');
    writeFileSync(
      join(dir, 'main.tscn'),
      `${TEXTURE_SCENE('icon.png')}\n[ext_resource type="Resource" path="res://payload.tres" id="2"]\n`,
      'utf8',
    );

    const collected = collectSceneScripts(join(dir, 'main.tscn'), dir);
    expect(collected.scripts).toEqual([join(dir, 'payload.gd')]);
    expect(collected.unscanned).toEqual([]);
  });
});

describe('readImportRemap', () => {
  it('reads the remap path, every feature path and every dest_files entry, once each', () => {
    const remap = readImportRemap(
      [
        '[remap]',
        '',
        'importer="texture"',
        'path.s3tc="res://.godot/imported/a.s3tc.ctex"',
        'path.etc2="res://.godot/imported/a.etc2.tres"',
        '',
        '[deps]',
        '',
        'source_file="res://a.png"',
        'dest_files=PackedStringArray("res://.godot/imported/a.s3tc.ctex", "res://b.tres")',
        '',
      ].join('\n'),
    );
    expect(remap).toEqual({
      targets: [
        'res://.godot/imported/a.s3tc.ctex',
        'res://.godot/imported/a.etc2.tres',
        'res://b.tres',
      ],
      problems: [],
    });
  });

  it('reports a statement before any section, which the engine still reads', () => {
    const remap = readImportRemap('path="res://payload.tres"\n\n[remap]\n\nimporter="texture"\n');
    expect(remap.problems).toEqual([
      'statement before any section at line 1: path="res://payload.tres"',
    ]);
  });

  it('reports a dest_files value that is not a list of plain strings', () => {
    const remap = readImportRemap('[deps]\n\ndest_files=[&"res://payload.tres"]\n');
    expect(remap.problems).toEqual(['[deps] dest_files is not a list of plain strings']);
  });

  it('a file of editor-written settings has no problems', () => {
    const remap = readImportRemap(
      '[remap]\n\nimporter="texture"\nvalid=false\n\n[params]\n\ncompress/mode=0\n',
    );
    expect(remap).toEqual({ targets: [], problems: [] });
  });
});
