import { describe, it, expect, afterAll } from 'vitest';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';
import { expectMatchesOutputSchema } from '../../helpers/schema-assert.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { copyProjectToTmp, removeTmpDir, useTmpDirs } from '../../helpers/tmp.js';
import { validateTempDir } from '../../../src/utils/artifact-paths.js';

// An inline `source` makes validate write under `.mcp/` and add a `.gitignore`
// entry in the project it is given, so every call here runs on a copy.
const projectCopyPath = copyProjectToTmp(fixtureProjectPath, 'mcp-validate-handler-');
afterAll(() => removeTmpDir(projectCopyPath));

// ---------------------------------------------------------------------------
// handleValidate: single-target mode
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
    const result = await handleValidate(fake.asRunner, { projectPath: projectCopyPath });
    expectErrorMatching(result, /One of scriptPath, source, or scenePath is required/);
  });

  it('rejects when more than one of scriptPath, source, scenePath is provided', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      source: 'extends Node',
      scenePath: fixtureScenePath,
    });
    expectErrorMatching(result, /Provide exactly one of scriptPath, source, or scenePath/);
  });

  it('rejects scriptPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scriptPath: '../outside.gd',
    });
    expectErrorMatching(result, /Invalid scriptPath/);
  });

  it('rejects nonexistent scriptPath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scriptPath: 'nonexistent.gd',
    });
    expectErrorMatching(result, /Script file does not exist/);
  });

  it('rejects scenePath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: '../outside.tscn',
    });
    expectErrorMatching(result, /Invalid scenePath/);
  });

  it('rejects nonexistent scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: 'ghost.tscn',
    });
    expectErrorMatching(result, /Scene file does not exist/);
  });

  it('includes the thrown message in the error response', async () => {
    const fake = createFakeRunner({ throws: new Error('disk full') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      source: 'extends Node',
    });
    const text = unwrap(result).content[0].text;
    expect(text).toContain('disk full');
  });

  it('returns a result (not isError) when runner succeeds with valid JSON stdout', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ valid: true, errors: [] }) });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      source: 'extends Node',
    });
    expect(hasError(result)).toBe(false);
    expect(expectMatchesOutputSchema('validate', result)).toEqual({ valid: true, errors: [] });
  });

  it('rejects an unknown top-level key by name and starts no process', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenepath: fixtureScenePath,
    });
    expectErrorMatching(result, /Unknown parameter "scenepath"/);
    expect(fake.calls).toHaveLength(0);
  });

  it('single mode never returns an invalid verdict with no errors', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ valid: false, errors: [] }) });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      source: 'extends Node',
    });
    const payload = expectMatchesOutputSchema('validate', result);
    expect(payload.valid).toBe(false);
    expect((payload.errors as unknown[]).length).toBe(1);
  });

  it('single mode with no result payload is an error response', async () => {
    // Nothing was validated, so there is no verdict to report: the batch and
    // combined branches already answer this with an error response.
    const fake = createFakeRunner({
      stdout: 'not json at all',
      stderr: '[ERROR] validate_resource requires script_path or scene_path',
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      source: 'extends Node',
    });
    expectErrorMatching(result, /no result was emitted.*requires script_path or scene_path/);
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
      projectPath: projectCopyPath,
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
      projectPath: projectCopyPath,
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
      projectPath: projectCopyPath,
      source: 'var x',
    });
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].line).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// handleValidate: batch (targets[]) mode
// ---------------------------------------------------------------------------

