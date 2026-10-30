// Chunk boundaries fall anywhere, including inside a UTF-8 sequence (decoded alone it becomes two U+FFFD) and inside a line.

import { StringDecoder } from 'string_decoder';

const TRAILING_CARRIAGE_RETURN = /\r$/;

/** Longest line held awaiting its newline; past it the line is emitted cut, with a marker, and the rest dropped up to the next newline. */
export const MAX_PENDING_LINE_CHARS = 65536;

export function truncatedLineMarker(limit: number): string {
  return ` <truncated: line exceeded ${limit} characters>`;
}

/** Decodes one child stream as UTF-8 across chunk boundaries. */
export class Utf8StreamDecoder {
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer | string): string {
    return typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
  }

  end(): string {
    return this.decoder.end();
  }
}

/** Splits decoded text into complete lines; the tail of a chunk is held until finished or `end`. A line has no terminator (a Windows `\r` goes with it). */
export class LineAssembler {
  private pending = '';
  private discarding = false;

  constructor(private readonly maxPendingChars: number = MAX_PENDING_LINE_CHARS) {}

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

  /** The line the stream ended on without a newline, or null; resets the assembler. */
  end(): string | null {
    const tail = this.pending.replace(TRAILING_CARRIAGE_RETURN, '');
    this.pending = '';
    this.discarding = false;
    return tail === '' ? null : tail;
  }

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
