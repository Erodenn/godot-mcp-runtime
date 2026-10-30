/** The bridge's wire contract is written twice (TypeScript and GDScript) and nothing else reads the GDScript half, so drift leaves every test green.
 * These assertions read the script as text. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  ACTION_BOUNDARY_SENTINEL,
  BRIDGE_UNAUTHORIZED_ERROR,
  DEFAULT_BRIDGE_PORT,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  NON_FINITE_COUNT_FIELD,
  OVERSIZE_RESPONSE_FIELD,
  PARENT_WATCH_PORT_ENV,
} from '../../src/utils/bridge-protocol.js';
import { screenshotsDir } from '../../src/utils/artifact-paths.js';
import { stderrRequestsImport } from '../../src/utils/headless-op.js';
import { TRACK_MAX_ENTRIES, TRACK_MIN_INTERVAL_MS } from '../../src/tools/profiler-tools.js';
import {
  extractTokenFramedPayload,
  normalizeForCompare,
  OPERATION_RESULT_SENTINEL,
  OPERATION_RESULT_TOKEN_END,
  OPERATION_RESULT_TOKEN_ENV,
} from '../../src/utils/output-parsing.js';
import {
  MAX_HOLD_MS,
  MAX_INPUT_BATCH_BUDGET_MS,
  MAX_TEXT_LENGTH,
  MAX_WAIT_FRAMES,
  MAX_WATCH_ENTRIES,
  runtimeToolDefinitions,
  SCREENSHOT_DEFAULT_TIMEOUT_MS,
  SCREENSHOT_FRAME_RENDER_BUDGET_MS,
} from '../../src/tools/runtime-tools.js';

const UTF8_MAX_BYTES_PER_CHAR = 4;

// Typed or untyped declarations alike; no fragment captures, so backreference numbers hold.
/** A GDScript type name, optionally with one bracketed element type: `int`, `Array[String]`. */
const GD_TYPE = String.raw`[A-Za-z_][\w.]*(?:\[[^\]\n]*\])?`;
/** The assignment of a `var` or `const`: inferred `:=` or annotated `: Type =`. */
const GD_ASSIGN = String.raw`(?:\s*:=|\s*:\s*${GD_TYPE}\s*=)`;
/** An optional parameter annotation, `: Type`. */
const GD_PARAM_TYPE = String.raw`(?:\s*:\s*${GD_TYPE})?`;
/** An optional return annotation, `-> Type`. */
const GD_RETURN_TYPE = String.raw`(?:\s*->\s*${GD_TYPE})?`;

const bridgeSource = readFileSync(
  new URL('../../src/scripts/mcp_bridge.gd', import.meta.url),
  'utf8',
);

/** The right-hand side of a `const NAME := <value>` declaration, verbatim. */
function gdConst(name: string): string {
  const match = bridgeSource.match(
    new RegExp(`^const ${name}${GD_ASSIGN}\\s*(.+?)\\s*(?:#.*)?$`, 'm'),
  );
  expect(match, `mcp_bridge.gd must declare const ${name}`).not.toBeNull();
  return match![1]!;
}

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

  it('declares the same token refusal text, and answers a bad token with it', () => {
    // Red when either side rewords the refusal: the readiness wait would take another session's bridge for one still starting
    // and wait out its whole budget.
    expect(gdConst('UNAUTHORIZED_ERROR')).toBe(`"${BRIDGE_UNAUTHORIZED_ERROR}"`);
    expect(gdFunctionBody('_dispatch_command')).toContain('{"error": UNAUTHORIZED_ERROR}');
  });

  it('declares the same non-finite count field', () => {
    // Red when either side renames the field: the count would reach the payload
    // as an unknown key and the warning would never be given.
    expect(gdConst('NON_FINITE_COUNT_FIELD')).toBe(`"${NON_FINITE_COUNT_FIELD}"`);
  });

  it('declares the same input batch caps', () => {
    // Red when a cap is retuned on one side: the schema would promise a limit
    // the bridge does not apply.
    expect(gdConst('MAX_WAIT_FRAMES')).toBe(String(MAX_WAIT_FRAMES));
    expect(gdConst('MAX_HOLD_MS')).toBe(String(MAX_HOLD_MS));
    expect(gdConst('MAX_TEXT_LENGTH')).toBe(String(MAX_TEXT_LENGTH));
    expect(gdConst('MAX_WATCH_ENTRIES')).toBe(String(MAX_WATCH_ENTRIES));
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

  // At or past the command timeout the bridge's own screenshot error could never arrive; the caller would get a generic timeout.
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

  it('reads the session token, bridge port and background flag from the variables the runner sets', () => {
    // Red when a name changes on one side only: the game would then start
    // with no token or on the baked port, and the start would time out.
    const runnerSource = readFileSync(
      new URL('../../src/utils/godot-runner.ts', import.meta.url),
      'utf8',
    );
    const set = [...runnerSource.matchAll(/\b(MCP_[A-Z_]+): /g)].map((match) => match[1]!);
    expect(set.sort()).toEqual(['MCP_BACKGROUND', 'MCP_BRIDGE_PORT', 'MCP_SESSION_TOKEN']);
    const ready = gdFunctionBody('_ready');
    for (const name of set) {
      expect(ready, `mcp_bridge.gd _ready must read ${name}`).toContain(
        `OS.get_environment("${name}")`,
      );
    }
  });
});

