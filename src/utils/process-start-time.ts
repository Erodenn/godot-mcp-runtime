// Start identity: an opaque string the OS fixes at process creation, so the same pid with another identity is a different process (pids are reused). Not a wall-clock time, which moves when the clock is stepped.
// Linux: boot id + /proc starttime. Windows: creation FILETIME via powershell. macOS: `ps -o lstart=` in UTC. Else unknown. Synchronous: the registry is read where nothing can await.

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/** Index of `starttime` in `/proc/<pid>/stat`, counted after the `(comm)` field. */
const PROC_STAT_STARTTIME_INDEX_AFTER_COMM = 19;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
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
      // C locale and UTC make two readings of one process the same text.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (result.error) return null;
    return { status: result.status, stdout: result.stdout };
  },
};

const START_IDENTITY_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'win32', 'darwin'];

export function startIdentityPlatform(identity: string | undefined): NodeJS.Platform | null {
  if (identity === undefined) return null;
  return START_IDENTITY_PLATFORMS.find((name) => identity.startsWith(`${name}:`)) ?? null;
}

export function startIdentityQuerySpawns(platform: NodeJS.Platform): boolean {
  return platform !== 'linux';
}

/** Start identity of the process holding `pid`, or null for unknown (never "not running"). Compared for equality only, with a platform prefix so kinds never match. Never throws. */
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
  // The command name may hold spaces and parentheses, so fields are counted from the last closing one.
  const afterComm = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const startTicks = afterComm[PROC_STAT_STARTTIME_INDEX_AFTER_COMM];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
  // Ticks count from boot and can recur after a reboot; the boot id is required, or one reading with it and one without would differ for one process.
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
