/**
 * Vitest globalSetup: on Windows, route every Godot process the suite starts
 * through the private-desktop launcher so none of them can take keyboard focus.
 *
 * It runs once in the main process before any worker starts, and workers copy
 * the main process environment when they are created, so mutating
 * `process.env` here reaches every test file. `GODOT_PATH` becomes the launcher
 * and `GODOT_MCP_TEST_LAUNCH_TARGET` holds the real Godot path the launcher runs.
 */

import { LAUNCH_TARGET_ENV_VAR, resolvePrivateDesktopLauncher } from './private-desktop.js';

function report(message: string): void {
  console.error(`[tests] private desktop: ${message}`);
}

// Each Vitest project (they extend the root config) runs this setup in the same
// main process but with its own module instances, so the first call records its
// decision in the environment and later ones return silently. This also keeps
// a nested run from wrapping an already substituted GODOT_PATH a second time.
const DECIDED_ENV_VAR = 'GODOT_MCP_TEST_PRIVATE_DESKTOP_DECIDED';

export function setup(): void {
  if (process.env[DECIDED_ENV_VAR] === '1') return;
  process.env[DECIDED_ENV_VAR] = '1';
  if (process.env[LAUNCH_TARGET_ENV_VAR]) {
    report(`${LAUNCH_TARGET_ENV_VAR} already set, leaving GODOT_PATH as is`);
    return;
  }
  const resolution = resolvePrivateDesktopLauncher();
  if (resolution.exe === null) {
    report(`off (${resolution.reason}); windows are only hidden`);
    return;
  }
  process.env[LAUNCH_TARGET_ENV_VAR] = process.env.GODOT_PATH;
  process.env.GODOT_PATH = resolution.exe;
  report(`on, launcher ${resolution.note}`);
}
