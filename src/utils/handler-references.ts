import { tokenizeStripped, type Token } from './gdscript-scanner.js';

/** How a script's tokens use a handler name. `connected`: named inside a `connect(...)` call. `referenced`: named as a Callable value elsewhere (`var f = _on_x`, `Callable(self, "_on_x")`, `_on_x.bind(..)`).
 * `maybe`: a Callable is built from a method name the tokens cannot pin to a string, and the name could be this handler (see `MethodReach`). `none`: no sign of use. Read-only: shares the scanner with the security gate and changes nothing there. */
export type HandlerUse = 'connected' | 'referenced' | 'maybe' | 'none';

/** Where a `maybe` came from: the script it was found in (when known) and the line of the Callable site. */
export interface MaybeSite {
  path?: string;
  line: number;
}

export interface HandlerUseDetail {
  use: HandlerUse;
  /** Set when `use` is `maybe`: the first site that could reach the handler. */
  site?: MaybeSite;
}

/** Which method names a dynamic Callable site can reach. `any`: no literal part, so every method of the script. `pattern`: names that start with `prefix` and end with `suffix` (either may be empty). */
type MethodReach = { kind: 'any' } | { kind: 'pattern'; prefix: string; suffix: string };

const CONNECT_METHOD = 'connect';
const CALLABLE_CTOR = 'Callable';
const STR_FUNCTION = 'str';
const SELF_TARGET = 'self';
const WRAPPER_CTORS: ReadonlySet<string> = new Set(['StringName', 'String']);
const OPEN_PAREN = '(';
const CLOSE_PAREN = ')';
const OPEN_BRACKET = '[';
const CLOSE_BRACKET = ']';
const COMMA = ',';
const PLUS = '+';
const FORMAT_OPERATOR = '%';
/** Shortest literal that counts as the stem of a built-up handler name in a `connect(...)` call: `"_on_"` itself. */
const MIN_STEM_LENGTH = 4;
/** A `%s`-style conversion inside a format string. */
const FORMAT_SPECIFIER_RE = /%[-+ #0-9.*]*[sdfxXoeEgGcbv]/g;
/** Words that change how an expression parses (ternary, boolean, cast); one at the top level of a method-name expression means its shape is not a plain concatenation. */
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'else',
  'and',
  'or',
  'not',
  'in',
  'is',
  'as',
  'await',
]);
const ANY_REACH: MethodReach = { kind: 'any' };

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text;
}

function isOperator(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'other' && token.text === text;
}

function isOpener(token: Token): boolean {
  return isPunct(token, OPEN_PAREN) || isPunct(token, OPEN_BRACKET);
}

function isCloser(token: Token): boolean {
  return isPunct(token, CLOSE_PAREN) || isPunct(token, CLOSE_BRACKET);
}

/** Index of the paren closing the one at `open`, or tokens.length for an unbalanced source. */
function matchingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], OPEN_PAREN)) depth++;
    else if (isPunct(tokens[i], CLOSE_PAREN) && --depth === 0) return i;
  }
  return tokens.length;
}

function lastSegment(token: Token): string | undefined {
  if (token.kind === 'memberChain') return token.chain?.[token.chain.length - 1];
  if (token.kind === 'identifier') return token.text;
  return undefined;
}

/** True when this token names `method` as a value: a bare identifier, or a chain segment (`self._on_x`, `_on_x.bind`), but not a declaration and not a direct call `_on_x()`. */
function namesMethodAsValue(tokens: Token[], i: number, method: string): boolean {
  const token = tokens[i]!;
  if (token.precededByFunc) return false;
  if (token.kind === 'identifier') {
    return token.text === method && !isPunct(tokens[i + 1], OPEN_PAREN);
  }
  if (token.kind === 'memberChain' && token.chain) {
    const at = token.chain.indexOf(method);
    if (at === -1) return false;
    const isLast = at === token.chain.length - 1;
    return !(isLast && isPunct(tokens[i + 1], OPEN_PAREN));
  }
  return false;
}

function isStemOf(literal: string | undefined, method: string): boolean {
  return (
    literal !== undefined &&
    literal.length >= MIN_STEM_LENGTH &&
    literal.length < method.length &&
    method.startsWith(literal)
  );
}

/** Token ranges `[start, end)` of the top-level arguments of the call whose paren opens at `open` and closes at `close`. */
function splitArguments(tokens: Token[], open: number, close: number): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]!;
    if (isOpener(token)) depth++;
    else if (isCloser(token)) depth--;
    else if (depth === 0 && isPunct(token, COMMA)) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  if (start < close) args.push([start, close]);
  return args;
}

