import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleBatchSceneOperations,
  sceneToolDefinitions,
} from '../../../src/tools/scene-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

describe('handleCreateScene', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, { scenePath: 'new.tscn' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: '../bad/path',
      scenePath: 'new.tscn',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project directory', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: '/does/not/exist',
      scenePath: 'new.tscn',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /scenePath is required/i);
  });

  it('accepts a scenePath pointing at a not-yet-existing file', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ scenePath: 'scenes/not-yet-created.tscn' }),
    });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'scenes/not-yet-created.tscn',
    });
    expect(hasError(result)).toBe(false);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'new.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'new.tscn',
    });
    expectErrorMatching(result, /boom/);
  });

  it('includes the thrown message in the error response', async () => {
    const fake = createFakeRunner({ throws: new Error('disk full') });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'new.tscn',
    });
    const text = unwrap(result).content[0].text;
    expect(text).toContain('disk full');
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ scenePath: 'scenes/x.tscn' }),
    });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'scenes/x.tscn',
    });
    expect(hasError(result)).toBe(false);
    const env = unwrap(result);
    expect(env.structuredContent).toEqual({ scenePath: 'scenes/x.tscn' });
    expect(JSON.parse(env.content[0].text)).toEqual(env.structuredContent);
    expectMatchesOutputSchema('create_scene', result);
  });
});

describe('handleAddNode', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      projectPath: '/no/project',
      scenePath: fixtureScenePath,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodeType', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeName: 'MyNode',
    });
    expectErrorMatching(result, /nodeType/i);
  });

  it('rejects missing nodeName', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
    });
    expectErrorMatching(result, /nodeName/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const added = { nodeName: 'Foo', nodeType: 'Node2D', nodePath: 'root/Foo' };
    const fake = createFakeRunner({ stdout: JSON.stringify(added) });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
    });
    expect(expectMatchesOutputSchema('add_node', result)).toEqual(added);
  });

  it('puts warnings first when Godot renamed the node', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        nodeName: '@Foo@2',
        nodePath: 'root/@Foo@2',
        nodeType: 'Node2D',
        warnings: ['renamed'],
      }),
    });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
    });
    const payload = expectMatchesOutputSchema('add_node', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.nodeName).toBe('@Foo@2');
  });

  it('sends the properties value when it conflicts with a top-level shorthand', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ nodeName: 'Foo', nodeType: 'Node2D', nodePath: 'root/Foo' }),
    });
    await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
      position: { x: 1, y: 2 },
      properties: { position: { x: 300, y: 400 } },
    });
    expect(fake.calls[0]?.params.properties).toEqual({ position: { x: 300, y: 400 } });
  });

  it('still sends a top-level shorthand that properties does not name', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ nodeName: 'Foo', nodeType: 'Node2D', nodePath: 'root/Foo' }),
    });
    await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
      position: { x: 1, y: 2 },
      properties: { visible: false },
    });
    expect(fake.calls[0]?.params.properties).toEqual({
      position: { x: 1, y: 2 },
      visible: false,
    });
  });

  it('reports output with no result line as an error', async () => {
    const fake = createFakeRunner({
      stdout: "Node 'Foo' of type 'Node2D' added successfully",
    });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
    });
    expectErrorMatching(result, /no JSON payload was emitted/);
  });
});

describe('handleLoadSprite', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      scenePath: fixtureScenePath,
      nodePath: 'root/Sprite',
      texturePath: 'icon.png',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Sprite',
      texturePath: 'icon.png',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      projectPath: '/not/a/project',
      scenePath: fixtureScenePath,
      nodePath: 'root/Sprite',
      texturePath: 'icon.png',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      texturePath: 'icon.png',
    });
    expectErrorMatching(result, /nodePath/i);
  });

  it('rejects missing texturePath', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
    });
    expectErrorMatching(result, /texturePath/i);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    // texturePath must point at an existing file so we get past fs validation and reach the runner.
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
      texturePath: 'placeholder.png',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const loaded = {
      nodePath: 'root/Sprite',
      nodeType: 'Sprite2D',
      texturePath: 'placeholder.png',
    };
    const fake = createFakeRunner({ stdout: JSON.stringify(loaded) });
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
      texturePath: 'placeholder.png',
    });
    expect(expectMatchesOutputSchema('load_sprite', result)).toEqual(loaded);
  });
});

