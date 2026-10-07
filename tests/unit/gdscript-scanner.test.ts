/**
 * Tokenizer tests. The scanner's contract with the policy evaluator is:
 *  - Comments and string-literal contents never reach the policy.
 *  - `Foo.bar.baz` becomes a single memberChain token with chain ['Foo','bar','baz'].
 *  - Line numbers track multi-line input correctly.
 *  - Triple-quoted strings don't false-positive on dangerous identifiers inside.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeStringLiteral,
  tokenize,
  tokenizeStripped,
  type Token,
} from '../../src/utils/gdscript-scanner.js';

function chains(source: string): string[][] {
  return tokenize(source)
    .filter((t) => t.kind === 'memberChain')
    .map((t) => t.chain ?? []);
}

function idents(source: string): string[] {
  return tokenize(source)
    .filter((t) => t.kind === 'identifier')
    .map((t) => t.text);
}

describe('tokenize: comments', () => {
  it('strips line comments entirely', () => {
    const tokens = tokenize('# OS.execute("rm -rf /")\nx = 1\n');
    // Nothing from the comment should survive.
    expect(tokens.some((t) => t.text === 'OS.execute')).toBe(false);
    expect(tokens.some((t) => t.text === 'OS')).toBe(false);
    expect(idents('# OS.execute("rm -rf /")\nx = 1\n')).toEqual(['x']);
  });

  it('strips trailing comments on a code line', () => {
    expect(idents('x = 1 # OS.execute\n')).toEqual(['x']);
  });
});

describe('tokenize: strings', () => {
  it('does not emit identifiers from inside double-quoted strings', () => {
    expect(idents('var s = "OS.execute"\n')).toEqual(['var', 's']);
  });

  it('does not emit identifiers from inside single-quoted strings', () => {
    expect(idents("var s = 'HTTPRequest'\n")).toEqual(['var', 's']);
  });

  it('does not emit identifiers from inside triple-quoted strings spanning lines', () => {
    const source = 'var doc = """\nOS.execute("rm -rf /")\nHTTPRequest.new()\n"""\nvar x = 1\n';
    const tokens = tokenize(source);
    expect(tokens.some((t) => t.text.startsWith('OS'))).toBe(false);
    expect(tokens.some((t) => t.text.startsWith('HTTPRequest'))).toBe(false);
    // Code after the docstring should still tokenize.
    expect(idents(source)).toEqual(['var', 'doc', 'var', 'x']);
  });

  it('handles escape sequences inside strings without leaking content', () => {
    expect(idents('var s = "OS.execute\\""\nx = 1\n')).toEqual(['var', 's', 'x']);
  });
});

describe('tokenize: member chains', () => {
  it('coalesces Foo.bar into a single memberChain token', () => {
    expect(chains('OS.execute()\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces multi-segment chains', () => {
    expect(chains('Engine.get_singleton("MyAuto").do_thing()\n')).toEqual([
      ['Engine', 'get_singleton'],
    ]);
  });

  it('keeps single identifiers as identifier tokens', () => {
    expect(idents('load("res://foo.tscn")\n')).toEqual(['load']);
    expect(chains('load("res://foo.tscn")\n')).toEqual([]);
  });
});

describe('tokenize: node-path literals', () => {
  it('treats $Foo/Bar as a single string-kind token', () => {
    const tokens = tokenize('var n = $Foo/Bar\n');
    const strings = tokens.filter((t) => t.kind === 'string');
    expect(strings).toHaveLength(1);
    expect(idents('var n = $Foo/Bar\n')).toEqual(['var', 'n']);
  });

  it('treats ^"..." as a string-kind token', () => {
    const tokens = tokenize('var n = ^"my_signal"\n');
    expect(tokens.some((t) => t.text === 'my_signal')).toBe(false);
  });
});

describe('tokenize: line tracking', () => {
  it('reports the correct line for tokens on later lines', () => {
    const tokens = tokenize('var x = 1\nvar y = 2\nOS.execute()\n');
    const chain = tokens.find((t) => t.kind === 'memberChain');
    expect(chain?.line).toBe(3);
  });

  it('emits newline tokens for each physical line', () => {
    const newlines = tokenize('a\nb\nc\n').filter((t) => t.kind === 'newline');
    expect(newlines).toHaveLength(3);
  });
});

describe('tokenize: line continuation', () => {
  it('treats `\\` + newline as a continuation (no extra newline emitted)', () => {
    // Continuation between segments is unusual in practice; verify the
    // tokenizer doesn't crash and treats the next line as the same logical
    // line for line numbering of the next token.
    const tokens = tokenize('var x = 1 \\\n+ 2\nOS.execute()\n');
    const chain = tokens.find((t) => t.kind === 'memberChain');
    // The continuation increments line (1→2) without emitting newline; then
    // the `\n` after `+ 2` emits newline and increments (2→3). OS.execute
    // therefore lives on physical line 3.
    expect(chain?.text).toBe('OS.execute');
    expect(chain?.line).toBe(3);
  });
});

describe('tokenize: member chains across whitespace/newlines', () => {
  // Regression coverage for the skeleton-key bypass: a tight "no whitespace
  // between identifier and dot" rule let `OS .execute`, `OS. execute`, and
  // `OS.\n  execute` slip past every two-segment policy rule at once.
  it('coalesces OS .execute (space before the dot)', () => {
    expect(chains('OS .execute()\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces OS. execute (space after the dot)', () => {
    expect(chains('OS. execute()\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces OS.\\n  execute (newline inside a call)', () => {
    expect(chains('foo(OS.\n  execute())\n')).toEqual([['OS', 'execute']]);
  });

  it('does not merge two separate statements (foo\\nbar stays two identifiers)', () => {
    expect(idents('foo\nbar\n')).toEqual(['foo', 'bar']);
    expect(chains('foo\nbar\n')).toEqual([]);
  });

  it('tracks line numbers correctly across a chain split by a newline', () => {
    const tokens = tokenize('var x = 1\nOS\n.execute()\n');
    const chain = tokens.find((t) => t.kind === 'memberChain');
    // Contract: the chain token's line stays that of the first segment.
    expect(chain?.line).toBe(2);
    // A token after the chain must resume line tracking correctly.
    const closeParen = tokens.filter((t) => t.text === ')').pop();
    expect(closeParen?.line).toBe(3);
  });
});

describe('tokenize: punctuation', () => {
  it('emits ( ) , as punct tokens', () => {
    const tokens = tokenize('foo(a, b)\n');
    const punct = tokens.filter((t) => t.kind === 'punct').map((t) => t.text);
    expect(punct).toEqual(['(', ',', ')']);
  });
});

describe('tokenize: member chains across continuations and comments', () => {
  it('coalesces a chain split by a backslash continuation before the dot', () => {
    expect(chains('OS \\\n.execute("x")\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces a chain split by a continuation with trailing blanks and a CRLF', () => {
    expect(chains('OS \\  \r\n  .execute("x")\r\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces a chain split by a continuation after the dot', () => {
    expect(chains('OS. \\\n  execute("x")\n')).toEqual([['OS', 'execute']]);
  });

  it('coalesces a chain split by a comment inside parentheses', () => {
    expect(chains('foo(OS # note\n  .execute("x"))\n')).toEqual([['OS', 'execute']]);
    expect(chains('foo(OS. # note\n  execute("x"))\n')).toEqual([['OS', 'execute']]);
  });

  it('keeps line numbers right after a chain split by a continuation', () => {
    const tokens = tokenize('OS \\\n.execute()\nx\n');
    const chain = tokens.find((t) => t.kind === 'memberChain');
    expect(chain?.line).toBe(1);
    expect(tokens.find((t) => t.text === 'x')?.line).toBe(3);
  });

  it('two statements separated by a comment stay two identifiers', () => {
    expect(idents('foo # note\nbar\n')).toEqual(['foo', 'bar']);
    expect(chains('foo # note\nbar\n')).toEqual([]);
  });

  it('a comment that mentions a dot does not join the lines around it', () => {
    expect(chains('foo # a.b\nbar\n')).toEqual([]);
    expect(idents('foo # a.b\nbar\n')).toEqual(['foo', 'bar']);
  });

  it('a continuation between two statements does not form a chain', () => {
    expect(chains('foo \\\nbar\n')).toEqual([]);
    expect(idents('foo \\\nbar\n')).toEqual(['foo', 'bar']);
  });

  it('a backslash that is not a continuation does not form a chain', () => {
    expect(chains('OS \\ x\n')).toEqual([]);
    expect(idents('OS \\ x\n')).toEqual(['OS', 'x']);
  });

  it('a caret before an identifier does not swallow it', () => {
    expect(chains('1^OS.execute("x")\n')).toEqual([['OS', 'execute']]);
    expect(idents('a ^b\n')).toEqual(['a', 'b']);
  });

  it('a caret before a quoted NodePath is still one literal', () => {
    const tokens = tokenize('x = ^"OS.execute"\n');
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.text)).toEqual(['<string-name>']);
    expect(tokens.some((t) => t.text === 'OS')).toBe(false);
    expect(chains('x = ^"OS.execute"\n')).toEqual([]);
  });

  it('a trailing caret at end of input does not throw', () => {
    expect(() => tokenize('a ^')).not.toThrow();
  });
});

describe('tokenize: strings spanning lines', () => {
  it('continues a regular string across a raw newline', () => {
    const tokens = tokenize('var a = "x\nOS.execute"\nvar b = 1\n');
    expect(tokens.filter((t) => t.kind === 'string')).toHaveLength(1);
    expect(tokens.some((t) => t.text.startsWith('OS'))).toBe(false);
    expect(tokens.find((t) => t.text === 'b')?.line).toBe(3);
  });

  it('tracks line and column for tokens after a multi-line string', () => {
    const tokens = tokenize('"a\r\nb\rc"; OS.execute()\n');
    const chain = tokens.find((t) => t.kind === 'memberChain');
    expect(chain?.line).toBe(3);
    expect(chain?.column).toBe(5);
  });

  it('keeps an escaped quote and an escaped newline inside the string', () => {
    const tokens = tokenize('"a\\"b\\\nOS.execute"\nx\n');
    expect(tokens.filter((t) => t.kind === 'string')).toHaveLength(1);
    expect(tokens.some((t) => t.kind === 'memberChain')).toBe(false);
    expect(tokens.find((t) => t.text === 'x')?.line).toBe(3);
  });

  it('handles triple-quoted, raw, string-name and quoted node-path forms', () => {
    const src =
      'a = """x\nOS.execute\n"""\nb = r"p\nOS.kill"\nc = &"n\nOS.kill"\nd = ^"n\nOS.kill"\ne = $"n\nOS.kill"\nz\n';
    const tokens = tokenize(src);
    expect(tokens.some((t) => t.kind === 'memberChain')).toBe(false);
    expect(tokens.find((t) => t.text === 'z')?.line).toBe(12);
  });

  it('does not throw or loop on an unterminated string at end of input', () => {
    for (const src of ['"abc', '"abc\n', "'", '"""abc', '^"abc', '$"abc', '"abc\\']) {
      expect(() => tokenize(src)).not.toThrow();
    }
  });
});

describe('tokenize: precededByDot', () => {
  const flag = (src: string, text: string): boolean | undefined =>
    tokenize(src).find((t) => t.text === text)?.precededByDot;

  it('is true for an identifier after a call, subscript or node path', () => {
    expect(flag('get_node("a").load(x)\n', 'load')).toBe(true);
    expect(flag('s[i].load(x)\n', 'load')).toBe(true);
    expect(flag('$A.load(x)\n', 'load')).toBe(true);
  });

  it('sees past whitespace, newlines, continuations and comments', () => {
    expect(flag('f() .  load(x)\n', 'load')).toBe(true);
    expect(flag('(f().\n load(x))\n', 'load')).toBe(true);
    expect(flag('f() . \\\n load(x)\n', 'load')).toBe(true);
    expect(flag('(f(). # note\n load(x))\n', 'load')).toBe(true);
  });

  it('is false for a bare global call', () => {
    expect(flag('load(x)\n', 'load')).toBe(false);
    expect(flag('x = 1\nload(x)\n', 'load')).toBe(false);
  });
});

describe('tokenize: a name declared with func', () => {
  it('marks the name after func, and no other use of it', () => {
    const tokens = tokenize('func load(slot: int) -> void:\n\tload(slot)\n');
    const loads = tokens.filter((t) => t.text === 'load');
    expect(loads.map((t) => [t.line, t.precededByFunc === true])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('marks the name of a static func', () => {
    const tokens = tokenize('static func str_to_var(text):\n\tpass\n');
    expect(tokens.find((t) => t.text === 'str_to_var')?.precededByFunc).toBe(true);
  });

  it('does not mark the first name of a lambda body or a name on the next line', () => {
    const tokens = tokenize('var f = func(): load(p)\nfunc\nload(p)\n');
    expect(tokens.filter((t) => t.text === 'load').some((t) => t.precededByFunc)).toBe(false);
  });
});

describe('tokenize: a parenthesised receiver', () => {
  const chainsOf = (source: string): string[][] =>
    tokenize(source)
      .filter((t) => t.kind === 'memberChain')
      .map((t) => t.chain!);

  it('reads (OS).execute as the chain OS.execute', () => {
    expect(chainsOf('(OS).execute("rm", [])\n')).toEqual([['OS', 'execute']]);
  });

  it('reads through nested parentheses, blanks and line breaks', () => {
    expect(chainsOf('((OS)).execute()\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('( OS ) . execute ()\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('x = (\n\tOS\n)\n\t.execute()\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('(Engine).get_singleton("X").call("y")\n')).toEqual([
      ['Engine', 'get_singleton'],
    ]);
  });

  it('reads it after a keyword, an operator, an opening bracket and a comma', () => {
    expect(chainsOf('return (OS).execute()\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('var x = (OS).execute()\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('print((OS).execute())\n').slice(-1)).toEqual([['OS', 'execute']]);
    expect(chainsOf('f(a, (OS).execute())\n')).toEqual([['OS', 'execute']]);
    expect(chainsOf('if not (OS).has_feature("x"):\n')).toEqual([['OS', 'has_feature']]);
  });

  it('keeps the position of the opening parenthesis', () => {
    const chain = tokenize('var x = 1\n\t(OS).execute()\n').find((t) => t.kind === 'memberChain');
    expect([chain?.line, chain?.column, chain?.text]).toEqual([2, 2, '(OS).execute']);
  });

  it('leaves an argument list alone: the method belongs to what the call returns', () => {
    expect(chainsOf('wrap(OS).execute()\n')).toEqual([]);
    expect(chainsOf('a.wrap(OS).execute()\n')).toEqual([['a', 'wrap']]);
    expect(chainsOf('make()(OS).execute()\n')).toEqual([]);
    expect(chainsOf('table[0](OS).execute()\n')).toEqual([]);
  });

  it('leaves parentheses that hold anything but one name, or that nothing is read from', () => {
    expect(chainsOf('(a + OS).execute()\n')).toEqual([]);
    expect(chainsOf('x = (OS)\n')).toEqual([]);
    expect(
      tokenize('x = (OS)\n')
        .filter((t) => t.kind === 'punct')
        .map((t) => t.text),
    ).toEqual(['=', '(', ')']);
  });
});

describe('tokenize: the characters of a string literal', () => {
  const literals = (source: string): Array<string | undefined> =>
    tokenize(source)
      .filter((t) => t.kind === 'string')
      .map((t) => t.literal);

  it('carries them for quoted, triple-quoted and StringName forms', () => {
    expect(literals('a("execute")')).toEqual(['execute']);
    expect(literals("a('execute')")).toEqual(['execute']);
    expect(literals('a("""execute""")')).toEqual(['execute']);
    expect(literals('a(&"execute")')).toEqual(['execute']);
    expect(literals('a("")')).toEqual(['']);
  });

  it('keeps escapes as written and reads an unterminated string to the end', () => {
    expect(literals('a("ex\\"ec")')).toEqual(['ex\\"ec']);
    expect(literals('a("open')).toEqual(['open']);
  });

  it('carries none for a node path', () => {
    expect(literals('$Foo/Bar')).toEqual([undefined]);
  });

  it('reads &"..." as one string and a lone & as an operator', () => {
    const tokens = tokenize('a & b\nc = &"OS.execute"\n');
    expect(tokens.filter((t) => t.kind === 'string')).toHaveLength(1);
    expect(tokens.some((t) => t.kind === 'memberChain')).toBe(false);
    expect(tokens.some((t) => t.kind === 'other' && t.text === '&')).toBe(true);
  });
});

describe('raw strings and decoded literals', () => {
  const strings = (source: string): Token[] => tokenize(source).filter((t) => t.kind === 'string');

  it('reads r"..." and r\'...\' as one string token marked raw', () => {
    const tokens = tokenizeStripped('load(r"res://x.gd", r\'y\')');
    expect(tokens.map((t) => t.kind)).toEqual([
      'identifier',
      'punct',
      'string',
      'punct',
      'string',
      'punct',
    ]);
    expect(strings('r"res://x.gd"')[0]).toMatchObject({ literal: 'res://x.gd', raw: true });
    expect(strings("r'''a\nb'''")[0]).toMatchObject({ literal: 'a\nb', raw: true });
  });

  it('keeps an identifier that merely starts or ends with r', () => {
    expect(tokenizeStripped('r = 1').map((t) => t.text)).toEqual(['r', '=', '1']);
    expect(tokenizeStripped('var"x"').map((t) => t.kind)).toEqual(['identifier', 'string']);
    expect(tokenizeStripped('r.x').map((t) => t.kind)).toEqual(['memberChain']);
  });

  it('gives a NodePath literal its body', () => {
    expect(strings('^"a/b"')[0]).toMatchObject({ literal: 'a/b' });
  });

  it.each([
    ['"plain"', 'plain'],
    ['"\\u0065xecute"', 'execute'],
    ['"\\U000065xecute"', 'execute'],
    ['"a\\nb\\t\\"c\\"\\\\"', 'a\nb\t"c"\\'],
    ['"exe\\\ncute"', 'execute'],
    ['r"\\u0065"', '\\u0065'],
    ['&"n\\u0061me"', 'name'],
  ])('decodes %s', (source, value) => {
    expect(decodeStringLiteral(strings(source)[0]!)).toBe(value);
  });

  it.each(['"\\q"', '"\\u12"', '"\\uzzzz"', '"\\U110000"'])('gives null for %s', (source) => {
    expect(decodeStringLiteral(strings(source)[0]!)).toBeNull();
  });

  it('gives null for a token with no literal', () => {
    expect(decodeStringLiteral(strings('$Node/Path')[0]!)).toBeNull();
  });
});
