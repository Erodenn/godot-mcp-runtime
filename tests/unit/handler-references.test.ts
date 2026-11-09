import { describe, it, expect } from 'vitest';
import {
  classifyHandlerUse,
  classifyHandlerUseAcross,
  classifyHandlerUseAcrossDetailed,
  classifyHandlerUseDetailed,
} from '../../src/utils/handler-references.js';

const HANDLER = '_on_button_pressed';
const DECLARATION = `func ${HANDLER}():\n\tpass\n`;

function script(body: string): string {
  const indented = body
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n');
  return `extends Node\nfunc _ready():\n${indented}\n${DECLARATION}`;
}

describe('classifyHandlerUse: connect forms', () => {
  it.each([
    ['signal member connect', `button.pressed.connect(${HANDLER})`],
    ['node-path signal connect', `$Button.pressed.connect(${HANDLER})`],
    ['string signal name', `connect("pressed", ${HANDLER})`],
    ['Callable with string method', `connect("pressed", Callable(self, "${HANDLER}"))`],
    ['StringName method', `button.connect(&"pressed", Callable(self, &"${HANDLER}"))`],
    ['bind', `button.pressed.connect(${HANDLER}.bind(1, 2))`],
    ['self-qualified', `button.pressed.connect(self.${HANDLER})`],
    ['with flags', `button.pressed.connect(${HANDLER}, CONNECT_ONE_SHOT)`],
  ])('counts %s as connected', (_name, line) => {
    expect(classifyHandlerUse(script(line), HANDLER)).toBe('connected');
  });
});

describe('classifyHandlerUse: references and orphans', () => {
  it('counts a Callable value held in a variable as referenced', () => {
    expect(classifyHandlerUse(script(`var cb = ${HANDLER}`), HANDLER)).toBe('referenced');
  });

  it('counts a Callable built from a string as referenced', () => {
    expect(classifyHandlerUse(script(`var cb = Callable(self, "${HANDLER}")`), HANDLER)).toBe(
      'referenced',
    );
  });

  it('leaves a true orphan alone: declaration only', () => {
    expect(classifyHandlerUse(DECLARATION, HANDLER)).toBe('none');
  });

  it('does not count a direct call as a reference', () => {
    expect(classifyHandlerUse(script(`${HANDLER}()`), HANDLER)).toBe('none');
  });

  it('ignores the name in a comment or an unrelated string', () => {
    const source = script(`# button.pressed.connect(${HANDLER})\nprint("${HANDLER} unused")`);
    expect(classifyHandlerUse(source, HANDLER)).toBe('none');
  });

  it('does not match a different handler that shares a prefix', () => {
    const source = script('button.pressed.connect(_on_button_pressed_twice)');
    expect(classifyHandlerUse(source, HANDLER)).toBe('none');
  });
});

describe('classifyHandlerUse: uncertain recognition', () => {
  it('reports maybe for a method name built from a stem', () => {
    const line = 'button.pressed.connect(Callable(self, "_on_" + name))';
    expect(classifyHandlerUse(script(line), HANDLER)).toBe('maybe');
  });

  it('reports maybe for a Callable whose method is a variable', () => {
    expect(classifyHandlerUse(script('var cb = Callable(self, method_name)'), HANDLER)).toBe(
      'maybe',
    );
  });

  it('a firm connect wins over an uncertain one across scripts', () => {
    const uncertain = script('var cb = Callable(self, method_name)');
    const firm = script(`button.pressed.connect(${HANDLER})`);
    expect(classifyHandlerUseAcross([uncertain, firm], HANDLER)).toBe('connected');
    expect(classifyHandlerUseAcross([uncertain], HANDLER)).toBe('maybe');
    expect(classifyHandlerUseAcross([], HANDLER)).toBe('none');
  });
});

describe('classifyHandlerUse: a dynamic site reaches only the names it can build', () => {
  const callable = (expr: string) => script(`var cb = Callable(self, ${expr})`);

  it.each([
    ['literal prefix concat', '"_on_button" + suffix', 'maybe'],
    ['literal prefix concat that cannot match', '"_on_timer" + suffix', 'none'],
    ['format string prefix', '"_on_button_%s" % suffix', 'maybe'],
    ['format string prefix that cannot match', '"_on_timer_%s" % suffix', 'none'],
    ['str() prefix', 'str("_on_button", suffix)', 'maybe'],
    ['str() prefix that cannot match', 'str("_on_timer", suffix)', 'none'],
    ['StringName wrapper', 'StringName("_on_button" + suffix)', 'maybe'],
    ['literal suffix that fits', '"_on_" + which + "_pressed"', 'maybe'],
    ['literal suffix that does not fit', '"_on_" + which + "_released"', 'none'],
    ['format string suffix that does not fit', '"_on_%s_released" % which', 'none'],
    ['suffix only', 'which + "_pressed"', 'maybe'],
    ['suffix only that does not fit', 'which + "_released"', 'none'],
    ['a bare variable', 'method_name', 'maybe'],
    ['a call result', 'pick_name()', 'maybe'],
    ['a ternary the scanner will not guess at', '"_on_timer" + a if flag else b', 'maybe'],
    ['a shape with another operator', '"_on_timer" + a * 2', 'maybe'],
  ])('%s', (_name, expr, expected) => {
    expect(classifyHandlerUse(callable(expr), HANDLER)).toBe(expected);
  });

  it('reports the line of the site that reaches the handler', () => {
    const source =
      'extends Node\nfunc _ready():\n\tvar a = Callable(self, "_on_timer" + x)\n\tvar b = Callable(self, n)\n' +
      DECLARATION;
    expect(classifyHandlerUseDetailed(source, HANDLER)).toEqual({
      use: 'maybe',
      site: { line: 4 },
    });
  });

  it('names the script of the site across scripts', () => {
    const plain = script('pass');
    const dynamic = callable('"_on_button" + x');
    const result = classifyHandlerUseAcrossDetailed(
      [
        { path: 'res://a.gd', source: plain },
        { path: 'res://b.gd', source: dynamic },
      ],
      HANDLER,
    );
    expect(result.use).toBe('maybe');
    expect(result.site?.path).toBe('res://b.gd');
  });
});

describe('classifyHandlerUse: the target of a dynamic site bounds its reach', () => {
  it('a self target does not reach a handler another script declares', () => {
    expect(classifyHandlerUse('func wire(n):\n\tvar cb = Callable(self, n)\n', HANDLER)).toBe(
      'none',
    );
  });

  it('a self target reaches a handler its own script declares', () => {
    expect(classifyHandlerUse(script('var cb = Callable(self, n)'), HANDLER)).toBe('maybe');
  });

  it.each(['$Hud', 'get_node("Hud")', 'hud', 'make_target()'])(
    'target %s reaches the whole scene',
    (target) => {
      const source = `func wire(n):\n\tvar cb = Callable(${target}, n)\n`;
      expect(classifyHandlerUse(source, HANDLER)).toBe('maybe');
    },
  );
});
