import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleValidate } from '../../../src/tools/validate-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { unwrap } from '../../helpers/assertions.js';
import { removeTmpDir } from '../../helpers/tmp.js';

const HANDLER = '_on_button_pressed';
const MAY_BE_CONNECTED = 'may be connected in code';
const HUD_SCRIPT = `func ${HANDLER}():\n\tpass\n`;
const DYNAMIC_WIRING = 'func _ready():\n\tconnect("pressed", Callable($Hud, "_on_" + name))\n';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'godot-mcp-orphan-'));
  mkdirSync(join(project, 'scripts'));
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
  writeFileSync(
    join(project, 'main.tscn'),
    '[gd_scene load_steps=3 format=3]\n\n' +
      '[ext_resource type="Script" path="res://scripts/hud.gd" id="1_a"]\n' +
      '[ext_resource type="Script" path="res://scripts/wiring.gd" id="2_b"]\n\n' +
      '[node name="Root" type="Node"]\n',
  );
});

afterEach(() => removeTmpDir(project));

function writeScript(name: string, body: string): void {
  writeFileSync(join(project, 'scripts', name), `extends Node\n${body}`);
}

function orphan(): Record<string, unknown> {
  return {
    check: 'signals',
    node: 'root/Hud',
    signal: '',
    target: 'root/Hud',
    method: HANDLER,
    problem: 'orphaned_handler',
    message: 'orphaned_handler',
    script: 'res://scripts/hud.gd',
  };
}

async function validateWith(findings: Record<string, unknown>[]) {
  const stdout = JSON.stringify({
    results: [{ target: 'main.tscn', errors: [], valid: true, checkErrors: findings }],
  });
  const fake = createFakeRunner({ stdout });
  const result = await handleValidate(fake.asRunner, {
    projectPath: project,
    scenePath: 'main.tscn',
    checks: [{ type: 'signals' }],
  });
  return JSON.parse(unwrap(result).content[0]!.text) as {
    valid: boolean;
    errors: Array<Record<string, unknown>>;
  };
}

describe('validate signals check: orphaned_handler recognises code connections', () => {
  const connectForms: Array<[string, string]> = [
    ['pressed.connect', `func _ready():\n\t$Button.pressed.connect(${HANDLER})\n`],
    ['connect with a signal name', `func _ready():\n\tconnect("pressed", ${HANDLER})\n`],
    [
      'connect with Callable(self, name)',
      `func _ready():\n\tconnect("pressed", Callable(self, "${HANDLER}"))\n`,
    ],
    ['connect with bind', `func _ready():\n\t$Button.pressed.connect(${HANDLER}.bind(1))\n`],
  ];

  it.each(connectForms)('drops the finding when the node script uses %s', async (_name, body) => {
    writeScript('hud.gd', `${body}${HUD_SCRIPT}`);
    writeScript('wiring.gd', '');
    const data = await validateWith([orphan()]);
    expect(data.errors).toEqual([]);
    expect(data.valid).toBe(true);
  });

  it('drops the finding when another script of the scene connects it', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', `func _ready():\n\t$Hud/Button.pressed.connect($Hud.${HANDLER})\n`);
    const data = await validateWith([orphan()]);
    expect(data.errors).toEqual([]);
  });

  it('drops the finding when the name is only held as a Callable value', async () => {
    writeScript('hud.gd', `var cb = ${HANDLER}\n${HUD_SCRIPT}`);
    writeScript('wiring.gd', '');
    const data = await validateWith([orphan()]);
    expect(data.errors).toEqual([]);
  });

  it('still reports a true orphan, without the internal script field', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', 'func _ready():\n\tpass\n');
    const data = await validateWith([orphan()]);
    expect(data.valid).toBe(false);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toMatchObject({ problem: 'orphaned_handler', method: HANDLER });
    expect(data.errors[0]).not.toHaveProperty('script');
    expect(data.errors[0]).not.toHaveProperty('severity');
  });

  it('lowers an uncertain finding to a warning that keeps the target valid', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', DYNAMIC_WIRING);
    const data = await validateWith([orphan()]);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toMatchObject({ problem: 'orphaned_handler', severity: 'warning' });
    expect(String(data.errors[0]!.message)).toContain(MAY_BE_CONNECTED);
    expect(data.valid).toBe(true);
  });

  it('a warning does not hide a real finding beside it', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', DYNAMIC_WIRING);
    const missing = {
      check: 'signals',
      node: 'root/A',
      signal: 'pressed',
      target: 'root/B',
      method: 'gone',
      problem: 'method_missing_on_target',
      message: 'method_missing_on_target',
    };
    const data = await validateWith([orphan(), missing]);
    expect(data.valid).toBe(false);
    expect(data.errors).toHaveLength(2);
  });
});

