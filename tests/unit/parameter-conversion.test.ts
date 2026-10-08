import { describe, it, expect } from 'vitest';
import {
  convertCamelToSnakeCase,
  normalizeParameters,
} from '../../src/utils/parameter-conversion.js';
import type { OperationParams } from '../../src/mcp.types.js';

/** Keys every plain object answers from its prototype. */
const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
] as const;

describe('normalizeParameters', () => {
  it('maps the snake_case keys it knows and leaves the rest', () => {
    expect(normalizeParameters({ project_path: '/p', node_path: 'root', other_key: 1 })).toEqual({
      projectPath: '/p',
      nodePath: 'root',
      other_key: 1,
    });
  });

  it('recurses into objects, not into arrays or opaque values', () => {
    expect(
      normalizeParameters({
        nested: { scene_path: 'a.tscn' },
        list: [{ scene_path: 'b.tscn' }],
        properties: { node_path: 'kept' },
      }),
    ).toEqual({
      nested: { scenePath: 'a.tscn' },
      list: [{ scene_path: 'b.tscn' }],
      properties: { node_path: 'kept' },
    });
  });

  it.each(PROTOTYPE_KEYS)('keeps the key %s as it is', (key) => {
    const result = normalizeParameters({ [key]: 1, project_path: '/p' });
    expect(Object.keys(result).sort()).toEqual([key, 'projectPath'].sort());
    expect(Object.getOwnPropertyDescriptor(result, key)?.value).toBe(1);
  });

  it('keeps an own __proto__ key as a key and never as the prototype', () => {
    const params = JSON.parse(
      '{"__proto__": {"projectPath": "/smuggled"}, "scene_path": "a.tscn"}',
    ) as OperationParams;
    const result = normalizeParameters(params);

    expect(Object.keys(result).sort()).toEqual(['__proto__', 'scenePath']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.projectPath).toBeUndefined();
    expect(({} as Record<string, unknown>).projectPath).toBeUndefined();
  });

  it('keeps an own __proto__ key with a scalar value', () => {
    const params = JSON.parse('{"__proto__": 1, "project_path": "/p"}') as OperationParams;
    const result = normalizeParameters(params);
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'projectPath']);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(1);
  });
});

describe('convertCamelToSnakeCase', () => {
  it('maps the camelCase keys it knows, through arrays too', () => {
    expect(
      convertCamelToSnakeCase({ scenePath: 'a.tscn', targets: [{ nodePath: 'root' }] }),
    ).toEqual({ scene_path: 'a.tscn', targets: [{ node_path: 'root' }] });
  });

  it('keeps keys that name a prototype member, whatever their case', () => {
    const result = convertCamelToSnakeCase(
      JSON.parse('{"constructor": 2, "__proto__": 5}') as OperationParams,
    );
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')?.value).toBe(2);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    for (const key of Object.keys(result)) expect(key).not.toMatch(/function|\[object/);
  });

  it('reads a camelCase prototype member name as the unmapped key it is', () => {
    expect(() => convertCamelToSnakeCase({ toString: 3 } as unknown as OperationParams)).toThrow(
      /unmapped camelCase key 'toString'/,
    );
    expect(() => convertCamelToSnakeCase({ someNewKey: 1 })).toThrow(/unmapped camelCase key/);
  });
});
