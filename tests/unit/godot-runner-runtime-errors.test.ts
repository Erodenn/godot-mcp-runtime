/**
 * Direct tests for the runtime-error extraction primitives on GodotRunner:
 * `extractRuntimeErrors` and `getErrorsSince`.
 *
 * Both feed the runtime-error warning channel for take_screenshot,
 * simulate_input, get_ui_elements, and the false-positive escalation in
 * run_script. If SCRIPT_ERROR_PATTERNS drifts (case mismatch with actual
 * Godot 4.x stderr lines) all four handlers silently lose their warning
 * channel: `runtimeErrors.length > 0` is then always false.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import type { GodotProcess } from '../../src/utils/godot-runner.js';
import { ACTION_BOUNDARY_SENTINEL } from '../../src/utils/bridge-protocol.js';
import { MAX_PENDING_LINE_CHARS, truncatedLineMarker } from '../../src/utils/child-output.js';
import { installSession } from '../helpers/session-install.js';

/** Actions in a batch whose only stderr output is their boundary lines. */
const BOUNDARY_ONLY_ACTIONS = 3;
/** A newline-free stream, delivered in chunks that together pass the pending cap several times. */
const NEWLINE_FREE_CHUNK_CHARS = 4096;
const NEWLINE_FREE_CHUNKS = (MAX_PENDING_LINE_CHARS / NEWLINE_FREE_CHUNK_CHARS) * 3;

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

  it('is case-sensitive: lowercase variants are filtered out', () => {
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
    const proc = makeFakeProcess({
      errors: ['old1', 'old2'],
      totalErrorsWritten: 2,
    });
    installSession(runner, { process: proc });
    expect(runner.getErrorsSince(2)).toEqual([]);
    expect(runner.getErrorsSince(5)).toEqual([]); // marker > total → still []
  });

  it('returns the tail slice corresponding to the new errors', () => {
    const proc = makeFakeProcess({
      errors: ['e1', 'e2', 'e3', 'e4'],
      totalErrorsWritten: 4,
    });
    installSession(runner, { process: proc });
    // Marker captured before e3 + e4 arrived.
    expect(runner.getErrorsSince(2)).toEqual(['e3', 'e4']);
  });

  it('returns the full window when delta exceeds the captured ring (post-truncation)', () => {
    // Simulates: ring buffer was trimmed (errors.length=3) but totalErrorsWritten=8.
    // Marker=4 → delta=4 > errors.length=3 → return full slice.
    const proc = makeFakeProcess({
      errors: ['e6', 'e7', 'e8'],
      totalErrorsWritten: 8,
    });
    installSession(runner, { process: proc });
    expect(runner.getErrorsSince(4)).toEqual(['e6', 'e7', 'e8']);
  });

  it('filters blank lines from the result window', () => {
    const proc = makeFakeProcess({
      errors: ['e1', '', 'e2', '   ', 'e3'],
      totalErrorsWritten: 5,
    });
    installSession(runner, { process: proc });
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
      ['SCRIPT ERROR: boom', `${ACTION_BOUNDARY_SENTINEL} 0`, 'after', ''].join('\n'),
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
        '',
      ].join('\n'),
    );
    expect(proc.actionBoundaries).toEqual([
      { index: 0, seq: 1 },
      { index: 1, seq: 3 },
      { index: 2, seq: 3 },
    ]);
    expect(proc.totalErrorsWritten).toBe(3);
  });

  it('rejoins a stderr line split across two chunks into one retained line', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'SCRIPT ERROR: bo');
    runner.ingestStderrChunk(proc, 'om on line 4\n');
    expect(proc.errors).toEqual(['SCRIPT ERROR: boom on line 4']);
    expect(proc.totalErrorsWritten).toBe(1);
  });

  it('recognizes an action-boundary sentinel split across two chunks', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, `a\n${ACTION_BOUNDARY_SENTINEL} `);
    runner.ingestStderrChunk(proc, '0\nb\n');
    expect(proc.actionBoundaries).toEqual([{ index: 0, seq: 1 }]);
    expect(proc.errors).toEqual(['a', 'b']);
    expect(proc.errors.some((line) => line.includes(ACTION_BOUNDARY_SENTINEL))).toBe(false);
  });

  it('keeps a chunk that ends in a newline intact across the next chunk', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'a\n');
    runner.ingestStderrChunk(proc, 'b\n');
    // The empty string after a final newline is not a line: nothing is
    // retained for it, and the next chunk starts a line of its own.
    expect(proc.errors).toEqual(['a', 'b']);
    expect(proc.totalErrorsWritten).toBe(2);
  });

  it('ignores an empty chunk and keeps holding the unfinished line', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'a');
    runner.ingestStderrChunk(proc, '');
    runner.ingestStderrChunk(proc, 'bc\n');
    expect(proc.errors).toEqual(['abc']);
  });

  it('retains no carriage return and no blank line from Windows line endings', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    // One line per chunk, the way a Windows pipe delivers them.
    runner.ingestStderrChunk(proc, 'first\r\n');
    runner.ingestStderrChunk(proc, '\r\n');
    runner.ingestStderrChunk(proc, 'second\r\nthird\r\n');
    expect(proc.errors).toEqual(['first', 'second', 'third']);
    expect(proc.totalErrorsWritten).toBe(3);
  });

  it('rejoins a line whose chunk boundary fell between the carriage return and the newline', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'SCRIPT ERROR: boom\r');
    // Not a line until its newline arrives.
    expect(proc.errors).toEqual([]);
    runner.ingestStderrChunk(proc, '\nnext\r\n');
    expect(proc.errors).toEqual(['SCRIPT ERROR: boom', 'next']);
    expect(proc.totalErrorsWritten).toBe(2);
  });

  it('leaves no empty entry where a boundary line was stripped', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    // Each printerr arrives as its own CRLF-terminated chunk.
    for (let action = 0; action < BOUNDARY_ONLY_ACTIONS; action += 1) {
      runner.ingestStderrChunk(proc, `${ACTION_BOUNDARY_SENTINEL} ${action}\r\n`);
    }
    runner.ingestStderrChunk(proc, 'SCRIPT ERROR: after the batch\r\n');
    expect(proc.errors).toEqual(['SCRIPT ERROR: after the batch']);
    expect(proc.actionBoundaries).toEqual([
      { index: 0, seq: 0 },
      { index: 1, seq: 0 },
      { index: 2, seq: 0 },
    ]);
  });

  it('classifies a boundary only once its line has ended, so a split index is read whole', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    // The first chunk ends in text that already reads as boundary 1. It is the
    // front of boundary 12: recording it at once would mark the wrong action
    // and leave a stray line "2" in the log.
    runner.ingestStderrChunk(proc, `a\n${ACTION_BOUNDARY_SENTINEL} 1`);
    expect(proc.actionBoundaries ?? []).toEqual([]);
    runner.ingestStderrChunk(proc, '2\nb\n');
    expect(proc.actionBoundaries).toEqual([{ index: 12, seq: 1 }]);
    expect(proc.errors).toEqual(['a', 'b']);
    expect(proc.totalErrorsWritten).toBe(2);
  });

  it('holds the text after the last newline out of the log until its line ends', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'whole\nhalf a ');
    expect(proc.errors).toEqual(['whole']);
    expect(proc.totalErrorsWritten).toBe(1);
    runner.ingestStderrChunk(proc, 'line\n');
    expect(proc.errors).toEqual(['whole', 'half a line']);
    expect(proc.totalErrorsWritten).toBe(2);
  });

  it('retains the line the stream ended in the middle of when the stream finishes', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, 'a\nlast words');
    runner.finishStderr(proc);
    expect(proc.errors).toEqual(['a', 'last words']);
    expect(proc.totalErrorsWritten).toBe(2);
    // Finishing twice adds nothing.
    runner.finishStderr(proc);
    expect(proc.errors).toEqual(['a', 'last words']);
  });

  it('records a boundary the stream ended on without a newline', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStderrChunk(proc, `a\n${ACTION_BOUNDARY_SENTINEL} 3`);
    runner.finishStderr(proc);
    expect(proc.actionBoundaries).toEqual([{ index: 3, seq: 1 }]);
    expect(proc.errors).toEqual(['a']);
  });

  it('cuts a line that never ends at the pending cap, once, and holds nothing more of it', () => {
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    const chunk = 'x'.repeat(NEWLINE_FREE_CHUNK_CHARS);
    for (let i = 0; i < NEWLINE_FREE_CHUNKS; i += 1) runner.ingestStderrChunk(proc, chunk);
    // One retained line: the cut head with its marker. The rest of the line
    // is dropped, not accumulated.
    const cutLine =
      'x'.repeat(MAX_PENDING_LINE_CHARS) + truncatedLineMarker(MAX_PENDING_LINE_CHARS);
    expect(proc.errors).toEqual([cutLine]);
    expect(proc.stderrLines?.pendingText).toBe('');
    // The newline that finally arrives ends the cut line; the next line is whole.
    runner.ingestStderrChunk(proc, 'tail\nnext\n');
    expect(proc.errors).toEqual([cutLine, 'next']);
  });
});