describe('handleValidate batch mode', () => {
  it('invokes validate_batch (not validate_resource) when a targets array is provided', async () => {
    // Boundary contract: targets[] routes through the batch operation.
    // Asserting only on the result shape can't distinguish batch from single,
    // so we inspect the spy.
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].operation).toBe('validate_batch');
  });

  // A single-target parameter beside targets used to be dropped: the batch ran
  // and reported the targets alone, with no sign the other parameter was never
  // read. It is refused before Godot runs, naming the parameter.
  it.each([
    ['scenePath', { scenePath: fixtureScenePath }],
    ['scriptPath', { scriptPath: 'placeholder.gd' }],
    ['source', { source: 'extends Node' }],
  ])('refuses a top-level %s passed alongside targets', async (param, extra) => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      ...extra,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, new RegExp(`"${param}" cannot be combined with targets`));
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses top-level checks passed alongside targets instead of reporting the targets valid', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }],
      checks: [{ type: 'structure', schema: { type: 'Node3D' } }],
    });
    expectErrorMatching(result, /"checks" cannot be combined with targets/);
    expectErrorMatching(result, /would not run on any target/);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts an empty top-level checks array alongside targets, as single mode does', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }],
      checks: [],
    });
    expect(hasError(result)).toBe(false);
  });

  it('reads a target written in snake_case and forwards it', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scene_path: fixtureScenePath }, { script_path: 'placeholder.gd' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].params).toEqual({
      targets: [{ scene_path: fixtureScenePath }, { script_path: 'placeholder.gd' }],
    });
  });

  it('reports a target that names nothing as its own failure and never forwards it', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }, {}, 7],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    const results = payload.results as Array<{
      target: string;
      valid: boolean;
      errors: Array<{ message: string }>;
    }>;
    expect(results).toHaveLength(3);
    expect(results[0]?.valid).toBe(true);
    expect(results[1]?.valid).toBe(false);
    expect(results[1]?.errors[0]?.message).toBe(
      'targets[1]: Target must have exactly one of scriptPath, source, or scenePath',
    );
    expect(results[2]?.valid).toBe(false);
    expect(results[2]?.errors[0]?.message).toMatch(/targets\[2\] must be an object/);
    expect(fake.calls[0].params).toEqual({ targets: [{ scene_path: fixtureScenePath }] });
  });

  it('reports a target with an unknown key as its own failure while the others still validate', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [
        { scenePath: fixtureScenePath },
        { scenePath: fixtureScenePath, check: [{ type: 'signals' }] },
      ],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    const results = payload.results as Array<{
      target: string;
      valid: boolean;
      errors: Array<{ message: string }>;
    }>;
    expect(results).toHaveLength(2);
    expect(results[0]?.valid).toBe(true);
    expect(results[1]?.valid).toBe(false);
    expect(results[1]?.target).toBe(fixtureScenePath);
    expect(results[1]?.errors[0]?.message).toBe(
      'targets[1]: unknown key "check" (allowed: scriptPath, source, scenePath, checks)',
    );
    expect(fake.calls[0].params).toEqual({ targets: [{ scene_path: fixtureScenePath }] });
  });

  it('reports a path of the wrong type as that target, not as a failed batch', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ results: [] }) });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: 5 }],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    const results = payload.results as Array<{
      valid: boolean;
      errors: Array<{ message: string }>;
    }>;
    expect(results[0]?.valid).toBe(false);
    expect(results[0]?.errors[0]?.message).toBe('targets[0].scriptPath must be a string');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a target the engine returned no result for instead of shortening results', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'main.tscn', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }, { scriptPath: 'placeholder.gd' }],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    const results = payload.results as Array<{
      target: string;
      valid: boolean;
      errors: Array<{ message: string }>;
    }>;
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({
      target: 'placeholder.gd',
      valid: false,
      errors: [{ message: 'Not validated: the engine returned no result for this target' }],
    });
  });

  it('words output without a result line as no result emitted, with the reason from stderr', async () => {
    const fake = createFakeRunner({
      stdout: '[Audio] ready\n',
      stderr: '[ERROR] Failed to parse JSON parameters',
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, /Batch validate failed: no result was emitted/);
    expectErrorMatching(result, /Failed to parse JSON parameters/);
    expect(unwrap(result).content[0]?.text ?? '').not.toContain('Invalid response');
  });

  it('treats empty Godot output as a failed operation in batch mode', async () => {
    const fake = createFakeRunner({ stdout: '' });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath }],
    });
    expectErrorMatching(result, /Batch validate failed/);
  });

  it('surfaces runner exceptions as a structured MCP error response in batch mode', async () => {
    const fake = createFakeRunner({ throws: new Error('boom') });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
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
      projectPath: projectCopyPath,
      targets: [],
    });
    // Handler runs batch mode; with an empty results list this is not an error
    expect(hasError(result)).toBe(false);
    expect(expectMatchesOutputSchema('validate', result)).toEqual({ results: [] });
  });

  it('validates a batch payload against the declared schema', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({ results: [{ target: 'placeholder.gd', valid: true, errors: [] }] }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: 'placeholder.gd' }],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    expect((payload.results as unknown[])[0]).toEqual({
      target: 'placeholder.gd',
      valid: true,
      errors: [],
    });
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
    // Regression: path validation ran in single-target mode but the batch
    // branch built snakeTargets without it. An agent could pass a traversal
    // path and bypass the documented path-traversal protection.
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: '../escape.gd' }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(0); // short-circuit: no runner spawn
    const parsed = JSON.parse(unwrap(result).content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].valid).toBe(false);
    expect(parsed.results[0].target).toBe('../escape.gd');
    expect(parsed.results[0].errors[0].message).toMatch(/Invalid scriptPath/);
  });

  it('short-circuits and reports per-target failure when batch scenePath is absolute and escapes root', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
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
      projectPath: projectCopyPath,
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
    //: the res:// path appears inside parentheses after a method name, not bare
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
      projectPath: projectCopyPath,
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
// writeTempGdScript placement: observed through handleValidate, which
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

  it('marks .mcp/ as ignored by the importer before the first temp script lands', async () => {
    const projectPath = tmp.makeProject('mcp-validate-gdignore-');
    expect(existsSync(join(projectPath, '.mcp'))).toBe(false);
    const fake = createFakeRunner({ stdout: '' });

    await handleValidate(fake.asRunner, { projectPath, source: 'extends Node\n' });

    expect(existsSync(join(projectPath, '.mcp', '.gdignore'))).toBe(true);
  });
});

