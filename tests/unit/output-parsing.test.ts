import { describe, it, expect } from 'vitest';
import {
  cleanStdout,
  condenseProcessTail,
  extractOperationPayload,
  extractTokenFramedPayload,
  newOperationResultToken,
  normalizeExitCode,
  OPERATION_RESULT_SENTINEL,
  OPERATION_RESULT_TOKEN_END,
  stripOperationSentinel,
} from '../../src/utils/output-parsing.js';

/** The token one run was handed, and another run's. */
const RUN_TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210';
/** The start of a result line as godot_operations.gd writes it for a run holding `token`. */
const framed = (token: string): string =>
  `${OPERATION_RESULT_SENTINEL}${token}${OPERATION_RESULT_TOKEN_END}`;

// RID-leak warnings land on stdout after a payload (benign) or instead of one when quit(1) fires first (masks the error).
describe('stdout payload extraction with interleaved engine noise', () => {
  const payload = { results: [{ ok: true }] };
  const payloadLine = `${OPERATION_RESULT_SENTINEL}${JSON.stringify(payload)}`;
  const framedPayloadLine = `${framed(RUN_TOKEN)}${JSON.stringify(payload)}`;

  const noisyShapes: Array<[string, (line: string) => string]> = [
    ['banner and payload', (line) => `Godot Engine v4.7.2\n${line}\n`],
    ['a trailing bracketed line', (line) => `Godot Engine v4.7.2\n${line}\n[Audio] shutdown\n`],
    ['a leading bracketed line', (line) => `Godot Engine v4.7.2\n[Autoload] ready\n${line}\n`],
    [
      'a printed dictionary on each side',
      (line) => `Godot Engine v4.7.2\n{"before": 1}\n${line}\n{"after": 2}\n`,
    ],
    ['a JSON-looking array after the payload', (line) => `${line}\n[1, 2]\n`],
    [
      'RID-leak warnings after the payload',
      (line) => `${line}\nERROR: 5 RIDs of type "CanvasTexture" were leaked at exit.\n`,
    ],
  ];

  for (const [label, around] of noisyShapes) {
    it(`extractOperationPayload returns exactly the payload with ${label}`, () => {
      expect(JSON.parse(extractOperationPayload(around(payloadLine)) ?? '')).toEqual(payload);
    });

    it(`cleanStdout keeps a payload that extracts identically with ${label}`, () => {
      const cleaned = cleanStdout(around(framedPayloadLine), RUN_TOKEN);
      expect(cleaned).toBe(payloadLine);
      expect(JSON.parse(extractOperationPayload(cleaned) ?? '')).toEqual(payload);
    });
  }

  it('lets the last sentinel line win when several are present', () => {
    const stdout = `${OPERATION_RESULT_SENTINEL}{"n": 1}\n${OPERATION_RESULT_SENTINEL}{"n": 2}\n`;
    expect(extractOperationPayload(stdout)).toBe('{"n": 2}');
  });

  // A payload can quote the sentinel (a Label's text, a node name echoed in a warning):
  // reading from the last occurrence would start inside it and report invalid JSON.
  it('reads the whole payload when the payload itself quotes the sentinel', () => {
    const quoting = {
      results: [{ nodePath: 'root/Label', properties: { text: `${OPERATION_RESULT_SENTINEL}x` } }],
    };
    const stdout = `Godot Engine v4.7.2\n${OPERATION_RESULT_SENTINEL}${JSON.stringify(quoting)}\n`;
    expect(JSON.parse(extractOperationPayload(stdout) ?? '')).toEqual(quoting);
    const raw = `Godot Engine v4.7.2\n${framed(RUN_TOKEN)}${JSON.stringify(quoting)}\n`;
    expect(JSON.parse(extractOperationPayload(cleanStdout(raw, RUN_TOKEN)) ?? '')).toEqual(quoting);
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
    const cleaned = cleanStdout(stdout, RUN_TOKEN);
    // Early-exit classification belongs to executeSceneOp (headless-op.test.ts).
    expect(cleaned).toBe(stdout.trim());
    expect(extractOperationPayload(cleaned)).toBeNull();
  });
});

// Any project script can print the sentinel: an autoload's _exit_tree runs after the result and its _init before, so only the run's token identifies it.
describe('a result line is told from a forged one by the run token', () => {
  const real = { name: 'Main', children: [] };
  const forged = { results: [{ nodePath: 'forged', success: true }] };
  const realLine = `${framed(RUN_TOKEN)}${JSON.stringify(real)}`;
  const bareForgedLine = `${OPERATION_RESULT_SENTINEL}${JSON.stringify(forged)}`;
  const staleForgedLine = `${framed(OTHER_TOKEN)}${JSON.stringify(forged)}`;

  const placements: Array<[string, string]> = [
    ['a bare sentinel line after the result', `banner\n${realLine}\n${bareForgedLine}\n`],
    ['a bare sentinel line before the result', `banner\n${bareForgedLine}\n${realLine}\n`],
    ['a line framed with another token after it', `${realLine}\n${staleForgedLine}\n`],
    [
      'forged lines on both sides',
      `${bareForgedLine}\n${staleForgedLine}\n${realLine}\n${bareForgedLine}\n${staleForgedLine}\n`,
    ],
    ['Windows line endings', `banner\r\n${realLine}\r\n${bareForgedLine}\r\n`],
  ];

  for (const [label, stdout] of placements) {
    it(`reads the run's own payload with ${label}`, () => {
      expect(JSON.parse(extractTokenFramedPayload(stdout, RUN_TOKEN) ?? '')).toEqual(real);
      const cleaned = cleanStdout(stdout, RUN_TOKEN);
      expect(JSON.parse(extractOperationPayload(cleaned) ?? '')).toEqual(real);
      expect(cleaned).not.toContain('forged');
    });
  }

  it("finds no payload when the only sentinel lines carry no token or another run's", () => {
    const stdout = `banner\n${bareForgedLine}\n${staleForgedLine}\n`;
    expect(extractTokenFramedPayload(stdout, RUN_TOKEN)).toBeNull();
  });

  it('hands on no sentinel at all from a run that wrote no result of its own', () => {
    const cleaned = cleanStdout(`banner\n${bareForgedLine}\n${staleForgedLine}\n`, RUN_TOKEN);
    expect(cleaned).not.toContain(OPERATION_RESULT_SENTINEL);
    expect(extractOperationPayload(cleaned)).toBeNull();
    // The printed text itself is still passed on, as any other noise is.
    expect(cleaned).toContain(JSON.stringify(forged));
  });

  it('does not accept a token that only starts with the run token', () => {
    const longer = `${OPERATION_RESULT_SENTINEL}${RUN_TOKEN}ff${OPERATION_RESULT_TOKEN_END}{"n": 1}`;
    expect(extractTokenFramedPayload(`${longer}\n`, RUN_TOKEN)).toBeNull();
  });

  it('reads a payload that quotes its own frame', () => {
    const quoting = { text: `${framed(RUN_TOKEN)}{"n": 1}` };
    const stdout = `${framed(RUN_TOKEN)}${JSON.stringify(quoting)}\n`;
    expect(JSON.parse(extractTokenFramedPayload(stdout, RUN_TOKEN) ?? '')).toEqual(quoting);
  });

  it('draws a different token for every run, in characters that cannot end the frame early', () => {
    const drawn = new Set(Array.from({ length: 64 }, () => newOperationResultToken()));
    expect(drawn.size).toBe(64);
    for (const token of drawn) expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

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

// A force-killed process can report the unsigned 32-bit form of a negative signal-kill status.
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
