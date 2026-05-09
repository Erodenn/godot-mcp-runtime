import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

// ---------------------------------------------------------------------------
// handleValidate — single-target mode
// ---------------------------------------------------------------------------

describe('handleValidate', () => {
  it('rejects missing projectPath in single-target mode', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, { source: 'extends Node' });
    expectErrorMatching(result, /projectPath is required/);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '../evil',
      source: 'extends Node',
    });
    expectErrorMatching(result, /Invalid project path/);
  });

  it('rejects nonexistent project directory', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '/does/not/exist',
      source: 'extends Node',
    });
    expectErrorMatching(result, /Not a valid Godot project/);
  });

  it('rejects when none of scriptPath, source, scenePath, or targets is provided', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /One of scriptPath, source, or scenePath is required/);
  });

  it('rejects when more than one of scriptPath, source, scenePath is provided', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'extends Node',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /Provide exactly one of scriptPath, source, or scenePath/);
  });

  it('rejects scriptPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scriptPath: '../outside.gd',
    });
    expectErrorMatching(result, /Invalid scriptPath/);
  });

  it('rejects nonexistent scriptPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scriptPath: 'nonexistent.gd',
    });
    expectErrorMatching(result, /Script file does not exist/);
  });

  it('rejects scenePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    expectErrorMatching(result, /Invalid scenePath/);
  });

  it('rejects nonexistent scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: 'ghost.tscn',
    });
    expectErrorMatching(result, /Scene file does not exist/);
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
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.valid).toBe(false);
  });

  it('returns valid:false when stdout reports valid:true but stderr contains parse errors', async () => {
    // Regression: GDScript-side _validate_single returns valid: resource != null,
    // but load() returns a non-null placeholder for malformed scripts. The
    // handler must override `valid` to false whenever stderr produced any
    // parse-error entries.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ valid: true, errors: [] }),
      stderr:
        'SCRIPT ERROR: Parse Error: Unexpected token: Identifier:foo\n   at: res://.mcp/validate_temp_x.gd:3',
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'func bad( :',
    });
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0].message).toContain('Unexpected token');
  });
});

// ---------------------------------------------------------------------------
// handleValidate — batch (targets[]) mode
// ---------------------------------------------------------------------------

describe('handleValidate batch mode', () => {
  it('invokes validate_batch (not validate_resource) when targets array is provided alongside single-target params', async () => {
    // Boundary contract: targets[] should route through the batch operation
    // even when single-target params are also present. Asserting only on the
    // result shape can't distinguish batch from single, so we inspect the spy.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].operation).toBe('validate_batch');
  });

  it('treats empty Godot output as a failed operation in batch mode', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, /Batch validate failed/);
  });

  it('surfaces runner exceptions as a structured MCP error response in batch mode', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, /Batch validation failed.*boom/);
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
    expectErrorMatching(result, /projectPath is required/);
  });

  it('rejects projectPath containing .. in batch mode', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: '../evil',
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, /Invalid project path/);
  });

  it('reports valid:false for parse-broken targets via secondary "Failed to load script" message', async () => {
    // Regression: parse-error stderr entries reference `gdscript://-N.gd` synthetic
    // URIs in their `at:` line, not `res://` paths. The handler must peek forward
    // for the secondary "Failed to load script: \"res://...\"" message to attribute
    // the error back to the right target. Without that, batch fell back to the
    // GDScript-side `resource != null` check, which is `true` for malformed scripts.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: '_e2e_test/broken.gd', valid: true, errors: [] },
          { target: '_e2e_test/ok.gd', valid: true, errors: [] },
        ],
      }),
      stderr: [
        'SCRIPT ERROR: Parse Error: Unexpected token: ":".',
        '   at: GDScript::reload (gdscript://-1.gd:2)',
        'ERROR: Failed to load script "res://_e2e_test/broken.gd" with error "Parse error".',
        '   at: load (core/io/resource_loader.cpp:283)',
      ].join('\n'),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scriptPath: '_e2e_test/broken.gd' }, { scriptPath: '_e2e_test/ok.gd' }],
    });
    expect(hasError(result)).toBe(false);

    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    const broken = parsed.results.find(
      (r: { target: string }) => r.target === '_e2e_test/broken.gd',
    );
    const ok = parsed.results.find((r: { target: string }) => r.target === '_e2e_test/ok.gd');
    expect(broken.valid).toBe(false);
    expect(broken.errors.length).toBeGreaterThan(0);
    expect(broken.errors[0].message).toContain('Unexpected token');
    expect(ok.valid).toBe(true);
  });
});
