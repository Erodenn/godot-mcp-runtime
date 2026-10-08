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
 *    `"""..."""`, `'''...'''`, and each of them with the raw prefix
 *    `r`). Every form may span lines.
 *  - Skip node-path literals (`$Foo/Bar`, `^"..."`) — their contents are
 *    Godot scene paths, not GDScript code. A `^` before anything but a quote
 *    is the XOR operator and is emitted as an `other` token. `&"..."` is a
 *    StringName literal and is one `string` token as well.
 *  - Read a parenthesised single identifier used as a receiver
 *    (`(OS).execute`) as the member chain it is (`OS.execute`).
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
 * analysis, which is out of scope for a hand-written tokenizer by design. The
 * policy answers the one step it can see, a guarded name used as a value
 * (`var f = OS`), with its alias rules; what happens to the value afterwards
 * stays invisible.
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
  /**
   * For identifier and memberChain tokens: true when the token is immediately
   * preceded by a `.` member access (past whitespace, newlines, continuations
   * and comments). `get_node("A").load(x)` and `$A.load(x)` leave `load` as a
   * bare identifier whose receiver the scanner cannot see; this flag is how a
   * rule that targets a global function tells it apart from a method call.
   */
  precededByDot?: boolean;
  /**
   * For identifier and memberChain tokens: true when the token directly
   * follows the `func` keyword, so it is the name a declaration gives a
   * function (`func load(slot):`) and not a use of that name.
   */
  precededByFunc?: boolean;
  /**
   * For a `string` token that is a quoted string, a `&"..."` StringName or a
   * `^"..."` NodePath: the characters between the quotes, exactly as written
   * (escapes not decoded; see `decodeStringLiteral`). The policy reads it only
   * to learn the method a reflective call names (`OS.call("execute")`); no
   * rule matches text inside a string.
   */
  literal?: string;
  /** For a `string` token: true when it carries the raw prefix (`r"..."`), so `literal` has no escapes to decode. */
  raw?: boolean;
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
 * Length of the line break at `pos` (2 for CRLF, 1 for LF or a bare CR, 0 when
 * `pos` is not at a line break).
 */
function lineBreakLength(source: string, len: number, pos: number): number {
  const c = source[pos];
  if (c === '\n') return 1;
  if (c === '\r') return pos + 1 < len && source[pos + 1] === '\n' ? 2 : 1;
  return 0;
}

/**
 * Consume a string body from `pos` (just past the opening delimiter) through
 * the first unescaped `closer`, which is the quote for a regular string and
 * three quotes for a triple-quoted one. Godot accepts a raw line break inside
 * either form, so a body runs across lines; line/lineStart track every break
 * crossed, escaped or not. An unterminated body runs to end of input.
 */
function skipStringBody(
  source: string,
  len: number,
  pos: number,
  closer: string,
  line: number,
  lineStart: number,
): { pos: number; line: number; lineStart: number } {
  while (pos < len) {
    if (source[pos] === '\\' && pos + 1 < len) {
      // Escaped character. An escaped line break continues the string.
      const escapedBreak = lineBreakLength(source, len, pos + 1);
      if (escapedBreak > 0) {
        pos += 1 + escapedBreak;
        line++;
        lineStart = pos;
      } else {
        pos += 2;
      }
      continue;
    }
    const brk = lineBreakLength(source, len, pos);
    if (brk > 0) {
      pos += brk;
      line++;
      lineStart = pos;
      continue;
    }
    if (source.startsWith(closer, pos)) {
      pos += closer.length;
      break;
    }
    pos++;
  }
  return { pos, line, lineStart };
}

/**
 * The characters of a string literal between its delimiters: from `bodyStart`
 * to the closing delimiter that ends at `end`, or to `end` itself when the
 * string is unterminated.
 */
function literalBody(source: string, bodyStart: number, end: number, closer: string): string {
  const closed = end - closer.length >= bodyStart && source.startsWith(closer, end - closer.length);
  return source.slice(bodyStart, closed ? end - closer.length : end);
}

/** What each single-character escape of a GDScript string stands for. */
const SIMPLE_STRING_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['"', '"'],
  ["'", "'"],
  ['\\', '\\'],
]);
/** Hex digits after `\u` and after `\U`. */
const UNICODE_ESCAPE_DIGITS: ReadonlyMap<string, number> = new Map([
  ['u', 4],
  ['U', 6],
]);
const HEX_DIGITS_REGEX = /^[0-9a-fA-F]+$/;
const HEX_RADIX = 16;
const MAX_CODE_POINT = 0x10ffff;

/**
 * The value a `string` token's literal has once GDScript has compiled it:
 * escapes decoded (`"execute"` is `execute`), an escaped line break
 * dropped. A raw string is its own value. Null when the token carries no
 * literal or holds an escape GDScript does not define, so the value is not
 * known here.
 */
