import { describe, it, expect } from 'vitest';
import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  extractGdError,
  createErrorResponse,
  extractJson,
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

  it('falls back to regex conversion for unmapped camelCase keys', () => {
    expect(convertCamelToSnakeCase({ someCustomKey: 1 })).toEqual({ some_custom_key: 1 });
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

  it('returns input unchanged when bracket-led prefix is unparseable noise', () => {
    // extractJson picks the first [ or { it sees. If the [ is from log noise like
    // "[debug]", the function falls through to its last-brace recovery, and if that
    // still fails it returns the original string. cleanOutput is responsible for
    // stripping log lines before extractJson runs in the real pipeline.
    const out = 'noise [debug] more {"ok": true}';
    expect(extractJson(out)).toBe(out);
  });
});