describe('handleValidate targets shape', () => {
  it.each([
    ['an object', { scenePath: 'broken.tscn' }],
    ['a string', 'broken.tscn'],
  ])('refuses targets given as %s instead of ignoring it', async (_label, targets) => {
    const projectPath = projectCopyPath;
    const withScript = await handleValidate(createFakeRunner({ stdout: '' }).asRunner, {
      projectPath,
      scriptPath: 'ok.gd',
      targets,
    });
    expectErrorMatching(withScript, /targets must be an array/);
    const alone = await handleValidate(createFakeRunner({ stdout: '' }).asRunner, {
      projectPath,
      targets,
    });
    expectErrorMatching(alone, /targets must be an array/);
  });
});

// ---------------------------------------------------------------------------
// handleValidate batch mode: attribution, unattributed diagnostics, check shapes
// ---------------------------------------------------------------------------

const BROKEN_SCRIPT_STDERR = [
  'SCRIPT ERROR: Parse Error: Expected parameter name.',
  '   at: GDScript::reload (res://broken.gd:3)',
  'ERROR: Failed to load script "res://broken.gd" with error "Parse error".',
  '   at: load (core/io/resource_loader.cpp:283)',
].join('\n');

/** The batch payload the handler returned, parsed from its text block. */
function batchPayload(result: unknown): {
  warnings?: string[];
  results: Array<{ target: string; valid: boolean; errors: Array<Record<string, unknown>> }>;
} {
  return JSON.parse(unwrap(result).content[0].text);
}

