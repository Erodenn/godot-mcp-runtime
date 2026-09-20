import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'godot-project');

describe('tests/fixtures/godot-project: fixture health', () => {
  it('project.godot exists', () => {
    expect(existsSync(join(fixturePath, 'project.godot'))).toBe(true);
  });

  it('project.godot wires run/main_scene to main.tscn', () => {
    const content = readFileSync(join(fixturePath, 'project.godot'), 'utf8');
    expect(content).toContain('main.tscn');
  });

  it('main.tscn exists alongside project.godot', () => {
    expect(existsSync(join(fixturePath, 'main.tscn'))).toBe(true);
  });

  // The three cases below guard the simulate_input probe fixture. Without them
  // a missing or renamed file surfaces only as opaque Godot failures inside
  // integration/simulate-input-observed.test.ts.
  it('input_probe.tscn exists alongside main.tscn', () => {
    expect(existsSync(join(fixturePath, 'input_probe.tscn'))).toBe(true);
  });

  it('input_probe.tscn references input_probe.gd, which exists', () => {
    const content = readFileSync(join(fixturePath, 'input_probe.tscn'), 'utf8');
    expect(content).toContain('res://input_probe.gd');
    expect(existsSync(join(fixturePath, 'input_probe.gd'))).toBe(true);
  });

  it('project.godot maps the probe_move input action', () => {
    const content = readFileSync(join(fixturePath, 'project.godot'), 'utf8');
    expect(content).toContain('probe_move');
    expect(content).toContain('"physical_keycode":87');
  });
});
