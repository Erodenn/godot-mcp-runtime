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
  clientSupportsFormElicitation,
  createElicitor,
  ELICITATION_PROMPT_TIMEOUT_MS,
  ElicitationUnsupportedError,
  type ElicitationClient,
  describeIgnoredFlagValues,
  normalizeProjectKey,
  resolveDisableSecurity,
} from '../../src/utils/mcp-context.js';
import { CLIENT_REQUEST_TIMEOUT_MS } from '../../src/utils/godot-runner.js';

describe('normalizeProjectKey', () => {
  it.runIf(process.platform === 'win32')(
    'lowercases the path on win32 so case-differing paths collapse to the same key',
    () => {
      expect(normalizeProjectKey('D:\\proj')).toBe(normalizeProjectKey('d:\\proj'));
    },
  );
});

// Breaks when the predicate reads any declared `elicitation` object as promptable.
describe('clientSupportsFormElicitation', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ elicitation: {} }, true],
    [{ elicitation: { form: {} } }, true],
    [{ elicitation: { form: {}, url: {} } }, true],
    [{ elicitation: { url: {} } }, false],
  ])('%j -> %s', (capabilities, expected) => {
    expect(clientSupportsFormElicitation(capabilities)).toBe(expected);
  });
});

describe('createElicitor', () => {
  const REQUEST = {
    message: 'Proceed?',
    requestedSchema: { type: 'object' as const, properties: {} },
  };
  const clientWith = (
    elicitation: Record<string, unknown> | undefined,
    calls: Array<{ timeout: number }>,
  ): ElicitationClient => ({
    getClientCapabilities: () => (elicitation === undefined ? {} : { elicitation }),
    elicitInput: async (_params, options) => {
      calls.push(options);
      return { action: 'accept', content: { confirm: true } };
    },
  });

  // Breaks when the prompt is sent without the timeout, so it waits on the SDK's 60 s default.
  it('sends the prompt with the named timeout', async () => {
    const calls: Array<{ timeout: number }> = [];

    const result = await createElicitor(clientWith({ form: {} }, calls))(REQUEST);

    expect(result).toEqual({ action: 'accept', content: { confirm: true } });
    expect(calls).toEqual([{ timeout: ELICITATION_PROMPT_TIMEOUT_MS }]);
  });

  // Breaks when the timeout is raised to or past the client's tool-call timeout.
  it('keeps the prompt wait under the client request timeout', () => {
    expect(ELICITATION_PROMPT_TIMEOUT_MS).toBeLessThan(CLIENT_REQUEST_TIMEOUT_MS);
  });

  // Breaks when a client without form elicitation is sent the prompt anyway.
  it('throws the typed error and sends nothing to a client that cannot be asked', async () => {
    const calls: Array<{ timeout: number }> = [];

    await expect(createElicitor(clientWith({ url: {} }, calls))(REQUEST)).rejects.toBeInstanceOf(
      ElicitationUnsupportedError,
    );
    expect(calls).toEqual([]);
  });
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

  it('writes a value outside printable ASCII as escapes, so the line is safe on any console', () => {
    const accentedLetter = String.fromCodePoint(0xed);
    const astralSymbol = String.fromCodePoint(0x1f600);
    const [line] = describeIgnoredFlagValues({
      GODOT_MCP_STRICT: `s${accentedLetter} ${astralSymbol}`,
    });
    expect(line).toBe(
      '[SERVER] GODOT_MCP_STRICT="s\\u00ed \\ud83d\\ude00" is not "true" and was ignored: strict mode is OFF',
    );
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  });
});
