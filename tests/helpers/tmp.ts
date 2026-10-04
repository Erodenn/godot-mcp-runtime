/**
 * Shared tmp-directory helper for tests that need an isolated filesystem.
 *
 * Tests that mutate disk state (writing project.godot, copying fixtures, etc.)
 * should create their dirs through this helper. Pair with `useTmpDirs()`
 * inside a `describe` block: the returned `track()` registers the dir for
 * `afterEach` cleanup so a failing test doesn't leak orphans into later runs.
 */

import { afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REMOVE_BUDGET_MS = 10_000;
const REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** Block this thread for `ms` without spinning. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a temp directory, retrying while something still holds it. On
 * Windows the suite starts Godot through a launcher exe, so killing a game
 * kills the launcher at once and the real Godot only dies a moment later (the
 * kill-on-close job object), still holding the directory: a bare `rmSync`
 * right after a stop fails with EBUSY. The retry is a loop of its own because
 * `rmSync`'s `maxRetries` did not wait this case out (measured on Node 22).
 */
export function removeTmpDir(dir: string): void {
  const deadline = Date.now() + REMOVE_BUDGET_MS;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE_REMOVE_CODES.has(code) || Date.now() >= deadline) {
        throw error;
      }
      sleepSync(REMOVE_RETRY_DELAY_MS);
    }
  }
}

export interface TmpDirHandle {
  /** Track an already-created dir so it gets cleaned up after each test. */
  track(dir: string): string;
  /** mkdtemp + track in one call. */
  make(prefix?: string): string;
  /** mkdtemp + write a minimal project.godot + track. */
  makeProject(prefix?: string, content?: string): string;
}

const DEFAULT_PROJECT_GODOT = 'config_version=5\n';

const FEATURES_LINE_REGEX = /^config\/features=.*\r?\n/m;

/**
 * Remove the `config/features` line from a tmp copy's project.godot, so the
 * project states no engine version. Every scene mutation on a project whose
 * stated version is older than the running engine leads with a warning; a test
 * that asserts an exact payload, or the absence of `warnings`, calls this
 * right after copying a fixture so its assertions hold on every engine in the
 * CI matrix. Never call it on a committed fixture directory.
 */
export function dropProjectFeatureVersion(projectDir: string): void {
  const projectFile = join(projectDir, 'project.godot');
  const content = readFileSync(projectFile, 'utf8');
  writeFileSync(projectFile, content.replace(FEATURES_LINE_REGEX, ''), 'utf8');
}

/**
 * Register an `afterEach` cleanup hook for tmp dirs created during the
 * enclosing describe block. Returns a handle whose methods all push into the
 * same internal list.
 */
export function useTmpDirs(): TmpDirHandle {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        removeTmpDir(d);
      } catch {
        // ignore cleanup errors
      }
    }
    dirs.length = 0;
  });

  return {
    track(dir: string): string {
      dirs.push(dir);
      return dir;
    },
    make(prefix = 'mcp-test-'): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    makeProject(prefix = 'mcp-test-', content = DEFAULT_PROJECT_GODOT): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      writeFileSync(join(dir, 'project.godot'), content, 'utf8');
      return dir;
    },
  };
}
