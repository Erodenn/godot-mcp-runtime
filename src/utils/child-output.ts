/**
 * Turning a child process's stdout or stderr bytes into text and lines.
 *
 * A pipe delivers bytes in chunks whose boundaries fall anywhere, including
 * inside a multi-byte UTF-8 sequence and inside a line. Decoding each chunk by
 * itself turns a split sequence into two U+FFFD characters, and classifying a
 * chunk's last segment as a line reads half a line as a whole one.
 */

import { StringDecoder } from 'string_decoder';

const TRAILING_CARRIAGE_RETURN = /\r$/;

/**
 * Longest line held while waiting for its newline. A stream that never sends
 * one (a progress bar, binary noise) would otherwise grow the pending text
 * without limit. Past this the line is emitted cut, with a marker, and the
 * rest of it is dropped up to the next newline.
 */
export const MAX_PENDING_LINE_CHARS = 65536;

export function truncatedLineMarker(limit: number): string {
  return ` <truncated: line exceeded ${limit} characters>`;
}

/**
 * Decodes one child stream as UTF-8 across chunk boundaries. `write` returns
 * the text that is complete so far; `end` returns what the stream closed on.
 */
export class Utf8StreamDecoder {
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer | string): string {
    return typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
  }

  end(): string {
    return this.decoder.end();
  }
}

/**
 * Splits decoded text into complete lines. Only text followed by a newline is
 * a line: the tail of a chunk is held until the chunk that finishes it, or
 * until `end`. A line carries no terminator (the `\r` Windows writes before
 * the `\n` goes with it).
 */
export class LineAssembler {
  private pending = '';
  /** True while the rest of an over-long line is being dropped. */
  private discarding = false;

  constructor(private readonly maxPendingChars: number = MAX_PENDING_LINE_CHARS) {}

  /** Complete lines made available by `text`, in order. */
  push(text: string): string[] {
    if (text === '') return [];
    const lines: string[] = [];
    let rest = text;
    while (rest !== '') {
      const newline = rest.indexOf('\n');
      if (newline === -1) {
        this.hold(rest, lines);
        break;
      }
      const segment = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        // The newline that ends the over-long line. Its head already went out.
        this.discarding = false;
        continue;
      }
      this.hold(segment, lines);
      if (this.discarding) {
        // `hold` emitted the cut line; this newline is its end.
        this.discarding = false;
        continue;
      }
      lines.push(this.pending.replace(TRAILING_CARRIAGE_RETURN, ''));
      this.pending = '';
    }
    return lines;
  }

  /**
   * The line the stream ended on without a newline, or null when there was
   * none. Resets the assembler.
   */
  end(): string | null {
    const tail = this.pending.replace(TRAILING_CARRIAGE_RETURN, '');
    this.pending = '';
    this.discarding = false;
    return tail === '' ? null : tail;
  }

  /** Text held for a line that has not ended yet. */
  get pendingText(): string {
    return this.pending;
  }

  private hold(text: string, lines: string[]): void {
    if (this.discarding) return;
    const room = this.maxPendingChars - this.pending.length;
    if (text.length <= room) {
      this.pending += text;
      return;
    }
    lines.push(this.pending + text.slice(0, room) + truncatedLineMarker(this.maxPendingChars));
    this.pending = '';
    this.discarding = true;
  }
}
