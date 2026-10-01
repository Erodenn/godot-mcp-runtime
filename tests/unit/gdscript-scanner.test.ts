/**
 * Tokenizer tests. The scanner's contract with the policy evaluator is:
 *  - Comments and string-literal contents never reach the policy.
 *  - `Foo.bar.baz` becomes a single memberChain token with chain ['Foo','bar','baz'].
 *  - Line numbers track multi-line input correctly.
 *  - Triple-quoted strings don't false-positive on dangerous identifiers inside.
 */

import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/utils/gdscript-scanner.js';

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