function loneLiteral(tokens: Token[], start: number, end: number): string | undefined {
  const token = tokens[start];
  return end - start === 1 && token?.kind === 'string' ? token.literal : undefined;
}

/** `"_on_%s_pressed" % x`: the text before the first conversion is the prefix; the text after the last is the suffix only when there is exactly one conversion and no other `%`. */
function formatReach(format: string): MethodReach {
  const firstPercent = format.indexOf(FORMAT_OPERATOR);
  if (firstPercent === -1) return { kind: 'pattern', prefix: format, suffix: '' };
  const specifiers = [...format.matchAll(FORMAT_SPECIFIER_RE)];
  const prefix = format.slice(0, firstPercent);
  const only = specifiers.length === 1 ? specifiers[0]! : undefined;
  const suffixText = only ? format.slice(only.index + only[0].length) : '';
  const suffix = suffixText.includes(FORMAT_OPERATOR) ? '' : suffixText;
  return { kind: 'pattern', prefix, suffix };
}

/** `str("_on_", x, "_pressed")`: a leading and a trailing literal argument. */
function strCallReach(tokens: Token[], open: number, close: number): MethodReach {
  const args = splitArguments(tokens, open, close);
  const first = args[0] ? loneLiteral(tokens, args[0][0], args[0][1]) : undefined;
  const last =
    args.length > 1
      ? loneLiteral(tokens, args[args.length - 1]![0], args[args.length - 1]![1])
      : undefined;
  if (first === undefined && last === undefined) return ANY_REACH;
  return { kind: 'pattern', prefix: first ?? '', suffix: last ?? '' };
}

/** `"_on_" + stem + "_pressed"`: leading and trailing literal operands of a top-level `+` chain. Anything but strings, names, numbers, `+`, `%` and bracket groups at the top level (a ternary, a comparison, `-`, `*`) is a shape the check will not guess at. */
function concatReach(tokens: Token[], start: number, end: number): MethodReach {
  const segments: Array<[number, number]> = [];
  let depth = 0;
  let segmentStart = start;
  let hasFormat = false;
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (isOpener(token)) {
      depth++;
      continue;
    }
    if (isCloser(token)) {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (isOperator(token, PLUS)) {
      segments.push([segmentStart, i]);
      segmentStart = i + 1;
    } else if (isOperator(token, FORMAT_OPERATOR)) {
      hasFormat = true;
    } else if (token.kind === 'identifier') {
      if (EXPRESSION_KEYWORDS.has(token.text)) return ANY_REACH;
    } else if (token.kind !== 'string' && token.kind !== 'memberChain' && token.kind !== 'number') {
      return ANY_REACH;
    }
  }
  segments.push([segmentStart, end]);

  if (hasFormat) {
    const format = loneLiteral(tokens, start, start + 1);
    const isPlainFormat = segments.length === 1 && isOperator(tokens[start + 1], FORMAT_OPERATOR);
    return format !== undefined && isPlainFormat ? formatReach(format) : ANY_REACH;
  }
  if (segments.length < 2) return ANY_REACH;

  let prefix = '';
  let leading = 0;
  while (leading < segments.length) {
    const literal = loneLiteral(tokens, segments[leading]![0], segments[leading]![1]);
    if (literal === undefined) break;
    prefix += literal;
    leading++;
  }
  if (leading === segments.length) return { kind: 'pattern', prefix, suffix: '' };
  let suffix = '';
  for (let k = segments.length - 1; k >= leading; k--) {
    const literal = loneLiteral(tokens, segments[k]![0], segments[k]![1]);
    if (literal === undefined) break;
    suffix = literal + suffix;
  }
  return prefix === '' && suffix === '' ? ANY_REACH : { kind: 'pattern', prefix, suffix };
}

/** Which names the method-name expression in `[start, end)` can produce. Unsure of the shape means `any`. */
function methodNameReach(tokens: Token[], start: number, end: number): MethodReach {
  const head = tokens[start];
  const open = tokens[start + 1];
  const wrapsWholeExpression =
    head !== undefined &&
    head.kind === 'identifier' &&
    isPunct(open, OPEN_PAREN) &&
    matchingParen(tokens, start + 1) === end - 1;
  if (wrapsWholeExpression) {
    if (head.text === STR_FUNCTION) return strCallReach(tokens, start + 1, end - 1);
    if (WRAPPER_CTORS.has(head.text)) {
      const args = splitArguments(tokens, start + 1, end - 1);
      return args.length === 1 ? methodNameReach(tokens, args[0]![0], args[0]![1]) : ANY_REACH;
    }
  }
  return concatReach(tokens, start, end);
}

