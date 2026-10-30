/** Workers copy the main process environment at creation, so setting `process.env` here reaches every test file; `GODOT_PATH` becomes the launcher and `GODOT_MCP_TEST_LAUNCH_TARGET` the real Godot. */

import { LAUNCH_TARGET_ENV_VAR, resolvePrivateDesktopLauncher } from './private-desktop.js';

function report(message: string): void {
  console.error(`[tests] private desktop: ${message}`);
}

// Each Vitest project runs this in the same process with its own module instances, so the decision is recorded in the environment; this also stops a nested run wrapping GODOT_PATH twice.
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
