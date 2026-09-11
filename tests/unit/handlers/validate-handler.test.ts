import { describe, it, expect } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { useTmpDirs } from '../../helpers/tmp.js';
import { validateTempDir } from '../../../src/utils/artifact-paths.js';

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
    const text = unwrap(result).content[0].text;
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
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
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0].message).toContain('Unexpected token');
  });

  // --- Autoload-aware validation + diagnostic quality regressions ---

  it('reports autoload-reference compile errors with file and line (error-43 class)', async () => {
    // Real-world failure class: scripts referencing autoload singletons produce a
    // "Compile Error: Identifier not found" on stderr that the handler must
    // overlay (message + line) instead of reporting a bare invalid.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ valid: true, errors: [] }),
      stderr: [
        'SCRIPT ERROR: Compile Error: Identifier not found: GameState',
        '          at: GDScript::reload (res://scripts/uses_autoload.gd:3)',
        'ERROR: Failed to load script "res://scripts/uses_autoload.gd" with error "Compilation failed".',
        '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
      ].join('\n'),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'func probe() -> int:\n\treturn GameState.score\n',
    });
    expect(hasError(result)).toBe(false);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].message).toContain('GameState');
    expect(parsed.errors[0].line).toBe(3);
  });

  it('does not surface engine-source line numbers from "Failed to load" echoes', async () => {
    // The engine echo "ERROR: Failed to load script ..." carries an at: line
    // pointing into Godot's C++ source (e.g. gdscript_resource_format.cpp:46).
    // Before the shared-parser dedup, that surfaced as a bogus error entry
    // with a line number belonging to nobody's script.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ valid: true, errors: [] }),
      stderr: [
        'SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.',
        '          at: GDScript::reload (res://scripts/a.gd:7)',
        'ERROR: Failed to load script "res://scripts/a.gd" with error "Parse error".',
        '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
      ].join('\n'),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      source: 'var x',
    });
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].line).toBe(7);
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

  it('short-circuits and reports per-target failure when batch scriptPath contains ..', async () => {
    // Regression: validateSubPath ran in single-target mode but the batch
    // branch built snakeTargets without it. An agent could pass a traversal
    // path and bypass the documented path-traversal protection.
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scriptPath: '../escape.gd' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(0); // short-circuit — no runner spawn
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].valid).toBe(false);
    expect(parsed.results[0].target).toBe('../escape.gd');
    expect(parsed.results[0].errors[0].message).toMatch(/Invalid scriptPath/);
  });

  it('short-circuits and reports per-target failure when batch scenePath is absolute and escapes root', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scenePath: '/etc/passwd' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].valid).toBe(false);
    expect(parsed.results[0].target).toBe('/etc/passwd');
    expect(parsed.results[0].errors[0].message).toMatch(/Invalid scenePath/);
  });

  it('preserves input order when mixing valid and invalid batch targets', async () => {
    // Godot only sees the two valid entries; the handler must splice the
    // pre-validation failure back at index 1 so output order matches input.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: 'ok.gd', valid: true, errors: [] },
          { target: 'ok.tscn', valid: true, errors: [] },
        ],
      }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scriptPath: 'ok.gd' }, { scriptPath: '../escape.gd' }, { scenePath: 'ok.tscn' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    const sentTargets = (
      fake.calls[0].params as { targets: Array<{ script_path?: string; scene_path?: string }> }
    ).targets;
    expect(sentTargets).toHaveLength(2); // only the two valid ones reach Godot
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].valid).toBe(true);
    expect(parsed.results[0].target).toBe('ok.gd');
    expect(parsed.results[1].valid).toBe(false);
    expect(parsed.results[1].target).toBe('../escape.gd');
    expect(parsed.results[1].errors[0].message).toMatch(/Invalid scriptPath/);
    expect(parsed.results[2].valid).toBe(true);
    expect(parsed.results[2].target).toBe('ok.tscn');
  });

  it('reports valid:false for parse-broken targets from real Godot 4.5 stderr', async () => {
    // Regression: real Godot 4.5 stderr formats the `at:` line as
    //   "   at: GDScript::reload (res://path/to/file.gd:LINE)"
    // — the res:// path appears inside parentheses after a method name, not bare
    // after `at:`. The tolerant `at:` regex must capture that path. As a
    // belt-and-suspenders fallback, the secondary "Failed to load script: \"res://...\""
    // message lands several lines below after a GDScript backtrace, so the
    // lookahead window must clear it (10 lines covers any realistic trace).
    // Without either fix, batch error attribution returns an empty Map and
    // valid falls back to GDScript's unreliable `resource != null` flag.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: '_e2e_test/broken.gd', valid: true, errors: [] },
          { target: '_e2e_test/ok.gd', valid: true, errors: [] },
        ],
      }),
      stderr: [
        'SCRIPT ERROR: Parse Error: Expected parameter name.',
        '   at: GDScript::reload (res://_e2e_test/broken.gd:3)',
        '   GDScript backtrace (most recent call first):',
        '       [0] _validate_single (res://.mcp/godot_operations.gd:860)',
        '       [1] validate_batch (res://.mcp/godot_operations.gd:876)',
        '       [2] _init (res://.mcp/godot_operations.gd:87)',
        'ERROR: Failed to load script "res://_e2e_test/broken.gd" with error "Parse error".',
        '   at: load (core/io/resource_loader.cpp:283)',
      ].join('\n'),
    });

    const result = await handleValidate(fake.asRunner, {
      projectPath: fixtureProjectPath,
      targets: [{ scriptPath: '_e2e_test/broken.gd' }, { scriptPath: '_e2e_test/ok.gd' }],
    });
    expect(hasError(result)).toBe(false);

    const parsed = JSON.parse(unwrap(result).content[0].text);
    const broken = parsed.results.find(
      (r: { target: string }) => r.target === '_e2e_test/broken.gd',
    );
    const ok = parsed.results.find((r: { target: string }) => r.target === '_e2e_test/ok.gd');
    expect(broken.valid).toBe(false);
    expect(broken.errors.length).toBeGreaterThan(0);
    expect(broken.errors[0].message).toContain('Expected parameter name');
    expect(broken.errors[0].line).toBe(3);
    expect(ok.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeTempGdScript placement (AC3.3) — observed through handleValidate, which
// is the only caller. The fake runner records the script path it was handed;
// the directory it was written into survives the per-call unlink, so its
// presence plus the file's absence proves both halves.
// ---------------------------------------------------------------------------

describe('handleValidate inline-source temp files', () => {
  const tmp = useTmpDirs();

  it('writes and removes the temp script under .mcp/godot-runtime/validate/', async () => {
    const projectPath = tmp.makeProject('mcp-validate-');
    const fake = createFakeRunner({ stdout: '' });

    await handleValidate(fake.asRunner, { projectPath, source: 'extends Node\n' });

    // Single-target mode hands executeOperation camelCase params; the snake_case
    // conversion happens inside the real runner, downstream of this fake.
    const scriptPath = fake.calls[0]?.params.scriptPath as string;
    expect(scriptPath).toMatch(/^\.mcp\/godot-runtime\/validate\/validate_temp_/);
    expect(existsSync(validateTempDir(projectPath))).toBe(true);
    expect(existsSync(join(projectPath, scriptPath))).toBe(false);
  });

  it('writes batch temp scripts under the same directory', async () => {
    const projectPath = tmp.makeProject('mcp-validate-batch-');
    const fake = createFakeRunner({ stdout: '' });

    await handleValidate(fake.asRunner, {
      projectPath,
      targets: [{ source: 'extends Node\n' }],
    });

    const params = fake.calls[0]?.params as { targets?: Array<{ script_path?: string }> };
    const batchPath = params.targets?.[0]?.script_path ?? '';
    expect(batchPath).toMatch(/^\.mcp\/godot-runtime\/validate\/validate_batch_/);
    expect(existsSync(join(projectPath, batchPath))).toBe(false);
  });
});
