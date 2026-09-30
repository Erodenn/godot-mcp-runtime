# Tools

The full MCP tool reference for Godot MCP Runtime. This file always reflects `main`; for older releases, browse the corresponding git tag.

## Project Management

| Tool               | Description                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_editor`    | Open the Godot editor GUI for a project                                                                                                                                                                                                  |
| `run_project`      | Run a project and inject the MCP bridge. Pass `background: true` to hide the window; `profiling: true` to enable the profiling tools; pass `bridgePort` (integer 1-65535) to pin the bridge port - auto-selects a free port when omitted |
| `attach_project`   | Inject the MCP bridge for a project you'll launch yourself. Pass `bridgePort` (integer 1-65535) to pin a specific port - auto-selects a free port when omitted                                                                           |
| `detach_project`   | Remove the injected bridge after manual-launch use, leaving the external process alone. Mostly optional: a disconnected bridge ends the attached session on the next tool call, and calling this afterwards succeeds idempotently        |
| `stop_project`     | Stop the running project and remove the bridge (also detaches attached-mode state). Call it even if you closed the Godot window yourself - it frees the retained process slot and reports `alreadyExited` with the logs captured then    |
| `get_debug_output` | Read stdout/stderr from an MCP-spawned project, including after it exits or crashes (unavailable in attached mode)                                                                                                                       |
| `list_projects`    | Find Godot projects in a directory                                                                                                                                                                                                       |
| `check_project`    | Get project metadata and Godot version, plus an always-present runtime block (session/bridge/process status) - never errors on the runtime probe itself                                                                                  |

## Runtime (requires `run_project` or `attach_project` first)

Both `run_project` and `attach_project` wait for the bridge before returning success, so runtime tools are usable immediately after the call returns. `attach_project` waits up to 20 s for the externally launched Godot process to start listening, and up to 45 s total once a connection has been observed, so a large project's cold start is absorbed. That ceiling sits under the 60 s default per-request timeout most MCP clients use, so the failure is reported by the server rather than cut off by the client. If something is listening on the port but answers no ping at all, the wait gives up after eight consecutive failures instead of spending the whole budget, and says so. If you (the agent) are launching Godot yourself, kick the launch off in parallel with `attach_project` so the wait absorbs Godot's startup - don't sequentialize. If a human is launching Godot and they don't make it inside the window, retry `attach_project` (`bridge.inject` is idempotent). Both `run_project` and `attach_project` auto-select a free bridge port when `bridgePort` is omitted; pass `bridgePort` to pin a specific port. A first cold launch on a large project (hundreds of scripts) is the case the longer budget exists for. A spawned `run_project` session waits up to 30 s for the same readiness signal, and aborts immediately if the child process exits first.

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

**`wait`** takes exactly one of `ms` (real time, for cooldowns and animations) or `frames` (deterministic engine process frames, for stepping game logic). Neither or both is a validation error. A `wait` injects nothing, so it adds no settle frame of its own and its reported `frame` is exactly the frames it waited. A `frames` wait is exact; an `ms` wait is a lower bound, resolving on the first frame at or past the requested wall-clock time, so it may overshoot by up to a frame. Note that `elapsed_ms` on every entry is measured from the start of the batch, not from the start of that action: subtract the previous entry's `elapsed_ms` to get one action's own cost. Real time here means wall clock, not scaled engine time: a game that pauses the tree or drops `Engine.time_scale` to zero still sees the wait resolve.

Neither wait is capped by a client-timeout budget. `ms` is uncapped outright, and `frames` is capped at 600 but charged at a 10 fps floor (100 ms per frame) so a slow or minimized game is never timed out mid-batch. Either can therefore describe a call longer than the 60 s default per-request timeout most MCP clients use, and a client that registered no progress handler will abort it before the server answers. Split a long wait across calls rather than relying on one.

**`text`** types a string into whatever Control currently holds focus, expanded to one key press and release per character with the unicode codepoint set. It does not focus anything itself: click or focus the `LineEdit` first, or the action fails.

**`watch`** is a top-level array, not a per-action field, and is sampled after every action in the batch. Each entry is a `NodePath:property` string, for example `"/root/Main/Player:position"`. Property subnames are allowed, so `"/root/Main/Player:position:x"` samples the scalar. Sampling is read-only and never fails a batch: an unresolvable node or property reports `null` for that key while the rest of the batch continues.

**`results[]`.** Every entry carries `index`, `type`, `ok`, `frame` (process frames since the batch started) and `elapsed_ms`. A failing entry carries `error`. The rest are present only where they mean something:

| Field      | On which types                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `hit`      | `click_element`, `mouse_button` - path of the Control under the pointer after the settle frame                                |
| `signals`  | `click_element` - which of `pressed`, `toggled`, `item_selected`, `text_submitted` the target emitted within the settle frame |
| `focus`    | `key`, `text` - path of the focus owner after the action                                                                      |
| `value`    | `text` - resulting text of the focused `LineEdit` or `TextEdit`                                                               |
| `pressed`  | `action` - whether the input action is still held after this entry                                                            |
| `position` | `mouse_motion` - the resulting mouse position                                                                                 |
| `errors`   | any action whose handlers raised a GDScript runtime error                                                                     |

**`changes`** is the delta in visible Control nodes across the action, over the same walk `get_ui_elements` uses, with `appeared`, `disappeared`, `changed` (text and disabled state), plus `scene` and `focus` when those moved. `appeared` and `disappeared` collapse subtrees: an overlay opening reports the overlay's path once, not every Control beneath it. Each list is capped, and `truncated` counts how many entries were dropped when it was.

**`still_held`** lists what this batch pressed and did not release, as `"key:W"`, `"action:jump"` or `"mouse_button:left"`. It is absent when the batch holds nothing. Nothing is auto-released at the end of a batch, so a held input stays held until a later action or call releases it.

**Failure handling.** An invalid batch is rejected whole, before anything is injected, with an error response naming the offending action index. A runtime failure part-way through is different: the batch stops there, the remaining entries come back as `{index, type, skipped: true}`, `success` is `false`, and the response is still a normal success-shaped response carrying the partial timeline. Read `results[]` to see how far it got.

`errors` is only available for sessions this server spawned with `run_project`. An `attach_project` session has no captured stderr, so handler errors cannot be attributed and the field is simply omitted.

`hit` and the occlusion check behind it both read the viewport's hovered control, which older Godot 4.x builds do not expose. On those builds `hit` is omitted and an occluded click reports plain success, so treat `hit` as a bonus rather than a guarantee.

Signal observers are connected before injection and disconnected after the one settle frame, so `signals` reports what the target emitted inside that frame. A handler that emits later (via `call_deferred`, a tween, an animation callback or a timer) is not observed: an absent entry means "not within one frame", not "never".

## Profiling (requires `run_project` with `profiling: true`)

`profiling: true` adds `--remote-debug` to the launch, so the numbers are Godot's own editor profiler measurements. The channel is set at launch: an already-running session, and every `attach_project` session, returns "Profiling is not enabled for this session."

| Tool              | Description                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `profile_project` | Capture a window (default 5 s, max 60): the most expensive GDScript functions, FPS, engine monitors, and optional render stages |
| `start_profiler`  | Start a capture and return immediately, so runtime tools can drive the game while it runs                                       |
| `stop_profiler`   | Stop (or re-read) that capture and rank its functions and render stages                                                         |

`profile_project` and `start_profiler` take `visual: true` to also record the editor's **Visual Profiler** (render-stage CPU and GPU time) for the same window. It is off by default: the capture then leaves the renderer's timestamps alone. They take `timeline: true` to record the capture over time as well (see [Timeline](#timeline)), `track` to sample node properties such as the player position onto that timeline, and `targetFps` (default 60) for the frame budget `slowFrames` counts against.

A capture returns what the editor's Profiler tab shows, plus the Monitors and Visual Profiler tabs:

| Field        | Editor equivalent                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rows[]`     | The **Script Functions** list. `function`, `file`, `line` (the tooltip's `res://…gd:371`), summed `calls`, own `selfMs` and inclusive `totalMs`, per-frame averages, `msPerCall` (the editor's "Average Time"), `percentOfFrame` ("Frame %", a share of the capture's own average frame, not of a 16.67 ms target), and `peak` frame |
| `frame`      | The **Frame Time** category: `frameMs`, `processMs`, `physicsMs`, `physicsFrameMs`, `scriptMs`, each as `{ avg, max }` over the capture                                                                                                                                                                                              |
| `servers[]`  | One entry per server category (`audio_thread`, `physics_2d`, …) with its functions, in milliseconds per frame                                                                                                                                                                                                                        |
| `worstFrame` | The slowest single frame: its timings plus its top 30 functions by inclusive time - the spike you would click in the editor's graph                                                                                                                                                                                                  |
| `fps`        | Frames per second across the capture, measured from the capture's own frames (see below). `null` when fewer than two frames were folded                                                                                                                                                                                              |
| `slowFrames` | Frames whose `frameMs` exceeded `1000 / targetFps`, with `targetFps` echoed back. Under vsync every frame runs to the refresh interval, and frames land a little either side of it: turn vsync off, or set `targetFps` a few percent below the refresh rate so on-time frames do not count                                           |
| `monitors`   | The **Monitors** tab: draw calls, primitives, objects in frame, video/texture/buffer memory, object and node counts, physics counts, pipeline compilations and custom monitors. `null` when no sample arrived                                                                                                                        |
| `visual`     | The **Visual Profiler** tab: CPU and GPU milliseconds per render stage. `null` unless the capture was started with `visual: true`                                                                                                                                                                                                    |
| `timeline`   | The graphs under the editor's Profiler and Visual Profiler tabs: the same numbers per interval, so a drop can be found in time. `null` unless the capture was started with `timeline`, `timelineMs` or `track`                                                                                                                       |

`sort` ranks rows by `selfMs` (default), `totalMs`, or `calls`. Milliseconds are rounded to four decimals. When something compromised a capture's numbers or changed what it recorded, the result opens with `warnings`, each saying what happened and what to do; they come first so that a client that cuts a long result short still shows them.

Reading the numbers:

- Times are elapsed wall clock, including waits, not CPU utilization. Inclusive rows overlap, so summing `totalMs` is meaningless.
- Totals sum the received frames after the first, which is discarded: enabling the profiler inside a running VM call gives that sample a zero start timestamp.
- Godot picks the rows it sends by inclusive time and caps them at `captureLimit`. `limitReached`, `frameGaps` and `undecodablePackets` say when rows, whole frames, or packets are missing; a function that is absent is not a function that is free.
- Totals are summed from the frame packets. The engine's own `servers:profile_total` is capped by the same `captureLimit` and carries nothing the frames did not, while top-N membership rotates between frames, so summing them covers strictly more functions than that packet does.
- The injected `mcp_bridge.gd` polls its socket every frame, so it shows up in the rows like any other script. That is real observer overhead (well under 0.05 ms/frame in practice), not a measurement artifact; a `track` adds a property read every 250 ms on top. A `run_script` you execute during a capture is profiled the same way and appears under its own generated script name; discount it when reading a capture you drove yourself.
- Native engine calls are not profiled as separate rows (the editor's "Display internal functions" toggle), so `selfMs` matches the editor's Self column in its default configuration.
- A capture stops itself at its time limit, measured from the first frame folded rather than from the enable round trip. `stop_project` ends it along with the session.
- A capture that folded no usable frames errors rather than returning zeroes: the first frame received is always discarded, so a window shorter than two rendered frames has nothing to average.
- A finished capture stays readable after the game exits, so the capture taken just before a crash can still be ranked.

### FPS and monitors

`fps` is the span of engine frame numbers over the wall time between the first and the last folded frame. It therefore counts everything between two frames, while `frame.frameMs` stops short: `frameMs` is one main-loop iteration up to and including the render and buffer swap (vsync waits land there), and the `Engine.max_fps` limiter and low-processor-mode sleep run after it. With either of those on, `1000 / frameMs.avg` overstates the frame rate and `fps` does not. The engine's own FPS monitor is not used, because it reports the previous whole second, and that second can end up to two seconds before the sample.

`monitors` holds the Monitors tab values that the frame budget does not already cover. The engine samples them once a second whenever a debugger is attached, and a capture keeps the samples that arrive while it is open. `samples` says how many that was; a window shorter than about a second can miss them all, and `monitors` is then `null`. Each value is `{ avg, min, max }` over the samples:

- `drawCallsInFrame`, `primitivesInFrame`, `objectsInFrame` - the last rendered frame at the moment of each sample, not every frame. A single-frame spike between samples is not seen. 2D canvas draw calls are counted from Godot 4.3; 4.0-4.2 count 3D only.
- `videoMemMiB`, `textureMemMiB`, `bufferMemMiB`, `staticMemMiB` - in MiB (2^20 bytes).
- `objects`, `resources`, `nodes`, `orphanNodes` - a growing `orphanNodes` is the classic leak of nodes removed from the tree but never freed.
- `physics2dActiveObjects`, `physics2dCollisionPairs`, `physics3dActiveObjects`, `physics3dCollisionPairs`.
- `pipelineCompilations` is `{ duringCapture, total }`: render pipelines compiled over the capture (the source of shader-compilation stutter) and since launch. The engine only reports running totals once a second, so `duringCapture` counts from the last sample before the capture opened to the last one inside it, each up to a second off the window's edges. It is `null` when a lone sample had nothing to count from, rather than a 0 that would read as "nothing compiled". The whole field is `null` before Godot 4.4, which did not report it.
- `custom` lists the monitors the game registered with `Performance.add_custom_monitor`, by name, up to 64 of them. A value that is not a finite number (a custom monitor dividing by zero reports infinity) is left out of its stats.

The TIME\_\* monitors are left out on purpose: the capture's own `frame` breakdown measures process and physics time per frame, where the monitors only report each second's maximum.

### Render stages (`visual: true`)

`visual` is the Visual Profiler tab. `cpuMs` and `gpuMs` are the whole render timeline of a frame, first marker to last, as `{ avg, max }`. `hardware` names the CPU and GPU the engine reports (Godot 4.4+; `null` before). `areas[]` ranks the stages by the larger of their CPU and GPU averages and is capped by `top`; `areasReceived` says how many stages had any measured time. `worstFrame` is the frame with the heaviest render timeline and its 15 most expensive stages.

Each area has a `path` that follows the engine's group nesting, joined with `" > "` because engine stage names contain slashes (`Render Viewports > Render Viewport 0 > Render 3D Scene > Render Directional/SpotLight Shadows`), plus `group`, `frames` (how many frames it appeared in), and `cpuMs` / `gpuMs` as `{ avg, max }`. The averages divide by every profiled frame, so a stage that only runs in some frames averages its cost over the whole capture.

Reading the stages:

- A stage lasts from its marker to the next marker, the same as in the editor. A group spans its own opening and closing markers, so a group row includes its children. Never add a group to its children.
- A group opened again while it is still open is its next pass, not a child of the first: the engine opens `Render DirectionalLight2D Shadows` once per shadowed 2D directional light but closes it once, after the last. The passes add up in one row beside the viewport's other stages. (The editor's tree nests them.)
- `(other)` is time inside a group that none of its markers cover. The editor's tree drops that time; here it is a row. In the Compatibility renderer, `Render Viewport N > (other)` is mostly the blit to the screen and the buffer swap, vsync wait included, so a large value there is usually not rendering work.
- GPU times come from GPU timestamp queries. They are 0 wherever the renderer cannot time the GPU (the Compatibility renderer on GLES and the web), and `gpuTimed: false` then says so, so zeros do not read as free.
- The first five frames after enabling are skipped. Both renderers read timestamps back through a ring of two or three frames and give each readback a fresh frame number, so those frames can hold timing from before the capture: the Compatibility renderer's internal markers, or, when a capture starts right after another, frames the previous one recorded. Any later frame the renderer timed with profiling off is skipped too. `framesReceived` counts every frame that arrived while visual profiling was on, `frames` only the ones folded.
- While nothing is drawn (a minimized window, or low-processor mode with nothing changing), the engine re-sends the last drawn frame under the same number on every iteration. Repeats are skipped, so `frames` counts draws. Under `--headless` nothing is timed at all and `visual.frames` stays 0.
- The renderer numbers frames with its own counter, which is not the engine frame number. `visual.worstFrame.frame` does not line up with `worstFrame.frame`.
- A frame can hold at most `debug/settings/profiler/max_timestamp_query_elements` markers (default 256, read once at startup). A heavy scene - reflection probes, many shadowed lights, several viewports or canvas layers - can need more. The renderer then drops the rest of the frame's markers and logs an error for every one it drops: `Tried capturing more timestamps than the configured maximum` on Forward+ and Mobile, `Condition "frames[frame].timestamp_count >= max_timestamp_query_elements" is true.` on Compatibility. The stages after the cut are missing, and `truncatedFrames` counts those frames.
- The errors are not free. A scene hundreds of markers over the limit logs hundreds of errors per frame, which makes the game several times slower, so every timing in the capture would describe the logging rather than the game. After three cut frames in a row the capture therefore switches the visual profiler off, and `stoppedAt` says how many seconds in; the rest of the capture measures the game as it runs, without render stages. The slowed frames before that point still count in `frameMs.max`, `worstFrame` and `slowFrames`, lower `fps` a little, and show in the timeline interval they fall in. The result carries a `warnings` entry with the fix below, and `get_debug_output` adds the same explanation to its `tip` whenever these errors are in the log, so they are not mistaken for a game bug. The flood can also push earlier lines out of that log, which keeps only the most recent ones.
- On Forward+ and Mobile, raise the setting in `project.godot` (for example `settings/profiler/max_timestamp_query_elements=4096` under `[debug]`, or Project Settings > Advanced Settings > Debug > Settings > Profiler) and relaunch; it only matters while profiling, so it can stay. The Compatibility renderer ignores the setting and always stops at 256 (`MAX_QUERIES` in the engine), so there the only fix is to profile that scene without `visual`.

### Timeline

`timeline: true` records the capture over time: `timeline.buckets[]` has one entry per `timelineMs` interval (default 500 ms, 250-5000), counted from the capture's first frame. A timeline splits its window into about 60 intervals at most (frames that arrive just after the window closes can add one or two), so a longer window uses wider ones, rounded up to 50 ms: 60 s gets 1000 ms intervals whatever `timelineMs` asked for. `timeline.bucketMs` (and `timelineMs` in `start_profiler`'s reply) is the interval actually used; when it widens a `timelineMs` you passed, `profile_project`'s result or `start_profiler`'s reply says so in `warnings`. It is the graph under the editor's Profiler and Visual Profiler tabs, read as numbers. Use it where one average cannot say when things went wrong: walking a level with `start_profiler`, `simulate_input` and `stop_profiler`, a hitch that comes and goes, a scene that slows over time.

