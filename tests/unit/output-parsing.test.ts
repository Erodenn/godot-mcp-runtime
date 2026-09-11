import { describe, it, expect } from 'vitest';
import {
  cleanStdout,
  condenseProcessTail,
  normalizeExitCode,
} from '../../src/utils/output-parsing.js';

// Observed in production: headless operations emit Godot RID-leak warnings on
// stdout, both AFTER a JSON payload (benign — handled) and INSTEAD of one,
// when the operation quit(1)s before emitting JSON (masks the real error).
describe('stdout JSON extraction with interleaved engine noise', () => {
  it('strips trailing RID-leak warnings after a JSON payload', () => {
    const noisy =
      '{"results": [{"ok": true}]}\nERROR: 5 RIDs of type "CanvasTexture" were leaked at exit.\n';
    const cleaned = cleanStdout(noisy);
    expect(JSON.parse(cleaned)).toEqual({ results: [{ ok: true }] });
  });

  it('strips leading noise before a JSON payload', () => {
    const noisy = 'Godot Engine v4.7.2\nWARNING: something\n{"signals": []}\n';
    const cleaned = cleanStdout(noisy);
    expect(() => JSON.parse(cleaned)).not.toThrow();
  });

  it('passes RID-only stdout through unchanged (no JSON to extract)', () => {
    const stdout = "ERROR: 5 RID allocations of type 'P11GodotBody2D' were leaked at exit.\n";
    const cleaned = cleanStdout(stdout);
    // cleanStdout passes the noise through (nothing to extract); classifying
    // this as an early exit rather than a JSON-format bug is
    // executeSceneOp's responsibility (stdoutLooksLikeEarlyQuitNoise),
    // covered in headless-op.test.ts.
    expect(cleaned).toBe(stdout.trim());
    expect(() => JSON.parse(cleaned)).toThrow(SyntaxError);
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
