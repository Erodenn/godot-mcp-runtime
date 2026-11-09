import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', 'src');
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const ALLOWED_CONTROL = new Set([TAB, LINE_FEED, CARRIAGE_RETURN]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('source text', () => {
  // A raw control byte makes grep treat the file as binary, which silently drops it from every line-based sweep.
  it('holds no control byte other than tab and line endings under src/', () => {
    const offenders = sourceFiles(SRC_ROOT).flatMap((file) => {
      const bytes = readFileSync(file);
      const at = bytes.findIndex((byte) => byte < FIRST_PRINTABLE && !ALLOWED_CONTROL.has(byte));
      return at === -1 ? [] : [`${file} at byte ${at}`];
    });
    expect(offenders).toEqual([]);
  });
});
