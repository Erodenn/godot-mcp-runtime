/**
 * The private-desktop launcher passes the child's standard streams,
 * environment, arguments and exit code through, and ends the child with
 * itself. Uses node as the target through the launcher's target-variable mode,
 * so it needs no Godot. Windows only; skipped when the launcher does not
 * resolve (no compiler, show-windows opt-out). Nothing here asserts focus,
 * which cannot be tested reliably.
 */

import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  LAUNCH_TARGET_ENV_VAR,
  resolvePrivateDesktopLauncher,
} from '../helpers/private-desktop.js';

const RUN_TIMEOUT_MS = 20_000;
const PID_WAIT_TIMEOUT_MS = 10_000;
const DEATH_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const EXPECTED_EXIT_CODE = 7;
const PROBE_ENV_VAR = 'GODOT_MCP_LAUNCHER_PROBE';
const PROBE_ENV_VALUE = 'env value with spaces';
const PID_MARKER = 'pid=';

// The resolver needs GODOT_PATH set, but this test targets node, not Godot.
const resolution = resolvePrivateDesktopLauncher({
  env: { ...process.env, GODOT_PATH: process.execPath },
});
const launcher = resolution.exe;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  [LAUNCH_TARGET_ENV_VAR]: process.execPath,
  [PROBE_ENV_VAR]: PROBE_ENV_VALUE,
});

describe.skipIf(launcher === null)('private desktop launcher', () => {
  const exe = launcher as string;

  it('passes stdout, stderr, an environment variable and the exit code through', () => {
    const script = `process.stdout.write('out:' + process.env.${PROBE_ENV_VAR}); process.stderr.write('err-text'); process.exit(${EXPECTED_EXIT_CODE});`;
    const result = spawnSync(exe, ['-e', script], {
      env: childEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: RUN_TIMEOUT_MS,
    });
    expect(result.stdout).toBe(`out:${PROBE_ENV_VALUE}`);
    expect(result.stderr).toBe('err-text');
    expect(result.status).toBe(EXPECTED_EXIT_CODE);
  });

  it('delivers arguments with spaces and quotes intact', () => {
    const args = ['plain', 'has space', 'say "hi" now', 'C:\\dir with space\\'];
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)));';
    const result = spawnSync(exe, ['-e', script, ...args], {
      env: childEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: RUN_TIMEOUT_MS,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it(
    'ends the grandchild when the launcher is killed',
    async () => {
      const script = `process.stdout.write('${PID_MARKER}' + process.pid + '\\n'); setInterval(() => {}, 1000);`;
      const proc = spawn(exe, ['-e', script], {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      let grandchild = 0;
      try {
        const pidDeadline = Date.now() + PID_WAIT_TIMEOUT_MS;
        while (grandchild === 0 && Date.now() < pidDeadline) {
          const match = new RegExp(`${PID_MARKER}(\\d+)`).exec(stdout);
          if (match?.[1]) grandchild = Number(match[1]);
          else await sleep(POLL_INTERVAL_MS);
        }
        expect(grandchild).toBeGreaterThan(0);
        expect(isAlive(grandchild)).toBe(true);

        proc.kill();
        const deathDeadline = Date.now() + DEATH_WAIT_TIMEOUT_MS;
        while (isAlive(grandchild) && Date.now() < deathDeadline) {
          await sleep(POLL_INTERVAL_MS);
        }
        expect(isAlive(grandchild)).toBe(false);
      } finally {
        proc.kill();
      }
    },
    RUN_TIMEOUT_MS,
  );
});
