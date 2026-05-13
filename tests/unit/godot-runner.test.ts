import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'path';
import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  validateSubPath,
  isUnderDir,
  extractGdError,
  createErrorResponse,
  extractJson,
  cleanStdout,
} from '../../src/utils/godot-runner.js';

describe('normalizeParameters', () => {
  it('converts known snake_case keys to camelCase', () => {
    const input = { project_path: '/p', scene_path: 's.tscn' };
    expect(normalizeParameters(input)).toEqual({ projectPath: '/p', scenePath: 's.tscn' });
  });

  it('passes through unknown snake_case keys unchanged', () => {
    const input = { not_in_mapping: 'x' };
    expect(normalizeParameters(input)).toEqual({ not_in_mapping: 'x' });
  });

  it('passes through camelCase keys unchanged', () => {
    const input = { projectPath: '/p', custom: 1 };
    expect(normalizeParameters(input)).toEqual({ projectPath: '/p', custom: 1 });
  });

  it('recurses into nested objects', () => {
    const input = { project_path: '/p', meta: { node_path: 'root/Player' } };
    expect(normalizeParameters(input)).toEqual({
      projectPath: '/p',
      meta: { nodePath: 'root/Player' },
    });
  });

  it('preserves arrays without recursing into them', () => {
    const input = { mesh_item_names: ['a', 'b'] };
    const result = normalizeParameters(input);
    expect(result.meshItemNames).toEqual(['a', 'b']);
  });

  it('returns non-objects as-is', () => {
    expect(normalizeParameters(null as never)).toBe(null);
    expect(normalizeParameters('x' as never)).toBe('x');
  });
});

describe('convertCamelToSnakeCase', () => {
  it('converts mapped camelCase keys back to snake_case', () => {
    const input = { projectPath: '/p', scenePath: 's.tscn' };
    expect(convertCamelToSnakeCase(input)).toEqual({ project_path: '/p', scene_path: 's.tscn' });
  });

  it('throws in test env when an unmapped camelCase key falls through', () => {
    expect(() => convertCamelToSnakeCase({ someCustomKey: 1 })).toThrow(
      /unmapped camelCase key 'someCustomKey'/,
    );
  });

  it('falls back to regex conversion in production env', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevVitest = process.env.VITEST;
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    try {
      expect(convertCamelToSnakeCase({ someCustomKey: 1 })).toEqual({ some_custom_key: 1 });
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
    }
  });

  it('round-trips through normalizeParameters', () => {
    const original = { project_path: '/p', node_path: 'root/X' };
    const round = convertCamelToSnakeCase(normalizeParameters(original));
    expect(round).toEqual(original);
  });

  it('recurses into nested objects', () => {
    const input = { projectPath: '/p', nested: { nodePath: 'root' } };
    expect(convertCamelToSnakeCase(input)).toEqual({
      project_path: '/p',
      nested: { node_path: 'root' },
    });
  });

  it('walks arrays and converts nested object keys', () => {
    const input = {
      updates: [
        { nodePath: 'root/A', property: 'position', value: 1 },
        { nodePath: 'root/B', property: 'rotation', value: 2 },
      ],
    };
    expect(convertCamelToSnakeCase(input)).toEqual({
      updates: [
        { node_path: 'root/A', property: 'position', value: 1 },
        { node_path: 'root/B', property: 'rotation', value: 2 },
      ],
    });
  });

  it('preserves arrays of primitives as-is', () => {
    expect(convertCamelToSnakeCase({ meshItemNames: ['a', 'b'] })).toEqual({
      mesh_item_names: ['a', 'b'],
    });
  });
});

describe('validatePath', () => {
  it('rejects empty paths', () => {
    expect(validatePath('')).toBe(false);
  });

  it('rejects paths containing ..', () => {
    expect(validatePath('../etc/passwd')).toBe(false);
    expect(validatePath('foo/../bar')).toBe(false);
  });

  it('accepts well-formed relative paths', () => {
    expect(validatePath('scenes/main.tscn')).toBe(true);
  });

  it('accepts absolute paths', () => {
    expect(validatePath('/abs/path/to/project')).toBe(true);
  });
});