describe('validate signals check: a dynamic Callable downgrades only the handlers it can reach', () => {
  const TIMER_HANDLER = '_on_timer_timeout';

  function timerOrphan(): Record<string, unknown> {
    return { ...orphan(), method: TIMER_HANDLER, script: 'res://scripts/wiring.gd' };
  }

  function bySeverity(
    errors: Array<Record<string, unknown>>,
    method: string,
  ): Record<string, unknown> | undefined {
    return errors.find((e) => e.method === method);
  }

  it('warns for a handler the prefix fits and keeps an error for one it cannot reach', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript(
      'wiring.gd',
      `func _ready():\n\tconnect("pressed", Callable($Hud, "_on_button" + name))\nfunc ${TIMER_HANDLER}():\n\tpass\n`,
    );
    const data = await validateWith([orphan(), timerOrphan()]);
    expect(bySeverity(data.errors, HANDLER)).toMatchObject({ severity: 'warning' });
    const timer = bySeverity(data.errors, TIMER_HANDLER)!;
    expect(timer).not.toHaveProperty('severity');
    expect(data.valid).toBe(false);
  });

  it('names the script and line of the site in the warning', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', DYNAMIC_WIRING);
    const data = await validateWith([orphan()]);
    expect(String(data.errors[0]!.message)).toContain('res://scripts/wiring.gd line 3');
  });

  it('a format-string prefix and a literal suffix narrow the same way', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript(
      'wiring.gd',
      `func _ready():\n\tvar a = Callable($Hud, "_on_%s_pressed" % name)\n\tvar b = Callable($Hud, "_on_" + name + "_timeout")\nfunc ${TIMER_HANDLER}():\n\tpass\n`,
    );
    const data = await validateWith([orphan(), timerOrphan()]);
    expect(data.errors.map((e) => e.severity)).toEqual(['warning', 'warning']);
  });

  it('a fully dynamic name downgrades every unconnected handler', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript(
      'wiring.gd',
      `func wire(method_name):\n\tconnect("pressed", Callable($Hud, method_name))\nfunc ${TIMER_HANDLER}():\n\tpass\n`,
    );
    const data = await validateWith([orphan(), timerOrphan()]);
    expect(data.errors.map((e) => e.severity)).toEqual(['warning', 'warning']);
    expect(data.valid).toBe(true);
  });

  it('a scene whose scripts hold no dynamic site keeps both errors', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript('wiring.gd', `func ${TIMER_HANDLER}():\n\tpass\n`);
    const data = await validateWith([orphan(), timerOrphan()]);
    expect(data.errors.map((e) => e.severity)).toEqual([undefined, undefined]);
  });

  it('a self-target dynamic site warns for its own script handler and leaves another script handler an error', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript(
      'wiring.gd',
      `func wire(method_name):\n\tconnect("pressed", Callable(self, method_name))\nfunc ${TIMER_HANDLER}():\n\tpass\n`,
    );
    const data = await validateWith([orphan(), timerOrphan()]);
    expect(bySeverity(data.errors, TIMER_HANDLER)).toMatchObject({ severity: 'warning' });
    expect(bySeverity(data.errors, HANDLER)).not.toHaveProperty('severity');
    expect(data.valid).toBe(false);
  });

  it('a non-self target dynamic site still reaches a handler in another script', async () => {
    writeScript('hud.gd', HUD_SCRIPT);
    writeScript(
      'wiring.gd',
      'func wire(method_name):\n\tconnect("pressed", Callable(get_node("Hud"), method_name))\n',
    );
    const data = await validateWith([orphan()]);
    expect(bySeverity(data.errors, HANDLER)).toMatchObject({ severity: 'warning' });
  });
});