/** The parent watch quits a spawned game whose server is gone; a text read pins that it starts only from the environment variable and quits only after an established connection. */
describe('mcp_bridge.gd parent watch', () => {
  it('is started from the environment variable and nowhere else', () => {
    const starts = bridgeSource.match(/_start_parent_watch\(/g) ?? [];
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

/** A reply the bridge cannot frame must still be answered: silence reads as a dead game. */
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

/** Pins the structure that bounds the value serializer's recursion (a Dictionary can hold itself); engine behavior is covered by the Godot integration run. */
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

/** godot_operations.gd prints the result sentinel and output-parsing.ts reads it; a drifted marker leaves payloads nobody extracts. */
describe('godot_operations.gd agrees with the TypeScript result sentinel', () => {
  const operationsSource = readFileSync(
    new URL('../../src/scripts/godot_operations.gd', import.meta.url),
    'utf8',
  );

  it('declares the same operation-result sentinel', () => {
    const match = operationsSource.match(
      new RegExp(String.raw`^const OPERATION_RESULT_SENTINEL${GD_ASSIGN}\s*(.+?)\s*(?:#.*)?$`, 'm'),
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
      new RegExp(`^const ${name}${GD_ASSIGN}\\s*(.+?)\\s*(?:#.*)?$`, 'm'),
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
    expect(operationsSource).toMatch(
      new RegExp(
        String.raw`var token_part${GD_ASSIGN} "" if result_token\.is_empty\(\) else result_token \+ OPERATION_RESULT_TOKEN_END`,
      ),
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

/** Values the headless script shares with TypeScript modules that do not export them, so that half is read as text. */
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
  const pathValidationSource = readFileSync(
    new URL('../../src/utils/path-validation.ts', import.meta.url),
    'utf8',
  );
  const argParsingSource = readFileSync(
    new URL('../../src/utils/arg-parsing.ts', import.meta.url),
    'utf8',
  );

  function quotedItems(list: string): string[] {
    return [...list.matchAll(/["']([^"']*)["']/g)].map((item) => item[1]!);
  }

  it('prints the operation-started line the runner looks for', () => {
    // Red when the marker constant or the script's log line changes: the runner would report every operation as an engine that died before dispatch,
    // or miss a real one.
    const marker = runnerSource.match(/^const OPERATION_STARTED_MARKER = '([^']*)';$/m);
    expect(marker, 'godot-runner.ts must declare OPERATION_STARTED_MARKER').not.toBeNull();
    const logPrefix = operationsSource.match(
      new RegExp(
        String.raw`^func log_info\(message${GD_PARAM_TYPE}\)${GD_RETURN_TYPE}:\s*printerr\("([^"]*)" \+ message\)$`,
        'm',
      ),
    );
    expect(logPrefix, 'godot_operations.gd log_info must print a quoted prefix').not.toBeNull();
    const started = operationsSource.match(/^\tlog_info\("([^"]*)" \+ operation\)$/m);
    expect(started, 'godot_operations.gd must log the operation it dispatches').not.toBeNull();
    expect(`${logPrefix![1]!}${started![1]!}`.trimEnd()).toBe(marker![1]!);
  });

  it('prints the import request as a line the retry check recognises', () => {
    // Red when the marker text or the log_error prefix changes on one side only:
    // a cold project would fail every scene operation instead of importing and retrying.
    const errorPrefix = operationsSource.match(
      new RegExp(
        String.raw`^func log_error\(message${GD_PARAM_TYPE}\)${GD_RETURN_TYPE}:\s*printerr\("([^"]*)" \+ message\)$`,
        'm',
      ),
    );
    expect(errorPrefix, 'godot_operations.gd log_error must print a quoted prefix').not.toBeNull();
    const request = operationsSource.match(
      /^\t\tlog_error\("([^"]*)" \+ context \+ ": " \+ paths\)$/m,
    );
    expect(request, 'godot_operations.gd must print the import request').not.toBeNull();
    const printed = `${errorPrefix![1]!}${request![1]!}res://main.tscn: res://icon.png`;
    expect(stderrRequestsImport(`Godot Engine v4\n${printed}\n`)).toBe(true);
  });

  it('promotes the same add_node parameters on both sides', () => {
    // Red when one list gains or loses a name: a top-level parameter would be applied by the standalone tool and ignored inside a batch, or the reverse.
    const gdList = operationsSource.match(
      new RegExp(String.raw`^const _PROMOTED_SPATIAL_PARAMS${GD_ASSIGN} \[([^\]]*)\]$`, 'm'),
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

  it('takes the same suffixes for a node type that names a scene', () => {
    // Red when one list gains or loses a suffix: the path check would then
    // resolve a node type the script instantiates as a class, or the reverse.
    const gdList = operationsSource.match(
      new RegExp(String.raw`^const _SCENE_SUFFIXES${GD_ASSIGN} \[([^\]]*)\]$`, 'm'),
    );
    expect(gdList, 'godot_operations.gd must declare _SCENE_SUFFIXES').not.toBeNull();
    const tsList = pathValidationSource.match(
      /^const NODE_TYPE_SCENE_SUFFIXES: readonly string\[\] = \[([^\]]*)\];$/m,
    );
    expect(tsList, 'path-validation.ts must declare NODE_TYPE_SCENE_SUFFIXES').not.toBeNull();
    const suffixes = quotedItems(gdList![1]!);
    expect(suffixes.length).toBeGreaterThan(0);
    expect(suffixes).toEqual(quotedItems(tsList![1]!));
  });

  it('dispatches the batch operations the item check admits, and names them in its hint', () => {
    // Red when an operation is added to one side only: the item check would refuse an operation the script runs,
    // or admit one it answers with "Unknown batch operation".
    const tsList = argParsingSource.match(
      /^const BATCH_OPERATION_NAMES = \[([^\]]*)\] as const;$/m,
    );
    expect(tsList, 'arg-parsing.ts must declare BATCH_OPERATION_NAMES').not.toBeNull();
    const admitted = quotedItems(tsList![1]!);
    expect(admitted.length).toBeGreaterThan(0);

    const batchStart = operationsSource.indexOf('\nfunc batch_scene_operations(');
    expect(
      batchStart,
      'godot_operations.gd must define batch_scene_operations',
    ).toBeGreaterThanOrEqual(0);
    const batchBody = operationsSource.slice(batchStart);
    const dispatch = batchBody.match(/^(\t+)match op_name:\n([\s\S]*?)^\1\t_:$/m);
    expect(dispatch, 'batch_scene_operations must match on op_name').not.toBeNull();
    const armPattern = new RegExp(`^${dispatch![1]!}\t"([^"]+)":$`, 'gm');
    const arms = [...dispatch![2]!.matchAll(armPattern)].map((arm) => arm[1]!);
    expect(arms).toEqual(admitted);
    expect(batchBody).toContain(`(one of: ${admitted.join(', ')})`);
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

/** The bridge's serializer and the headless one name the same packed types and write the same value shapes; each reads the other's list only as text. */
describe('mcp_bridge.gd serializes values in the shapes godot_operations.gd reads them in', () => {
  const operationsSource = readFileSync(
    new URL('../../src/scripts/godot_operations.gd', import.meta.url),
    'utf8',
  );

  function packedReadTypes(source: string, file: string): string[] {
    const match = source.match(
      new RegExp(String.raw`^const _PACKED_READ_TYPES${GD_ASSIGN} \[([^\]]*)\]`, 'm'),
    );
    expect(match, `${file} must declare const _PACKED_READ_TYPES`).not.toBeNull();
    return [...match![1]!.matchAll(/TYPE_PACKED_\w+/g)].map((type) => type[0]).sort();
  }

  // Red when a packed type is added to or dropped from one list only: a value the headless
  // reader returns as an array would come back from run_script as text, or the reverse.
  it('lists the same packed types on both sides', () => {
    const bridge = packedReadTypes(bridgeSource, 'mcp_bridge.gd');
    const operations = packedReadTypes(operationsSource, 'godot_operations.gd');
    expect(bridge.length).toBeGreaterThan(0);
    expect(bridge).toEqual(operations);
  });

  it('carries a KEEP IN SYNC marker on each list naming the other', () => {
    expect(bridgeSource).toMatch(
      /# KEEP IN SYNC: _PACKED_READ_TYPES in src\/scripts\/godot_operations\.gd[^\n]*\nconst _PACKED_READ_TYPES/,
    );
    expect(operationsSource).toMatch(
      /# KEEP IN SYNC: _PACKED_READ_TYPES in src\/scripts\/mcp_bridge\.gd[^\n]*\nconst _PACKED_READ_TYPES/,
    );
  });

  // Red when the Vector4 arms are removed: a Vector4 would fall to the text branch again.
  it('writes Vector4 and Vector4i as {x,y,z,w}', () => {
    const walker = gdFunctionBody('_serialize_bounded');
    expect(walker).toContain('TYPE_VECTOR4:');
    expect(walker).toContain('TYPE_VECTOR4I:');
    expect(walker.match(/"w": /g)).toHaveLength(2);
  });

  // Red when a packed array stops going through the element budget, depth cut and markers.
  it('bounds a packed array like an array: depth cut, element budget, marker', () => {
    expect(gdFunctionBody('_serialize_bounded')).toContain(
      'if typeof(value) in _PACKED_READ_TYPES:\n\t\t\t\treturn _serialize_packed(value, depth)',
    );
    const packed = gdFunctionBody('_serialize_packed');
    expect(packed).toContain('if depth >= _serialize_depth_limit:');
    expect(packed).toContain('TRUNCATED_DEPTH_MARKER %');
    expect(packed).toContain('if not _take_serialize_element():');
    expect(packed).toContain('TRUNCATED_ELEMENTS_MARKER %');
    expect(packed).toContain('_serialize_bounded(packed[i], depth + 1)');
  });
});

/** Numbers mcp_bridge.gd names as constants and must not spell inline. */
describe('mcp_bridge.gd names its port bounds and its letter-case offset', () => {
  const codeLines = bridgeSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => !/^const /.test(line));

  // Red when a port bound or the case offset is written as a literal again outside a const declaration.
  it('has no 65535 or "+ 32" literal outside a const declaration', () => {
    expect(codeLines.filter((line) => /\b65535\b/.test(line))).toEqual([]);
    expect(codeLines.filter((line) => /\+ 32\b/.test(line))).toEqual([]);
  });

  it('checks both ports it reads from the environment against the one named range', () => {
    expect(gdConst('PORT_MIN')).toBe('1');
    expect(gdConst('PORT_MAX')).toBe('65535');
    expect(gdFunctionBody('_ready').match(/_is_usable_port\(/g)).toHaveLength(2);
    expect(gdFunctionBody('_is_usable_port')).toContain('port >= PORT_MIN and port <= PORT_MAX');
    expect(gdFunctionBody('_inject_key')).toContain('ASCII_LOWERCASE_OFFSET');
    expect(gdConst('ASCII_LOWERCASE_OFFSET')).toBe('32');
  });
});

/** A handler that reads a payload field into a typed variable raises on a wrong type and sends no reply; the client then waits out its whole timeout. */
describe('mcp_bridge.gd handlers type-check payload fields before using them', () => {
  // Red when a typed read of a payload field comes back: `var source: String = payload.get(...)`
  // raises in the engine on a non-string, and the bridge command never answers.
  it.each([
    ['_handle_get_ui_elements', ['visible_only', 'type_filter']],
    ['_handle_run_script', ['source']],
  ])('%s reads %j as Variant and refuses a wrong type', (handler, fields) => {
    const body = gdFunctionBody(handler);
    for (const field of fields as string[]) {
      expect(body).toContain(`var ${field}_field: Variant = payload.get("${field}"`);
      expect(body).toMatch(
        new RegExp(`if typeof\\(${field}_field\\) != TYPE_(BOOL|STRING):\\n\\t+_send_response\\(`),
      );
      expect(body).not.toMatch(new RegExp(`var ${field}: \\w+ = payload\\.get`));
    }
  });
});

/** An input batch keeps its own non-finite tally and reads still_held from the engine. */
describe('mcp_bridge.gd input batches', () => {
  const SERIALIZER_CALL = /_sample_watch\(|_serialize_value\(/g;

  // Red when a batch serialization stops moving its tally to the batch: an abandoned batch's
  // count would be taken by the next reply and could hide that reply's own warning.
  it('moves the tally of every serialization in _run_action to the batch', () => {
    const body = gdFunctionBody('_run_action');
    const calls = body.match(SERIALIZER_CALL) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(
      body.match(new RegExp(String.raw`var \w+${GD_ASSIGN} _non_finite_count\n`, 'g')),
    ).toHaveLength(calls.length);
    expect(body.match(/_move_tally_to_batch\(batch, \w+\)/g)).toHaveLength(calls.length);
    // Each call sits between its own `before` read and its own move.
    const sandwiches = body.match(
      new RegExp(
        String.raw`var (\w+)${GD_ASSIGN} _non_finite_count\n[^\n]*(?:_sample_watch\(|_serialize_value\()[^\n]*\n\t+_move_tally_to_batch\(batch, \1\)`,
        'g',
      ),
    );
    expect(sandwiches).toHaveLength(calls.length);
  });

  // Red when the batch's count is added for an abandoned batch too.
  it('adds the batch tally to the shared count only when a reader is left', () => {
    const body = gdFunctionBody('_handle_input');
    expect(body).toMatch(
      new RegExp(
        String.raw`if not abandoned:\n\t+_non_finite_count \+= batch\.non_finite_count\n\t+var still_held${GD_ASSIGN} _read_still_held\(batch\)`,
      ),
    );
    expect(body.match(/_non_finite_count \+= /g)).toHaveLength(1);
  });

  // Red when still_held is built from the request again.
  it('reads still_held from Input, not from the request', () => {
    const read = gdFunctionBody('_read_still_held');
    expect(read).toContain('Input.is_key_pressed(code) or Input.is_physical_key_pressed(code)');
    expect(read).toContain('Input.is_mouse_button_pressed(code)');
    expect(read).toContain('Input.is_action_pressed(StringName(str(code)))');
    expect(gdFunctionBody('_handle_input')).not.toContain('held.keys()');
    expect(bridgeSource).not.toContain('_update_held');
  });

  // Red when a press is recorded under the request's own text, so "w" and "W" are two candidates again.
  it("records a key under the engine's keycode string", () => {
    expect(gdFunctionBody('_run_action')).toContain(
      '_track_held(batch, HELD_KIND_KEY, OS.get_keycode_string(held_keycode), held_keycode, key_pressed)',
    );
  });
});
