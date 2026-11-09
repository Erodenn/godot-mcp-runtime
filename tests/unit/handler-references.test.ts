import { describe, it, expect } from 'vitest';
import {
  classifyHandlerUse,
  classifyHandlerUseAcross,
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
