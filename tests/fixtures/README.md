# Test fixtures

## `godot-project/`

A minimal Godot 4.4 project used as a stable test surface for MCP tools. Committed to the repo (unlike `.test-project/`, which is gitignored for ad-hoc local testing) so contributors and CI share the same baseline.

Contents:
- `project.godot` — minimal config, references `main.tscn` as main scene
- `main.tscn` — `Node2D` root with `Label` and `Sprite2D` children
- `placeholder.gd`, `placeholder.png` — empty placeholder files used by handler tests that exercise `attach_script` / `load_sprite` runner-throws paths

Use it from tests by passing the absolute path:

```ts
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'godot-project');
```

Tests that exercise headless Godot (validate, scene operations) skip themselves when `GODOT_PATH` is not set, so this fixture is also safe to leave in place when Godot is not installed.

When you change a tool's contract, update this fixture or add a sibling fixture under `tests/fixtures/` rather than mutating `main.tscn` in place — old tests may depend on the existing shape.
