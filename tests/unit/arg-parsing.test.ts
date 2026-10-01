/**
 * Direct unit tests for the generic field helpers in `src/utils/arg-parsing.ts`.
 *
 * These previously only had incidental coverage through handler tests, which
 * exercise the path-shaped parsers (parseProjectArgs/parseSceneArgs/parseNodePath
 * variants: covered in godot-runner-extended.test.ts) but not every generic
 * primitive directly. One `ok` case, one wrong-type `err` case, and (for the
 * optionals) the `undefined -> ok(undefined)` case per helper.
 */

import { describe, it, expect } from 'vitest';
import {
  requireString,
  optionalString,
  requireNumber,
  optionalNumber,
  requireBoolean,
  optionalBoolean,
  requireObject,
  optionalObject,
  requireArray,
  requireStringArray,
  optionalStringArray,
  parseNodePath,
  parseRequiredNodePath,
  parseOptionalNodePath,
  checkBatchOperationItems,
} from '../../src/utils/arg-parsing.js';

function expectOk(result: { ok: boolean }): void {
  expect(result.ok).toBe(true);
}

function expectErr(result: { ok: boolean; error?: unknown }): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect((result.error as { isError: boolean }).isError).toBe(true);
  }
}

describe('requireString', () => {
  it('ok: returns the string value', () => {
    const result = requireString({ key: 'hello' }, 'key');
    expectOk(result);
  });

  it('err: rejects a non-string value', () => {
    expectErr(requireString({ key: 42 }, 'key'));
  });

  it('err: rejects an empty string', () => {
    expectErr(requireString({ key: '' }, 'key'));
  });
});

