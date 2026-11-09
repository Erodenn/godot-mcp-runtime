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

  it('blank.tscn exists alongside main.tscn', () => {
    expect(existsSync(join(fixturePath, 'blank.tscn'))).toBe(true);
  });

  // The three cases below guard the simulate_input probe fixture, whose absence would surface only as opaque Godot failures.
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

  it('motion_animated.tscn references motion_animated.gd, which exists', () => {
    const content = readFileSync(join(fixturePath, 'motion_animated.tscn'), 'utf8');
    expect(content).toContain('res://motion_animated.gd');
    expect(existsSync(join(fixturePath, 'motion_animated.gd'))).toBe(true);
  });

  it('motion_static.tscn exists alongside main.tscn', () => {
    expect(existsSync(join(fixturePath, 'motion_static.tscn'))).toBe(true);
  });
});

describe('tests/fixtures/godot-authored-project: fixture health', () => {
  const authoredPath = join(here, '..', 'fixtures', 'godot-authored-project');
  const authoredFiles = [
    'project.godot',
    'game_state.gd',
    'player.gd',
    'player.gd.uid',
    'player.tscn',
    'base_unit.tscn',
    'derived_unit.tscn',
    'host.tscn',
    'inventory.gd',
    'inventory.tscn',
    'broken_script.gd',
    'broken_script.tscn',
    'tinted_unit.tscn',
    'tinted_host.tscn',
    'typed_values.gd',
    'typed_values.tscn',
    'spawner.gd',
    'spawner.tscn',
    'unbind_host.gd',
    'unbind_host.tscn',
    'mixed_signal_host.tscn',
    'item_stats.gd',
    'item_stats.gd.uid',
    'sword.tres',
    'title_table.gd',
    'title_table.gd.uid',
    'bare_titles.tres',
    'title_host.gd',
    'title_host.tscn',
    'number_bag.gd',
    'number_bag.tres',
    'notes.txt',
  ];

  it.each(authoredFiles)('%s exists', (file) => {
    expect(existsSync(join(authoredPath, file))).toBe(true);
  });

  it('player.tscn header carries the scene uid', () => {
    const content = readFileSync(join(authoredPath, 'player.tscn'), 'utf8');
    expect(content.split('\n')[0]).toContain('uid="uid://clomui4eibwiq"');
  });

  it('project.godot registers the GameState autoload', () => {
    const content = readFileSync(join(authoredPath, 'project.godot'), 'utf8');
    expect(content).toContain('GameState="*res://game_state.gd"');
  });
});

describe.each([
  {
    fixture: 'godot-stretch-project',
    mainScene: 'stretch_probe.tscn',
    files: ['stretch_probe.gd'],
  },
  {
    fixture: 'godot-canvas-layer-project',
    mainScene: 'canvas_layer_probe.tscn',
    files: ['canvas_layer_probe.gd', 'content_scale_probe.tscn', 'content_scale_probe.gd'],
  },
])('tests/fixtures/$fixture: fixture health', ({ fixture, mainScene, files }) => {
  const projectPath = join(here, '..', 'fixtures', fixture);

  it(`project.godot wires run/main_scene to ${mainScene}, which exists`, () => {
    const content = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(content).toContain(`run/main_scene="res://${mainScene}"`);
    expect(existsSync(join(projectPath, mainScene))).toBe(true);
  });

  it.each(files)('%s exists', (file) => {
    expect(existsSync(join(projectPath, file))).toBe(true);
  });
});
