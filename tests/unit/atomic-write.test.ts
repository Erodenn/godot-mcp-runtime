import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { writeFileAtomicSync } from '../../src/utils/atomic-write.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

describe('writeFileAtomicSync', () => {
  it('writes the given content to the target path', () => {
    const dir = tmp.make('atomic-write-');
    const target = join(dir, 'file.txt');
    writeFileAtomicSync(target, 'hello world');
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('leaves no .tmp file behind after a successful write', () => {
    const dir = tmp.make('atomic-write-');
    const target = join(dir, 'file.txt');
    writeFileAtomicSync(target, 'content');
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites existing content at the target path', () => {
    const dir = tmp.make('atomic-write-');
    const target = join(dir, 'file.txt');
    writeFileAtomicSync(target, 'first');
    writeFileAtomicSync(target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('only ever leaves the target file in the directory, never a stray temp file', () => {
    const dir = tmp.make('atomic-write-');
    const target = join(dir, 'file.txt');
    writeFileAtomicSync(target, 'only content');
    expect(readdirSync(dir)).toEqual(['file.txt']);
    expect(existsSync(target)).toBe(true);
  });
});