describe('handleSaveScene', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, { scenePath: fixtureScenePath });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, {
      projectPath: '../../etc',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, {
      projectPath: '/ghost/project',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects newPath containing ..', async () => {
    const fake = createFakeRunner({ stdout: 'ok' });
    const result = await handleSaveScene(fake.asRunner, {
      ...validBase,
      newPath: '../outside/scene.tscn',
    });
    expectErrorMatching(result, /newPath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const saved = { scenePath: 'main.tscn', savedScenePath: 'main.tscn' };
    const fake = createFakeRunner({ stdout: JSON.stringify(saved) });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expect(expectMatchesOutputSchema('save_scene', result)).toEqual(saved);
  });
});

describe('handleExportMeshLibrary', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      scenePath: fixtureScenePath,
      outputPath: 'out.res',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      outputPath: 'out.res',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      outputPath: 'out.res',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing outputPath', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, validBase);
    expectErrorMatching(result, /outputPath/i);
  });

  it('rejects outputPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: '../escape.res',
    });
    expectErrorMatching(result, /outputPath/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: 'out.res',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: 'out.res',
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const exported = { outputPath: 'lib.res', itemCount: 3, itemNames: ['A', 'B', 'C'] };
    const fake = createFakeRunner({ stdout: JSON.stringify(exported) });
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: 'lib.res',
    });
    expect(expectMatchesOutputSchema('export_mesh_library', result)).toEqual(exported);
  });

  it('puts warnings first when a requested item was not exported', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        outputPath: 'lib.res',
        itemCount: 3,
        itemNames: ['A', 'B', 'C'],
        warnings: ['Requested mesh items were not exported: D'],
      }),
    });
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: 'lib.res',
      meshItemNames: ['A', 'D'],
    });
    const payload = expectMatchesOutputSchema('export_mesh_library', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
  });
});

describe('handleBatchSceneOperations', () => {
  const validOps = [
    { operation: 'add_node', scenePath: fixtureScenePath, nodeType: 'Node2D', nodeName: 'Foo' },
  ];

  // Red when a batch item's updates are checked as spelled and forwarded raw.
  it('checks and forwards one spelling of a nested update whose nodePath is spelled both ways', async () => {
    const SET = { operation: 'set_node_properties', scenePath: fixtureScenePath };
    const refused = createFakeRunner({ stdout: '{"results":[]}' });
    const result = await handleBatchSceneOperations(refused.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [
        { ...SET, updates: [{ nodePath: 'root', node_path: '../Out', property: 'p', value: 1 }] },
      ],
    });
    expectErrorMatching(result, /Invalid operations\[0\]\.updates\[0\]\.nodePath/);
    expect(refused.calls).toHaveLength(0);

    const forwarded = createFakeRunner({ stdout: '{"results":[]}' });
    await handleBatchSceneOperations(forwarded.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [
        { ...SET, updates: [{ node_path: 'root/A', nodePath: 'root/B', property: 'p', value: 1 }] },
      ],
    });
    const operations = forwarded.calls[0]?.params.operations as Array<{ updates: unknown }>;
    expect(operations[0]?.updates).toEqual([{ nodePath: 'root/B', property: 'p', value: 1 }]);
  });

  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSceneOperations(fake.asRunner, { operations: validOps });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: '../evil',
      operations: validOps,
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: '/ghost',
      operations: validOps,
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing operations array', async () => {
    const fake = createFakeRunner();
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
    });
    expectErrorMatching(result, /operations/i);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: validOps,
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: validOps,
    });
    expectErrorMatching(result, /boom/);
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: `{"results":[{"operation":"add_node","scenePath":"${fixtureScenePath}","success":true}]}`,
    });
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: validOps,
    });
    expect(hasError(result)).toBe(false);
    const text = unwrap(result).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
    expect(parsed.results[0].operation).toBe('add_node');
  });

  it('declares resolvedNodePath on an update entry and returns the one the engine reported', async () => {
    const update = {
      nodePath: '%Sprite2D',
      property: 'visible',
      resolvedNodePath: 'root/Sprite2D',
      success: true,
    };
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          {
            operation: 'set_node_properties',
            scenePath: fixtureScenePath,
            success: true,
            updates: [update],
          },
        ],
      }),
    });
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: [
        {
          operation: 'set_node_properties',
          scenePath: fixtureScenePath,
          updates: [{ nodePath: '%Sprite2D', property: 'visible', value: false }],
        },
      ],
    });
    const payload = expectMatchesOutputSchema('batch_scene_operations', result);
    expect((payload.results as Array<{ updates: unknown[] }>)[0]!.updates).toEqual([update]);
    const definition = sceneToolDefinitions.find(
      (tool) => tool.name === 'batch_scene_operations',
    ) as unknown as {
      outputSchema: {
        properties: {
          results: { items: { properties: { updates: { items: { properties: object } } } } };
        };
      };
    };
    const updateFields = definition.outputSchema.properties.results.items.properties.updates;
    expect(Object.keys(updateFields.items.properties)).toContain('resolvedNodePath');
  });

  it('validates a batch payload with per-operation fields', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          {
            operation: 'add_node',
            scenePath: 'main.tscn',
            success: true,
            nodeName: '@Foo@2',
            nodeType: 'Node2D',
            nodePath: 'root/@Foo@2',
          },
          {
            operation: 'save',
            scenePath: 'main.tscn',
            success: true,
            savedScenePath: 'copy.tscn',
          },
        ],
        warnings: ['operations[0]: renamed'],
      }),
    });
    const result = await handleBatchSceneOperations(fake.asRunner, {
      projectPath: fixtureProjectPath,
      operations: validOps,
    });
    const payload = expectMatchesOutputSchema('batch_scene_operations', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.results).toHaveLength(2);
  });
});

