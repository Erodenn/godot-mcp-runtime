/**
 * Hand-written state-machine tokenizer for GDScript source.
 *
 * Used by `run-script-policy.ts` to evaluate scripts against the declarative
 * rule table. The tokenizer's job is to strip comments and string literals so
 * the policy never matches text inside `"OS.execute"` or `# OS.execute`, and
 * to coalesce member-access chains (`OS.execute`, `Foo.bar.baz`) into a single
 * `memberChain` token whose `chain` array the rules match against directly.
 *
 * Not a full GDScript parser — we only need enough to:
 *  - Recognize comments (`#` to EOL).
 *  - Skip string-literal contents in all GDScript forms (`"..."`, `'...'`,
 *    `"""..."""`, `'''...'''`).
 *  - Skip node-path literals (`$Foo/Bar`, `^"..."`) — their contents are
 *    Godot scene paths, not GDScript code. A `^` before anything but a quote
 *    is the XOR operator and is emitted as an `other` token.
 *  - Emit identifiers, member chains, parentheses, commas, and a small set
 *    of other punctuation. Everything else (operators, numbers) collapses to
 *    an `other` token the policy ignores.
 *  - Track line numbers and the rough start column of each token so policy
 *    findings can name the offending line.
 *
 * Line continuation (`\` at end of line) is handled by treating the next line
 * as a continuation of the current logical line for member-chain coalescing
 * purposes. The chain builder also reads across a continuation and across a
 * `#` comment on either side of a `.`, as GDScript itself does.
 *
 * This tokenizer is a best-effort accident guard, not a sound static
 * analysis — see `run-script-policy.ts` and `docs/security.md` for the full
 * doctrine. One structural blind spot worth stating plainly here, since it's
 * inherent to token-level scanning and not a gap the next feature closes:
 * identifier aliasing / dataflow is invisible. `var f = OS; f.execute(...)`
 * tokenizes as two unrelated identifiers — the tokenizer has no notion of
 * "what does this variable refer to," so a rule keyed on `OS.execute` never
 * fires. Do not mistake this for a TODO; closing it would require a dataflow
 * analysis, which is out of scope for a hand-written tokenizer by design.
 */

export type TokenKind =
  | 'identifier'
  | 'memberChain'
  | 'string'
  | 'number'
  | 'punct'
  | 'newline'
  | 'other';

export interface Token {
  kind: TokenKind;
  text: string;
  /** For memberChain, the dotted segments in order: `OS.execute` → `['OS','execute']`. */
  chain?: string[];
  line: number;
  column: number;
}

const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_PART_RE = /[A-Za-z0-9_]/;
const DIGIT_RE = /[0-9]/;
const NODE_PATH_CHAR_RE = /[A-Za-z0-9_/\\]/;

function isIdentStart(ch: string): boolean {
  return IDENT_START_RE.test(ch);
}
function isIdentPart(ch: string): boolean {
  return IDENT_PART_RE.test(ch);
}
function isDigit(ch: string): boolean {
  return DIGIT_RE.test(ch);
}
function isNodePathChar(ch: string): boolean {
  return NODE_PATH_CHAR_RE.test(ch);
}

/**
 * Skip inline whitespace (space/tab), newlines, backslash line continuations
 * and `#` comments starting at `pos`, tracking line/lineStart across any
 * newline crossed. Used by the member-chain builder to peek past everything
 * GDScript itself reads as insignificant around a `.` without committing to
 * the skip unless the peek finds what it's looking for (see the identifier
 * branch in `tokenize`).
 */
function skipWsAndNewlines(
  source: string,
  len: number,
  pos: number,
  line: number,
  lineStart: number,
): { pos: number; line: number; lineStart: number } {
  while (pos < len) {
    const c = source[pos];
    if (c === ' ' || c === '\t') {
      pos++;
      continue;
    }
    if (c === '\n') {
      pos++;
      line++;
      lineStart = pos;
      continue;
    }
    if (c === '\r') {
      pos++;
      if (pos < len && source[pos] === '\n') pos++;
      line++;
      lineStart = pos;
      continue;
    }
    if (c === '\\') {
      // A continuation is a backslash, optional blanks, then a line break. A
      // backslash followed by anything else is not skippable.
      let j = pos + 1;
      while (j < len && (source[j] === ' ' || source[j] === '\t')) j++;
      if (j >= len || (source[j] !== '\n' && source[j] !== '\r')) break;
      const crlf = source[j] === '\r' && source[j + 1] === '\n';
      pos = j + (crlf ? 2 : 1);
      line++;
      lineStart = pos;
      continue;
    }
    if (c === '#') {
      // A comment runs to the end of its line; the line break itself is
      // handled by the next iteration.
      while (pos < len && source[pos] !== '\n' && source[pos] !== '\r') pos++;
      continue;
    }
    break;
  }
  return { pos, line, lineStart };
}