describe('handleValidate batch attribution', () => {
  it('batch attribution uses the path Godot resolved, not the raw target', async () => {
    // The caller wrote ./broken.gd; Godot reports the simplified res://broken.gd.
    // Keyed on the raw spelling the diagnostic matched nothing and the target
    // stayed valid.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: './broken.gd', resolvedPath: 'res://broken.gd', valid: true, errors: [] },
        ],
      }),
      stderr: BROKEN_SCRIPT_STDERR,
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: './broken.gd' }],
    });
    expect(hasError(result)).toBe(false);
    const payload = batchPayload(result);
    expect(payload.results[0].target).toBe('./broken.gd');
    expect(payload.results[0].valid).toBe(false);
    expect(payload.results[0].errors[0].message).toContain('Expected parameter name');
    expect(payload.results[0].errors[0].line).toBe(3);
    expect(payload.results[0]).not.toHaveProperty('resolvedPath');
    expect(payload.warnings).toBeUndefined();
  });

  it('a target Godot reports invalid stays invalid when no diagnostic could be attributed', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'odd.gd', resolvedPath: 'res://odd.gd', valid: false, errors: [] }],
      }),
      stderr: '',
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: 'odd.gd' }],
    });
    expect(hasError(result)).toBe(false);
    const payload = batchPayload(result);
    const entry = payload.results[0];
    expect(entry.valid).toBe(false);
    expect(entry.errors).toHaveLength(1);
    // Nothing was printed, so the entry must not send the caller to a
    // warnings list that is not there.
    expect(String(entry.errors[0].message)).toMatch(/printed no diagnostic that names it/);
    expect(String(entry.errors[0].message)).not.toMatch(/see warnings/);
    expect(payload).not.toHaveProperty('warnings');
  });

  it('an invalid target whose diagnostic named another spelling points at the warnings that hold it', async () => {
    // A directory with a space: the engine prints the path, and the diagnostic
    // parser keeps it only up to the blank, so it matches no target.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          {
            target: 'my scripts/broken.gd',
            resolvedPath: 'res://my scripts/broken.gd',
            valid: false,
            errors: [],
          },
        ],
      }),
      stderr: [
        'SCRIPT ERROR: Parse Error: Expected parameter name.',
        '   at: GDScript::reload (res://my scripts/broken.gd:3)',
        'ERROR: Failed to load script "res://my scripts/broken.gd" with error "Parse error".',
        '   at: load (core/io/resource_loader.cpp:283)',
      ].join('\n'),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: 'my scripts/broken.gd' }],
    });
    const payload = expectMatchesOutputSchema('validate', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect((payload.warnings as string[])[0]).toContain('Expected parameter name');
    const entry = batchPayload(result).results[0];
    expect(entry.valid).toBe(false);
    expect(entry.errors).toHaveLength(1);
    expect(String(entry.errors[0].message)).toMatch(/could not be attributed.*see warnings/);
  });

  it('diagnostics that belong to no target lead the batch payload as warnings', async () => {
    // A script attached inside the validated scene has a parse error. The scene
    // itself loads, so its target stays valid, but the diagnostic must not be lost.
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [
          { target: 'main.tscn', resolvedPath: 'res://main.tscn', valid: true, errors: [] },
        ],
      }),
      stderr: [
        'SCRIPT ERROR: Parse Error: Expected parameter name.',
        '   at: GDScript::reload (res://scripts/attached.gd:7)',
        'Parse Error: Unexpected token at line 5',
      ].join('\n'),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: 'main.tscn' }],
    });
    expect(hasError(result)).toBe(false);
    const payload = expectMatchesOutputSchema('validate', result);
    expect(Object.keys(payload)[0]).toBe('warnings');
    expect(payload.warnings).toEqual([
      'res://scripts/attached.gd:7: Expected parameter name.',
      'Unexpected token',
    ]);
    expect(batchPayload(result).results[0].valid).toBe(true);
  });

  it('caps the unattributed diagnostics and counts the rest', async () => {
    const total = 12;
    const stderr = Array.from(
      { length: total },
      (_, i) =>
        `SCRIPT ERROR: Parse Error: problem ${i}\n   at: GDScript::reload (res://other.gd:${i + 1})`,
    ).join('\n');
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'ok.gd', resolvedPath: 'res://ok.gd', valid: true, errors: [] }],
      }),
      stderr,
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scriptPath: 'ok.gd' }],
    });
    const warnings = batchPayload(result).warnings ?? [];
    expect(warnings).toHaveLength(11);
    expect(warnings[0]).toBe('res://other.gd:1: problem 0');
    expect(warnings[10]).toBe('+2 more');
  });
});

// ---------------------------------------------------------------------------
// handleValidate: shapes the checks[] array must have
// ---------------------------------------------------------------------------

