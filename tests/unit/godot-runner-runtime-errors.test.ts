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
import { ACTION_BOUNDARY_SENTINEL } from '../../src/utils/bridge-protocol.js';

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

  it('does not match bare "GDScript error" substring (avoids false positives on user printerr)', () => {
    const lines = ['Parse Error: GDScript error at line 5', 'noise'];
    expect(runner.extractRuntimeErrors(lines)).toEqual([]);
  });

  it('returns matches in input order, preserving duplicates', () => {
    const lines = ['SCRIPT ERROR: a', 'between', 'SCRIPT ERROR: b', 'USER SCRIPT ERROR: trailing'];
    expect(runner.extractRuntimeErrors(lines)).toEqual([
      'SCRIPT ERROR: a',
      'SCRIPT ERROR: b',
      'USER SCRIPT ERROR: trailing',
    ]);
  });

  it('is case-sensitive — lowercase variants are filtered out', () => {
    // Documents current behavior. If Godot ever emits lowercase variants the
    // caller's warning channel will silently miss them; this test will need
    // updating alongside the patterns.
    const lines = ['script error: lower', 'user script error: lower', 'SCRIPT ERROR: kept'];
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

// ---------------------------------------------------------------------------
// Sentinel-aware stderr ingestion and per-action error attribution
// ---------------------------------------------------------------------------

describe('GodotRunner.ingestStderrChunk', () => {
  let runner: GodotRunner;
  beforeEach(() => {
    runner = new GodotRunner();
  });

  it('keeps sentinel lines out of proc.errors and counts only retained lines', () => {
    // proc.errors is the single buffer behind get_debug_output AND
    // stop_project's finalErrors, so keeping sentinels out of it here is what
    // keeps both of those clean - no per-read filter exists or is needed.
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(
      proc,
      ['SCRIPT ERROR: boom', `${ACTION_BOUNDARY_SENTINEL} 0`, 'after'].join('\n'),
    );
    expect(proc.errors).toEqual(['SCRIPT ERROR: boom', 'after']);
    expect(proc.totalErrorsWritten).toBe(2);
    expect(proc.errors.some((line) => line.includes(ACTION_BOUNDARY_SENTINEL))).toBe(false);
  });

  it('records boundary marks whose seq is the retained-line count before each sentinel', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(
      proc,
      [
        'a',
        `${ACTION_BOUNDARY_SENTINEL} 0`,
        'b',
        'c',
        `${ACTION_BOUNDARY_SENTINEL} 1`,
        `${ACTION_BOUNDARY_SENTINEL} 2`,
      ].join('\n'),
    );
    expect(proc.actionBoundaries).toEqual([
      { index: 0, seq: 1 },
      { index: 1, seq: 3 },
      { index: 2, seq: 3 },
    ]);
    expect(proc.totalErrorsWritten).toBe(3);
  });
});

describe('GodotRunner.collectActionErrors', () => {
  const FAST_DRAIN_MS = 5;
  let runner: GodotRunner;
  beforeEach(() => {
    runner = new GodotRunner();
  });

  it('buckets SCRIPT ERROR lines onto the right entry and drops non-matching lines', async () => {
    runner.activeProcess = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    const capture = runner.beginActionErrorCapture();
    runner.ingestStderrChunk(
      runner.activeProcess,
      [
        'plain log line',
        `${ACTION_BOUNDARY_SENTINEL} 0`,
        'SCRIPT ERROR: from action 1',
        'noise',
        `${ACTION_BOUNDARY_SENTINEL} 1`,
      ].join('\n'),
    );
    const collected = await runner.collectActionErrors(capture, 2, FAST_DRAIN_MS);
    expect(collected.buckets).toEqual([[], ['SCRIPT ERROR: from action 1']]);
    expect(collected.trailing).toEqual([]);
    expect(collected.sentinelTimedOut).toBe(false);
  });

  it('reports sentinelTimedOut and attributes what is present when a sentinel never arrives', async () => {
    runner.activeProcess = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    const capture = runner.beginActionErrorCapture();
    runner.ingestStderrChunk(
      runner.activeProcess,
      [
        'SCRIPT ERROR: from action 0',
        `${ACTION_BOUNDARY_SENTINEL} 0`,
        'SCRIPT ERROR: after the last mark',
      ].join('\n'),
    );
    const collected = await runner.collectActionErrors(capture, 2, FAST_DRAIN_MS);
    expect(collected.sentinelTimedOut).toBe(true);
    expect(collected.buckets[0]).toEqual(['SCRIPT ERROR: from action 0']);
    expect(collected.buckets[1]).toEqual([]);
    expect(collected.trailing).toEqual(['SCRIPT ERROR: after the last mark']);
  });

  it('returns empty buckets immediately when there is no active process (attached mode)', async () => {
    const capture = runner.beginActionErrorCapture();
    const started = Date.now();
    const collected = await runner.collectActionErrors(capture, 3);
    expect(collected.buckets).toEqual([[], [], []]);
    expect(collected.trailing).toEqual([]);
    expect(collected.sentinelTimedOut).toBe(false);
    // No wait at all: it must not burn the default drain timeout.
    expect(Date.now() - started).toBeLessThan(100);
  });
});
