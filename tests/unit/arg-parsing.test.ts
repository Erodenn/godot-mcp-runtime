/**
 * Direct unit tests for the generic field helpers in `src/utils/arg-parsing.ts`.
 *
 * These previously only had incidental coverage through handler tests, which
 * exercise the path-shaped parsers (parseProjectArgs/parseSceneArgs/parseNodePath
 * variants: covered in godot-runner-extended.test.ts) but not every generic
 * primitive directly. One `ok` case, one wrong-type `err` case, and (for the
 * optionals) the `undefined -> ok(undefined)` case per helper.
 */

import { symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
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
  parseProjectArgs,
  parseSceneArgs,
} from '../../src/utils/arg-parsing.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { unwrap } from '../helpers/assertions.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

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
      checkBatchOperationItems(
        [
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
        ],
        fixtureProjectPath,
      ),
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
    const result = checkBatchOperationItems(
      [{ ...ADD_NODE, nodeName: 'First' }, item],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toBe(`operations[1].${field} must be a string when provided`);
  });

  it.each([
    ['a string', 'x'],
    ['an array', [1]],
    ['null', null],
  ])('err: refuses properties given as %s', (_label, properties) => {
    const result = checkBatchOperationItems(
      [{ ...ADD_NODE, nodeName: 'A', properties }],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toBe('operations[0].properties must be an object when provided');
  });

  it.each([
    ['missing', {}],
    ['null', { operation: null }],
    ['empty', { operation: '' }],
  ])('err: refuses an item whose operation is %s, naming the item', (_label, operationKey) => {
    const result = checkBatchOperationItems(
      [ADD_NODE, { scenePath: 'main.tscn', ...operationKey }],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toBe(
      "operations[1] is missing the required 'operation' key (one of: add_node, load_sprite, set_node_properties, save).",
    );
  });

  it.each([
    ['nodeName', { nodeName: 'A' }, 'nodeName/nodeType', 'add_node'],
    ['node_type', { node_type: 'Node2D' }, 'nodeName/nodeType', 'add_node'],
    ['updates', { updates: [] }, 'updates', 'set_node_properties'],
    ['texturePath', { texturePath: 'a.png' }, 'texturePath', 'load_sprite'],
    ['texture_path', { texture_path: 'a.png' }, 'texturePath', 'load_sprite'],
  ])('err: a missing operation with %s present hints the intended one', (_k, keys, shown, op) => {
    const result = checkBatchOperationItems(
      [{ scenePath: 'main.tscn', ...keys }],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toContain(` (${shown} present: did you mean operation '${op}'?)`);
  });

  it('err: refuses a non-string operation', () => {
    const result = checkBatchOperationItems([ADD_NODE, { operation: 7 }], fixtureProjectPath);
    expectErr(result);
    expect(messageOf(result)).toBe('operations[1].operation must be a string');
  });

  it('err: refuses an unknown operation string, naming it and the valid ones', () => {
    const result = checkBatchOperationItems(
      [ADD_NODE, { operation: 'delete_everything' }],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toBe(
      'operations[1].operation "delete_everything" is not a batch operation (one of: add_node, load_sprite, set_node_properties, save)',
    );
  });

  it('err: refuses a non-boolean abortOnError on an item', () => {
    const result = checkBatchOperationItems(
      [
        {
          operation: 'set_node_properties',
          scenePath: 'main.tscn',
          updates: [],
          abortOnError: 'yes',
        },
      ],
      fixtureProjectPath,
    );
    expectErr(result);
    expect(messageOf(result)).toBe('operations[0].abortOnError must be a boolean when provided');
  });
});

describe('checkBatchOperationItems resolves every path an item carries', () => {
  const messageOf = (result: unknown): string =>
    unwrap(result)
      .content.map((entry) => entry.text ?? '')
      .join('\n');

  function projectWithLinkedFolder(): string {
    const projectDir = tmp.makeProject('batch-paths-');
    const shared = tmp.make('batch-paths-shared-');
    writeFileSync(join(shared, 'tex.png'), '', 'utf8');
    writeFileSync(join(shared, 'part.tscn'), '', 'utf8');
    symlinkSync(shared, join(projectDir, 'linked'), 'junction');
    return projectDir;
  }

  it('forwards each path in its project-relative form, under camelCase keys', () => {
    const result = checkBatchOperationItems(
      [
        {
          operation: 'add_node',
          scenePath: 'res://main.tscn',
          nodeType: './parts/a.tscn',
          nodeName: 'A',
        },
        {
          operation: 'load_sprite',
          scene_path: 'scenes\\b.tscn',
          node_path: 'root/S',
          texture_path: 'res://art/t.png',
        },
        { operation: 'save', scenePath: './main.tscn', new_path: 'res://copies/main.tscn' },
        { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'B' },
      ],
      fixtureProjectPath,
    );
    expect(result.ok && result.value).toEqual([
      { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'parts/a.tscn', nodeName: 'A' },
      {
        operation: 'load_sprite',
        scenePath: 'scenes/b.tscn',
        nodePath: 'root/S',
        texturePath: 'art/t.png',
      },
      { operation: 'save', scenePath: 'main.tscn', newPath: 'copies/main.tscn' },
      { operation: 'add_node', scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'B' },
    ]);
  });

  const ADD = { operation: 'add_node', nodeType: 'Node', nodeName: 'A' };
  it.each([
    ['scenePath', { ...ADD, scenePath: '../out.tscn' }],
    ['scenePath', { ...ADD, scene_path: 'main.tscn.' }],
    ['scenePath', { ...ADD, scenePath: 'main.tscn:s' }],
    ['scenePath', { ...ADD, scenePath: 'NUL' }],
    ['newPath', { operation: 'save', scenePath: 'main.tscn', newPath: 'res://../out.tscn' }],
    ['newPath', { operation: 'save', scenePath: 'main.tscn', new_path: 'copy.tscn ' }],
    [
      'texturePath',
      {
        operation: 'load_sprite',
        scenePath: 'main.tscn',
        nodePath: 'root/S',
        texturePath: '../t.png',
      },
    ],
    ['nodeType', { ...ADD, scenePath: 'main.tscn', nodeType: '../part.tscn' }],
  ])('refuses a bad %s before Godot starts, naming the item', (field, item) => {
    const result = checkBatchOperationItems(
      [{ ...ADD, scenePath: 'main.tscn', nodeName: 'Ok' }, item],
      fixtureProjectPath,
    );
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain(`Invalid operations[1].${field}:`);
    expect(messageOf(result)).toContain('resolves outside the project or is not a valid file name');
  });

  it('a scene or save-as target behind a link that leaves the project is refused', () => {
    const projectDir = projectWithLinkedFolder();
    const scene = checkBatchOperationItems([{ ...ADD, scenePath: 'linked/part.tscn' }], projectDir);
    expect(messageOf(scene)).toContain('Invalid operations[0].scenePath:');
    const copy = checkBatchOperationItems(
      [{ operation: 'save', scenePath: 'main.tscn', newPath: 'linked/copy.tscn' }],
      projectDir,
    );
    expect(messageOf(copy)).toContain('Invalid operations[0].newPath:');
  });

  // Red when the items are checked as spelled: `newPath` is then the one
  // resolved, and `new_path`, which the runner folds onto the same key after
  // it, reaches the script unchecked.
  it('a key spelled both ways is checked as the one value that is forwarded', () => {
    const projectDir = projectWithLinkedFolder();
    const SAVE = { operation: 'save', scenePath: 'main.tscn' };
    const outside = checkBatchOperationItems(
      [{ ...SAVE, newPath: 'copy.tscn', new_path: 'linked/copy.tscn' }],
      projectDir,
    );
    expect(messageOf(outside)).toContain('Invalid operations[0].newPath: "linked/copy.tscn"');
    const inside = checkBatchOperationItems(
      [{ ...SAVE, newPath: 'linked/copy.tscn', new_path: 'res://copy.tscn' }],
      projectDir,
    );
    expect(inside.ok && inside.value).toEqual([{ ...SAVE, newPath: 'copy.tscn' }]);
    const mistyped = checkBatchOperationItems(
      [{ ...SAVE, scenePath: 'main.tscn', scene_path: 5 }],
      projectDir,
    );
    expect(messageOf(mistyped)).toContain('operations[0].scenePath must be a string');
  });

  it('a texture or an instanced scene behind such a link is only read, and is accepted', () => {
    const projectDir = projectWithLinkedFolder();
    const result = checkBatchOperationItems(
      [
        {
          operation: 'load_sprite',
          scenePath: 'main.tscn',
          nodePath: 'root/S',
          texturePath: 'linked/tex.png',
        },
        { ...ADD, scenePath: 'main.tscn', nodeType: 'linked/part.tscn' },
      ],
      projectDir,
    );
    expect(result.ok).toBe(true);
  });
});

describe('parseSceneArgs access intent', () => {
  it('reads a scene behind a link that leaves the project and refuses to write it', () => {
    const projectDir = tmp.makeProject('scene-intent-');
    const shared = tmp.make('scene-intent-shared-');
    writeFileSync(join(shared, 'part.tscn'), '', 'utf8');
    symlinkSync(shared, join(projectDir, 'linked'), 'junction');
    const args = { projectPath: projectDir, scenePath: 'linked/part.tscn' };

    const read = parseSceneArgs(args, 'read');
    expect(read.ok && read.value.scenePath).toBe('linked/part.tscn');
    expect(parseSceneArgs(args, 'write').ok).toBe(false);
  });
});

describe('parseSceneArgs path errors', () => {
  const textOf = (result: unknown): string =>
    unwrap(result)
      .content.map((entry) => entry.text ?? '')
      .join('\n');

  it.each(['../outside.tscn', 'main.tscn.', 'main.tscn:stream', ' '])(
    'refuses %j and states the rule as it is',
    (scenePath) => {
      const result = parseSceneArgs({ projectPath: fixtureProjectPath, scenePath }, 'write');
      expect(result.ok).toBe(false);
      const text = textOf(result);
      expect(text).toContain('resolves outside the project or is not a valid file name');
      expect(text).toMatch(/"res:\/\/"/);
      expect(text).toMatch(/absolute path inside the project/);
      expect(text).not.toMatch(/must be project-relative|relative path without/);
    },
  );

  it('accepts a scene whose name holds two dots', () => {
    const result = parseSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: 'ui/menu..old.tscn' },
      'write',
      { requireExists: false },
    );
    expect(result.ok && result.value.scene.relPath).toBe('ui/menu..old.tscn');
  });

  it('refuses a project path with a .. segment and accepts a name with two dots in it', () => {
    expect(parseProjectArgs({ projectPath: '../evil' }).ok).toBe(false);
    const dotted = parseProjectArgs({ projectPath: '/no/such/my..game' });
    expect(textOf(dotted)).toMatch(/Not a valid Godot project/);
  });
});
