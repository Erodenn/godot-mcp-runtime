import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result;
}

// ---------------------------------------------------------------------------
// handleValidate — single-target mode
// ---------------------------------------------------------------------------

describe('handleValidate (single-target)', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, { source: 'extends Node' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '../evil',
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project directory', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '/does/not/exist',
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects when none of scriptPath, source, scenePath, or targets is provided', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, { projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects when more than one of scriptPath, source, scenePath is provided', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects scriptPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scriptPath: '../outside.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent scriptPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scriptPath: 'nonexistent.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects scenePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'ghost.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws (source mode)', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(true);
  });

  it('includes the thrown message in the error response', async () => {
    const fake = createFakeRunner({ throws: new Error('disk full') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('disk full');
  });

  it('returns a result (not isError) when runner succeeds with valid JSON stdout', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ valid: true, errors: [] }) });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(false);
  });

  it('returns a result (not isError) when runner succeeds with invalid JSON stdout (treated as invalid script)', async () => {
    // Non-JSON stdout is handled gracefully — valid=false but no isError
    const fake = createFakeRunner({ stdout: 'not json at all' });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleValidate — batch (targets[]) mode
// ---------------------------------------------------------------------------

describe('handleValidate (batch mode)', () => {
  it('enters batch mode when targets array is provided alongside single-target params', async () => {
    // When targets is provided, the handler runs in batch mode and ignores single-target params.
    // The handler does NOT return isError just because both are present; it processes targets.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath, // single-target param also present
      targets: [{ scenePath: fixtureScenePath }],
    });
    // Batch mode runs; no isError expected when runner returns valid JSON
    expect(hasError(result)).toBe(false);
  });

  it('returns isError when runner returns empty stdout in batch mode', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when runner throws in batch mode', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('handles empty targets array (batch mode with no items)', async () => {
    // Empty targets array goes to the batch branch. Runner gets called with an empty list.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [],
    });
    // Handler runs batch mode; with an empty results list this is not an error
    expect(hasError(result)).toBe(false);
  });

  it('rejects missing projectPath even in batch mode', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing .. in batch mode', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '../evil',
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(true);
  });
});
