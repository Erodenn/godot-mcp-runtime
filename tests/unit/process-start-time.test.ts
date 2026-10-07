/**
 * Reading a process's start identity per platform. The operating system
 * calls are injected: these cases pin the parsing, the "unknown is null"
 * rule, and that the value is the kernel's own, not one derived from the
 * wall clock.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  readProcessStartIdentity,
  startIdentityQuerySpawns,
  type ProcessStartIdentityDeps,
} from '../../src/utils/process-start-time.js';

const PID = 4242;
const BOOT_ID = '0b4e2c1a-7f7e-4d0c-9a51-3f3c2d1e0a99';
/** `starttime` in clock ticks since boot. */
const START_TICKS = 123_456;
/** A FILETIME: 100 ns intervals since 1601, as PowerShell prints it. */
const WINDOWS_FILE_TIME = '134041230001234567';

/** A `/proc/<pid>/stat` line: 19 fields between the command name and `starttime`. */
function procStat(comm: string, startTicks: number | string): string {
  const fieldsBeforeStartTime = ['S', ...Array.from({ length: 18 }, (_unused, i) => String(i))];
  return `${PID} (${comm}) ${fieldsBeforeStartTime.join(' ')} ${startTicks} 0 0\n`;
}

function deps(overrides: Partial<ProcessStartIdentityDeps>): ProcessStartIdentityDeps {
  return {
    platform: 'linux',
    readFile: () => {
      throw new Error('ENOENT');
    },
    run: () => null,
    ...overrides,
  };
}

function linuxFiles(stat: string, bootId: string = `${BOOT_ID}\n`): (path: string) => string {
  return (path) => {
    if (path === `/proc/${PID}/stat`) return stat;
    if (path === '/proc/sys/kernel/random/boot_id') return bootId;
    throw new Error(`unexpected read of ${path}`);
  };
}

describe('readProcessStartIdentity', () => {
  it('is the boot id and the raw start ticks on Linux, with no helper program', () => {
    const run = vi.fn(() => null);
    const identity = readProcessStartIdentity(
      PID,
      deps({ readFile: linuxFiles(procStat('node', START_TICKS)), run }),
    );
    expect(identity).toBe(`linux:${BOOT_ID}:${START_TICKS}`);
    expect(run).not.toHaveBeenCalled();
  });

  it('never reads the boot time on Linux, so a stepped wall clock cannot change the identity', () => {
    const readFile = vi.fn(linuxFiles(procStat('node', START_TICKS)));
    readProcessStartIdentity(PID, deps({ readFile }));
    // `btime` in /proc/stat is the wall-clock boot time and moves with the
    // clock; an identity built on it would differ across a clock step.
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain('/proc/stat');
  });

  it('finds the start ticks behind a command name that holds spaces and parentheses', () => {
    const identity = readProcessStartIdentity(
      PID,
      deps({ readFile: linuxFiles(procStat('my (odd) name) 1 2 3', START_TICKS)) }),
    );
    expect(identity).toBe(`linux:${BOOT_ID}:${START_TICKS}`);
  });

  it('is null on Linux when the process has no /proc entry', () => {
    expect(readProcessStartIdentity(PID, deps({}))).toBeNull();
  });

  it('is null on Linux when the boot id cannot be read, never an identity without it', () => {
    const noBootId = (path: string): string => {
      if (path === `/proc/${PID}/stat`) return procStat('node', START_TICKS);
      throw new Error('EACCES');
    };
    expect(readProcessStartIdentity(PID, deps({ readFile: noBootId }))).toBeNull();
    expect(
      readProcessStartIdentity(
        PID,
        deps({ readFile: linuxFiles(procStat('node', START_TICKS), '\n') }),
      ),
    ).toBeNull();
  });

  it('is null on Linux when the start field is not a tick count', () => {
    expect(
      readProcessStartIdentity(PID, deps({ readFile: linuxFiles(procStat('node', 'abc')) })),
    ).toBeNull();
  });

  it('is the creation FILETIME PowerShell prints on Windows', () => {
    const run = vi.fn(() => ({ status: 0, stdout: `${WINDOWS_FILE_TIME}\r\n` }));
    const identity = readProcessStartIdentity(PID, deps({ platform: 'win32', run }));
    expect(identity).toBe(`win32:${WINDOWS_FILE_TIME}`);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('powershell.exe');
    expect(args.join(' ')).toContain(`Get-Process -Id ${PID}`);
    expect(args.join(' ')).toContain('ToFileTimeUtc()');
  });

  it('is null on Windows when the helper fails, cannot be run, or prints something else', () => {
    expect(
      readProcessStartIdentity(
        PID,
        deps({ platform: 'win32', run: () => ({ status: 1, stdout: '' }) }),
      ),
    ).toBeNull();
    expect(readProcessStartIdentity(PID, deps({ platform: 'win32', run: () => null }))).toBeNull();
    expect(
      readProcessStartIdentity(
        PID,
        deps({ platform: 'win32', run: () => ({ status: 0, stdout: 'Get-Process : denied' }) }),
      ),
    ).toBeNull();
  });

  it('is the start time ps prints on macOS, with its spacing folded', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'Sun Oct  4 12:30:00 2026\n' }));
    const identity = readProcessStartIdentity(PID, deps({ platform: 'darwin', run }));
    expect(identity).toBe('darwin:Sun Oct 4 12:30:00 2026');
    const [command, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('ps');
    expect(args).toEqual(['-o', 'lstart=', '-p', String(PID)]);
  });

  it('is null on macOS when ps fails or prints nothing', () => {
    expect(
      readProcessStartIdentity(
        PID,
        deps({ platform: 'darwin', run: () => ({ status: 1, stdout: '' }) }),
      ),
    ).toBeNull();
    expect(
      readProcessStartIdentity(
        PID,
        deps({ platform: 'darwin', run: () => ({ status: 0, stdout: '  \n' }) }),
      ),
    ).toBeNull();
  });

  it('is unknown, with nothing run, on a platform whose start time moves with the clock', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'Sun Oct  4 12:30:00 2026\n' }));
    for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      expect(readProcessStartIdentity(PID, deps({ platform, run })), platform).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('is null for a pid that cannot be one', () => {
    const run = vi.fn(() => ({ status: 0, stdout: WINDOWS_FILE_TIME }));
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(
        readProcessStartIdentity(pid, deps({ platform: 'win32', run })),
        String(pid),
      ).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('never throws when a dependency does', () => {
    const run = (): never => {
      throw new Error('spawn failed');
    };
    expect(readProcessStartIdentity(PID, deps({ platform: 'win32', run }))).toBeNull();
    expect(readProcessStartIdentity(PID, deps({ platform: 'darwin', run }))).toBeNull();
  });

  it('gives readings of two platforms prefixes that cannot compare equal', () => {
    const linux = readProcessStartIdentity(
      PID,
      deps({ readFile: linuxFiles(procStat('node', START_TICKS)) }),
    );
    const windows = readProcessStartIdentity(
      PID,
      deps({ platform: 'win32', run: () => ({ status: 0, stdout: String(START_TICKS) }) }),
    );
    expect(linux).not.toBe(windows);
  });
});

describe('startIdentityQuerySpawns', () => {
  it('is false only where the identity is read from a file', () => {
    expect(startIdentityQuerySpawns('linux')).toBe(false);
    expect(startIdentityQuerySpawns('win32')).toBe(true);
    expect(startIdentityQuerySpawns('darwin')).toBe(true);
  });
});
