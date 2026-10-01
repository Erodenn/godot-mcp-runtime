/**
 * Unit test for `normalizeProjectKey`, the pure helper that collapses
 * case-differing Windows paths into the same `runProjectConfirmed` session
 * key. Tested directly (rather than through handleRunProject) to avoid
 * platform-gated flakiness in the handler-level session-gate tests.
 *
 * The function branches on `process.platform`, which vitest cannot safely
 * override mid-run: so the assertion only runs on win32 and is a no-op
 * (via `it.runIf`) everywhere else.
 */

import { describe, it, expect } from 'vitest';
import {
  describeIgnoredFlagValues,
  normalizeProjectKey,
  resolveDisableSecurity,
} from '../../src/utils/mcp-context.js';

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

describe('describeIgnoredFlagValues', () => {
  it('reports a strict flag set to 1 as ignored', () => {
    expect(describeIgnoredFlagValues({ GODOT_MCP_STRICT: '1' })).toEqual([
      '[SERVER] GODOT_MCP_STRICT="1" is not "true" and was ignored: strict mode is OFF',
    ]);
  });

  it('reports nothing for true, false, empty and unset', () => {
    expect(describeIgnoredFlagValues({})).toEqual([]);
    for (const value of ['true', 'false', '', undefined]) {
      expect(
        describeIgnoredFlagValues({
          GODOT_MCP_STRICT: value,
          GODOT_MCP_DISABLE_ELICITATION: value,
          GODOT_MCP_DISABLE_SECURITY: value,
        }),
      ).toEqual([]);
    }
  });

  it('names each of the three flags', () => {
    const lines = describeIgnoredFlagValues({
      GODOT_MCP_STRICT: 'yes',
      GODOT_MCP_DISABLE_ELICITATION: 'TRUE',
      GODOT_MCP_DISABLE_SECURITY: ' true',
    });
    expect(lines).toEqual([
      '[SERVER] GODOT_MCP_STRICT="yes" is not "true" and was ignored: strict mode is OFF',
      '[SERVER] GODOT_MCP_DISABLE_ELICITATION="TRUE" is not "true" and was ignored: confirmation prompts stay ON',
      '[SERVER] GODOT_MCP_DISABLE_SECURITY=" true" is not "true" and was ignored: the security gate stays ON',
    ]);
  });
});