/**
 * Tokens emitted by `tokenize`. Comments and string-literal contents are NOT
 * present — they are consumed silently. String literals as a whole are emitted
 * as a single `string` token so the policy can recognize "literal first
 * argument" patterns (e.g. `load("res://foo.tscn")`) without seeing the
 * characters inside.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const colOf = (pos: number): number => pos - lineStart + 1;

  while (i < len) {
    const ch = source[i]!;

    // Newline — emit, advance line counter.
    if (ch === '\n') {
      tokens.push({ kind: 'newline', text: '\n', line, column: colOf(i) });
      i++;
      line++;
      lineStart = i;
      continue;
    }

    // \r\n or bare \r — treat as newline.
    if (ch === '\r') {
      tokens.push({ kind: 'newline', text: '\n', line, column: colOf(i) });
      i++;
      if (i < len && source[i] === '\n') i++;
      line++;
      lineStart = i;
      continue;
    }

    // Whitespace.
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // Line continuation: `\` at end of line. Skip the backslash + newline so
    // the next physical line is treated as the same logical line for chain
    // coalescing. Don't emit a newline token in this case.
    if (ch === '\\') {
      let j = i + 1;
      while (j < len && (source[j] === ' ' || source[j] === '\t')) j++;
      if (j < len && (source[j] === '\n' || source[j] === '\r')) {
        i = j + 1;
        if (i < len && source[j] === '\r' && source[i] === '\n') i++;
        line++;
        lineStart = i;
        continue;
      }
      // Bare backslash is rare in GDScript outside strings; emit as other.
      tokens.push({ kind: 'other', text: '\\', line, column: colOf(i) });
      i++;
      continue;
    }

    // Comment: `#` to EOL. Consume silently.
    if (ch === '#') {
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }

    // String literals (all GDScript forms).
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const startCol = colOf(i);
      const quote = ch;
      // Triple-quoted?
      if (i + 2 < len && source[i + 1] === quote && source[i + 2] === quote) {
        i += 3;
        while (i < len) {
          if (source[i] === '\\' && i + 1 < len) {
            // Skip escaped char; track newlines inside the escape sequence.
            if (source[i + 1] === '\n') {
              line++;
              lineStart = i + 2;
            }
            i += 2;
            continue;
          }
          if (source[i] === '\n') {
            line++;
            lineStart = i + 1;
            i++;
            continue;
          }
          if (
            source[i] === quote &&
            i + 2 < len &&
            source[i + 1] === quote &&
            source[i + 2] === quote
          ) {
            i += 3;
            break;
          }
          i++;
        }
        tokens.push({ kind: 'string', text: '<triple-string>', line: startLine, column: startCol });
        continue;
      }
      // Single-line string.
      i++;
      while (i < len && source[i] !== quote && source[i] !== '\n' && source[i] !== '\r') {
        if (source[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < len && source[i] === quote) i++;
      tokens.push({ kind: 'string', text: '<string>', line: startLine, column: startCol });
      continue;
    }

    // Node-path literal: `$Foo/Bar` or `$"Foo Bar"`. Consume to whitespace,
    // newline, or a clear non-path delimiter.
    if (ch === '$') {
      const startLine = line;
      const startCol = colOf(i);
      i++;
      if (i < len && (source[i] === '"' || source[i] === "'")) {
        const quote = source[i]!;
        i++;
        while (i < len && source[i] !== quote && source[i] !== '\n') i++;
        if (i < len && source[i] === quote) i++;
      } else {
        while (i < len && isNodePathChar(source[i]!)) i++;
      }
      tokens.push({ kind: 'string', text: '<node-path>', line: startLine, column: startCol });
      continue;
    }

    // String-name literal: `^"..."`, an opaque string. A `^` followed by
    // anything else is the XOR operator, and what follows it is ordinary code
    // (`1^OS.execute(...)` must still reach the identifier branch).
    if (ch === '^') {
      const startLine = line;
      const startCol = colOf(i);
      const next = i + 1 < len ? source[i + 1] : '';
      if (next !== '"' && next !== "'") {
        tokens.push({ kind: 'other', text: '^', line, column: startCol });
        i++;
        continue;
      }
      i++;
      const quote = source[i]!;
      i++;
      while (i < len && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < len && source[i] === quote) i++;
      tokens.push({ kind: 'string', text: '<string-name>', line: startLine, column: startCol });
      continue;
    }

    // Number literal — emit but otherwise ignored by policy.
    if (isDigit(ch)) {
      const startLine = line;
      const startCol = colOf(i);
      const start = i;
      while (i < len && (isDigit(source[i]!) || source[i] === '.' || source[i] === '_')) {
        i++;
      }
      // Exponent.
      if (i < len && (source[i] === 'e' || source[i] === 'E')) {
        i++;
        if (i < len && (source[i] === '+' || source[i] === '-')) i++;
        while (i < len && isDigit(source[i]!)) i++;
      }
      tokens.push({
        kind: 'number',
        text: source.slice(start, i),
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Identifier or member chain. Build the chain by reading identifier
    // segments separated by `.` (with no whitespace between identifier and
    // dot — `foo .bar` is two tokens, but GDScript style is `foo.bar`).
    if (isIdentStart(ch)) {
      const startLine = line;
      const startCol = colOf(i);
      const start = i;
      while (i < len && isIdentPart(source[i]!)) i++;
      const first = source.slice(start, i);
      const chain: string[] = [first];
      let endText = first;
      // Continue the chain across `.identifier` segments, tolerating
      // whitespace and newlines both before and after the `.` — GDScript
      // already treats `a\n.b` inside parens as `a.b`, and a tight
      // "no whitespace" rule here was a skeleton key that let `OS .execute`,
      // `OS. execute`, and `OS.\n  execute` bypass every two-segment rule in
      // the policy table at once. Peek past whitespace/newlines for the `.`,
      // then past whitespace/newlines after the `.` for the next identifier
      // segment; only commit (advance i/line/lineStart) if both are found —
      // on failure nothing has moved, so a genuine `foo\nbar` (two separate
      // statements) still tokenizes as two identifiers and the skipped
      // whitespace/newline is re-scanned normally by the outer loop.
      while (i < len) {
        const beforeDot = skipWsAndNewlines(source, len, i, line, lineStart);
        if (beforeDot.pos >= len || source[beforeDot.pos] !== '.') break;
        const afterDot = skipWsAndNewlines(
          source,
          len,
          beforeDot.pos + 1,
          beforeDot.line,
          beforeDot.lineStart,
        );
        if (afterDot.pos >= len || !isIdentStart(source[afterDot.pos]!)) break;
        let k = afterDot.pos;
        while (k < len && isIdentPart(source[k]!)) k++;
        chain.push(source.slice(afterDot.pos, k));
        endText += '.' + source.slice(afterDot.pos, k);
        i = k;
        line = afterDot.line;
        lineStart = afterDot.lineStart;
      }
      if (chain.length > 1) {
        tokens.push({
          kind: 'memberChain',
          text: endText,
          chain,
          line: startLine,
          column: startCol,
        });
      } else {
        tokens.push({ kind: 'identifier', text: first, line: startLine, column: startCol });
      }
      continue;
    }

    // Punctuation we care about.
    if (ch === '(' || ch === ')' || ch === ',' || ch === '[' || ch === ']' || ch === '=') {
      tokens.push({ kind: 'punct', text: ch, line, column: colOf(i) });
      i++;
      continue;
    }

    // Anything else (operators, `:`, `.` outside member chain) — collapse to other.
    tokens.push({ kind: 'other', text: ch, line, column: colOf(i) });
    i++;
  }

  return tokens;
}

/**
 * Convenience: return only the non-newline, non-whitespace tokens. Useful for
 * policy rules that don't care about line structure.
 */
export function tokenizeStripped(source: string): Token[] {
  return tokenize(source).filter((t) => t.kind !== 'newline');
}
