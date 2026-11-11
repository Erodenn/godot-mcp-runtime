import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/process-lifecycle.js', () => ({
  registerProcessLifecycle: vi.fn(),
  shutDownRunner: vi.fn(),
}));
import {
  clientSupportsFormElicitation,
  createElicitor,
  ELICITATION_PROMPT_TIMEOUT_MS,
  ElicitationUnsupportedError,
  type ElicitationClient,
  describeIgnoredFlagValues,
  type McpContext,
} from '../../src/utils/mcp-context.js';
import { CLIENT_REQUEST_TIMEOUT_MS } from '../../src/utils/godot-runner.js';

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

// Breaks when a removed flag gets a line again, or when the surviving flag stops being reported or stops being the only one.
describe('describeIgnoredFlagValues', () => {
  it('reports a disable-elicitation flag set to 1 as ignored', () => {
    expect(describeIgnoredFlagValues({ GODOT_MCP_DISABLE_ELICITATION: '1' })).toEqual([
      '[SERVER] GODOT_MCP_DISABLE_ELICITATION="1" is not "true" and was ignored: confirmation prompts stay ON',
    ]);
  });

  it('reports nothing for true, false, empty and unset', () => {
    expect(describeIgnoredFlagValues({})).toEqual([]);
    for (const value of ['true', 'false', '', undefined]) {
      expect(describeIgnoredFlagValues({ GODOT_MCP_DISABLE_ELICITATION: value })).toEqual([]);
    }
  });

  it.each(['1', 'true', 'false', 'yes', 'TRUE', ' true', ''])(
    'returns no line for the removed flags at %j',
    (value) => {
      expect(
        describeIgnoredFlagValues({
          GODOT_MCP_STRICT: value,
          GODOT_MCP_DISABLE_SECURITY: value,
        }),
      ).toEqual([]);
    },
  );

  it('names only the surviving flag when all three are set', () => {
    const lines = describeIgnoredFlagValues({
      GODOT_MCP_STRICT: 'yes',
      GODOT_MCP_DISABLE_ELICITATION: 'TRUE',
      GODOT_MCP_DISABLE_SECURITY: ' true',
    });
    expect(lines).toEqual([
      '[SERVER] GODOT_MCP_DISABLE_ELICITATION="TRUE" is not "true" and was ignored: confirmation prompts stay ON',
    ]);
  });

  it('writes a value outside printable ASCII as escapes, so the line is safe on any console', () => {
    const accentedLetter = String.fromCodePoint(0xed);
    const astralSymbol = String.fromCodePoint(0x1f600);
    const [line] = describeIgnoredFlagValues({
      GODOT_MCP_DISABLE_ELICITATION: `s${accentedLetter} ${astralSymbol}`,
    });
    expect(line).toBe(
      '[SERVER] GODOT_MCP_DISABLE_ELICITATION="s\\u00ed \\ud83d\\ude00" is not "true" and was ignored: confirmation prompts stay ON',
    );
    expect(line).toMatch(/^[ -~]+$/);
  });
});

describe('the context the server builds from the environment', () => {
  const ENV_NAMES = [
    'GODOT_MCP_STRICT',
    'GODOT_MCP_DISABLE_SECURITY',
    'GODOT_MCP_DISABLE_ELICITATION',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ENV_NAMES) saved.set(name, process.env[name]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  async function buildContext(env: Partial<Record<(typeof ENV_NAMES)[number], string>>) {
    for (const name of ENV_NAMES) delete process.env[name];
    Object.assign(process.env, env);
    const { GodotMcpServer } = await import('../../src/server.js');
    return (new GodotMcpServer() as unknown as { ctx: McpContext }).ctx;
  }

  // Breaks when disableElicitation is derived from, or masked by, any flag other than GODOT_MCP_DISABLE_ELICITATION (the old strict dependency).
  it('sets disableElicitation with GODOT_MCP_STRICT=true alongside GODOT_MCP_DISABLE_ELICITATION=true', async () => {
    const ctx = await buildContext({
      GODOT_MCP_STRICT: 'true',
      GODOT_MCP_DISABLE_ELICITATION: 'true',
    });
    expect(ctx.disableElicitation).toBe(true);
  });

  // Breaks when either removed flag starts to change the context again.
  it('leaves disableElicitation off when only the removed flags are set', async () => {
    const ctx = await buildContext({
      GODOT_MCP_STRICT: 'true',
      GODOT_MCP_DISABLE_SECURITY: 'true',
    });
    expect(ctx.disableElicitation).toBe(false);
    expect(Object.keys(ctx).sort()).toEqual([
      'disableElicitation',
      'elicitor',
      'now',
      'sessionState',
    ]);
  });

  // Breaks when a startup line names a removed flag.
  it('prints no startup line about the removed flags', async () => {
    await buildContext({ GODOT_MCP_STRICT: 'true', GODOT_MCP_DISABLE_SECURITY: 'true' });
    const printed = vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    expect(printed).not.toMatch(/STRICT|DISABLE_SECURITY/);
  });
});
