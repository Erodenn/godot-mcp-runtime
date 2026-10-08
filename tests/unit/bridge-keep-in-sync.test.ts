/**
 * The bridge's wire contract is written twice: once in TypeScript and once in
 * GDScript, with KEEP IN SYNC comments pointing each side at the other. Nothing
 * else in the suite reads the GDScript half, so a rename or a retuned constant
 * on the TypeScript side leaves every test green while the two stop agreeing.
 * The failure is silent by construction: a renamed sentinel, for instance, is
 * still printed by the game and still ignored by the reader, and per-action
 * error attribution quietly degrades to "trailing" on every call.
 *
 * These assertions read the script as text, which is all a Node test can do
 * with GDScript, and cost nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  ACTION_BOUNDARY_SENTINEL,
  DEFAULT_BRIDGE_PORT,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  NON_FINITE_COUNT_FIELD,
  OVERSIZE_RESPONSE_FIELD,
  PARENT_WATCH_PORT_ENV,
} from '../../src/utils/bridge-protocol.js';
import { screenshotsDir } from '../../src/utils/artifact-paths.js';
import { TRACK_MAX_ENTRIES, TRACK_MIN_INTERVAL_MS } from '../../src/tools/profiler-tools.js';
import {
  extractTokenFramedPayload,
  normalizeForCompare,
  OPERATION_RESULT_SENTINEL,
  OPERATION_RESULT_TOKEN_END,
  OPERATION_RESULT_TOKEN_ENV,
} from '../../src/utils/output-parsing.js';
import {
  MAX_INPUT_BATCH_BUDGET_MS,
  runtimeToolDefinitions,
  SCREENSHOT_DEFAULT_TIMEOUT_MS,
  SCREENSHOT_FRAME_RENDER_BUDGET_MS,
} from '../../src/tools/runtime-tools.js';

/** The most bytes UTF-8 spends on one character. */
const UTF8_MAX_BYTES_PER_CHAR = 4;

const bridgeSource = readFileSync(
  new URL('../../src/scripts/mcp_bridge.gd', import.meta.url),
  'utf8',
);

/** The right-hand side of a `const NAME := <value>` declaration, verbatim. */
function gdConst(name: string): string {
  const match = bridgeSource.match(new RegExp(`^const ${name}\\s*:=\\s*(.+?)\\s*(?:#.*)?$`, 'm'));
  expect(match, `mcp_bridge.gd must declare const ${name}`).not.toBeNull();
  return match![1]!;
}

