#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const lockfilePath = resolve(repoRoot, 'package-lock.json');
const snapshotPath = resolve(__dirname, 'cross-platform-lockfile-entries.json');

const LOG_PREFIX = '[snapshot]';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const lockfile = readJson(lockfilePath);

if (lockfile.lockfileVersion !== 3) {
  console.error(
    `${LOG_PREFIX} expected lockfileVersion 3, got ${lockfile.lockfileVersion}. Update this script.`,
  );
  process.exit(1);
}

const filtered = Object.entries(lockfile.packages ?? {})
  .filter(([key, value]) => key !== '' && value && value.optional === true && value.peer === true)
  .sort(([a], [b]) => a.localeCompare(b));

if (filtered.length === 0) {
  console.error(`${LOG_PREFIX} no peer-optional entries found in current lockfile.`);
  console.error(
    `${LOG_PREFIX} the lockfile may already be pruned: regenerate it on Linux/WSL or pull a clean copy from CI before running this command.`,
  );
  process.exit(1);
}

const newEntries = Object.fromEntries(filtered);
const newKeys = Object.keys(newEntries);

let oldKeys = [];
if (existsSync(snapshotPath)) {
  try {
    const old = readJson(snapshotPath);
    oldKeys = Object.keys(old.entries ?? {});
  } catch {
    // ignore — treat as no prior snapshot
  }
}

const added = newKeys.filter((k) => !oldKeys.includes(k));
const removed = oldKeys.filter((k) => !newKeys.includes(k));

const snapshot = {
  _comment:
    'Lockfile entries that npm prunes on Windows but are required on Linux/CI. Regenerate with: npm run snapshot-cross-platform-deps',
  lockfileVersion: 3,
  entries: newEntries,
};

writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');

console.log(
  `${LOG_PREFIX} captured ${newKeys.length} entr${newKeys.length === 1 ? 'y' : 'ies'}: ${newKeys.join(', ')}`,
);
if (added.length) console.log(`${LOG_PREFIX} added vs prior snapshot: ${added.join(', ')}`);
if (removed.length) console.log(`${LOG_PREFIX} removed vs prior snapshot: ${removed.join(', ')}`);
