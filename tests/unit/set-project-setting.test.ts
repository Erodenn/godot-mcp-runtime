import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applySetting,
  checkSettingLiteral,
  godotLiteralFromJson,
  settingTargetError,
} from '../../src/utils/project-godot.js';
import {
  handleGetProjectSettings,
  handleSetProjectSetting,
} from '../../src/tools/project-tools.js';
import { errorText, expectErrorMatching, hasError, unwrap } from '../helpers/assertions.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const LF_PROJECT =
  'config_version=5\n\n[application]\n\nconfig/name="Demo" ; kept\nrun/main_scene="res://main.tscn"\n\n[display]\n\nwindow/size/viewport_width=1152\n\n[autoload]\n\nGlobals="*res://globals.gd"\n';

const CRLF_PROJECT = LF_PROJECT.replace(/\n/g, '\r\n');

function projectFile(dir: string): string {
  return readFileSync(join(dir, 'project.godot'), 'utf8');
}

describe('applySetting', () => {
  it('rewrites an existing value in place and leaves every other line byte for byte', () => {
    const result = applySetting(LF_PROJECT, 'display', 'window/size/viewport_width', '1920');
    expect(result.created).toBe(false);
    expect(result.previous).toBe(1152);
    expect(result.content).toBe(LF_PROJECT.replace('=1152', '=1920'));
  });

  it('keeps CRLF on the rewritten line and on every untouched line', () => {
    const result = applySetting(CRLF_PROJECT, 'application', 'config/name', '"Renamed"');
    expect(result.content).toBe(CRLF_PROJECT.replace('"Demo" ; kept', '"Renamed"'));
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('adds a missing key after the last statement of an existing section', () => {
    const result = applySetting(LF_PROJECT, 'display', 'window/size/viewport_height', '648');
    expect(result.created).toBe(true);
    expect(result.sectionCreated).toBe(false);
    expect(result.content).toBe(
      LF_PROJECT.replace(
        'viewport_width=1152\n',
        'viewport_width=1152\nwindow/size/viewport_height=648\n',
      ),
    );
  });

  it('creates a missing section at the end after one blank line, in CRLF when the file uses it', () => {
    const result = applySetting(CRLF_PROJECT, 'rendering', 'renderer/rendering_method', '"mobile"');
    expect(result.sectionCreated).toBe(true);
    expect(result.content).toBe(
      `${CRLF_PROJECT}\r\n[rendering]\r\nrenderer/rendering_method="mobile"\r\n`,
    );
  });

  it('terminates an unterminated last line before appending', () => {
    const result = applySetting('config_version=5', 'display', 'a/b', '1');
    expect(result.content).toBe('config_version=5\n\n[display]\na/b=1\n');
  });

  it('rewrites the winning assignment of a setting split across spellings and leaves the earlier one', () => {
    const content = 'display/a=1\n\n[display]\na=2\n';
    const result = applySetting(content, 'display', 'a', '3');
    expect(result.content).toBe('display/a=1\n\n[display]\na=3\n');
    expect(result.previous).toBe(2);
  });
});

describe('settingTargetError', () => {
  it('refuses autoload settings under either spelling and points to the autoload tools', () => {
    expect(settingTargetError('autoload', 'Globals')?.solution).toMatch(/add_autoload/);
    expect(settingTargetError('', 'x')).not.toBeNull();
  });

  // Breaks when a refusal's text says security again, or when the autoload refusal stops covering a feature-tag key.
  it.each([
    ['autoload', 'Globals'],
    ['autoload', 'Globals.windows'],
  ])('refuses %s / %s and says why without naming security', (section, key) => {
    const refusal = settingTargetError(section, key);
    expect(refusal?.message).toContain(`"${section}/${key}"`);
    expect(`${refusal?.message} ${refusal?.solution}`).not.toMatch(/security/i);
  });

  // Breaks when any of the three keys the scan once refused is refused again, in any spelling or feature-tag variant.
  it.each([
    ['application', 'run/main_scene'],
    ['application/run', 'main_scene'],
    ['application', 'run/main_scene.windows'],
    ['application', 'run/main_scene.mobile.release'],
    ['application', 'run/main_loop_type'],
    ['application/run', 'main_loop_type.web'],
    ['editor_plugins', 'enabled'],
    ['editor_plugins', 'enabled.editor'],
    ['application', 'run/main_scenes'],
    ['application', 'run/main_scene_extra'],
    ['Application', 'run/main_scene'],
    ['application', 'run/Main_Loop_Type'],
    ['editor_plugin', 'enabled'],
    ['application', 'config/name'],
  ])('writes %s / %s', (s, k) => {
    expect(settingTargetError(s, k)).toBeNull();
  });

  it('refuses names that need quoting and the global pseudo-section', () => {
    expect(settingTargetError('display', 'a b')).not.toBeNull();
    expect(settingTargetError('dis"play', 'a')).not.toBeNull();
    expect(settingTargetError('__global__', 'config_version')).not.toBeNull();
    expect(settingTargetError('display', 'window/size/width')).toBeNull();
  });
});

describe('godotLiteralFromJson', () => {
  it('converts scalars, arrays and objects to Godot literals', () => {
    expect(godotLiteralFromJson('a "q"\n')).toBe('"a \\"q\\"\\n"');
    expect(godotLiteralFromJson(3)).toBe('3');
    expect(godotLiteralFromJson(0.5)).toBe('0.5');
    expect(godotLiteralFromJson(false)).toBe('false');
    expect(godotLiteralFromJson([1, 'x', [true]])).toBe('[1, "x", [true]]');
    expect(godotLiteralFromJson({ a: 1 })).toBe('{"a": 1}');
  });

  it('refuses null and non-finite numbers', () => {
    expect(() => godotLiteralFromJson(null)).toThrow(/literal/);
    expect(() => godotLiteralFromJson(Infinity)).toThrow(/finite/);
  });
});

describe('checkSettingLiteral', () => {
  it('accepts one complete value of each Godot form', () => {
    for (const literal of [
      '"s"',
      '1',
      '2.0',
      'true',
      'null',
      '[1, 2]',
      '{"a": 1}',
      'Vector2i(1280, 720)',
      'PackedStringArray("a", "b")',
    ]) {
      expect(checkSettingLiteral(literal), literal).toBeNull();
    }
  });

  it.each([
    ['Resource', 'Resource("res://p.gd")'],
    ['Object', 'Object(RefCounted, "script": null)'],
    ['Resource', '[1, {"k": Resource("res://r.tres")}]'],
    ['Object', 'Object (RefCounted)'],
    ['ExtResource', 'ExtResource("1")'],
    ['SubResource', 'SubResource("x")'],
    ['ExtResource', '{"a": [ExtResource("1")]}'],
    ['SubResource', '[1, {"k": SubResource("x")}]'],
  ])('refuses a %s constructor anywhere in the value: %s', (constructor, literal) => {
    expect(checkSettingLiteral(literal)).toContain(`${constructor}(...)`);
  });

  it('writes the constructor names inside a string or as part of another name', () => {
    for (const literal of ['"Resource(x)"', '["Object(", &"Resource()"]', 'MyResource(1)']) {
      expect(checkSettingLiteral(literal) ?? '', literal).not.toMatch(/constructor/);
    }
  });

  it('refuses text that is not one complete value on one line', () => {
    for (const literal of ['', 'bare words', '1 ; trailing', '[1, 2', '"open', '1\n2', 'a=b']) {
      expect(checkSettingLiteral(literal), literal).not.toBeNull();
    }
  });
});

describe('handleSetProjectSetting', () => {
  it('changes a value and get_project_settings reads the new value back', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    const result = await handleSetProjectSetting({
      projectPath: dir,
      section: 'display',
      key: 'window/size/viewport_width',
      value: 1920,
    });
    expect(expectMatchesOutputSchema('set_project_setting', result)).toEqual({
      section: 'display',
      key: 'window/size/viewport_width',
      value: 1920,
      created: false,
      sectionCreated: false,
      previous: 1152,
    });
    expect(projectFile(dir)).toBe(LF_PROJECT.replace('=1152', '=1920'));

    const read = expectMatchesOutputSchema(
      'get_project_settings',
      await handleGetProjectSettings({ projectPath: dir, section: 'display' }),
    );
    expect(read.settings).toEqual({ 'window/size/viewport_width': 1920 });
  });

  it('creates a section and round-trips a string, a boolean, an array and a typed literal', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ key: 'name', value: 'He said "hi"\\' }, 'He said "hi"\\'],
      [{ key: 'flag', value: true }, true],
      [{ key: 'list', value: [1, 'two'] }, '[1, "two"]'],
      [{ key: 'size', literal: 'Vector2i(1280, 720)' }, 'Vector2i(1280, 720)'],
      [{ key: 'scale', literal: '2.0' }, 2],
    ];
    for (const [params, expected] of cases) {
      const result = await handleSetProjectSetting({
        projectPath: dir,
        section: 'custom',
        ...params,
      });
      expectMatchesOutputSchema('set_project_setting', result);
      const read = expectMatchesOutputSchema(
        'get_project_settings',
        await handleGetProjectSettings({ projectPath: dir, section: 'custom' }),
      );
      expect((read.settings as Record<string, unknown>)[params.key as string]).toEqual(expected);
    }
    expect(projectFile(dir).startsWith(LF_PROJECT)).toBe(true);
    expect(projectFile(dir)).toContain('\n[custom]\n');
  });

  it('refuses an autoload key without touching the file', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    expectErrorMatching(
      await handleSetProjectSetting({
        projectPath: dir,
        section: 'autoload',
        key: 'Globals',
        value: '*res://other.gd',
      }),
      /autoload/i,
    );
    expectErrorMatching(
      await handleSetProjectSetting({
        projectPath: dir,
        section: 'autoload',
        key: 'New',
        literal: '"*res://x.gd"',
      }),
      /add_autoload/,
    );
    expect(projectFile(dir)).toBe(LF_PROJECT);
  });

  // Breaks when the main scene, main loop type or editor plugin key is refused again, or written to the wrong place.
  it('writes the main scene, the main loop type and an editor plugin key, as the saved file shows', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    const writes: Array<{ section: string; key: string; value?: string; literal?: string }> = [
      { section: 'application', key: 'run/main_scene', value: 'res://other.tscn' },
      { section: 'application', key: 'run/main_loop_type', value: 'MyLoop' },
      {
        section: 'editor_plugins',
        key: 'enabled',
        literal: 'PackedStringArray("res://addons/demo/plugin.cfg")',
      },
    ];
    for (const write of writes) {
      const result = await handleSetProjectSetting({ projectPath: dir, ...write });
      expect(hasError(result), errorText(result)).toBe(false);
    }

    const saved = projectFile(dir);
    expect(saved).toContain('\nrun/main_scene="res://other.tscn"\n');
    expect(saved).not.toContain('run/main_scene="res://main.tscn"');
    expect(saved).toContain('\nrun/main_loop_type="MyLoop"\n');
    expect(saved).toContain('[editor_plugins]');
    expect(saved).toContain('\nenabled=PackedStringArray("res://addons/demo/plugin.cfg")\n');
    expect(saved).toContain('config/name="Demo" ; kept');
    expect(saved).toContain('Globals="*res://globals.gd"');
  });

  // Breaks when a refusal text says security again.
  it('refuses an autoload key with a message that does not name security', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    const result = await handleSetProjectSetting({
      projectPath: dir,
      section: 'autoload',
      key: 'Globals',
      value: '*res://other.gd',
    });
    expect(hasError(result)).toBe(true);
    expect(errorText(result)).not.toMatch(/security/i);
    expect(unwrap(result).content[1]?.text ?? '').not.toMatch(/security/i);
    expect(projectFile(dir)).toBe(LF_PROJECT);
  });

  it('refuses a nested Resource() literal without touching the file', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    expectErrorMatching(
      await handleSetProjectSetting({
        projectPath: dir,
        section: 'custom',
        key: 'data',
        literal: '{"a": [Resource("res://p.gd")]}',
      }),
      /Resource\(\.\.\.\) constructor/,
    );
    expect(projectFile(dir)).toBe(LF_PROJECT);
  });

  it('writes a key that only resembles main_scene, byte for byte elsewhere', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    await handleSetProjectSetting({
      projectPath: dir,
      section: 'application',
      key: 'run/main_scene_note',
      literal: '"Resource(x)"',
    });
    expect(projectFile(dir)).toBe(
      LF_PROJECT.replace(
        'run/main_scene="res://main.tscn"\n',
        'run/main_scene="res://main.tscn"\nrun/main_scene_note="Resource(x)"\n',
      ),
    );
  });

  it('refuses both or neither of value and literal, and a bad literal, leaving the file alone', async () => {
    const dir = tmp.makeProject('mcp-setting-', LF_PROJECT);
    const base = { projectPath: dir, section: 'display', key: 'x' };
    expectErrorMatching(
      await handleSetProjectSetting({ ...base, value: 1, literal: '1' }),
      /not both/,
    );
    expectErrorMatching(await handleSetProjectSetting(base), /value.*literal/);
    expectErrorMatching(
      await handleSetProjectSetting({ ...base, literal: '1 ; c' }),
      /complete value/,
    );
    expectErrorMatching(await handleSetProjectSetting({ ...base, value: null }), /literal/);
    expect(projectFile(dir)).toBe(LF_PROJECT);
  });
});
