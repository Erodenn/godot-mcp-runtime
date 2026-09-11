import { describe, it, expect } from 'vitest';
import { cleanStdout } from '../../src/utils/output-parsing.js';

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
