import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'godot-project');

describe('tests/fixtures/godot-project — fixture health', () => {
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
});
