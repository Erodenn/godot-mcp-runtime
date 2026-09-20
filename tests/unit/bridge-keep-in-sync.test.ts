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
import { normalizeForCompare } from '../../src/utils/output-parsing.js';

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

  it('writes screenshots where the containment check looks for them', () => {
    const resPath = gdConst('SCREENSHOT_DIR_RES_PATH').replace(/^"|"$/g, '');
    const projectRelative = resPath.replace('res://', '');
    expect(normalizeForCompare(screenshotsDir('/project'))).toBe(`/project/${projectRelative}`);
  });
});