function reaches(reach: MethodReach, method: string): boolean {
  if (reach.kind === 'any') return true;
  const { prefix, suffix } = reach;
  return (
    method.length >= prefix.length + suffix.length &&
    method.startsWith(prefix) &&
    method.endsWith(suffix)
  );
}

/** True when this script's tokens declare `func <method>`. */
function declaresMethod(tokens: Token[], method: string): boolean {
  return tokens.some((t) => t.precededByFunc === true && t.text === method);
}

/** True when the `Callable(` call opening at `open` takes a method name that is not a lone string literal and could produce `method`. A `self` target reaches only methods this script declares; any other target (a node expression, a variable, an unrecognised form) reaches the whole scene. */
function dynamicCallableReaches(
  tokens: Token[],
  open: number,
  close: number,
  method: string,
): boolean {
  const args = splitArguments(tokens, open, close);
  const methodArg = args[1];
  if (methodArg === undefined) return false;
  if (loneLiteral(tokens, methodArg[0], methodArg[1]) !== undefined) return false;
  const targetArg = args[0];
  const targetsSelf =
    targetArg !== undefined &&
    targetArg[1] - targetArg[0] === 1 &&
    tokens[targetArg[0]]!.kind === 'identifier' &&
    tokens[targetArg[0]]!.text === SELF_TARGET;
  if (targetsSelf && !declaresMethod(tokens, method)) return false;
  return reaches(methodNameReach(tokens, methodArg[0], methodArg[1]), method);
}

/** How one script's source uses `method`, with the line of the first dynamic site that could reach it; see `HandlerUse`. */
export function classifyHandlerUseDetailed(source: string, method: string): HandlerUseDetail {
  const tokens = tokenizeStripped(source);
  let referenced = false;
  let site: MaybeSite | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isConnectCall =
      lastSegment(token) === CONNECT_METHOD &&
      token.kind !== 'string' &&
      isPunct(tokens[i + 1], OPEN_PAREN);
    const isCallableCtor =
      token.kind === 'identifier' &&
      token.text === CALLABLE_CTOR &&
      isPunct(tokens[i + 1], OPEN_PAREN);

    if (isConnectCall || isCallableCtor) {
      const open = i + 1;
      const close = matchingParen(tokens, open);
      let nestedCallableEnd = -1;
      for (let j = open + 1; j < close; j++) {
        const inner = tokens[j]!;
        if (
          inner.kind === 'identifier' &&
          inner.text === CALLABLE_CTOR &&
          isPunct(tokens[j + 1], OPEN_PAREN)
        ) {
          nestedCallableEnd = Math.max(nestedCallableEnd, matchingParen(tokens, j + 1));
        }
        if (inner.kind === 'string' && inner.literal === method) {
          if (isConnectCall) return { use: 'connected' };
          referenced = true;
        } else if (namesMethodAsValue(tokens, j, method)) {
          if (isConnectCall) return { use: 'connected' };
          referenced = true;
        } else if (
          inner.kind === 'string' &&
          isConnectCall &&
          j > nestedCallableEnd &&
          isStemOf(inner.literal, method)
        ) {
          site ??= { line: inner.line };
        }
      }
      if (isCallableCtor && dynamicCallableReaches(tokens, open, close, method)) {
        site ??= { line: token.line };
      }
      continue;
    }

    if (namesMethodAsValue(tokens, i, method)) referenced = true;
  }

  if (referenced) return { use: 'referenced' };
  return site ? { use: 'maybe', site } : { use: 'none' };
}

export interface ScriptSource {
  path: string;
  source: string;
}

/** The strongest use of `method` across several scripts: connected, then referenced, then maybe (with the script and line of the first maybe). */
export function classifyHandlerUseAcrossDetailed(
  scripts: readonly ScriptSource[],
  method: string,
): HandlerUseDetail {
  let best: HandlerUseDetail = { use: 'none' };
  for (const { path, source } of scripts) {
    const detail = classifyHandlerUseDetailed(source, method);
    if (detail.use === 'connected') return detail;
    if (detail.use === 'referenced') best = detail;
    else if (detail.use === 'maybe' && best.use === 'none' && detail.site) {
      best = { use: 'maybe', site: { path, line: detail.site.line } };
    }
  }
  return best;
}
