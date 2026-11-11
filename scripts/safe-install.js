#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const lockfilePath = resolve(repoRoot, 'package-lock.json');
const snapshotPath = resolve(__dirname, 'cross-platform-lockfile-entries.json');

const LOG_PREFIX = '[safe-install]';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const passthroughArgs = process.argv.slice(2);
const installArgs = ['install', ...passthroughArgs];

console.log(`${LOG_PREFIX} running: ${npmCmd} ${installArgs.join(' ')}`);
const result = spawnSync(npmCmd, installArgs, {
  stdio: 'inherit',
  cwd: repoRoot,
  shell: isWindows,
});

if (result.error) {
  console.error(`${LOG_PREFIX} failed to spawn npm: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`${LOG_PREFIX} npm install failed (exit ${result.status}); not touching lockfile`);
  process.exit(result.status ?? 1);
}

if (!existsSync(snapshotPath)) {
  console.warn(`${LOG_PREFIX} snapshot file not found at ${snapshotPath}; skipping restoration`);
  process.exit(0);
}

let snapshot;
try {
  snapshot = readJson(snapshotPath);
} catch (err) {
  console.error(`${LOG_PREFIX} snapshot file is malformed JSON: ${err.message}`);
  process.exit(1);
}

const lockfile = readJson(lockfilePath);

if (lockfile.lockfileVersion !== 3) {
  console.error(
    `${LOG_PREFIX} expected lockfileVersion 3, got ${lockfile.lockfileVersion}. Update this script.`,
  );
  process.exit(1);
}

if (snapshot.lockfileVersion !== lockfile.lockfileVersion) {
  console.warn(
    `${LOG_PREFIX} snapshot lockfileVersion (${snapshot.lockfileVersion}) differs from lockfile (${lockfile.lockfileVersion}); proceeding best-effort`,
  );
}

const restored = [];
for (const [key, value] of Object.entries(snapshot.entries ?? {})) {
  if (!Object.prototype.hasOwnProperty.call(lockfile.packages, key)) {
    lockfile.packages[key] = value;
    restored.push(key);
  }
}

if (restored.length === 0) {
  console.log(`${LOG_PREFIX} lockfile clean, no restoration needed`);
  process.exit(0);
}

const rootEntry = lockfile.packages[''];
const sortedKeys = Object.keys(lockfile.packages)
  .filter((k) => k !== '')
  .sort((a, b) => a.localeCompare(b));
const reordered = { '': rootEntry };
for (const key of sortedKeys) reordered[key] = lockfile.packages[key];
lockfile.packages = reordered;

writeJson(lockfilePath, lockfile);
console.log(
  `${LOG_PREFIX} restored ${restored.length} pruned entr${restored.length === 1 ? 'y' : 'ies'}: ${restored.join(', ')}`,
);
