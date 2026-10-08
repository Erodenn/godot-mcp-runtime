# Test fixtures

## `godot-project/`

A minimal Godot 4.4 project used as a stable test surface for MCP tools. Committed to the repo (unlike `.test-project/`, which is gitignored for ad-hoc local testing) so contributors and CI share the same baseline.

Contents:
- `project.godot`: minimal config, references `main.tscn` as main scene
- `main.tscn`: `Node2D` root with `Label` and `Sprite2D` children
- `placeholder.gd`, `placeholder.png`: empty placeholder files used by handler tests that exercise `attach_script` / `load_sprite` runner-throws paths
- `input_probe.tscn`, `input_probe.gd` - sibling probe scene for the `simulate_input` integration tests: buttons that are plain, toggling, disabled, occluded, panel-opening, error-raising and self-freeing, plus a `LineEdit` and a `Node2D` moved by an `is_action_pressed` poll
- `blank.tscn` - empty `Node` root that renders only the clear color; the blank case for the pixel statistics tests. Launched by rewriting `run/main_scene` in a temp copy
- `motion_animated.tscn`, `motion_animated.gd`, `motion_static.tscn` - sibling scenes for the `render_movie` motion tests: a `ColorRect` moved every frame by `motion_animated.gd`, and the same rect with no script

`project.godot` also carries one InputMap action, `probe_move`, bound to W by `physical_keycode` (the Godot editor's default binding style). `tests/integration/simulate-input-observed.test.ts` launches the probe scene by rewriting `run/main_scene` in its own temp copy of the project, so `main.tscn` stays the main scene for everything else.

## `godot-authored-project/`

A project laid out the way the Godot editor writes one: a registered autoload, a scene uid and ext_resource uids, an inherited scene and typed exports. The minimal fixture above is hand-trimmed and hides every bug that depends on those. Copy it to a tmp dir before mutating (`authoredFixtureProjectPath` in `tests/helpers/fixture-paths.ts`). `config/features` names 4.5.

Contents and what each file is for:
- `project.godot`: registers the `GameState` autoload (`game_state.gd`, `var score := 7`)
- `player.tscn`, `player.gd`, `player.gd.uid`: root script reads the `GameState` autoload (it only compiles when autoload globals exist), stored `speed = 9.0`, a scene uid, a script uid on the ext_resource, and a `Body` `Sprite2D` child
- `base_unit.tscn`: plain scene with an `Arm` `Sprite2D` and a `Leg` `Label` that carry non-default properties
- `derived_unit.tscn`: inherits `base_unit.tscn` (root is `instance=`), overrides `Arm.position` and adds its own `Extra` child
- `host.tscn`: instances `base_unit.tscn` as `Unit` with a position override, for edits inside an instanced child
- `inventory.tscn`, `inventory.gd`: typed exports (`Dictionary[String, int]`, `Dictionary[int, float]`, `Vector2i`, `PackedByteArray`, `PackedInt32Array`); needs Godot 4.4+ because of the typed dictionaries
- `broken_script.tscn`, `broken_script.gd`: a script that cannot compile (undeclared identifier) with a stored `speed = 9.0`, the deterministic case for a save that drops content
- `tinted_unit.tscn`, `tinted_host.tscn`: a scene whose root carries a non-default `position` and `modulate` plus a `Core` child, and a host that instances it twice: as `Unit` with a position override and a `Badge` child the host adds under it, and as `Group/Inner` with no override. Both carry scene uids. Used by the `duplicate_node` tests on instanced nodes
- `typed_values.tscn`, `typed_values.gd`: stored `Array[int]`, `PackedInt32Array` and `int` exports plus an `Array[Vector2i]` left at its default, for the integer range and empty container write tests. The script has no `.uid` sidecar because the scene references it by path alone
- `spawner.tscn`, `spawner.gd`: a scene that holds `base_unit.tscn` as a property value, once in a `PackedScene` export and once in an `Array[PackedScene]` export, both written as `ExtResource`. For the batch test that saves `base_unit.tscn` while this scene's tree is loaded: the reference has to stay an `ExtResource`
- `unbind_host.tscn`, `unbind_host.gd`: a `Toggle` `CheckButton` whose `toggled` signal is connected to a root method that takes no argument, with `unbinds=1`. For the `duplicate_node` test that the copy's connection keeps its unbound argument count
- `notes.txt`: a plain text file under `res://`, not an importable resource

## `godot-profiling-project/`

The same shape, with a `_process` loop that burns measurable time (`hot_loop.gd::burn`).
`integration/profiler-smoke.test.ts` launches it with `profiling: true` and expects that
function to come back at the top of the capture, and uses it for the `visual: true` render-stage
capture as well. Import it as `profilingFixtureProjectPath`.

Use it from tests by importing the path helper:

```ts
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
```

`tests/helpers/fixture-paths.ts` exports `fixtureProjectPath`, `fixtureScenePath`, and `fixtureSceneAbsPath` so individual specs don't redo the `fileURLToPath` / `dirname` / `join` boilerplate.

Tests that exercise headless Godot (validate, scene operations) skip themselves when `GODOT_PATH` is not set, so this fixture is also safe to leave in place when Godot is not installed.

When you change a tool's contract, update this fixture or add a sibling fixture under `tests/fixtures/` rather than mutating `main.tscn` in place, since old tests may depend on the existing shape.