Each bucket holds:

| Field                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t`                                  | Seconds from the capture's first frame to the start of the interval                                                                                                                                                                                                                                                                                                                                                                      |
| `frames`, `fps`                      | Frames that arrived in the interval and their rate. An interval with no frames at all is a freeze: `frames: 0`, `fps: 0`, and the long frame that ends it lands in a later interval with a large `frameMs.max`. `fps` is `null` for a trailing interval shorter than a quarter of `timelineMs`                                                                                                                                           |
| `frameMs`                            | `{ avg, max }` over the interval's frames                                                                                                                                                                                                                                                                                                                                                                                                |
| `processMs`, `physicsMs`, `scriptMs` | Per-frame averages of the editor's Frame Time categories                                                                                                                                                                                                                                                                                                                                                                                 |
| `slowFrames`                         | Frames over the `targetFps` budget                                                                                                                                                                                                                                                                                                                                                                                                       |
| `render`                             | `{ cpuMs, gpuMs }` of the render timeline per profiled frame. `null` without `visual`                                                                                                                                                                                                                                                                                                                                                    |
| `drawCalls`                          | The draw-call monitor, when a once-a-second sample arrived in the interval; `null` otherwise                                                                                                                                                                                                                                                                                                                                             |
| `top`                                | The three heaviest things of the interval: `{ kind, name, ms, maxMs }`, where `kind` is `script` (a GDScript function with its file and line), `server` (an engine server function, e.g. `physics_3d/Finalize Islands`) or `render` (a stage, with `visual`). `ms` is per frame, `maxMs` the most it took in one frame, so a spike shows as a large `maxMs` over a small `ms`. Render stages count the heavier of their CPU and GPU time |
| `track`                              | The tracked values, see below; `null` without `track` or when no sample fell inside the interval                                                                                                                                                                                                                                                                                                                                         |

`track` takes up to four `NodePath:property` strings, in the same form as `simulate_input`'s `watch` (`"/root/Main/Player:global_position"`), and implies a timeline. The game samples them itself, every 250 ms (or half of the interval when that is shorter), stamped with the engine frame number, and the server places each sample on the interval that holds that frame. Sampling runs from the bridge's `_process`, so it carries on while `simulate_input` or any other command occupies the bridge. The samples are collected once the capture has closed, so the bridge's work handing them over is not measured. `timeline.track` echoes the specs; `timeline.trackError` says why values are missing when the samples could not be collected: the game exited first, another profiler call replaced the track, or another bridge command was still running when the capture ended. An unresolvable path samples as `null`, as `watch` does.

Starting and collecting a track are bridge commands, and the bridge takes one command at a time. Drive the game between `start_profiler` and `stop_profiler` rather than alongside a `profile_project` with `track`: a `simulate_input` sent in parallel with it is refused, or makes the capture lose its track.

Every interval costs a few hundred bytes of the agent's context, which is why a timeline stops at about 60 of them.

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
| `attach_script`       | Attach a GDScript or C# script to a node                                  |
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
| `{x, y, z, w}`               | `Vector4`                   |
| `{r, g, b}` / `{r, g, b, a}` | `Color` (`a` defaults to 1) |

A property whose declared type is `Dictionary` skips this coercion, so a dict with `x`/`y` or `r`/`g`/`b` keys is stored as a plain `Dictionary`.

### Accepted widening conversions

Godot performs these on store, so they are allowed: float to int, string to `NodePath` or `StringName`, bool to int or float, `Vector2` to `Vector2i` (and back), `Vector3` to `Vector3i` (and back), `Vector4` to `Vector4i` (and back), and `Array` to any `Packed*Array`. Everything else errors.

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

A script-declared `Array[T]` (for example `@export var points: Array[Vector2]`) takes a plain JSON array too, and the same element conversions apply when `T` is `bool`, `int`, `float`, `String`, `StringName`, `NodePath`, `Vector2`, `Vector2i`, `Vector3`, `Vector3i`, `Vector4`, `Vector4i` or `Color`. Widening applies within that set the way it does for scalars, so JSON ints land in an `Array[float]` and `{ "x": 1, "y": 2 }` lands in an `Array[Vector2i]`. An element that cannot represent `T` errors and the error names its index. An untyped `Array` accepts anything, unchanged.

Any other `T` (a class, a Resource, an enum, `Dictionary`, a nested `Array`) is rejected with an explicit error naming the element type. That is deliberate: `set()` does not convert an untyped array element by element for a typed property, it refuses the assignment and leaves an empty array behind while reporting nothing, so passing one through would be a silent drop reported as success. Use `run_script` for those.

### Object-typed properties

Properties declared as a `Resource` or `Node` (for example `CollisionShape2D.shape`, `Sprite2D.texture`) reject plain values. They accept one of three forms:

| Form                                | Behavior                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"res://path/to/file.tres"`         | Loads the saved resource. An asset that exists on disk but has never been imported triggers an automatic headless import and one retry, transparent to the caller. A path that does not exist on disk is an error, and a mutation on a scene that references a missing file is refused outright so the reference is not stripped on save. |
| `{ "type": "ClassName", ...props }` | Constructs the Resource inline via `ClassDB.instantiate`, then assigns each inner property.                                                                                                                                                                                                                                               |
| `null`                              | Clears the property.                                                                                                                                                                                                                                                                                                                      |

