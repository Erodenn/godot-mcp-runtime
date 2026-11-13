import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  earlierNotedReleases,
  earlierNotesLine,
  tagsWithNotes,
} from '../../scripts/release-notes-links.js';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'release-notes-links.js');
const REPO = 'owner/repo';
const NOTED = ['v3.7.0', 'v4.0.0', 'v4.2.0', 'v4.10.0', 'v5.0.0'];

describe('release-notes-links', () => {
  it('reads tags from notes file names and skips anything else', () => {
    expect(tagsWithNotes(['v4.0.0.md', 'README.md', 'v4.1.0-rc.1.md', 'v4.1.md'])).toEqual([
      'v4.0.0',
    ]);
  });

  it('lists earlier noted releases of the same major, newest first', () => {
    expect(earlierNotedReleases('v4.11.2', NOTED)).toEqual(['v4.10.0', 'v4.2.0', 'v4.0.0']);
  });

  it('leaves out the release itself, later releases and other majors', () => {
    expect(earlierNotedReleases('v4.2.0', NOTED)).toEqual(['v4.0.0']);
    expect(earlierNotedReleases('v4.0.0', NOTED)).toEqual([]);
  });

  it('returns nothing for a tag that is not a stable version', () => {
    expect(earlierNotedReleases('v4.3.0-rc.1', NOTED)).toEqual([]);
    expect(earlierNotesLine('archive/release-4.0', NOTED, REPO)).toBe('');
  });

  it('formats the links as one line', () => {
    expect(earlierNotesLine('v4.2.1', NOTED, REPO)).toBe(
      '**Earlier 4.x release notes**: ' +
        '[v4.2.0](https://github.com/owner/repo/releases/tag/v4.2.0), ' +
        '[v4.0.0](https://github.com/owner/repo/releases/tag/v4.0.0)',
    );
  });

  it('prints the line for a tag from the committed notes folder', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'v4.0.1', REPO], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[v4.0.0](https://github.com/owner/repo/releases/tag/v4.0.0)');
  });
});
