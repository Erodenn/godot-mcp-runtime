#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = resolve(__dirname, '..', '.github', 'release-notes');

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const NOTES_FILE = /^(v\d+\.\d+\.\d+)\.md$/;

function parseTag(tag) {
  const match = STABLE_TAG.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function tagsWithNotes(fileNames) {
  return fileNames.flatMap((name) => {
    const match = NOTES_FILE.exec(name);
    return match ? [match[1]] : [];
  });
}

export function earlierNotedReleases(tag, notedTags) {
  const current = parseTag(tag);
  if (!current) return [];
  return notedTags
    .map((noted) => ({ noted, version: parseTag(noted) }))
    .filter(
      ({ version }) =>
        version && version[0] === current[0] && compareVersions(version, current) < 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ noted }) => noted);
}

export function earlierNotesLine(tag, notedTags, repo) {
  const earlier = earlierNotedReleases(tag, notedTags);
  if (earlier.length === 0) return '';
  const major = parseTag(tag)[0];
  const links = earlier.map(
    (noted) => `[${noted}](https://github.com/${repo}/releases/tag/${noted})`,
  );
  return `**Earlier ${major}.x release notes**: ${links.join(', ')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, repo] = process.argv.slice(2);
  if (!tag || !repo) {
    console.error('usage: release-notes-links.js <tag> <owner/repo>');
    process.exit(1);
  }
  const line = earlierNotesLine(tag, tagsWithNotes(readdirSync(NOTES_DIR)), repo);
  if (line) process.stdout.write(`${line}\n`);
}