export function decodeStringLiteral(token: Token): string | null {
  const body = token.literal;
  if (body === undefined) return null;
  if (token.raw === true || !body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const escaped = body[i + 1];
    if (escaped === undefined) return null;
    const breakLength = lineBreakLength(body, body.length, i + 1);
    if (breakLength > 0) {
      i += breakLength;
      continue;
    }
    const digits = UNICODE_ESCAPE_DIGITS.get(escaped);
    if (digits !== undefined) {
      const hex = body.slice(i + 2, i + 2 + digits);
      if (hex.length !== digits || !HEX_DIGITS_REGEX.test(hex)) return null;
      const codePoint = parseInt(hex, HEX_RADIX);
      if (codePoint > MAX_CODE_POINT) return null;
      out += String.fromCodePoint(codePoint);
      i += 1 + digits;
      continue;
    }
    const simple = SIMPLE_STRING_ESCAPES.get(escaped);
    if (simple === undefined) return null;
    out += simple;
    i++;
  }
  return out;
}

/** The raw-string prefix: `r"..."` is a string whose backslashes are literal. */
const RAW_STRING_PREFIX = 'r';

function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'";
}

/**
 * True when the last non-newline token is a member-access `.`. Newlines are
 * skipped to match how the chain builder joins across them; comments and
 * continuations never produce tokens, so they are skipped by construction.
 */
function lastTokenIsDot(tokens: readonly Token[]): boolean {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k]!;
    if (t.kind === 'newline') continue;
    return t.kind === 'other' && t.text === '.';
  }
  return false;
}

const FUNC_KEYWORD = 'func';

/** True when the token just emitted is the `func` keyword, so the next name is being declared. */
function lastTokenIsFunc(tokens: readonly Token[]): boolean {
  const last = tokens[tokens.length - 1];
  return last !== undefined && last.kind === 'identifier' && last.text === FUNC_KEYWORD;
}

/**
 * Keywords an opening parenthesis can directly follow without being a call:
 * after `return`, `(` groups an expression, while after any other name it
 * opens that name's argument list.
 */
const GROUPING_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'if',
  'elif',
  'else',
  'while',
  'for',
  'in',
  'and',
  'or',
  'not',
  'await',
  'match',
  'when',
  'assert',
  'is',
  'as',
]);

/**
 * True when a `(` at the current position opens an argument list: it directly
 * follows a name, a member chain, or the `)` or `]` that ends a callable
 * expression. A `(` anywhere else groups an expression.
 */
function parenOpensCall(tokens: readonly Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;
  if (last.kind === 'memberChain') return true;
  if (last.kind === 'identifier') return !GROUPING_KEYWORDS.has(last.text);
  return last.kind === 'punct' && (last.text === ')' || last.text === ']');
}

interface ScanPosition {
  pos: number;
  line: number;
  lineStart: number;
}

/**
 * Read `( name )`, with any number of nested parentheses around the one
 * identifier, starting at the `(` at `pos`. Returns the identifier and the
 * position just past the last `)`, or null when the parentheses hold anything
 * else.
 */
function readParenthesisedName(
  source: string,
  len: number,
  pos: number,
  line: number,
  lineStart: number,
): (ScanPosition & { name: string }) | null {
  let at: ScanPosition = { pos, line, lineStart };
  let depth = 0;
  while (at.pos < len && source[at.pos] === '(') {
    depth++;
    at = skipWsAndNewlines(source, len, at.pos + 1, at.line, at.lineStart);
  }
  if (at.pos >= len || !isIdentStart(source[at.pos]!)) return null;
  let end = at.pos;
  while (end < len && isIdentPart(source[end]!)) end++;
  const name = source.slice(at.pos, end);
  at = { ...at, pos: end };
  for (; depth > 0; depth--) {
    at = skipWsAndNewlines(source, len, at.pos, at.line, at.lineStart);
    if (at.pos >= len || source[at.pos] !== ')') return null;
    at = { ...at, pos: at.pos + 1 };
  }
  return { ...at, name };
}

/**
 * Read the `.identifier` segments that continue a member chain from `pos`,
 * tolerating whitespace, line breaks, continuations and comments both before
 * and after each `.`: GDScript already treats `a\n.b` inside parens as `a.b`,
 * and a tight "no whitespace" rule was a skeleton key that let `OS .execute`,
 * `OS. execute`, and `OS.\n  execute` bypass every two-segment rule in the
 * policy table at once. Each segment is committed only when both the `.` and
 * the identifier after it are found; on failure the returned position is where
 * the last committed segment ended, so a genuine `foo\nbar` (two separate
 * statements) still tokenizes as two identifiers and the skipped whitespace is
 * re-scanned normally by the caller.
 */
