#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const hookPath = resolve(repoRoot, '.githooks', 'pre-commit');

const LOG_PREFIX = '[install-hooks]';

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

try {
  const version = git(['--version']);
  const match = version.match(/(\d+)\.(\d+)/);
  if (match) {
    const [, major, minor] = match.map(Number);
    if (major < 2 || (major === 2 && minor < 9)) {
      console.error(
        `${LOG_PREFIX} git ${version} does not support core.hooksPath (need >= 2.9). Upgrade git.`,
      );
      process.exit(1);
    }
  }
} catch (err) {
  console.error(`${LOG_PREFIX} could not detect git version: ${err.message}`);
  process.exit(1);
}

if (!existsSync(hookPath)) {
  console.error(`${LOG_PREFIX} hook script not found at ${hookPath}`);
  process.exit(1);
}

git(['config', 'core.hooksPath', '.githooks']);

if (process.platform !== 'win32') {
  try {
    chmodSync(hookPath, 0o755);
  } catch (err) {
    console.warn(`${LOG_PREFIX} could not chmod hook (continuing): ${err.message}`);
  }
}

try {
  execFileSync('git', ['update-index', '--chmod=+x', '.githooks/pre-commit'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
} catch {
  // file may not be tracked yet; harmless
}

console.log(
  `${LOG_PREFIX} core.hooksPath set to .githooks. Pre-commit lockfile guard and staged-file formatting active.`,
);