/** Body of one top-level `func`, up to the next top-level declaration. */
function gdFunctionBody(name: string): string {
  const start = bridgeSource.indexOf(`\nfunc ${name}(`);
  expect(start, `mcp_bridge.gd must define func ${name}`).toBeGreaterThanOrEqual(0);
  const rest = bridgeSource.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:func |# |const |var )/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('mcp_bridge.gd agrees with the TypeScript wire contract', () => {
  it('declares the same default port', () => {
    expect(gdConst('PORT')).toBe(String(DEFAULT_BRIDGE_PORT));
  });

  it('declares the same frame limits', () => {
    expect(gdConst('MAX_FRAME_BYTES')).toBe('16 * 1024 * 1024');
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(gdConst('FRAME_HEADER_BYTES')).toBe(String(FRAME_HEADER_BYTES));
  });

  it('declares the same action-boundary sentinel', () => {
    expect(gdConst('ACTION_BOUNDARY_SENTINEL')).toBe(`"${ACTION_BOUNDARY_SENTINEL}"`);
  });

  it('declares the same oversize-response field', () => {
    // Red when either side renames the field: the handler would then report a
    // script that ran as a refusal where nothing ran.
    expect(gdConst('OVERSIZE_RESPONSE_FIELD')).toBe(`"${OVERSIZE_RESPONSE_FIELD}"`);
  });

  it('declares the same non-finite count field', () => {
    // Red when either side renames the field: the count would reach the payload
    // as an unknown key and the warning would never be given.
    expect(gdConst('NON_FINITE_COUNT_FIELD')).toBe(`"${NON_FINITE_COUNT_FIELD}"`);
  });

  it('declares the same profiler track caps', () => {
    expect(gdConst('MAX_TRACK_ENTRIES')).toBe(String(TRACK_MAX_ENTRIES));
    expect(gdConst('MIN_TRACK_INTERVAL_MS')).toBe(String(TRACK_MIN_INTERVAL_MS));
  });

  it('writes screenshots where the containment check looks for them', () => {
    const resPath = gdConst('SCREENSHOT_DIR_RES_PATH').replace(/^"|"$/g, '');
    const projectRelative = resPath.replace('res://', '');
    expect(normalizeForCompare(screenshotsDir('/project'))).toBe(`/project/${projectRelative}`);
  });

  // The budget is how long the bridge waits for a frame before it answers a
  // screenshot with its own error. At or past the command timeout, that error
  // could never arrive: the caller would get a generic timeout instead.
  it('the screenshot frame budget matches its TypeScript twin and stays under the default screenshot timeout', () => {
    expect(gdConst('FRAME_RENDER_BUDGET_MS')).toBe(String(SCREENSHOT_FRAME_RENDER_BUDGET_MS));
    expect(SCREENSHOT_FRAME_RENDER_BUDGET_MS).toBeLessThan(SCREENSHOT_DEFAULT_TIMEOUT_MS);
  });

  it('waits for a rendered frame on a bounded loop, never on the signal itself', () => {
    expect(bridgeSource).not.toContain('await RenderingServer.frame_post_draw');
    expect(bridgeSource).toContain('< FRAME_RENDER_BUDGET_MS');
  });

  it('bounds the waits of one input batch at the same figure as the TypeScript budget ceiling', () => {
    expect(gdConst('MAX_BATCH_WAIT_MS')).toBe(String(MAX_INPUT_BATCH_BUDGET_MS));
    const validation = gdFunctionBody('_validate_input_batch');
    expect(validation).toContain('if total_wait_ms > float(MAX_BATCH_WAIT_MS):');
  });

  it('states the action cap of one input batch as the bridge enforces it', () => {
    // Red when MAX_BATCH_ACTIONS is retuned and the simulate_input schema text
    // keeps the old figure, or when the bridge stops enforcing the cap.
    const cap = gdConst('MAX_BATCH_ACTIONS');
    expect(cap).toMatch(/^\d+$/);
    expect(gdFunctionBody('_validate_input_batch')).toContain(
      'if actions.size() > MAX_BATCH_ACTIONS:',
    );
    const simulateInput = runtimeToolDefinitions.find((tool) => tool.name === 'simulate_input');
    expect(simulateInput, 'runtime-tools.ts must define simulate_input').toBeDefined();
    const properties = simulateInput!.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    // The schema states the figure the time budget derives, which has to stay
    // within the cap the bridge enforces.
    const stated = /admits at most (\d+) actions per call/.exec(
      properties.actions?.description ?? '',
    );
    expect(stated, 'the actions description must state the budget-derived cap').not.toBeNull();
    expect(Number(stated![1])).toBeLessThanOrEqual(Number(cap));
  });

  it('reads the parent-watch port from the variable the server sets', () => {
    expect(gdConst('PARENT_WATCH_PORT_ENV')).toBe(`"${PARENT_WATCH_PORT_ENV}"`);
    expect(gdFunctionBody('_ready')).toContain('OS.get_environment(PARENT_WATCH_PORT_ENV)');
  });
});

/**
 * The parent watch quits a spawned game whose server is gone. What a text
 * read can pin is the shape that keeps it from quitting a game it should not:
 * it is started only from the environment variable (an attached Godot is
 * given none), and it quits only on a connection that was established first.
 */