describe('validateSubPath', () => {
  const project = resolve('/project');

  it('rejects empty paths', () => {
    expect(validateSubPath(project, '')).toBe(false);
  });

  it('rejects paths containing ..', () => {
    expect(validateSubPath(project, '../etc/passwd')).toBe(false);
    expect(validateSubPath(project, 'foo/../../bar')).toBe(false);
  });

  it('rejects absolute paths that escape the project', () => {
    expect(validateSubPath(project, '/etc/passwd')).toBe(false);
    expect(validateSubPath(project, resolve('/elsewhere/file.gd'))).toBe(false);
  });

  it('accepts simple sub-paths', () => {
    expect(validateSubPath(project, 'scenes/main.tscn')).toBe(true);
  });

  it('accepts nested sub-paths', () => {
    expect(validateSubPath(project, 'a/b/c/d.gd')).toBe(true);
  });

  it('accepts an absolute path that resolves inside the project', () => {
    const inside = resolve(project, 'sub/file.gd');
    expect(validateSubPath(project, inside)).toBe(true);
  });

  it('tolerates a leading res:// prefix', () => {
    expect(validateSubPath(project, 'res://autoload/foo.gd')).toBe(true);
  });

  it('rejects a res:// path that escapes via ..', () => {
    expect(validateSubPath(project, 'res://../escape.gd')).toBe(false);
  });

  it('rejects a res:// prefix on its own', () => {
    expect(validateSubPath(project, 'res://')).toBe(false);
  });

  it('does not match a sibling directory with the same prefix', () => {
    // path.resolve('/project', '../project-evil') would equal '/project-evil',
    // which must not pass the startsWith(projectRoot + sep) check.
    expect(validateSubPath(project, '../project-evil/file.gd')).toBe(false);
  });
});

describe('isUnderDir', () => {
  const parent = resolve('/parent');

  it('returns true for the parent itself', () => {
    expect(isUnderDir(parent, parent)).toBe(true);
  });

  it('returns true for a child path', () => {
    expect(isUnderDir(parent, resolve(parent, 'child/file.txt'))).toBe(true);
  });

  it('returns false for a sibling with the same prefix', () => {
    const sibling = parent + '-evil' + sep + 'file.txt';
    expect(isUnderDir(parent, sibling)).toBe(false);
  });

  it('returns false for an unrelated absolute path', () => {
    expect(isUnderDir(parent, resolve('/elsewhere/file.txt'))).toBe(false);
  });
});

describe('extractGdError', () => {
  it('extracts the first [ERROR] line', () => {
    const stderr = 'noise line\n[ERROR] something broke\nmore noise';
    expect(extractGdError(stderr)).toBe('something broke');
  });

  it('falls back to a generic message when no [ERROR] line present', () => {
    expect(extractGdError('just noise\n[INFO] ok')).toBe('see get_debug_output for details');
  });

  it('strips the prefix correctly when [ERROR] has surrounding context', () => {
    const stderr = '2026-01-01 [ERROR] failed to save scene';
    expect(extractGdError(stderr)).toBe('failed to save scene');
  });
});

describe('createErrorResponse', () => {
  it('returns isError:true with a single content block when no solutions', () => {
    const r = createErrorResponse('boom');
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toBe('boom');
  });

  it('appends a solutions block when solutions provided', () => {
    const r = createErrorResponse('boom', ['try X', 'try Y']);
    expect(r.content).toHaveLength(2);
    expect(r.content[1].text).toContain('try X');
    expect(r.content[1].text).toContain('try Y');
  });
});

describe('extractJson', () => {
  it('strips Godot version banner before JSON object', () => {
    const out = 'Godot Engine v4.5.stable\n{"ok": true}';
    expect(JSON.parse(extractJson(out))).toEqual({ ok: true });
  });

  it('strips banner before JSON array', () => {
    const out = 'Godot Engine v4.5.stable\n[1, 2, 3]';
    expect(JSON.parse(extractJson(out))).toEqual([1, 2, 3]);
  });

  it('returns input unchanged when no JSON present', () => {
    expect(extractJson('just text, no json')).toBe('just text, no json');
  });

  it('parses cleanly when no bracket-noise precedes the JSON', () => {
    const out = 'INFO: starting up\n{"ok": true}';
    expect(JSON.parse(extractJson(out))).toEqual({ ok: true });
  });
});

describe('cleanStdout', () => {
  it('routes JSON-object output through extractJson (strips banner)', () => {
    const out = 'Godot Engine v4.5.stable\nINFO line\n{"ok": true}';
    expect(JSON.parse(cleanStdout(out))).toEqual({ ok: true });
  });

  it('routes JSON-array output through extractJson (no `{` present)', () => {
    const out = 'Godot Engine v4.5.stable\n[1, 2, 3]';
    expect(JSON.parse(cleanStdout(out))).toEqual([1, 2, 3]);
  });

  it('routes plain non-JSON output through cleanOutput (drops banner)', () => {
    // No `{` or `[` anywhere — takes the cleanOutput branch.
    const out = 'Godot Engine v4.5.stable\nplain success';
    expect(cleanStdout(out)).toBe('plain success');
  });

  it('handles empty stdout', () => {
    expect(cleanStdout('')).toBe('');
  });
});
