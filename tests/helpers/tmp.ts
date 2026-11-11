import { afterEach } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REMOVE_BUDGET_MS = 10_000;
const REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows the launcher dies at once but the real Godot only a moment later (kill-on-close job object), still holding the directory, so a bare rmSync fails with EBUSY.
// The retry is its own loop because rmSync's maxRetries did not wait this out (measured on Node 22).
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

/** Handlers that write into the project they are given never touch the committed fixture directory. */
export function copyProjectToTmp(fixtureDir: string, prefix = 'mcp-fixture-copy-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

export interface TmpDirHandle {
  track(dir: string): string;
  make(prefix?: string): string;
  makeProject(prefix?: string, content?: string): string;
}

const DEFAULT_PROJECT_GODOT = 'config_version=5\n';

const FEATURES_LINE_REGEX = /^config\/features=.*\r?\n/m;

/** Every scene mutation on a project whose stated version is older than the running engine leads with a warning; call this on a tmp copy so exact-payload assertions hold on every CI engine. Never call it on a committed fixture. */
export function dropProjectFeatureVersion(projectDir: string): void {
  const projectFile = join(projectDir, 'project.godot');
  const content = readFileSync(projectFile, 'utf8');
  writeFileSync(projectFile, content.replace(FEATURES_LINE_REGEX, ''), 'utf8');
}

export function useTmpDirs(): TmpDirHandle {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        removeTmpDir(d);
      } catch {}
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
