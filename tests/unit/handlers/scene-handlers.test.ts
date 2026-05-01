import { describe, it, expect } from 'vitest';
import {
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleManageUids,
} from '../../../src/tools/scene-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError } from '../../helpers/assertions.js';
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: '../bad/path',
      scenePath: 'new.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project directory', async () => {
    const fake = createFakeRunner();
    const result = await handleCreateScene(fake.asRunner, {
      projectPath: '/does/not/exist',
      scenePath: 'new.tscn',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      projectPath: '/no/project',
      scenePath: fixtureScenePath,
      nodeType: 'Node2D',
      nodeName: 'MyNode',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodeType', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeName: 'MyNode',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodeName', async () => {
    const fake = createFakeRunner();
    const result = await handleAddNode(fake.asRunner, {
      ...validBase,
      nodeType: 'Node2D',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      nodePath: 'root/Sprite',
      texturePath: 'icon.png',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      projectPath: '/not/a/project',
      scenePath: fixtureScenePath,
      nodePath: 'root/Sprite',
      texturePath: 'icon.png',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing nodePath', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      texturePath: 'icon.png',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing texturePath', async () => {
    const fake = createFakeRunner();
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
    });
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    // texturePath must point at an existing file so we get past fs validation and reach the runner.
    const result = await handleLoadSprite(fake.asRunner, {
      ...validBase,
      nodePath: 'root/Sprite',
      texturePath: 'placeholder.png',
    });
    expect(hasError(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleSaveScene
// ---------------------------------------------------------------------------

describe('handleSaveScene', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, { scenePath: fixtureScenePath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, {
      projectPath: '../../etc',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleSaveScene(fake.asRunner, {
      projectPath: '/ghost/project',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects newPath containing ..', async () => {
    const fake = createFakeRunner({ stdout: 'ok' });
    const result = await handleSaveScene(fake.asRunner, {
      ...validBase,
      newPath: '../outside/scene.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('treats empty Godot output as a failed operation', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('surfaces runner exceptions as a structured MCP error response', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleSaveScene(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
      outputPath: 'out.res',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
      outputPath: 'out.res',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing outputPath', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, validBase);
    expect(hasError(result)).toBe(true);
  });

  it('rejects outputPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleExportMeshLibrary(fake.asRunner, {
      ...validBase,
      outputPath: '../escape.res',
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleManageUids
// ---------------------------------------------------------------------------

describe('handleManageUids', () => {
  it('rejects missing operation', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, { projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: '../evil',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: '/ghost',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws (treated as version check or op failure)', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleManageUids(fake.asRunner, {
      operation: 'update',
      projectPath: fixtureProjectPath,
    });
    expect(hasError(result)).toBe(true);
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
    expect(hasError(result)).toBe(true);
  });
});