describe('scene tools accept every project path spelling', () => {
  const spellings = [
    ['res://', (p: string) => `res://${p}`],
    ['absolute', (p: string) => join(fixtureProjectPath, p)],
  ] as const;

  it.each(spellings)(
    'scenePath as %s reaches Godot as the relative path',
    async (_label, spell) => {
      const fake = createFakeRunner({ stdout: JSON.stringify({}) });
      await handleSaveScene(fake.asRunner, {
        projectPath: fixtureProjectPath,
        scenePath: spell(fixtureScenePath),
      });
      expect(fake.calls[0]?.params.scenePath).toBe(fixtureScenePath);
    },
  );

  it.each(spellings)('load_sprite texturePath as %s is forwarded relative', async (_l, spell) => {
    const fake = createFakeRunner({ stdout: JSON.stringify({}) });
    await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
      texturePath: spell('placeholder.png'),
    });
    expect(fake.calls[0]?.params.texturePath).toBe('placeholder.png');
  });

  it.each(spellings)('save_scene newPath as %s is forwarded relative', async (_l, spell) => {
    const fake = createFakeRunner({ stdout: JSON.stringify({}) });
    await handleSaveScene(fake.asRunner, { ...validBase, newPath: spell('copy.tscn') });
    expect(fake.calls[0]?.params.newPath).toBe('copy.tscn');
  });

  it.each(spellings)(
    'export_mesh_library outputPath as %s is forwarded relative',
    async (_l, spell) => {
      const fake = createFakeRunner({ stdout: JSON.stringify({}) });
      await handleExportMeshLibrary(fake.asRunner, { ...validBase, outputPath: spell('lib.res') });
      expect(fake.calls[0]?.params.outputPath).toBe('lib.res');
    },
  );

  it.each(spellings)(
    'add_node scene-path nodeType as %s is forwarded relative',
    async (_l, spell) => {
      const fake = createFakeRunner({ stdout: JSON.stringify({}) });
      await handleAddNode(fake.asRunner, {
        ...validBase,
        nodeType: spell('input_probe.tscn'),
        nodeName: 'Probe',
      });
      expect(fake.calls[0]?.params.nodeType).toBe('input_probe.tscn');
    },
  );

  it('add_node leaves a class-name nodeType untouched', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({}) });
    await handleAddNode(fake.asRunner, { ...validBase, nodeType: 'Node2D', nodeName: 'Foo' });
    expect(fake.calls[0]?.params.nodeType).toBe('Node2D');
  });
});