describe('mcp_bridge.gd parent watch', () => {
  it('is started from the environment variable and nowhere else', () => {
    const starts = bridgeSource.match(/_start_parent_watch\(/g) ?? [];
    // The definition and the one call in _ready.
    expect(starts).toHaveLength(2);
    expect(bridgeSource).not.toMatch(/const PARENT_WATCH_PORT\s*:=/);
  });

  it('quits only after the connection had been established, and warns otherwise', () => {
    const poll = gdFunctionBody('_poll_parent_watch');
    const giveUp = poll.indexOf('if not _parent_watch_established:');
    const quit = poll.indexOf('get_tree().quit()');
    expect(giveUp).toBeGreaterThanOrEqual(0);
    expect(quit).toBeGreaterThan(giveUp);
    expect(poll.slice(giveUp, quit)).toContain('return');
    expect(poll).toContain('_parent_watch.put_data(_parent_watch_beat) == OK');
  });

  it('checks on a named interval', () => {
    expect(Number(gdConst('PARENT_WATCH_INTERVAL_MS'))).toBeGreaterThan(0);
    expect(gdFunctionBody('_poll_parent_watch')).toContain('PARENT_WATCH_INTERVAL_MS');
  });
});

/**
 * A reply the bridge cannot frame must still be answered: the caller is
 * waiting, and silence reads as a dead game.
 */
describe('mcp_bridge.gd answers every command', () => {
  it('sends an error in place of a response over the frame limit, instead of sending nothing', () => {
    const send = gdFunctionBody('_send_response');
    expect(send).toContain('OVERSIZE_RESPONSE_ERROR %');
    // One exit only: the oversize branch falls through to the write.
    expect(send.match(/^\t+return$/gm)).toBeNull();
    expect(gdConst('OVERSIZE_RESPONSE_ERROR')).toContain('%d');
  });

  it('bounds the two text fields of an input result that no serializer sees', () => {
    expect(Number(gdConst('MAX_UI_TEXT_CHARS'))).toBeGreaterThan(0);
    expect(gdFunctionBody('_run_action').match(/_cut_text\(.+, MAX_UI_TEXT_CHARS\)/g)).toHaveLength(
      2,
    );
    expect(gdFunctionBody('_diff_ui')).toMatch(
      /delta\["text"\] = _cut_text\(.+, MAX_UI_TEXT_CHARS\)/,
    );
  });
});

/**
 * The value serializer recurses through containers, and a Dictionary can hold
 * itself. A Node test cannot run GDScript, so this reads the structure that
 * keeps the recursion bounded: the engine-side behavior is covered by the
 * Godot-backed integration run.
 */
describe('mcp_bridge.gd bounds the values it serializes', () => {
  it('declares a depth bound for every serialization and size bounds for samples', () => {
    expect(Number(gdConst('MAX_RESULT_DEPTH'))).toBeGreaterThan(0);
    expect(Number(gdConst('MAX_SAMPLE_DEPTH'))).toBeGreaterThan(0);
    expect(Number(gdConst('MAX_SAMPLE_DEPTH'))).toBeLessThanOrEqual(
      Number(gdConst('MAX_RESULT_DEPTH')),
    );
    expect(Number(gdConst('MAX_SAMPLE_ELEMENTS'))).toBeGreaterThan(0);
    expect(Number(gdConst('MAX_SAMPLE_STRING_CHARS'))).toBeGreaterThan(0);
  });

  it('recurses only through the bounded walker, which checks the depth in both container branches', () => {
    const walker = gdFunctionBody('_serialize_bounded');
    // No way back into an entry point, which would reset the bounds mid-walk.
    expect(walker).not.toContain('_serialize_value(');
    expect(walker).not.toContain('_serialize_sample(');
    expect(walker.match(/if depth >= _serialize_depth_limit:/g)).toHaveLength(2);
    expect(walker.match(/_serialize_bounded\(.+, depth \+ 1\)/g)).toHaveLength(2);
    expect(walker.match(/if not _take_serialize_element\(\):/g)).toHaveLength(2);
  });

  it('marks every cut in the value instead of dropping it', () => {
    const walker = gdFunctionBody('_serialize_bounded');
    expect(walker.match(/TRUNCATED_DEPTH_MARKER %/g)).toHaveLength(2);
    expect(walker).toContain('TRUNCATED_ELEMENTS_MARKER %');
    expect(walker).toContain('TRUNCATED_ENTRIES_MARKER %');
    expect(gdFunctionBody('_cut_text')).toContain('TRUNCATED_STRING_MARKER %');
    expect(gdFunctionBody('_bound_text')).toContain('_cut_text(text, _serialize_string_limit)');
  });

  it('cuts a container that is already being walked, in both container branches, by identity', () => {
    const walker = gdFunctionBody('_serialize_bounded');
    expect(
      walker.match(/if _on_serialize_path\(\w+\):\n\t+return TRUNCATED_CYCLE_MARKER/g),
    ).toHaveLength(2);
    // Entered and left in pairs, so a sibling is never mistaken for an ancestor.
    expect(walker.match(/_serialize_path\.append\(/g)).toHaveLength(2);
    expect(walker.match(/_serialize_path\.pop_back\(\)/g)).toHaveLength(2);
    // == on a container that holds itself is the recursion being avoided.
    expect(gdFunctionBody('_on_serialize_path')).toContain('is_same(ancestor, container)');
    // Each entry point starts from an empty path.
    expect(gdFunctionBody('_serialize_value')).toContain('_serialize_path.clear()');
    expect(gdFunctionBody('_serialize_sample')).toContain('_serialize_path.clear()');
  });

  it('samples watch and track values through the size-bounded entry point', () => {
    const sampler = gdFunctionBody('_sample_one_watch');
    expect(sampler).toContain('_serialize_sample(');
    expect(sampler).not.toContain('_serialize_value(');
    const sampleEntry = gdFunctionBody('_serialize_sample');
    expect(sampleEntry).toContain('_serialize_depth_limit = MAX_SAMPLE_DEPTH');
    expect(sampleEntry).toContain('_serialize_elements_left = MAX_SAMPLE_ELEMENTS');
    expect(sampleEntry).toContain('_serialize_string_limit = MAX_SAMPLE_STRING_CHARS');
  });

  it('gives a run_script result all three bounds, far wider than a sample gets', () => {
    const resultEntry = gdFunctionBody('_serialize_value');
    expect(resultEntry).toContain('_serialize_depth_limit = MAX_RESULT_DEPTH');
    expect(resultEntry).toContain('_serialize_elements_left = MAX_RESULT_ELEMENTS');
    expect(resultEntry).toContain('_serialize_string_limit = MAX_RESULT_STRING_CHARS');
    expect(Number(gdConst('MAX_RESULT_ELEMENTS'))).toBeGreaterThan(
      Number(gdConst('MAX_SAMPLE_ELEMENTS')),
    );
    expect(Number(gdConst('MAX_RESULT_STRING_CHARS'))).toBeGreaterThan(
      Number(gdConst('MAX_SAMPLE_STRING_CHARS')),
    );
  });

  it('has no unbounded serialization left', () => {
    expect(bridgeSource).not.toContain('SERIALIZE_UNLIMITED');
    // A result string at its cap, encoded at four bytes a character, still fits a frame.
    const worstCaseStringBytes =
      Number(gdConst('MAX_RESULT_STRING_CHARS')) * UTF8_MAX_BYTES_PER_CHAR;
    expect(worstCaseStringBytes).toBeLessThan(MAX_FRAME_BYTES);
  });
});

/**
 * The headless-operation result sentinel is the same kind of two-sided
 * contract: godot_operations.gd prints it, output-parsing.ts reads it. A
 * drifted marker leaves every operation printing a payload nobody extracts.
 */
describe('godot_operations.gd agrees with the TypeScript result sentinel', () => {
  const operationsSource = readFileSync(
    new URL('../../src/scripts/godot_operations.gd', import.meta.url),
    'utf8',
  );

  it('declares the same operation-result sentinel', () => {
    const match = operationsSource.match(
      /^const OPERATION_RESULT_SENTINEL\s*:=\s*(.+?)\s*(?:#.*)?$/m,
    );
    expect(
      match,
      'godot_operations.gd must declare const OPERATION_RESULT_SENTINEL',
    ).not.toBeNull();
    expect(match![1]).toBe(`"${OPERATION_RESULT_SENTINEL}"`);
  });

  it.each([
    ['OPERATION_RESULT_TOKEN_ENV', OPERATION_RESULT_TOKEN_ENV],
    ['OPERATION_RESULT_TOKEN_END', OPERATION_RESULT_TOKEN_END],
  ])('declares the same %s', (name, expected) => {
    const match = operationsSource.match(
      new RegExp(`^const ${name}\\s*:=\\s*(.+?)\\s*(?:#.*)?$`, 'm'),
    );
    expect(match, `godot_operations.gd must declare const ${name}`).not.toBeNull();
    expect(match![1]).toBe(`"${expected}"`);
  });

  it('frames the result as the reader expects it: sentinel, token, token end, JSON', () => {
    const emitterLine = operationsSource
      .split('\n')
      .find((line) => line.includes('print(OPERATION_RESULT_SENTINEL'));
    expect(emitterLine?.trim()).toBe(
      'print(OPERATION_RESULT_SENTINEL + token_part + JSON.stringify(payload))',
    );
    expect(operationsSource).toContain(
      'var token_part := "" if result_token.is_empty() else result_token + OPERATION_RESULT_TOKEN_END',
    );
    expect(operationsSource).toContain(
      'result_token = OS.get_environment(OPERATION_RESULT_TOKEN_ENV)',
    );

    // The same concatenation, done here, is what the reader accepts.
    const token = 'ab12';
    const line = `${OPERATION_RESULT_SENTINEL}${token}${OPERATION_RESULT_TOKEN_END}{"ok":true}`;
    expect(extractTokenFramedPayload(line, token)).toBe('{"ok":true}');
  });

  it('keeps the sentinel distinct from the stderr action-boundary sentinel', () => {
    expect(OPERATION_RESULT_SENTINEL.startsWith(ACTION_BOUNDARY_SENTINEL)).toBe(false);
    expect(ACTION_BOUNDARY_SENTINEL.startsWith(OPERATION_RESULT_SENTINEL)).toBe(false);
  });

  it('keeps the sentinel ASCII', () => {
    expect(OPERATION_RESULT_SENTINEL).toMatch(/^[\x20-\x7e]+$/);
  });

  it('prints results only through the emitter helper', () => {
    expect(operationsSource).not.toContain('print(JSON.stringify');
    const printsSentinel = operationsSource
      .split('\n')
      .filter((line) => line.includes('print(OPERATION_RESULT_SENTINEL'));
    expect(printsSentinel).toHaveLength(1);
  });

  it('writes nothing to stdout except the framed result', () => {
    const stdoutPrints = operationsSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /(^|[^A-Za-z_])print\(/.test(line));
    expect(stdoutPrints).toHaveLength(1);
    expect(stdoutPrints[0]).toContain('print(OPERATION_RESULT_SENTINEL');
  });
});

/**
 * Two values the headless script shares with TypeScript modules that do not
 * export them, so the TypeScript half is read as text like the GDScript half.
 */
describe('godot_operations.gd agrees with unexported TypeScript constants', () => {
  const operationsSource = readFileSync(
    new URL('../../src/scripts/godot_operations.gd', import.meta.url),
    'utf8',
  );
  const runnerSource = readFileSync(
    new URL('../../src/utils/godot-runner.ts', import.meta.url),
    'utf8',
  );
  const sceneToolsSource = readFileSync(
    new URL('../../src/tools/scene-tools.ts', import.meta.url),
    'utf8',
  );

  /** The quoted strings of a bracketed list, in order. */
  function quotedItems(list: string): string[] {
    return [...list.matchAll(/["']([^"']*)["']/g)].map((item) => item[1]!);
  }

  it('prints the operation-started line the runner looks for', () => {
    // Red when either the marker constant or the script's log line changes: the
    // runner would then report every operation as an engine that died before
    // dispatch, or miss a real one.
    const marker = runnerSource.match(/^const OPERATION_STARTED_MARKER = '([^']*)';$/m);
    expect(marker, 'godot-runner.ts must declare OPERATION_STARTED_MARKER').not.toBeNull();
    const logPrefix = operationsSource.match(
      /^func log_info\(message\):\s*printerr\("([^"]*)" \+ message\)$/m,
    );
    expect(logPrefix, 'godot_operations.gd log_info must print a quoted prefix').not.toBeNull();
    const started = operationsSource.match(/^\tlog_info\("([^"]*)" \+ operation\)$/m);
    expect(started, 'godot_operations.gd must log the operation it dispatches').not.toBeNull();
    expect(`${logPrefix![1]!}${started![1]!}`.trimEnd()).toBe(marker![1]!);
  });

  it('promotes the same add_node parameters on both sides', () => {
    // Red when one list gains or loses a name: a top-level parameter would then
    // be applied by the standalone tool and ignored inside a batch, or the
    // reverse.
    const gdList = operationsSource.match(
      /^const _PROMOTED_SPATIAL_PARAMS: Array = \[([^\]]*)\]$/m,
    );
    expect(gdList, 'godot_operations.gd must declare _PROMOTED_SPATIAL_PARAMS').not.toBeNull();
    const tsList = sceneToolsSource.match(
      /^const PROMOTED_SPATIAL_PARAMS = \[([^\]]*)\] as const;$/m,
    );
    expect(tsList, 'scene-tools.ts must declare PROMOTED_SPATIAL_PARAMS').not.toBeNull();
    const promoted = quotedItems(gdList![1]!);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted).toEqual(quotedItems(tsList![1]!));
  });

  it('ends the process in one place', () => {
    // Red when a second quit is added: a later quit(code) replaces an earlier
    // one's exit code, so a failure could leave with a success code.
    const quits = operationsSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /(^|[^A-Za-z_])quit\(/.test(line));
    expect(quits).toHaveLength(1);
  });
});
