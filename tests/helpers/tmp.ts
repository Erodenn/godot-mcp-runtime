/**
 * Shared tmp-directory helper for tests that need an isolated filesystem.
 *
 * Tests that mutate disk state (writing project.godot, copying fixtures, etc.)
 * should create their dirs through this helper. Pair with `useTmpDirs()`
 * inside a `describe` block — the returned `track()` registers the dir for
 * `afterEach` cleanup so a failing test doesn't leak orphans into later runs.
 */

import { afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface TmpDirHandle {
  /** Track an already-created dir so it gets cleaned up after each test. */
  track(dir: string): string;
  /** mkdtemp + track in one call. */
  make(prefix?: string): string;
  /** mkdtemp + write a minimal project.godot + track. */
  makeProject(prefix?: string, content?: string): string;
}

const DEFAULT_PROJECT_GODOT = 'config_version=5\n';

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
        rmSync(d, { recursive: true, force: true });
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
