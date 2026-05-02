import { describe, it, expect } from 'vitest';
import {
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleManageUids,
  handleBatchSceneOperations,
} from '../../../src/tools/scene-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

// ---------------------------------------------------------------------------
// handleCreateScene
// ---------------------------------------------------------------------------

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
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('disk full');
  });

  it('returns parsed result on successful runner output', async () => {
    const fake = createFakeRunner({ stdout: 'Scene created successfully at: scenes/x.tscn' });
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'scenes/x.tscn',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('created successfully');
  });
});

// ---------------------------------------------------------------------------
// handleAddNode
// ---------------------------------------------------------------------------

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
    const fake = createFakeRunner({
      stdout: "Node 'Foo' of type 'Node2D' added successfully",
    });
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
      nodeName: 'Foo',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('added successfully');
  });
});

// ---------------------------------------------------------------------------
// handleLoadSprite
// ---------------------------------------------------------------------------

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
    const fake = createFakeRunner({
      stdout: 'Sprite loaded successfully with texture: placeholder.png',
    });
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
      texturePath: 'placeholder.png',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('loaded successfully');
  });
});

// ---------------------------------------------------------------------------
// handleSaveScene
// ---------------------------------------------------------------------------

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
    const fake = createFakeRunner({ stdout: 'Scene saved successfully to: main.tscn' });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('saved successfully');
  });
});

// ---------------------------------------------------------------------------
// handleExportMeshLibrary
// ---------------------------------------------------------------------------

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
    const fake = createFakeRunner({
      stdout: 'MeshLibrary exported successfully with 3 items to: lib.res',
    });
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: 'lib.res',
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('MeshLibrary exported');
  });
});

// ---------------------------------------------------------------------------
// handleManageUids
// ---------------------------------------------------------------------------

describe('handleManageUids', () => {
  it('rejects missing operation', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /operation/i);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: '../evil',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: '/ghost',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    // Force the version gate open so the runner is actually invoked — otherwise
    // the 4.4+ version check short-circuits before executeOperation and the
    // throws branch is never exercised.
    const fake = createFakeRunner({
      throws: new Error('boom'),
      godotVersion: '4.4.1.stable',
    });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: fixtureProjectPath,
    });
    expectErrorMatching(result, /boom/);
  });

  it('reports the version gate when Godot is older than 4.4', async () => {
    // Default godotVersion is 4.3 — the version check should fire before any
    // operation dispatch, regardless of what the runner is configured to do.
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: fixtureProjectPath,
    });
    expectErrorMatching(result, /godot 4\.4 or later/i);
  });

  it('rejects unknown operation when running on a version-gated Godot 4.4+ project', async () => {
    // Reports Godot 4.4+ so handleManageUids passes its version gate, then
    // returns an empty stdout for the operation itself, which the handler
    // surfaces as an error response.
    const fake = createFakeRunner({ stdout: '', godotVersion: '4.4.1.stable' });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'bad_op',
      projectPath: fixtureProjectPath,
    });
    expectErrorMatching(result, /unknown operation|operation/i);
  });

  it('returns parsed result for get operation on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: 'uid://abcdef',
      godotVersion: '4.4.1.stable',
    });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'get',
      projectPath: fixtureProjectPath,
      filePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('uid://abcdef');
    expect(text).toContain(fixtureScenePath);
  });

  it('returns parsed result for update operation on successful runner output', async () => {
    const fake = createFakeRunner({
      stdout: 'Resave operation complete. Scenes: 5 saved, 0 errors. UIDs generated: 2',
      godotVersion: '4.4.1.stable',
    });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: fixtureProjectPath,
    });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('Resave operation complete');
  });
});

// ---------------------------------------------------------------------------
// handleBatchSceneOperations
// ---------------------------------------------------------------------------

describe('handleBatchSceneOperations', () => {
  const validOps = [
    { operation: 'add_node', scenePath: fixtureScenePath, nodeType: 'Node2D', nodeName: 'Foo' },
  ];

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
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results[0].success).toBe(true);
    expect(parsed.results[0].operation).toBe('add_node');
  });
});
