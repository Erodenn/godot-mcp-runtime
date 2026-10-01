import { describe, it, expect } from 'vitest';
import {
  cleanStdout,
  condenseProcessTail,
  extractOperationPayload,
  normalizeExitCode,
  OPERATION_RESULT_SENTINEL,
  stripOperationSentinel,
} from '../../src/utils/output-parsing.js';

// Observed in production: headless operations emit Godot RID-leak warnings on
// stdout, both AFTER a JSON payload (benign: handled) and INSTEAD of one,
// when the operation quit(1)s before emitting JSON (masks the real error).
describe('stdout payload extraction with interleaved engine noise', () => {
  const payload = { results: [{ ok: true }] };
  const payloadLine = `${OPERATION_RESULT_SENTINEL}${JSON.stringify(payload)}`;

  const noisyShapes: Array<[string, string]> = [
    ['banner and payload', `Godot Engine v4.7.2\n${payloadLine}\n`],
    ['a trailing bracketed line', `Godot Engine v4.7.2\n${payloadLine}\n[Audio] shutdown\n`],
    ['a leading bracketed line', `Godot Engine v4.7.2\n[Autoload] ready\n${payloadLine}\n`],
    [
      'a printed dictionary on each side',
      `Godot Engine v4.7.2\n{"before": 1}\n${payloadLine}\n{"after": 2}\n`,
    ],
    ['a JSON-looking array after the payload', `${payloadLine}\n[1, 2]\n`],
    [
      'RID-leak warnings after the payload',
      `${payloadLine}\nERROR: 5 RIDs of type "CanvasTexture" were leaked at exit.\n`,
    ],
  ];

  for (const [label, stdout] of noisyShapes) {
    it(`extractOperationPayload returns exactly the payload with ${label}`, () => {
      expect(JSON.parse(extractOperationPayload(stdout) ?? '')).toEqual(payload);
    });

    it(`cleanStdout keeps a payload that extracts identically with ${label}`, () => {
      expect(JSON.parse(extractOperationPayload(cleanStdout(stdout)) ?? '')).toEqual(payload);
    });
  }

  it('lets the last sentinel line win when several are present', () => {
    const stdout = `${OPERATION_RESULT_SENTINEL}{"n": 1}\n${OPERATION_RESULT_SENTINEL}{"n": 2}\n`;
    expect(extractOperationPayload(stdout)).toBe('{"n": 2}');
  });

  // The emitter writes the sentinel once, at the start of the payload. A
  // payload can still quote it: a Label whose text mentions it, a requested
  // node name echoed in a warning. Reading from the last occurrence starts
  // inside that string and reports a finished operation as invalid JSON.
  it('reads the whole payload when the payload itself quotes the sentinel', () => {
    const quoting = {
      results: [{ nodePath: 'root/Label', properties: { text: `${OPERATION_RESULT_SENTINEL}x` } }],
    };
    const stdout = `Godot Engine v4.7.2\n${OPERATION_RESULT_SENTINEL}${JSON.stringify(quoting)}\n`;
    expect(JSON.parse(extractOperationPayload(stdout) ?? '')).toEqual(quoting);
    expect(JSON.parse(extractOperationPayload(cleanStdout(stdout)) ?? '')).toEqual(quoting);
  });

  it('skips sentinel text left in front of the payload by an unterminated print', () => {
    const stdout = `noise ${OPERATION_RESULT_SENTINEL} not json ${payloadLine}\n`;
    expect(JSON.parse(extractOperationPayload(stdout) ?? '')).toEqual(payload);
  });

  it('returns the text after the first sentinel when nothing on the line parses', () => {
    const stdout = `${OPERATION_RESULT_SENTINEL}{"a": ${OPERATION_RESULT_SENTINEL} tru`;
    expect(extractOperationPayload(stdout)).toBe(`{"a": ${OPERATION_RESULT_SENTINEL} tru`);
  });

  it('returns null, never a fallback parse, when no line carries the sentinel', () => {
    expect(extractOperationPayload('Godot Engine v4.7.2\n[Audio] ready\n{"a": 1}\n')).toBeNull();
    expect(extractOperationPayload('{"bare": "json"}')).toBeNull();
  });

  it('strips the sentinel from text bound for a user', () => {
    expect(stripOperationSentinel(`${OPERATION_RESULT_SENTINEL}{"a": 1}`)).toBe('{"a": 1}');
  });

  it('passes RID-only stdout through unchanged (no payload to extract)', () => {
    const stdout = "ERROR: 5 RID allocations of type 'P11GodotBody2D' were leaked at exit.\n";
    const cleaned = cleanStdout(stdout);
    // Classifying this as an early exit rather than a JSON-format bug is
    // executeSceneOp's responsibility, covered in headless-op.test.ts.
    expect(cleaned).toBe(stdout.trim());
    expect(extractOperationPayload(cleaned)).toBeNull();
  });
});

// ─── condenseProcessTail ────────────────────────────────────────────────────

describe('condenseProcessTail', () => {
  it('drops the renderer/device startup banner', () => {
    const lines = [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      'Metal 4.0 - Forward+ - Using Device #1: Apple M3 Pro',
      'PASS: scenario complete',
    ];
    expect(condenseProcessTail(lines, 200)).toEqual(['PASS: scenario complete']);
  });

  it('keeps a genuine WARNING: line', () => {
    const lines = ['WARNING: Node not found: "res://missing.tscn"', 'PASS: scenario complete'];
    expect(condenseProcessTail(lines, 200)).toEqual(lines);
  });

  it('keeps a renderer-name line that is not the startup banner', () => {
    const lines = ['OpenGL context lost', 'PASS: scenario complete'];
    expect(condenseProcessTail(lines, 200)).toEqual(lines);
  });

  it('caps the result to maxLines, keeping the tail', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
    expect(condenseProcessTail(lines, 3)).toEqual(['line2', 'line3', 'line4']);
  });

  it('falls back to the last non-empty original line when everything is filtered', () => {
    const lines = [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      '',
      'Vulkan 1.3.280 - Forward+ - Using Device #0: NVIDIA GeForce RTX 4070',
    ];
    expect(condenseProcessTail(lines, 200)).toEqual([
      'Vulkan 1.3.280 - Forward+ - Using Device #0: NVIDIA GeForce RTX 4070',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(condenseProcessTail([], 200)).toEqual([]);
  });
});

// A force-killed process can report its exit code as the unsigned 32-bit
// representation of a negative signal-kill status. See CLAUDE.md / plan A5.
describe('normalizeExitCode', () => {
  it('normalizes the unsigned 32-bit representation of -1 to -1', () => {
    expect(normalizeExitCode(4294967295)).toBe(-1);
  });

  it('leaves 0 unchanged', () => {
    expect(normalizeExitCode(0)).toBe(0);
  });

  it('leaves 1 unchanged', () => {
    expect(normalizeExitCode(1)).toBe(1);
  });

  it('passes null through unchanged', () => {
    expect(normalizeExitCode(null)).toBe(null);
  });

  it('leaves a normal small exit code unchanged', () => {
    expect(normalizeExitCode(255)).toBe(255);
  });
});
