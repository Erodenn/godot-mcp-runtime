import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// publish.yml appends the generated changelog, and GitHub caps the whole release body at 125,000 characters.
const HIGHLIGHTS_MAX_CHARS = 25000;
const NOTES_DIR = join(__dirname, '..', '..', '.github', 'release-notes');

describe('release notes', () => {
  const files = readdirSync(NOTES_DIR).filter((name) => name.endsWith('.md'));

  it.each(files)('%s leaves room for the generated changelog', (name) => {
    const text = readFileSync(join(NOTES_DIR, name), 'utf8');
    expect(text.length).toBeLessThanOrEqual(HIGHLIGHTS_MAX_CHARS);
  });
});
