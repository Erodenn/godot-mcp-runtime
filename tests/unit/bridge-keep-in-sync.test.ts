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
} from '../../src/utils/bridge-protocol.js';
import { screenshotsDir } from '../../src/utils/artifact-paths.js';
import { TRACK_MAX_ENTRIES, TRACK_MIN_INTERVAL_MS } from '../../src/tools/profiler-tools.js';
import { normalizeForCompare, OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import {
  SCREENSHOT_DEFAULT_TIMEOUT_MS,
  SCREENSHOT_FRAME_RENDER_BUDGET_MS,
} from '../../src/tools/runtime-tools.js';

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
