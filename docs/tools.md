# Tools

The full MCP tool reference for Godot MCP Runtime. This file always reflects `main`; for older releases, browse the corresponding git tag.

## Project Management

| Tool               | Description                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_editor`    | Open the Godot editor GUI for a project                                                                                                                                                                                                  |
| `run_project`      | Run a project and inject the MCP bridge. Pass `background: true` to hide the window; `profiling: true` to enable the profiling tools; pass `bridgePort` (integer 1–65535) to pin the bridge port - auto-selects a free port when omitted |
| `attach_project`   | Inject the MCP bridge for a project you'll launch yourself. Pass `bridgePort` (integer 1–65535) to pin a specific port - auto-selects a free port when omitted                                                                           |
| `detach_project`   | Remove the injected bridge after manual-launch use, leaving the external process alone. Mostly optional: a disconnected bridge ends the attached session on the next tool call, and calling this afterwards succeeds idempotently        |
| `stop_project`     | Stop the running project and remove the bridge (also detaches attached-mode state). Call it even if you closed the Godot window yourself - it frees the retained process slot and reports `alreadyExited` with the logs captured then    |
| `get_debug_output` | Read stdout/stderr from an MCP-spawned project, including after it exits or crashes (unavailable in attached mode)                                                                                                                       |
| `list_projects`    | Find Godot projects in a directory                                                                                                                                                                                                       |
| `check_project`    | Get project metadata and Godot version, plus an always-present runtime block (session/bridge/process status) - never errors on the runtime probe itself                                                                                  |

## Runtime (requires `run_project` or `attach_project` first)

Both `run_project` and `attach_project` wait for the bridge before returning success, so runtime tools are usable immediately after the call returns. `attach_project` waits up to 20 s for the externally launched Godot process to start listening, and up to 60 s total once a connection has been observed, so a large project's cold start is absorbed. If you (the agent) are launching Godot yourself, kick the launch off in parallel with `attach_project` so the wait absorbs Godot's startup - don't sequentialize. If a human is launching Godot and they don't make it inside the window, retry `attach_project` (`bridge.inject` is idempotent). Both `run_project` and `attach_project` auto-select a free bridge port when `bridgePort` is omitted; pass `bridgePort` to pin a specific port. A first cold launch on a large project (hundreds of scripts) is the case the longer budget exists for.

| Tool              | Description                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `take_screenshot` | Capture a PNG; defaults to a 960x540 inline preview. Use `responseMode: "full"` for pixel-perfect, `"path_only"` for path metadata only |
| `simulate_input`  | Send batched input and report what each action did: the Control it hit, the signals it fired, what changed on screen                    |
| `get_ui_elements` | Get all visible Control nodes with positions, types, and text                                                                           |
| `run_script`      | Execute arbitrary GDScript at runtime with full SceneTree access                                                                        |

`take_screenshot` defaults to `responseMode: "preview"` - the full PNG is saved to `.mcp/godot-runtime/screenshots/` and a 960x540-bounded preview is returned inline. Use `"full"` for pixel-level inspection or `"path_only"` to skip the inline image.

### `simulate_input`

One call executes a batch of actions in order and returns one result entry per action, describing what the engine did rather than what was requested. Each action is injected, given one `process_frame` to settle, and only then read: `Input.parse_input_event` is buffered, so nothing has happened yet in the frame an event is submitted.

**Action types.** `key`, `mouse_button`, `mouse_motion`, `click_element`, `action`, `text`, `wait`.

**The press rule.** For `key`, `mouse_button` and `action`, omitting `pressed` taps: the input presses and releases itself inside the one action. `pressed: true` presses and holds across later actions in the batch and across later calls; `pressed: false` releases an earlier hold. This replaces the old behavior, where omitting `pressed` pressed without ever releasing and left the input stuck down.

`hold_ms` replaces the default tap gap with a real-time hold, for game code that polls `is_action_pressed` over time. It applies to `key`, `mouse_button` and `action` only, and is rejected when `pressed` is set as well: a hold with an explicit press has no end to time. The default gap is one `process_frame` plus one `physics_frame` for `key` and `action` (so a `_physics_process` poll cannot miss the press) and zero gap for `mouse_button` and `click_element`, which is what a real click looks like.

**`wait`** takes exactly one of `ms` (real time, for cooldowns and animations) or `frames` (deterministic engine process frames, for stepping game logic). Neither or both is a validation error. A `wait` injects nothing, so it adds no settle frame of its own and its reported `frame` is exactly the frames it waited. A `frames` wait is exact; an `ms` wait is a lower bound, resolving on the first frame at or past the requested wall-clock time, so `elapsed_ms` is never less than `ms` and may exceed it by up to a frame. Real time here means wall clock, not scaled engine time: a game that pauses the tree or drops `Engine.time_scale` to zero still sees the wait resolve.

**`text`** types a string into whatever Control currently holds focus, expanded to one key press and release per character with the unicode codepoint set. It does not focus anything itself: click or focus the `LineEdit` first, or the action fails.

**`watch`** is a top-level array, not a per-action field, and is sampled after every action in the batch. Each entry is a `NodePath:property` string, for example `"/root/Main/Player:position"`. Property subnames are allowed, so `"/root/Main/Player:position:x"` samples the scalar. Sampling is read-only and never fails a batch: an unresolvable node or property reports `null` for that key while the rest of the batch continues.

**`results[]`.** Every entry carries `index`, `type`, `ok`, `frame` (process frames since the batch started) and `elapsed_ms`. A failing entry carries `error`. The rest are present only where they mean something:

| Field      | On which types                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `hit`      | `click_element`, `mouse_button` - path of the Control under the pointer after the settle frame        |
| `signals`  | `click_element` - which of `pressed`, `toggled`, `item_selected`, `text_submitted` the target emitted |
| `focus`    | `key`, `text` - path of the focus owner after the action                                              |
| `value`    | `text` - resulting text of the focused `LineEdit` or `TextEdit`                                       |
| `pressed`  | `action` - whether the input action is still held after this entry                                    |
| `position` | `mouse_motion` - the resulting mouse position                                                         |
| `errors`   | any action whose handlers raised a GDScript runtime error                                             |

**`changes`** is the delta in visible Control nodes across the action, over the same walk `get_ui_elements` uses, with `appeared`, `disappeared`, `changed` (text and disabled state), plus `scene` and `focus` when those moved. `appeared` and `disappeared` collapse subtrees: an overlay opening reports the overlay's path once, not every Control beneath it. Each list is capped, and `truncated` counts how many entries were dropped when it was.

**`still_held`** lists what this batch pressed and did not release, as `"key:W"`, `"action:jump"` or `"mouse_button:left"`. It is absent when the batch holds nothing. Nothing is auto-released at the end of a batch, so a held input stays held until a later action or call releases it.

**Failure handling.** An invalid batch is rejected whole, before anything is injected, with an error response naming the offending action index. A runtime failure part-way through is different: the batch stops there, the remaining entries come back as `{index, type, skipped: true}`, `success` is `false`, and the response is still a normal success-shaped response carrying the partial timeline. Read `results[]` to see how far it got.

`errors` is only available for sessions this server spawned with `run_project`. An `attach_project` session has no captured stderr, so handler errors cannot be attributed and the field is simply omitted.

`hit` and the occlusion check behind it both read the viewport's hovered control, which older Godot 4.x builds do not expose. On those builds `hit` is omitted and an occluded click reports plain success, so treat `hit` as a bonus rather than a guarantee.

## Profiling (requires `run_project` with `profiling: true`)

`profiling: true` adds `--remote-debug` to the launch, so the numbers are Godot's own editor profiler measurements. The channel is set at launch: an already-running session, and every `attach_project` session, returns "Profiling is not enabled for this session."

| Tool              | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `profile_project` | Capture a window (default 5 s, max 60) and return the most expensive GDScript functions   |
| `start_profiler`  | Start a capture and return immediately, so runtime tools can drive the game while it runs |
| `stop_profiler`   | Stop (or re-read) that capture and rank its functions                                     |

A capture returns the same three things the editor's Profiler tab shows:

| Field        | Editor equivalent                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rows[]`     | The **Script Functions** list. `function`, `file`, `line` (the tooltip's `res://…gd:371`), summed `calls`, own `selfMs` and inclusive `totalMs`, per-frame averages, `msPerCall` (the editor's "Average Time"), `percentOfFrame` ("Frame %", a share of the capture's own average frame, not of a 16.67 ms target), and `peak` frame |
| `frame`      | The **Frame Time** category: `frameMs`, `processMs`, `physicsMs`, `physicsFrameMs`, `scriptMs`, each as `{ avg, max }` over the capture                                                                                                                                                                                              |
| `servers[]`  | One entry per server category (`audio_thread`, `physics_2d`, …) with its functions, in milliseconds per frame                                                                                                                                                                                                                        |
| `worstFrame` | The slowest single frame: its timings plus its top 30 functions by inclusive time - the spike you would click in the editor's graph                                                                                                                                                                                                  |

`sort` ranks rows by `selfMs` (default), `totalMs`, or `calls`. Milliseconds are rounded to four decimals.

Reading the numbers:

- Times are elapsed wall clock, including waits, not CPU utilization. Inclusive rows overlap, so summing `totalMs` is meaningless.
- Totals sum the received frames after the first, which is discarded: enabling the profiler inside a running VM call gives that sample a zero start timestamp.
- Godot picks the rows it sends by inclusive time and caps them at `captureLimit`. `limitReached`, `frameGaps` and `undecodablePackets` say when rows, whole frames, or packets are missing; a function that is absent is not a function that is free.
- Totals are summed from the frame packets. The engine's own `servers:profile_total` is capped by the same `captureLimit` and carries nothing the frames did not, while top-N membership rotates between frames, so summing them covers strictly more functions than that packet does.
- The injected `mcp_bridge.gd` polls its socket every frame, so it shows up in the rows like any other script. That is real observer overhead (well under 0.05 ms/frame in practice), not a measurement artifact. A `run_script` you execute during a capture is profiled the same way and appears under its own generated script name; discount it when reading a capture you drove yourself.
- Native engine calls are not profiled as separate rows (the editor's "Display internal functions" toggle), so `selfMs` matches the editor's Self column in its default configuration.
- A capture stops itself at its time limit, measured from the first frame folded rather than from the enable round trip. `stop_project` ends it along with the session.
- A capture that folded no usable frames errors rather than returning zeroes: the first frame received is always discarded, so a window shorter than two rendered frames has nothing to average.
- A finished capture stays readable after the game exits, so the capture taken just before a crash can still be ranked.

While the debugger is attached, a script error or a `breakpoint` would normally pause the game; the server answers every break with `continue`, so the game keeps running and the error still shows up in `get_debug_output`.

## Scene Editing (headless)

All mutation operations save automatically. Use `save_scene` only for save-as (`newPath`) or to re-canonicalize a `.tscn` file.

Every tool below errors while a Godot runtime session is active on the same project - a running process can write its own scene files at any point, so a headless write would race it. Call `stop_project` (or `detach_project`) to clear the block. A spawned process that exits on its own clears the block at that moment, without a tool call.

| Tool                     | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `create_scene`           | Create a new scene file                                                                  |
| `add_node`               | Add a node, or instance an existing scene, into a scene                                  |
| `load_sprite`            | Set a texture on a Sprite2D, Sprite3D, or TextureRect                                    |
| `save_scene`             | Re-pack and save the scene, or save-as with `newPath`                                    |
| `export_mesh_library`    | Export scenes as a MeshLibrary for GridMap                                               |
| `batch_scene_operations` | Run multiple add_node/load_sprite/set_node_properties/save ops in a single Godot process |

`add_node` takes either a Godot class name or a project-relative scene path (`.tscn` or `.scn`, matched case-insensitively) as `nodeType`. A scene path is loaded and instanced, and serializes as `instance=ExtResource(...)` on save, so scenes can be composed without hand-editing `.tscn` files.

Spatial properties (`position`, `rotation`, `scale`, `visible`, `modulate`) may be passed as top-level params instead of under `properties`, on the standalone tool and on `add_node` items inside `batch_scene_operations` alike. `properties` wins on a key conflict. `position` takes `{x, y}` on a 2D node and `{x, y, z}` on a 3D node.

`set_node_properties` items inside `batch_scene_operations` accept the same per-update params (`nodePath`, `property`, `value`) as the standalone tool, plus a per-operation `scenePath` and `abortOnError`; per-update results appear under `results[].updates`.

Every path argument is confined to the project root. A path that resolves outside it (for example `../enemy.tscn`) is rejected rather than followed, on both the standalone and batch paths.

## Node Editing (headless)

All mutation operations save automatically. Property and delete tools take always-array input - pass a single-element array for one-off operations, or many for batched work in one Godot process.

`set_node_properties`, `attach_script`, `duplicate_node`, `delete_nodes`, `connect_signal`, and `disconnect_signal` error while a Godot runtime session is active on the same project - a running process can write its own scene files at any point, so a headless write would race it. Call `stop_project` (or `detach_project`) to clear the block. The three read-only tools (`get_scene_tree`, `get_node_properties`, `get_node_signals`) are unaffected.

| Tool                  | Description                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| `get_scene_tree`      | Get the full scene tree hierarchy (use `maxDepth: 1` for shallow listing) |
| `get_node_properties` | Read properties from one or more nodes (always-array `nodes`)             |
| `set_node_properties` | Set properties on one or more nodes (always-array `updates`)              |
| `attach_script`       | Attach a GDScript to a node                                               |
| `duplicate_node`      | Duplicate a node within the scene                                         |
| `delete_nodes`        | Remove one or more nodes from the scene (always-array `nodePaths`)        |
| `get_node_signals`    | List all signals on a node with their connections                         |
| `connect_signal`      | Connect a signal to a method on another node                              |
| `disconnect_signal`   | Disconnect a signal connection                                            |

## Property Values (`add_node`, `set_node_properties`)

Both tools take JSON property values and assign them through the same validated path. `node.set()` casts through the property's typed setter with no validity return, so an incompatible value would silently store the declared type's zero value (a string on an int stores `0`, a dict on a Resource clears it). Every value is therefore checked against the property's declared type first, and a mismatch errors instead of reporting a write that did not land.

### Automatic conversions

| Input                        | Becomes                     |
| ---------------------------- | --------------------------- |
| `{x, y}`                     | `Vector2`                   |
| `{x, y, z}`                  | `Vector3`                   |
| `{r, g, b}` / `{r, g, b, a}` | `Color` (`a` defaults to 1) |

A property whose declared type is `Dictionary` skips this coercion, so a dict with `x`/`y` or `r`/`g`/`b` keys is stored as a plain `Dictionary`.

### Accepted widening conversions

Godot performs these on store, so they are allowed: float to int, string to `NodePath` or `StringName`, bool to int or float, `Vector2` to `Vector2i` (and back), `Vector3` to `Vector3i` (and back), and `Array` to any `Packed*Array`. Everything else errors.

### Packed arrays

`Array` to a `Packed*Array` conversion also applies per element: each element is coerced with the scalar rules above (`{"x": 1, "y": 2}` becomes `Vector2(1, 2)`, ints widen to floats in `PackedFloat32Array`, and so on). An element that cannot represent the packed element type (a string in a `PackedVector2Array`, a bool in a `PackedColorArray`) errors instead of storing Godot's silent zero value, and the error names the offending element index. An empty array clears the property.

```json
{
  "polygon": [
    { "x": 10, "y": 20 },
    { "x": 30, "y": 40 }
  ]
}
```

### Typed arrays

A script-declared `Array[T]` (for example `@export var points: Array[Vector2]`) takes a plain JSON array too, and the same element conversions apply when `T` is `int`, `float`, `String`, `Vector2`, `Vector3`, `Vector4` or `Color`. An element that cannot represent `T` errors and the error names its index. An untyped `Array` accepts anything, unchanged. An `Array[T]` whose `T` is a class, a Resource or an enum is passed through without element checks, so a wrong element there surfaces as a Godot engine error in the process output rather than as a tool error.

### Object-typed properties

Properties declared as a `Resource` or `Node` (for example `CollisionShape2D.shape`, `Sprite2D.texture`) reject plain values. They accept one of three forms:

| Form                                | Behavior                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"res://path/to/file.tres"`         | Loads the saved resource. An asset that exists on disk but has never been imported triggers an automatic headless import and one retry, transparent to the caller. A path that does not exist on disk is an error, and a mutation on a scene that references a missing file is refused outright so the reference is not stripped on save. |
| `{ "type": "ClassName", ...props }` | Constructs the Resource inline via `ClassDB.instantiate`, then assigns each inner property.                                                                                                                                                                                                                                               |
| `null`                              | Clears the property.                                                                                                                                                                                                                                                                                                                      |

Inline construction example:

```json
{ "shape": { "type": "RectangleShape2D", "size": { "x": 80, "y": 16 } } }
```

Inner properties are assigned through the same validation described above, so nested typed dicts and nested `res://` paths both work at any depth. The scene is persisted with `PackedScene.pack()`, so a constructed Resource is written out as a normal `[sub_resource]` block.

#### Virtual properties (slash-suffixed keys, e.g. `shader_parameter/*`)

Keys containing `/` (most importantly `ShaderMaterial`'s `shader_parameter/<uniform>` entries) name _virtual_ properties that only exist on an instance after the property they depend on is assigned. They are handled specially:

- Dependency-first ordering: plain keys are assigned before slash-suffixed keys, so `"shader": "res://neon.gdshader"` lands before `"shader_parameter/glow"`.
- Validation is against the instance's live property list (`set()` alone accepts unknown names silently), so a `shader_parameter/<name>` that the assigned shader does not declare as a uniform is an explicit error, as is any slash-suffixed key when no shader is assigned. A group/subgroup/category label that happens to contain `/` is rejected too, even when it is otherwise listed.
- Settable from JSON: `float`, `int`, and `bool` uniforms; plain `vec2` and `vec3` uniforms (via `{x,y}` / `{x,y,z}` dicts); `source_color` uniforms declared `vec3` or `vec4` (via `{r,g,b,a}` dicts, coerced to `Color`); and `sampler2D`/`sampler3D` uniforms (via a `res://` path, like any Object-typed property). Not yet settable from JSON: a plain `vec4` uniform (one without `: source_color`) and `mat2`/`mat3`/`mat4` uniforms - these error explicitly rather than dropping silently.

```json
{
  "material": {
    "type": "ShaderMaterial",
    "shader": "res://shaders/neon.gdshader",
    "shader_parameter/glow": 2.5,
    "shader_parameter/tint": { "r": 0.2, "g": 0.9, "b": 1.0 }
  }
}
```

The persisted scene references the shader as an `ext_resource` plus one line per explicitly set parameter (unset uniforms are serialized as `null` lines; that is stock `PackedScene.pack()` behavior, identical to any scene saved by the editor with a partially-configured material).

Construction errors are explicit and nothing is persisted when one fires:

- `type` names an unknown class
- `type` names a class that is not a `Resource` subclass
- `type` names an abstract or native-only class that cannot be instantiated
- the constructed class does not satisfy the property's declared resource hint (for example a `RectangleShape2D` assigned to `Sprite2D.texture`)
- an inner property does not exist on the constructed class, or its value fails the type check (the error names the inner property)
- a slash-suffixed key does not resolve on the instance: for `shader_parameter/<name>`, either no shader was assigned before it, the assigned shader does not declare `<name>` as a uniform, or the assigned shader failed to compile (reported as such, distinct from the other two)

#### Key names are preserved verbatim

Property names, `metadata/<key>` entries, script-exported variable names, and `shader_parameter/<uniform>` names are passed to Godot exactly as written, including camelCase (`shader_parameter/glowAmount`). The snake_case/camelCase translation applies to tool parameter names only, never to keys inside `properties` or inside an update's `value`.

## Project Config (no Godot process required)

These tools edit `project.godot` directly or read the filesystem. Safe to use even when autoloads are broken.

| Tool                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `list_autoloads`         | List all registered autoloads with paths and singleton status        |
| `add_autoload`           | Register a new autoload                                              |
| `remove_autoload`        | Unregister an autoload by name                                       |
| `update_autoload`        | Modify an existing autoload's path or singleton flag                 |
| `get_project_settings`   | Read settings from `project.godot`, optionally filtered by `section` |
| `get_project_files`      | Get the project file tree with types and extensions                  |
| `search_project`         | Search for a string across project source files                      |
| `get_scene_dependencies` | List all resources a scene depends on                                |

## Validation: `validate`

Validate before attaching or running. Catches syntax errors and missing resource references before they cause headless crashes or runtime failures. Supports `scriptPath`, `source` (inline GDScript), `scenePath`, or a `targets` array for batch validation.

A `checks` array (alongside `scenePath`, or inside a `targets[]` item) adds structural and signal-verification checks in the same validation call. With `scenePath + checks`, both the resource-integrity validation and the checks run; their errors are merged into one `errors` array, each check-attributed error carrying a `check` discriminator.

A parse error carries a `line` only when Godot's stderr includes one, which is not always.

```json
{
  "projectPath": "/path/to/project",
  "scenePath": "scenes/player.tscn",
  "checks": [
    {
      "type": "structure",
      "schema": {
        "type": "CharacterBody2D",
        "children": [{ "type": "CollisionShape2D", "hasProperty": "shape" }]
      }
    },
    { "type": "signals", "nodePath": "root/HUD" }
  ]
}
```

**Instantiation.** A plain `scenePath` only loads the scene. `scenePath` plus `checks` instantiates it, which runs every attached script's `_init()` inside the headless process. Worth knowing, because `validate` is the tool to run before trusting a scene.

**Batch cost.** `targets[].checks` run inside the same single Godot process as the rest of the batch, so adding checks to a batch costs no extra process launches. One target's failure (a bad schema, a missing scene, an unimported dependency) is reported on that target and the other targets still report, in input order.

**Why `checks[].type` is a discriminator.** It is a deliberate exception to the antipattern in [`tool-authoring.md` section 5](tool-authoring.md#5-consolidation-criteria): the two checks are heterogeneous operations over one instantiated scene tree in one process. Splitting them would cost a second Godot launch per scene and grow the tool surface.

### Structural checks: `checks: [{ type: "structure" }]`

`validate` with a plain `scenePath` checks one scene's syntax and resource integrity; a `structure` check validates a scene's _shape_ against a schema you declare. Use it to enforce architectural invariants a game loop depends on: "the Player scene's root is a `CharacterBody2D` and it has a `CollisionShape2D` child with `shape` set".

The schema is a recursive object:

```json
{
  "type": "CharacterBody2D",
  "children": [{ "type": "CollisionShape2D", "hasProperty": "shape" }, { "type": "Sprite2D" }]
}
```

- `type`: the node's Godot class name, matched as an exact class name with no subclass matching. A schema declaring `Node2D` fails against a `CharacterBody2D` root even though a `CharacterBody2D` is one.
- `children`: schemas for direct children. Each entry matches the first not-yet-consumed child of its declared type, in schema order; two entries of the same type require two distinct matching children.
- `hasProperty`: the property is present and its value is neither `null` nor an empty string. Integer `0` and boolean `false` count as set.

Read-only: the scene is loaded into a headless process, never mutated, and no save happens. Unmatched children or extra siblings are not reported - only declared requirements are checked, so a schema cannot express "and nothing else".

Structural failures are returned in the `validate` output's `errors` array with `"check": "structure"` and a human-readable `message` naming the expected type/property and path.

### Signal checks: `checks: [{ type: "signals" }]`

Walks every connection reachable from the scope (whole scene, or the subtree under `nodePath`) and reports one issue per problem found. Read-only. Issues appear in `errors` with `"check": "signals"` and `{ node, signal, target, method, problem }`; `node`, `target` are scene-root-relative paths. The problem codes:

| Code                       | Meaning                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `target_not_in_scene`      | Connection target resolves outside the scene (freed object, or a connection made to a non-Node).                                         |
| `method_missing_on_target` | The handler method does not exist on the target node - the signal would silently no-op or error on emit. See the residual classes below. |
| `naming_convention`        | Handler does not begin with `_on_` - debuggability warning only, the connection still fires.                                             |
| `orphaned_handler`         | A script-defined `_on_*` method on a node with no incoming connection pointing at it - dead code, or leftover after a disconnect.        |

What `method_missing_on_target` covers, stated precisely so a clean result is not read as proof:

- **Reported:** a connection authored in the scene file (a `[connection]` line, which is what `connect_signal` writes) whose method is declared by neither the target's script chain nor the target's engine class. A private name is no exemption and neither is the absence of a script on the target: `_hanlde_press` is reported wherever it points, because a method that exists in no script and no engine class exists nowhere.
- **Not reported (false negatives):** a typo that happens to collide with a method the target's engine class declares, and a handler wired only in code (`connect()` at runtime), which a headless check never sees connected in the first place.
- **Excluded by design:** connections the engine makes for itself while instantiating the scene. Those are not persisted into the scene file, so they are skipped rather than guessed at. An unnamed callable such as a lambda also has no method name to check.
