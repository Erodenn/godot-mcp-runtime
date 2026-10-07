/**
 * Decoding and line assembly for child process output: a UTF-8 sequence or a
 * line cut by a pipe chunk boundary must come out whole.
 */

import { describe, it, expect } from 'vitest';
import {
  LineAssembler,
  MAX_PENDING_LINE_CHARS,
  Utf8StreamDecoder,
  truncatedLineMarker,
} from '../../src/utils/child-output.js';

const REPLACEMENT_CHARACTER = '�';
/** A small cap, so the over-long-line cases need no megabyte strings. */
const SMALL_PENDING_CAP = 8;

describe('Utf8StreamDecoder', () => {
  it('joins a multi-byte character split across two chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const bytes = Buffer.from('{"name":"José"}', 'utf8');
    // Cut inside the two-byte sequence for the e-acute.
    const cut = bytes.indexOf(0xc3) + 1;

    const text = decoder.write(bytes.subarray(0, cut)) + decoder.write(bytes.subarray(cut));

    expect(text + decoder.end()).toBe('{"name":"José"}');
    expect(text).not.toContain(REPLACEMENT_CHARACTER);
  });

  it('joins a four-byte character delivered one byte at a time', () => {
    const decoder = new Utf8StreamDecoder();
    const bytes = Buffer.from('a\u{1F600}b', 'utf8');
    let text = '';
    for (const byte of bytes) text += decoder.write(Buffer.from([byte]));

    expect(text + decoder.end()).toBe('a\u{1F600}b');
  });

  it('shows that decoding each chunk alone is what corrupts the character', () => {
    const bytes = Buffer.from('é', 'utf8');
    const perChunk = bytes.subarray(0, 1).toString() + bytes.subarray(1).toString();
    expect(perChunk).toContain(REPLACEMENT_CHARACTER);
  });

  it('returns what an incomplete sequence at the end of the stream decodes to', () => {
    const decoder = new Utf8StreamDecoder();
    const bytes = Buffer.from('é', 'utf8');
    expect(decoder.write(bytes.subarray(0, 1))).toBe('');
    // The stream ended mid-sequence: the remainder is surfaced, not lost.
    expect(decoder.end()).toBe(REPLACEMENT_CHARACTER);
  });

  it('passes text through unchanged', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.write('already text')).toBe('already text');
  });
});

describe('LineAssembler', () => {
  it('returns only lines that have ended, and holds the rest', () => {
    const lines = new LineAssembler();
    expect(lines.push('one\ntwo\nthr')).toEqual(['one', 'two']);
    expect(lines.pendingText).toBe('thr');
    expect(lines.push('ee\n')).toEqual(['three']);
    expect(lines.pendingText).toBe('');
  });

  it('removes the carriage return of a Windows line ending, also when the chunk cut between the two', () => {
    const lines = new LineAssembler();
    expect(lines.push('first\r\nsecond\r')).toEqual(['first']);
    expect(lines.push('\nthird\r\n')).toEqual(['second', 'third']);
  });

  it('returns an empty line as an empty string, for the caller to keep or drop', () => {
    const lines = new LineAssembler();
    expect(lines.push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('hands over the unfinished last line when the stream ends, once', () => {
    const lines = new LineAssembler();
    lines.push('done\nlast words');
    expect(lines.end()).toBe('last words');
    expect(lines.end()).toBeNull();
  });

  it('reports no last line when the stream ended on a newline', () => {
    const lines = new LineAssembler();
    lines.push('done\n');
    expect(lines.end()).toBeNull();
  });

  it('cuts a line that passes the cap, marks the cut, and drops the rest of it up to its newline', () => {
    const lines = new LineAssembler(SMALL_PENDING_CAP);
    expect(lines.push('12345')).toEqual([]);
    expect(lines.push('6789abc')).toEqual(['12345678' + truncatedLineMarker(SMALL_PENDING_CAP)]);
    // Still inside the same over-long line: nothing is held or returned.
    expect(lines.push('more of the same line')).toEqual([]);
    expect(lines.pendingText).toBe('');
    expect(lines.push(' and its end\nnext\n')).toEqual(['next']);
  });

  it('cuts an over-long line that arrives whole in one chunk', () => {
    const lines = new LineAssembler(SMALL_PENDING_CAP);
    expect(lines.push('123456789abcdef\nshort\n')).toEqual([
      '12345678' + truncatedLineMarker(SMALL_PENDING_CAP),
      'short',
    ]);
  });

  it('never holds more than the cap, whatever a newline-free stream sends', () => {
    const lines = new LineAssembler();
    const chunk = 'x'.repeat(MAX_PENDING_LINE_CHARS / 2);
    let emitted = 0;
    for (let i = 0; i < 10; i += 1) {
      emitted += lines.push(chunk).length;
      expect(lines.pendingText.length).toBeLessThanOrEqual(MAX_PENDING_LINE_CHARS);
    }
    expect(emitted).toBe(1);
  });
});
