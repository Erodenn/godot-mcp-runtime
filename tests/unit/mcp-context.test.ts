/**
 * Unit test for `normalizeProjectKey`, the pure helper that collapses
 * case-differing Windows paths into the same `runProjectConfirmed` session
 * key. Tested directly (rather than through handleRunProject) to avoid
 * platform-gated flakiness in the handler-level session-gate tests.
 *
 * The function branches on `process.platform`, which vitest cannot safely
 * override mid-run — so the assertion only runs on win32 and is a no-op
 * (via `it.runIf`) everywhere else.
 */

import { describe, it, expect } from 'vitest';
import { normalizeProjectKey, resolveDisableSecurity } from '../../src/utils/mcp-context.js';

describe('normalizeProjectKey', () => {
  it.runIf(process.platform === 'win32')(
    'lowercases the path on win32 so case-differing paths collapse to the same key',
    () => {
      expect(normalizeProjectKey('D:\\proj')).toBe(normalizeProjectKey('d:\\proj'));
    },
  );
});

describe('resolveDisableSecurity', () => {
  it('resolves false when GODOT_MCP_DISABLE_SECURITY is unset', () => {
    expect(resolveDisableSecurity(undefined, false)).toEqual({
      disableSecurity: false,
      strictIgnored: false,
    });
  });

  it('resolves true when set alone (strict off)', () => {
    expect(resolveDisableSecurity('true', false)).toEqual({
      disableSecurity: true,
      strictIgnored: false,
    });
  });

  it('resolves true and reports strict as ignored when set alongside strict mode', () => {
    expect(resolveDisableSecurity('true', true)).toEqual({
      disableSecurity: true,
      strictIgnored: true,
    });
  });

  it('leaves strict mode behavior unchanged when disable-security is unset (strict alone)', () => {
    expect(resolveDisableSecurity(undefined, true)).toEqual({
      disableSecurity: false,
      strictIgnored: false,
    });
  });
});