The `script` property gets one more check beyond the table above: a loaded Script is rejected when it cannot be instantiated (a GDScript with parse errors or declared `@abstract`, or a C# class not yet compiled into the project assembly), since `set_script()` on one fails silently and would otherwise leave the node without a script while reporting success. `attach_script` runs the same check.

Inline construction example:

```json
{ "shape": { "type": "RectangleShape2D", "size": { "x": 80, "y": 16 } } }
```

Inner properties are assigned through the same validation described above, so nested typed dicts and nested `res://` paths both work at any depth. The scene is persisted with `PackedScene.pack()`, so a constructed Resource is written out as a normal `[sub_resource]` block.

#### Virtual properties (slash-suffixed keys, e.g. `shader_parameter/*`)

Keys containing `/` (most importantly `ShaderMaterial`'s `shader_parameter/<uniform>` entries) name _virtual_ properties that only exist on an instance after the property they depend on is assigned.

**They are supported inside an inline resource dict only** - the `{ "type": "ClassName", ... }` form above. A slash-suffixed key addressed straight at a node (`set_node_properties` with `property: "metadata/mine"`, or a top-level `properties` entry on `add_node`) still goes through the node's plain property lookup and is rejected as a property the node does not have. Inside an inline resource dict they are handled specially:

- Dependency-first ordering: plain keys are assigned before slash-suffixed keys, so `"shader": "res://neon.gdshader"` lands before `"shader_parameter/glow"`.
- Validation is against the instance's live property list (`set()` alone accepts unknown names silently), so a `shader_parameter/<name>` that the assigned shader does not declare as a uniform is an explicit error, as is any slash-suffixed key when no shader is assigned. A group/subgroup/category label that happens to contain `/` is rejected too, even when it is otherwise listed.
- Settable from JSON: `float`, `int`, and `bool` uniforms; plain `vec2`, `vec3` and `vec4` uniforms (via `{x,y}` / `{x,y,z}` / `{x,y,z,w}` dicts); `source_color` uniforms declared `vec3` or `vec4` (via `{r,g,b,a}` dicts, coerced to `Color`); and `sampler2D`/`sampler3D` uniforms (via a `res://` path, like any Object-typed property). Not yet settable from JSON: `mat2`/`mat3`/`mat4` uniforms - these error explicitly rather than dropping silently.

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

**Process cost.** Checks never cost an extra process launch, in either spelling. A single `scenePath` plus `checks` does the parse validation and the checks against one instantiated scene in one process, and `targets[].checks` run inside the same single process as the rest of the batch. One target's failure (a bad schema, a missing scene, an unimported dependency) is reported on that target and the other targets still report, in input order.

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