describe('GodotRunner.ingestStdoutChunk', () => {
  it('retains whole lines with no carriage return, no blank line and no split line', () => {
    const runner = new GodotRunner();
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStdoutChunk(proc, 'Godot Engine v4\r\n\r\nhalf a ');
    expect(proc.output).toEqual(['Godot Engine v4']);
    runner.ingestStdoutChunk(proc, 'line\r\nlast\r\n');
    expect(proc.output).toEqual(['Godot Engine v4', 'half a line', 'last']);
  });

  it('retains the line stdout ended in the middle of when the stream finishes', () => {
    const runner = new GodotRunner();
    const proc = makeFakeProcess({ errors: [], totalErrorsWritten: 0 });
    runner.ingestStdoutChunk(proc, 'done\nno newline at the end');
    runner.finishStdout(proc);
    expect(proc.output).toEqual(['done', 'no newline at the end']);
  });
});

describe('GodotRunner.collectActionErrors', () => {
  const FAST_DRAIN_MS = 5;
  let runner: GodotRunner;
  beforeEach(() => {
    runner = new GodotRunner();
  });

  it('buckets SCRIPT ERROR lines onto the right entry and drops non-matching lines', async () => {
    installSession(runner, { process: makeFakeProcess({ errors: [], totalErrorsWritten: 0 }) });
    const capture = runner.beginActionErrorCapture();
    runner.ingestStderrChunk(
      runner.activeProcess,
      [
        'plain log line',
        `${ACTION_BOUNDARY_SENTINEL} 0`,
        'SCRIPT ERROR: from action 1',
        'noise',
        `${ACTION_BOUNDARY_SENTINEL} 1`,
        '',
      ].join('\n'),
    );
    const collected = await runner.collectActionErrors(capture, 2, FAST_DRAIN_MS);
    expect(collected.buckets).toEqual([[], ['SCRIPT ERROR: from action 1']]);
    expect(collected.trailing).toEqual([]);
    expect(collected.sentinelTimedOut).toBe(false);
  });

  it('reports sentinelTimedOut and attributes what is present when a sentinel never arrives', async () => {
    installSession(runner, { process: makeFakeProcess({ errors: [], totalErrorsWritten: 0 }) });
    const capture = runner.beginActionErrorCapture();
    runner.ingestStderrChunk(
      runner.activeProcess,
      [
        'SCRIPT ERROR: from action 0',
        `${ACTION_BOUNDARY_SENTINEL} 0`,
        'SCRIPT ERROR: after the last mark',
        '',
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

  it('attributes errors to the right action when the sentinel is split', async () => {
    installSession(runner, { process: makeFakeProcess({ errors: [], totalErrorsWritten: 0 }) });
    const capture = runner.beginActionErrorCapture();
    // Same scenario as 'buckets SCRIPT ERROR lines onto the right entry', cut
    // into two chunks mid-sentinel.
    runner.ingestStderrChunk(runner.activeProcess, `plain log line\n${ACTION_BOUNDARY_SENTINEL} `);
    runner.ingestStderrChunk(
      runner.activeProcess,
      `0\nSCRIPT ERROR: from action 1\nnoise\n${ACTION_BOUNDARY_SENTINEL} 1\n`,
    );
    const collected = await runner.collectActionErrors(capture, 2, FAST_DRAIN_MS);
    expect(collected.buckets).toEqual([[], ['SCRIPT ERROR: from action 1']]);
    expect(collected.sentinelTimedOut).toBe(false);
  });

  it('still attributes each error to its action when lines end in CRLF and blank lines sit between them', async () => {
    installSession(runner, { process: makeFakeProcess({ errors: [], totalErrorsWritten: 0 }) });
    const capture = runner.beginActionErrorCapture();
    for (const chunk of [
      'SCRIPT ERROR: from action 0\r\n',
      '\r\n',
      `${ACTION_BOUNDARY_SENTINEL} 0\r\n`,
      `${ACTION_BOUNDARY_SENTINEL} 1\r\n`,
      '\r\n',
      'SCRIPT ERROR: from action 2\r\n',
      `${ACTION_BOUNDARY_SENTINEL} 2\r\n`,
    ]) {
      runner.ingestStderrChunk(runner.activeProcess, chunk);
    }
    const collected = await runner.collectActionErrors(capture, 3, FAST_DRAIN_MS);
    expect(collected.buckets).toEqual([
      ['SCRIPT ERROR: from action 0'],
      [],
      ['SCRIPT ERROR: from action 2'],
    ]);
    expect(collected.trailing).toEqual([]);
    expect(collected.sentinelTimedOut).toBe(false);
  });
});
