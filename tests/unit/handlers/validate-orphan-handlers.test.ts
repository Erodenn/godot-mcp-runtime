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
const DYNAMIC_WIRING = 'func _ready():\n\tconnect("pressed", Callable(self, "_on_" + name))\n';

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
