/**
 * The start identity of the process holding a pid: an opaque string that the
 * operating system fixes when the process is created and that no later event
 * changes.
 *
 * A pid says only that some process has that number now. The operating system
 * hands numbers out again, so a pid recorded by a process that has since died
 * can belong to an unrelated one. The start identity tells the two apart: the
 * same pid with a different identity is a different process.
 *
 * Two readings of one process are equal, whatever the wall clock did in
 * between. That is why this is not a wall-clock time: a start time derived
 * from "now" or from the boot time moves when the clock is stepped (NTP after
 * a wake, an RTC correction), and a comparison across such a step would call
 * a live process a different one. Each platform reads the value the kernel
 * stored at creation:
 *
 * - Linux: the boot id and the `starttime` field of `/proc/<pid>/stat`, in
 *   clock ticks since boot. Neither moves with the wall clock. No helper.
 * - Windows: the process creation time as a FILETIME integer, which the
 *   kernel records once at creation. One `powershell` run.
 * - macOS: `ps -o lstart=`, printed in UTC. The kernel keeps the start as an
 *   absolute time taken at fork. One `ps` run.
 * - Anything else: unknown. The BSDs keep the start relative to a boot time
 *   that is adjusted when the clock is stepped, so their value is not stable.
 *
 * Synchronous on purpose: the bridge owner registry is read from paths that
 * cannot await.
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/** Index of `starttime` in `/proc/<pid>/stat`, counted after the `(comm)` field. */
const PROC_STAT_STARTTIME_INDEX_AFTER_COMM = 19;
/** Identifies one boot of a Linux kernel; a new value at every boot. */
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
/** Upper bound on one start-identity query that has to run a helper program. */
export const START_IDENTITY_QUERY_TIMEOUT_MS = 5000;

export interface ProcessStartIdentityDeps {
  platform: NodeJS.Platform;
  readFile: (path: string) => string;
  run: (command: string, args: string[]) => { status: number | null; stdout: string } | null;
}

export const defaultProcessStartIdentityDeps: ProcessStartIdentityDeps = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, 'utf8'),
  run: (command, args) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: START_IDENTITY_QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // `ps` prints the start time in the locale's format and the process's
      // time zone. C and UTC make two readings of one process the same text
      // whatever the user's locale or zone is at either reading.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (result.error) return null;
    return { status: result.status, stdout: result.stdout };
  },
};

/** The platforms a start identity can be read on; each prefixes its identity with its name. */
const START_IDENTITY_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'win32', 'darwin'];

/** The platform a start identity was read on, or null when it names none. */
export function startIdentityPlatform(identity: string | undefined): NodeJS.Platform | null {
  if (identity === undefined) return null;
  return START_IDENTITY_PLATFORMS.find((name) => identity.startsWith(`${name}:`)) ?? null;
}

/** Whether reading a start identity on this platform runs a helper program. */
export function startIdentityQuerySpawns(platform: NodeJS.Platform): boolean {
  return platform !== 'linux';
}

/**
 * Start identity of the process holding `pid`, or null when it cannot be read
 * (no such process, no permission, an unsupported platform, a helper that
 * failed or timed out). Never throws. Null is "unknown", never "not running".
 *
 * The string is only ever compared for equality with another reading taken on
 * the same host. It carries a platform prefix so readings of two kinds never
 * compare equal.
 */
export function readProcessStartIdentity(
  pid: number,
  deps: ProcessStartIdentityDeps = defaultProcessStartIdentityDeps,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (deps.platform === 'linux') return readLinuxStartIdentity(pid, deps);
    if (deps.platform === 'win32') return readWindowsStartIdentity(pid, deps);
    if (deps.platform === 'darwin') return readDarwinStartIdentity(pid, deps);
    return null;
  } catch {
    return null;
  }
}

function readLinuxStartIdentity(pid: number, deps: ProcessStartIdentityDeps): string | null {
  const stat = deps.readFile(`/proc/${pid}/stat`);
  // The second field is the command name in parentheses and may itself hold
  // spaces and parentheses, so the fixed-position fields are counted from the
  // last closing one.
  const afterComm = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const startTicks = afterComm[PROC_STAT_STARTTIME_INDEX_AFTER_COMM];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
  // Ticks count from boot, so the same pid and tick count can recur after a
  // reboot. The boot id is required, not optional: an identity that carried it
  // on one reading and not on the next would compare unequal for one process.
  const bootId = deps.readFile(LINUX_BOOT_ID_PATH).trim();
  if (bootId === '') return null;
  return `linux:${bootId}:${startTicks}`;
}

function readWindowsStartIdentity(pid: number, deps: ProcessStartIdentityDeps): string | null {
  const result = deps.run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
  ]);
  if (result === null || result.status !== 0) return null;
  const fileTime = result.stdout.trim();
  if (!/^\d+$/.test(fileTime)) return null;
  return `win32:${fileTime}`;
}

function readDarwinStartIdentity(pid: number, deps: ProcessStartIdentityDeps): string | null {
  const result = deps.run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (result === null || result.status !== 0) return null;
  const started = result.stdout.trim().replace(/\s+/g, ' ');
  if (started === '') return null;
  return `darwin:${started}`;
}
