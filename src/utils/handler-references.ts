import { tokenizeStripped, type Token } from './gdscript-scanner.js';

/** How a script's tokens use a handler name. `connected`: named inside a `connect(...)` call. `referenced`: named as a Callable value elsewhere (`var f = _on_x`, `Callable(self, "_on_x")`, `_on_x.bind(..)`).
 * `maybe`: a Callable is built from something the tokens cannot resolve (`"_on_" + name`, a variable method name). `none`: no sign of use. Read-only: shares the scanner with the security gate and changes nothing there. */
export type HandlerUse = 'connected' | 'referenced' | 'maybe' | 'none';

const CONNECT_METHOD = 'connect';
const CALLABLE_CTOR = 'Callable';
const OPEN_PAREN = '(';
const CLOSE_PAREN = ')';
const COMMA = ',';
/** Shortest literal that counts as the stem of a built-up handler name: `"_on_"` itself. */
const MIN_STEM_LENGTH = 4;

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text;
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

/** True when the `Callable(` call opening at `open` takes anything but a string literal as its method argument. */
function callableHasDynamicMethod(tokens: Token[], open: number, close: number): boolean {
  let depth = 0;
  let methodArgStart = -1;
  for (let i = open; i < close; i++) {
    if (isPunct(tokens[i], OPEN_PAREN)) depth++;
    else if (isPunct(tokens[i], CLOSE_PAREN)) depth--;
    else if (depth === 1 && isPunct(tokens[i], COMMA)) {
      methodArgStart = i + 1;
      break;
    }
  }
  if (methodArgStart === -1) return false;
  const first = tokens[methodArgStart];
  const next = tokens[methodArgStart + 1];
  const isLoneLiteral =
    first !== undefined &&
    first.kind === 'string' &&
    (isPunct(next, CLOSE_PAREN) || isPunct(next, COMMA));
  return !isLoneLiteral;
}

/** How one script's source uses `method`; see `HandlerUse`. */
export function classifyHandlerUse(source: string, method: string): HandlerUse {
  const tokens = tokenizeStripped(source);
  let referenced = false;
  let maybe = false;

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
      for (let j = open + 1; j < close; j++) {
        const inner = tokens[j]!;
        if (inner.kind === 'string' && inner.literal === method) {
          if (isConnectCall) return 'connected';
          referenced = true;
        } else if (namesMethodAsValue(tokens, j, method)) {
          if (isConnectCall) return 'connected';
          referenced = true;
        } else if (inner.kind === 'string' && isStemOf(inner.literal, method)) {
          maybe = true;
        }
      }
      if (isCallableCtor && callableHasDynamicMethod(tokens, open, close)) maybe = true;
      continue;
    }

    if (namesMethodAsValue(tokens, i, method)) referenced = true;
  }

  if (referenced) return 'referenced';
  return maybe ? 'maybe' : 'none';
}

/** The strongest use of `method` across several scripts: connected, then referenced, then maybe. */
export function classifyHandlerUseAcross(sources: readonly string[], method: string): HandlerUse {
  let best: HandlerUse = 'none';
  for (const source of sources) {
    const use = classifyHandlerUse(source, method);
    if (use === 'connected') return use;
    if (use === 'referenced') best = use;
    else if (use === 'maybe' && best === 'none') best = use;
  }
  return best;
}
