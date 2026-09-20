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
