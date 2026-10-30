#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const LOG_PREFIX = '[comment-share]';
const GIT_MAX_BUFFER = 1 << 26;
const PERCENT = 100;

export const SCANNED_ROOTS = ['src/', 'tests/'];
export const MAX_COMMENT_RUN_LINES = 2;
export const MAX_COMMENT_SHARE = 0.3;
export const MIN_COMMENT_LINES_FOR_SHARE = 4;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const TS_COMMENT_START = /^(\/\/|\/\*|\*(\s|\/|$))/;
const GD_COMMENT_START = /^#/;

function isScanned(path) {
  return SCANNED_ROOTS.some((root) => path.startsWith(root)) && /\.(ts|gd)$/.test(path);
}

function isCommentLine(path, text) {
  const trimmed = text.trim();
  return (path.endsWith('.gd') ? GD_COMMENT_START : TS_COMMENT_START).test(trimmed);
}

/**
 * Reads a `git diff --unified=0` and returns one entry per scanned file:
 * { path, commentLines, codeLines, share, longestRun, longestRunLine }.
 * Only added lines count; blank added lines are ignored. A run is consecutive
 * added comment lines within one hunk.
 */
export function measureDiff(diffText) {
  const files = new Map();
  let current = null;
  let nextLine = 0;
  let run = 0;
  let runStart = 0;

  const endRun = () => {
    if (current && run > current.longestRun) {
      current.longestRun = run;
      current.longestRunLine = runStart;
    }
    run = 0;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      endRun();
      const target = line.slice(4).replace(/^b\//, '');
      current = null;
      if (isScanned(target)) {
        current = files.get(target) ?? {
          path: target,
          commentLines: 0,
          codeLines: 0,
          share: 0,
          longestRun: 0,
          longestRunLine: 0,
        };
        files.set(target, current);
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      endRun();
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!current || !line.startsWith('+')) continue;

    const text = line.slice(1);
    if (text.trim() !== '') {
      if (isCommentLine(current.path, text)) {
        if (run === 0) runStart = nextLine;
        run += 1;
        current.commentLines += 1;
      } else {
        endRun();
        current.codeLines += 1;
      }
    } else {
      endRun();
    }
    nextLine += 1;
  }
  endRun();

  for (const file of files.values()) {
    const added = file.commentLines + file.codeLines;
    file.share = added === 0 ? 0 : file.commentLines / added;
  }
  return [...files.values()];
}

/** Returns one ASCII warning string per file that adds too many comments. */
export function warningsFor(measurements) {
  const warnings = [];
  for (const file of measurements) {
    if (file.longestRun > MAX_COMMENT_RUN_LINES) {
      warnings.push(
        `${file.path}:${file.longestRunLine} adds a ${file.longestRun}-line comment run ` +
          `(limit ${MAX_COMMENT_RUN_LINES}).`,
      );
    }
    if (file.commentLines >= MIN_COMMENT_LINES_FOR_SHARE && file.share > MAX_COMMENT_SHARE) {
      warnings.push(
        `${file.path} adds ${file.commentLines} comment lines against ${file.codeLines} ` +
          `code lines (${Math.round(file.share * PERCENT)}% comments, limit ` +
          `${Math.round(MAX_COMMENT_SHARE * PERCENT)}%).`,
      );
    }
  }
  return warnings;
}

function readStagedDiff() {
  return execFileSync(
    'git',
    ['diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff', '--', 'src', 'tests'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Warns on stderr and returns the warning count. Never throws: a failure
 * reading the diff prints one note and counts as no warnings.
 */
export function reportStagedComments(readDiff = readStagedDiff, write = console.error) {
  let warnings;
  try {
    warnings = warningsFor(measureDiff(readDiff()));
  } catch (err) {
    write(
      `${LOG_PREFIX} skipped: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`,
    );
    return 0;
  }
  if (warnings.length === 0) return 0;
  write('');
  for (const warning of warnings) write(`${LOG_PREFIX} warning: ${warning}`);
  write(
    `${LOG_PREFIX} See the Comments section in CONTRIBUTING.md. This does not block the commit.`,
  );
  write('');
  return warnings.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportStagedComments();
  process.exit(0);
}
