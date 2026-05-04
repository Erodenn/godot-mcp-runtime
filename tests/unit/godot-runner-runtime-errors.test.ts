/**
 * Direct tests for the runtime-error extraction primitives on GodotRunner:
 * `extractRuntimeErrors` and `getErrorsSince`.
 *
 * Both feed the runtime-error warning channel for take_screenshot,
 * simulate_input, get_ui_elements, and the false-positive escalation in
 * run_script. If SCRIPT_ERROR_PATTERNS drifts (case mismatch with actual
 * Godot 4.x stderr lines) all four handlers silently lose their warning
 * channel — `runtimeErrors.length > 0` is then always false.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import type { GodotProcess } from '../../src/utils/godot-runner.js';

function makeFakeProcess(opts: { errors?: string[]; totalErrorsWritten?: number }): GodotProcess {
  const errors = opts.errors ?? [];
  return {
    // ChildProcess is not used by these methods; cast is intentional.
    process: undefined as unknown as GodotProcess['process'],
    output: [],
    errors,
    totalErrorsWritten: opts.totalErrorsWritten ?? errors.length,
    exitCode: null,
    hasExited: false,
    sessionToken: 'fake-token',
  };
}

describe('GodotRunner.extractRuntimeErrors', () => {
  let runner: GodotRunner;
  beforeEach(() => {
    runner = new GodotRunner();
  });

  it('matches the SCRIPT ERROR: pattern', () => {
    const lines = ['SCRIPT ERROR: Invalid call to function "foo"', 'normal log line'];
    expect(runner.extractRuntimeErrors(lines)).toEqual([
      'SCRIPT ERROR: Invalid call to function "foo"',
    ]);
  });

  it('matches the USER SCRIPT ERROR: pattern', () => {
    const lines = ['USER SCRIPT ERROR: assertion failed', 'unrelated'];
    expect(runner.extractRuntimeErrors(lines)).toEqual(['USER SCRIPT ERROR: assertion failed']);
  });

  it('matches the GDScript error substring (no colon)', () => {
    const lines = ['Parse Error: GDScript error at line 5', 'noise'];
    expect(runner.extractRuntimeErrors(lines)).toEqual(['Parse Error: GDScript error at line 5']);
  });

  it('returns matches in input order, preserving duplicates', () => {
    const lines = ['SCRIPT ERROR: a', 'between', 'SCRIPT ERROR: b', 'GDScript error trailing'];
    expect(runner.extractRuntimeErrors(lines)).toEqual([
      'SCRIPT ERROR: a',
      'SCRIPT ERROR: b',
      'GDScript error trailing',
    ]);
  });

  it('is case-sensitive — lowercase variants are filtered out', () => {
    // Documents current behavior. If Godot ever emits lowercase variants the
    // caller's warning channel will silently miss them; this test will need
    // updating alongside the patterns.
    const lines = ['script error: lower', 'gdscript error lower', 'SCRIPT ERROR: kept'];
    expect(runner.extractRuntimeErrors(lines)).toEqual(['SCRIPT ERROR: kept']);
  });

  it('returns [] when no line matches', () => {
    expect(runner.extractRuntimeErrors(['a', 'b', ''])).toEqual([]);
  });

  it('returns [] for an empty input array', () => {
    expect(runner.extractRuntimeErrors([])).toEqual([]);
  });
});

describe('GodotRunner.getErrorsSince', () => {
  let runner: GodotRunner;
  beforeEach(() => {
    runner = new GodotRunner();
  });

  it('returns [] when there is no active process', () => {
    expect(runner.getErrorsSince(0)).toEqual([]);
  });

  it('returns [] when no new errors arrived since the marker', () => {
    runner.activeProcess = makeFakeProcess({
      errors: ['old1', 'old2'],
      totalErrorsWritten: 2,
    });
    expect(runner.getErrorsSince(2)).toEqual([]);
    expect(runner.getErrorsSince(5)).toEqual([]); // marker > total → still []
  });

  it('returns the tail slice corresponding to the new errors', () => {
    runner.activeProcess = makeFakeProcess({
      errors: ['e1', 'e2', 'e3', 'e4'],
      totalErrorsWritten: 4,
    });
    // Marker captured before e3 + e4 arrived.
    expect(runner.getErrorsSince(2)).toEqual(['e3', 'e4']);
  });

  it('returns the full window when delta exceeds the captured ring (post-truncation)', () => {
    // Simulates: ring buffer was trimmed (errors.length=3) but totalErrorsWritten=8.
    // Marker=4 → delta=4 > errors.length=3 → return full slice.
    runner.activeProcess = makeFakeProcess({
      errors: ['e6', 'e7', 'e8'],
      totalErrorsWritten: 8,
    });
    expect(runner.getErrorsSince(4)).toEqual(['e6', 'e7', 'e8']);
  });

  it('filters blank lines from the result window', () => {
    runner.activeProcess = makeFakeProcess({
      errors: ['e1', '', 'e2', '   ', 'e3'],
      totalErrorsWritten: 5,
    });
    expect(runner.getErrorsSince(0)).toEqual(['e1', 'e2', 'e3']);
  });
});
