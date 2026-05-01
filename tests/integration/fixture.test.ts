import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'godot-project');

describe('committed test fixture', () => {
  it('contains a valid project.godot', () => {
    expect(existsSync(join(fixturePath, 'project.godot'))).toBe(true);
  });

  it('contains the main scene referenced by project.godot', () => {
    expect(existsSync(join(fixturePath, 'main.tscn'))).toBe(true);
  });
});