describe('handleValidate check shapes', () => {
  it("a batch target whose checks is an object is that target's error", async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [{ scenePath: fixtureScenePath, checks: { type: 'signals' } }],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const entry = batchPayload(result).results[0];
    expect(entry.valid).toBe(false);
    expect(String(entry.errors[0].message)).toMatch(/Invalid checks: must be an array/);
  });

  it('an unknown key in a structure schema is rejected', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'structure', schema: { type: 'Node2D', hasPropery: 'shape' } }],
    });
    expectErrorMatching(result, /Invalid schema at schema: unknown key "hasPropery"/);
    expect(fake.calls).toHaveLength(0);
  });

  it('an unknown key in a nested schema node is rejected with its breadcrumb', async () => {
    const fake = createFakeRunner();
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [
        {
          scenePath: fixtureScenePath,
          checks: [
            {
              type: 'structure',
              schema: { type: 'Node2D', children: [{ type: 'Sprite2D', child: [] }] },
            },
          ],
        },
      ],
    });
    const entry = batchPayload(result).results[0];
    expect(entry.valid).toBe(false);
    expect(String(entry.errors[0].message)).toMatch(/schema\.children\[0\]: unknown key "child"/);
    expect(fake.calls).toHaveLength(0);
  });

  it('has_property is accepted as the snake_case spelling', async () => {
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [{ target: 'main.tscn', valid: true, errors: [], checkErrors: [] }],
      }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: 'main.tscn',
      checks: [
        {
          type: 'structure',
          schema: { type: 'Node2D', children: [{ has_property: 'texture' }] },
        },
      ],
    });
    expect(hasError(result)).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it('an unknown key on a check item is rejected', async () => {
    const fake = createFakeRunner();
    const signals = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'signals', nodepath: 'root/HUD' }],
    });
    expectErrorMatching(signals, /unknown key "nodepath" on a signals check/);
    const structure = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      scenePath: fixtureScenePath,
      checks: [{ type: 'structure', schema: { type: 'Node2D' }, nodePath: 'root' }],
    });
    expectErrorMatching(structure, /unknown key "nodePath" on a structure check/);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Path spellings: res://, absolute-inside
// ---------------------------------------------------------------------------

describe('validate accepts every project path spelling', () => {
  const absolute = (p: string) => join(projectCopyPath, p);

  it.each([
    ['res://', (p: string) => `res://${p}`],
    ['absolute', absolute],
  ] as const)('single scriptPath and scenePath as %s are forwarded relative', async (_l, spell) => {
    const script = createFakeRunner({ stdout: JSON.stringify({ valid: true, errors: [] }) });
    await handleValidate(script.asRunner, {
      projectPath: projectCopyPath,
      scriptPath: spell('placeholder.gd'),
    });
    expect(script.calls[0]?.params).toEqual({ scriptPath: 'placeholder.gd' });

    const scene = createFakeRunner({ stdout: JSON.stringify({ valid: true, errors: [] }) });
    await handleValidate(scene.asRunner, {
      projectPath: projectCopyPath,
      scenePath: spell(fixtureScenePath),
    });
    expect(scene.calls[0]?.params).toEqual({ scenePath: fixtureScenePath });
  });

  it('batch targets are forwarded relative, whatever the caller spelling', async () => {
    const fake = createFakeRunner({ stdout: JSON.stringify({ results: [] }) });
    await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [
        { scriptPath: 'res://placeholder.gd' },
        { scriptPath: '.\\placeholder.gd' },
        { scriptPath: absolute('placeholder.gd') },
        { scenePath: absolute(fixtureScenePath) },
      ],
    });
    expect(fake.calls[0]?.params).toEqual({
      targets: [
        { script_path: 'placeholder.gd' },
        { script_path: 'placeholder.gd' },
        { script_path: 'placeholder.gd' },
        { scene_path: fixtureScenePath },
      ],
    });
  });

  it('a batch result reports the caller spelling, and the relative path for an absolute one', async () => {
    const answer = (target: string) => ({ target, valid: true, errors: [], checkErrors: [] });
    const fake = createFakeRunner({
      stdout: JSON.stringify({
        results: [answer('placeholder.gd'), answer('placeholder.gd'), answer(fixtureScenePath)],
      }),
    });
    const result = await handleValidate(fake.asRunner, {
      projectPath: projectCopyPath,
      targets: [
        { scriptPath: 'res://placeholder.gd' },
        { scriptPath: absolute('placeholder.gd') },
        { scenePath: `./${fixtureScenePath}` },
      ],
    });
    const payload = JSON.parse(unwrap(result).content[0]!.text) as {
      results: Array<{ target: string }>;
    };
    expect(payload.results.map((r) => r.target)).toEqual([
      'res://placeholder.gd',
      'placeholder.gd',
      `./${fixtureScenePath}`,
    ]);
  });
});