function readChainTail(
  source: string,
  len: number,
  pos: number,
  line: number,
  lineStart: number,
): ScanPosition & { segments: string[] } {
  const segments: string[] = [];
  let at: ScanPosition = { pos, line, lineStart };
  while (at.pos < len) {
    const beforeDot = skipWsAndNewlines(source, len, at.pos, at.line, at.lineStart);
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
    segments.push(source.slice(afterDot.pos, k));
    at = { pos: k, line: afterDot.line, lineStart: afterDot.lineStart };
  }
  return { ...at, segments };
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

    // String literals (all GDScript forms), with or without the raw prefix.
    const rawPrefixed = ch === RAW_STRING_PREFIX && isQuote(source[i + 1]);
    if (isQuote(ch) || rawPrefixed) {
      const startLine = line;
      const startCol = colOf(i);
      const quoteAt = rawPrefixed ? i + 1 : i;
      const quote = source[quoteAt]!;
      const triple = source[quoteAt + 1] === quote && source[quoteAt + 2] === quote;
      // A regular string ends at the matching unescaped quote, line breaks
      // included: Godot compiles a string with a raw newline in it. In a raw
      // string a backslash still keeps the quote after it from closing.
      const closer = triple ? quote.repeat(3) : quote;
      const bodyStart = quoteAt + closer.length;
      const body = skipStringBody(source, len, bodyStart, closer, line, lineStart);
      i = body.pos;
      line = body.line;
      lineStart = body.lineStart;
      tokens.push({
        kind: 'string',
        text: triple ? '<triple-string>' : '<string>',
        literal: literalBody(source, bodyStart, body.pos, closer),
        ...(rawPrefixed ? { raw: true } : {}),
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // StringName literal: `&"..."`. One string token, so a method named with
    // it (`OS.call(&"execute")`) reads as the literal it is. A `&` before
    // anything else is an operator.
    if (ch === '&' && i + 1 < len && (source[i + 1] === '"' || source[i + 1] === "'")) {
      const startLine = line;
      const startCol = colOf(i);
      const quote = source[i + 1]!;
      const bodyStart = i + 2;
      const body = skipStringBody(source, len, bodyStart, quote, line, lineStart);
      i = body.pos;
      line = body.line;
      lineStart = body.lineStart;
      tokens.push({
        kind: 'string',
        text: '<string-name>',
        literal: literalBody(source, bodyStart, body.pos, quote),
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Node-path literal: `$Foo/Bar` or `$"Foo Bar"`. Consume to whitespace,
    // newline, or a clear non-path delimiter.
    if (ch === '$') {
      const startLine = line;
      const startCol = colOf(i);
      i++;
      if (i < len && (source[i] === '"' || source[i] === "'")) {
        const body = skipStringBody(source, len, i + 1, source[i]!, line, lineStart);
        i = body.pos;
        line = body.line;
        lineStart = body.lineStart;
      } else {
        while (i < len && isNodePathChar(source[i]!)) i++;
      }
      tokens.push({ kind: 'string', text: '<node-path>', line: startLine, column: startCol });
      continue;
    }

    // NodePath literal: `^"..."`, an opaque string. A `^` followed by
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
      const bodyStart = i + 2;
      const quote = source[i + 1]!;
      const body = skipStringBody(source, len, bodyStart, quote, line, lineStart);
      i = body.pos;
      line = body.line;
      lineStart = body.lineStart;
      tokens.push({
        kind: 'string',
        text: '<string-name>',
        literal: literalBody(source, bodyStart, body.pos, quote),
        line: startLine,
        column: startCol,
      });
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

    // Identifier or member chain: `foo .bar` is one chain, see `readChainTail`.
    if (isIdentStart(ch)) {
      const startLine = line;
      const startCol = colOf(i);
      const start = i;
      const precededByDot = lastTokenIsDot(tokens);
      const precededByFunc = lastTokenIsFunc(tokens);
      while (i < len && isIdentPart(source[i]!)) i++;
      const first = source.slice(start, i);
      const tail = readChainTail(source, len, i, line, lineStart);
      const chain: string[] = [first, ...tail.segments];
      const endText = chain.join('.');
      i = tail.pos;
      line = tail.line;
      lineStart = tail.lineStart;
      if (chain.length > 1) {
        tokens.push({
          kind: 'memberChain',
          text: endText,
          chain,
          precededByDot,
          ...(precededByFunc ? { precededByFunc } : {}),
          line: startLine,
          column: startCol,
        });
      } else {
        tokens.push({
          kind: 'identifier',
          text: first,
          precededByDot,
          ...(precededByFunc ? { precededByFunc } : {}),
          line: startLine,
          column: startCol,
        });
      }
      continue;
    }

    // A parenthesised single identifier used as a receiver: `(OS).execute` is
    // the chain `OS.execute`. Only a grouping `(` qualifies; in `wrap(OS).run()`
    // the parentheses are an argument list and `run` belongs to the result.
    if (ch === '(' && !parenOpensCall(tokens)) {
      const receiver = readParenthesisedName(source, len, i, line, lineStart);
      const tail =
        receiver === null
          ? null
          : readChainTail(source, len, receiver.pos, receiver.line, receiver.lineStart);
      if (receiver !== null && tail !== null && tail.segments.length > 0) {
        const chain = [receiver.name, ...tail.segments];
        tokens.push({
          kind: 'memberChain',
          text: `(${receiver.name}).${tail.segments.join('.')}`,
          chain,
          precededByDot: false,
          line,
          column: colOf(i),
        });
        i = tail.pos;
        line = tail.line;
        lineStart = tail.lineStart;
        continue;
      }
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