describe('optionalString', () => {
  it('ok: returns the string value', () => {
    expectOk(optionalString({ key: 'hello' }, 'key'));
  });

  it('err: rejects a non-string value', () => {
    expectErr(optionalString({ key: 42 }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = optionalString({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('requireNumber', () => {
  it('ok: returns the numeric value', () => {
    expectOk(requireNumber({ key: 42 }, 'key'));
  });

  it('err: rejects a non-number value', () => {
    expectErr(requireNumber({ key: 'not a number' }, 'key'));
  });
});

describe('optionalNumber', () => {
  it('ok: returns the numeric value', () => {
    expectOk(optionalNumber({ key: 42 }, 'key'));
  });

  it('err: rejects a non-number value', () => {
    expectErr(optionalNumber({ key: 'not a number' }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = optionalNumber({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('requireBoolean', () => {
  it('ok: returns the boolean value', () => {
    expectOk(requireBoolean({ key: true }, 'key'));
  });

  it('err: rejects a non-boolean value', () => {
    expectErr(requireBoolean({ key: 'true' }, 'key'));
  });
});

describe('optionalBoolean', () => {
  it('ok: returns the boolean value', () => {
    expectOk(optionalBoolean({ key: false }, 'key'));
  });

  it('err: rejects a non-boolean value', () => {
    expectErr(optionalBoolean({ key: 'false' }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = optionalBoolean({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('requireObject', () => {
  it('ok: returns the object value', () => {
    expectOk(requireObject({ key: { a: 1 } }, 'key'));
  });

  it('err: rejects a non-object value (array)', () => {
    expectErr(requireObject({ key: [1, 2, 3] }, 'key'));
  });

  it('err: rejects a non-object value (string)', () => {
    expectErr(requireObject({ key: 'not an object' }, 'key'));
  });
});

describe('optionalObject', () => {
  it('ok: returns the object value', () => {
    expectOk(optionalObject({ key: { a: 1 } }, 'key'));
  });

  it('err: rejects a non-object value', () => {
    expectErr(optionalObject({ key: 'not an object' }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = optionalObject({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('requireArray', () => {
  it('ok: returns the array value', () => {
    expectOk(requireArray({ key: [1, 2] }, 'key'));
  });

  it('err: rejects a non-array value', () => {
    expectErr(requireArray({ key: 'not an array' }, 'key'));
  });

  it('err: rejects an array shorter than minLength', () => {
    expectErr(requireArray({ key: [] }, 'key', { minLength: 1 }));
  });
});

describe('requireStringArray', () => {
  it('ok: returns the string array value', () => {
    expectOk(requireStringArray({ key: ['a', 'b'] }, 'key'));
  });

  it('err: rejects a non-array value', () => {
    expectErr(requireStringArray({ key: 'not an array' }, 'key'));
  });

  it('err: rejects an array with non-string entries', () => {
    expectErr(requireStringArray({ key: ['a', 1] }, 'key'));
  });
});

describe('optionalStringArray', () => {
  it('ok: returns the string array value', () => {
    expectOk(optionalStringArray({ key: ['a', 'b'] }, 'key'));
  });

  it('err: rejects a non-array value', () => {
    expectErr(optionalStringArray({ key: 'not an array' }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = optionalStringArray({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('parseNodePath', () => {
  it('ok: returns the branded NodePath for a valid shape', () => {
    expectOk(parseNodePath('root/Player'));
  });

  it('err: rejects a path containing ".."', () => {
    expectErr(parseNodePath('root/../Player'));
  });

  it('err: rejects an empty string', () => {
    expectErr(parseNodePath(''));
  });
});

describe('parseRequiredNodePath', () => {
  it('ok: returns the branded NodePath for a valid shape', () => {
    expectOk(parseRequiredNodePath({ key: 'root/Player' }, 'key'));
  });

  it('err: rejects a non-string value', () => {
    expectErr(parseRequiredNodePath({ key: 42 }, 'key'));
  });

  it('err: rejects an empty string (required, no undefined shortcut)', () => {
    expectErr(parseRequiredNodePath({ key: '' }, 'key'));
  });
});

describe('parseOptionalNodePath', () => {
  it('ok: returns the branded NodePath for a valid shape', () => {
    expectOk(parseOptionalNodePath({ key: 'root/Player' }, 'key'));
  });

  it('err: rejects a non-string value', () => {
    expectErr(parseOptionalNodePath({ key: 42 }, 'key'));
  });

  it('ok(undefined): when the field is absent', () => {
    const result = parseOptionalNodePath({}, 'key');
    expectOk(result);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

// The script reads these fields into typed parameters and string comparisons.
// A value of another type raises inside it and takes every other operation in
// the batch down with it, so each is refused here with the index it sits at.
describe('checkBatchOperationItems', () => {
  function messageOf(result: { ok: boolean; error?: unknown }): string {
    if (result.ok) return '';
    const content = (result.error as { content: Array<{ text: string }> }).content;
    return content[0]?.text ?? '';
  }

  const ADD_NODE = { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D' };

  it('ok: accepts well-formed items in either key spelling', () => {
    expectOk(
      checkBatchOperationItems([
        { ...ADD_NODE, nodeName: 'A', parentNodePath: 'root', properties: { visible: true } },
        { operation: 'add_node', scene_path: 'main.tscn', node_type: 'Node2D', node_name: 'B' },
        {
          operation: 'load_sprite',
          scenePath: 'main.tscn',
          nodePath: 'root/S',
          texturePath: 'a.png',
        },
        { operation: 'save', scenePath: 'main.tscn', newPath: 'copy.tscn' },
        {
          operation: 'set_node_properties',
          scenePath: 'main.tscn',
          updates: [],
          abortOnError: true,
        },
      ]),
    );
  });

  it.each([
    ['nodeName', { ...ADD_NODE, nodeName: 5 }],
    ['nodeName', { ...ADD_NODE, node_name: 5 }],
    ['nodeType', { operation: 'add_node', scenePath: 'main.tscn', nodeType: ['Node2D'] }],
    ['parentNodePath', { ...ADD_NODE, nodeName: 'A', parentNodePath: 3 }],
    ['nodePath', { operation: 'load_sprite', scenePath: 'main.tscn', nodePath: {} }],
    ['texturePath', { operation: 'load_sprite', scenePath: 'main.tscn', texture_path: 1 }],
    ['newPath', { operation: 'save', scenePath: 'main.tscn', newPath: false }],
  ])('err: refuses a non-string %s, naming the item', (field, item) => {
    const result = checkBatchOperationItems([{ ...ADD_NODE, nodeName: 'First' }, item]);
    expectErr(result);
    expect(messageOf(result)).toBe(`operations[1].${field} must be a string when provided`);
  });

  it.each([
    ['a string', 'x'],
    ['an array', [1]],
    ['null', null],
  ])('err: refuses properties given as %s', (_label, properties) => {
    const result = checkBatchOperationItems([{ ...ADD_NODE, nodeName: 'A', properties }]);
    expectErr(result);
    expect(messageOf(result)).toBe('operations[0].properties must be an object when provided');
  });

  it('err: refuses a non-boolean abortOnError on an item', () => {
    const result = checkBatchOperationItems([
      {
        operation: 'set_node_properties',
        scenePath: 'main.tscn',
        updates: [],
        abortOnError: 'yes',
      },
    ]);
    expectErr(result);
    expect(messageOf(result)).toBe('operations[0].abortOnError must be a boolean when provided');
  });
});
