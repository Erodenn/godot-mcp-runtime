# Security Model: `run_script` and `run_project`

GDScript executed via `run_script` runs inside the live Godot process with full user privileges. `run_project` launches the configured main scene and all `[autoload]` scripts, which is equally arbitrary code. Treat both as user-level RCE primitives.

**This is a best-effort accident guard, not a sandbox and not a security boundary.** It exists to catch the _obvious, unobfuscated_ dangerous primitive when it appears verbatim in a `run_script` payload, or in an autoload/scene script that `run_project` is about to launch - the "a non-programmer downloaded a malicious Godot project and ran it through the server" case. It does **not** defend against an adversary who knows the ruleset (the tool is open source), and it _cannot_ - GDScript is Turing-complete and reflective, and tokenizer-level static analysis of it is unsound by construction.

The defense has two parts: a **three-tier static-analysis gate** that inspects GDScript before it reaches the bridge, and a **per-session bridge auth token** on every bridge frame (see "Bridge authentication" below). Together: every bridge frame is authenticated with a per-session token and every `run_script` payload is scanned, but the scan is a best-effort filter with known holes, and neither the token nor the scan is a hard sandbox. MCP client bypass-permissions modes (Claude Code `--dangerously-skip-permissions`, Cursor YOLO, etc.) auto-answer elicitation requests, so elicitation alone is a UX speed bump, not a hard boundary. Strict mode (`GODOT_MCP_STRICT=true`) lets operators running unattended opt into hard-rejecting everything the filter would otherwise elicit - it raises the floor, it does not close the structural gaps listed under "What this does NOT do."

The rule catalogue below is the auditable surface, and because it's auditable, anyone can read it and construct a bypass - that's accepted as inherent to a best-effort filter, not a bug we're hiding. Tier assignments were calibrated against nine real Godot projects under `D:/Godot/Projects` - `OS.execute` and family have zero hits in real game code; literal `load()` / `preload()` / `call()` appear in nearly every game script and were demoted to Tier 3 to avoid conditioning users to click "yes" reflexively.

---

## Tier 1 - Hard block

The server rejects the call. The bridge never sees the script (or the project never launches, for strict-mode `run_project` with Tier 1 autoload findings). No client cooperation required.

### Direct exec

| Primitive                | Rule ID                                    |
| ------------------------ | ------------------------------------------ |
| `OS.execute`             | `tier1.direct_exec.OS.execute`             |
| `OS.create_process`      | `tier1.direct_exec.OS.create_process`      |
| `OS.execute_with_pipe`   | `tier1.direct_exec.OS.execute_with_pipe`   |
| `OS.shell_open`          | `tier1.direct_exec.OS.shell_open`          |
| `OS.kill`                | `tier1.direct_exec.OS.kill`                |
| `OS.set_environment`     | `tier1.direct_exec.OS.set_environment`     |
| `OS.unset_environment`   | `tier1.direct_exec.OS.unset_environment`   |
| `OS.set_restart_on_exit` | `tier1.direct_exec.OS.set_restart_on_exit` |

### Resource-pack persistence

| Primitive                            | Rule ID                           |
| ------------------------------------ | --------------------------------- |
| `ProjectSettings.load_resource_pack` | `tier1.resource_pack.load`        |
| `ProjectSettings.save`               | `tier1.resource_pack.save`        |
| `ProjectSettings.save_custom`        | `tier1.resource_pack.save_custom` |

### Engine tampering

| Primitive                         | Rule ID                                 |
| --------------------------------- | --------------------------------------- |
| `Engine.get_singleton`            | `tier1.engine.get_singleton`            |
| `Engine.register_singleton`       | `tier1.engine.register_singleton`       |
| `Engine.register_script_language` | `tier1.engine.register_script_language` |

### Reflection bypasses

| Primitive                   | Rule ID                                      |
| --------------------------- | -------------------------------------------- |
| `ClassDB.instantiate`       | `tier1.reflection.ClassDB.instantiate`       |
| `ClassDB.class_call_static` | `tier1.reflection.ClassDB.class_call_static` |
| `Object.set_script`         | `tier1.reflection.Object.set_script`         |
| `Node.set_script`           | `tier1.reflection.Node.set_script`           |
| `Callable(...)` constructor | `tier1.reflection.Callable`                  |

`tier1.reflection.Callable` fires only when `Callable` is used as a call (`Callable(self, "run")`, `Callable.create(...)`). A type annotation such as `cb: Callable`, `-> Callable`, `Array[Callable]`, `is Callable` or `as Callable` is not a construction and does not match.

### Dynamic code & deserialization

| Primitive                          | Rule ID                                   |
| ---------------------------------- | ----------------------------------------- |
| `Expression` type reference        | `tier1.dynamic.Expression`                |
| `str_to_var` (bare)                | `tier1.dynamic.str_to_var`                |
| `bytes_to_var_with_objects` (bare) | `tier1.dynamic.bytes_to_var_with_objects` |
| `ConfigFile.load`                  | `tier1.config.ConfigFile.load`            |
| `ConfigFile.load_encrypted`        | `tier1.config.ConfigFile.load_encrypted`  |
| `ConfigFile.parse`                 | `tier1.config.ConfigFile.parse`           |

### Non-literal indirection

These primitives fire when the call's **whole first argument** does not classify as a lone string literal - not just its first token. `load("res://" + evil_var)` is non-literal (the argument is a string concatenated with a variable) even though a string literal appears first; only a call whose first argument is a single bare string token, like `load("res://main.tscn")`, classifies as literal and drops to Tier 3 (warn).

| Primitive                              | Rule ID                                          |
| -------------------------------------- | ------------------------------------------------ |
| `load(non_literal)`                    | `tier1.indirect.load.nonliteral`                 |
| `preload(non_literal)`                 | `tier1.indirect.preload.nonliteral`              |
| `ResourceLoader.load(non_literal)`     | `tier1.indirect.ResourceLoader.load.nonliteral`  |
| `Object.call(non_literal, …)`          | `tier1.indirect.Object.call.nonliteral`          |
| `Object.callv(non_literal, …)`         | `tier1.indirect.Object.callv.nonliteral`         |
| `OS.call(non_literal, …)`              | `tier1.indirect.OS.call.nonliteral`              |
| `Engine.call(non_literal, …)`          | `tier1.indirect.Engine.call.nonliteral`          |
| `ClassDB.call(non_literal, …)`         | `tier1.indirect.ClassDB.call.nonliteral`         |
| `ProjectSettings.call(non_literal, …)` | `tier1.indirect.ProjectSettings.call.nonliteral` |

The `load`, `preload`, `str_to_var` and `bytes_to_var_with_objects` rules target GDScript global functions. They match only when the name is not preceded by a `.`: `save_manager.load(slot)`, `$SaveManager.load(slot)`, `get_node("Save").load(slot)` and `slots[i].load(d)` call a method of some other object and are not governed by them. The bare form `load(path_var)` is unchanged.

---

## Tier 2 - Elicit

The server pauses and sends an `elicitation/create` request to the client. User accept proceeds; decline returns an error naming the primitive. Elicitation failure (older SDK or unsupported client) falls back to a hard denial with a clear error.

**In strict mode (`GODOT_MCP_STRICT=true`), every Tier 2 finding is promoted to Tier 1.**

### Filesystem writes

| Primitive                                                | Rule ID                                          |
| -------------------------------------------------------- | ------------------------------------------------ |
| `FileAccess.open` (any mode)                             | `tier2.fs.FileAccess.open`                       |
| `FileAccess.open_encrypted`                              | `tier2.fs.FileAccess.open_encrypted`             |
| `FileAccess.open_encrypted_with_pass`                    | `tier2.fs.FileAccess.open_encrypted_with_pass`   |
| `FileAccess.open_compressed`                             | `tier2.fs.FileAccess.open_compressed`            |
| `FileAccess.create_temp`                                 | `tier2.fs.FileAccess.create_temp`                |
| `FileAccess.set_read_only_attribute`                     | `tier2.fs.FileAccess.set_read_only_attribute`    |
| `FileAccess.set_hidden_attribute`                        | `tier2.fs.FileAccess.set_hidden_attribute`       |
| `DirAccess.remove`                                       | `tier2.fs.DirAccess.remove`                      |
| `DirAccess.remove_absolute`                              | `tier2.fs.DirAccess.remove_absolute`             |
| `DirAccess.copy`                                         | `tier2.fs.DirAccess.copy`                        |
| `DirAccess.rename`                                       | `tier2.fs.DirAccess.rename`                      |
| `DirAccess.create_link`                                  | `tier2.fs.DirAccess.create_link`                 |
| `DirAccess.make_dir` (instance)                          | `tier2.fs.DirAccess.make_dir`                    |
| `DirAccess.make_dir_absolute` (static)                   | `tier2.fs.DirAccess.make_dir_absolute`           |
| `DirAccess.make_dir_recursive` (instance)                | `tier2.fs.DirAccess.make_dir_recursive`          |
| `DirAccess.make_dir_recursive_absolute` (static)         | `tier2.fs.DirAccess.make_dir_recursive_absolute` |
| `OS.move_to_trash`                                       | `tier2.fs.OS.move_to_trash`                      |
| `ResourceSaver.save` (either arity)                      | `tier2.resource_saver.save`                      |
| `ConfigFile` (any usage - see note below)                | `tier2.config.ConfigFile`                        |
| `ConfigFile.save_encrypted`                              | `tier2.config.ConfigFile.save_encrypted`         |
| `ConfigFile.save_encrypted_pass`                         | `tier2.config.ConfigFile.save_encrypted_pass`    |
| `Image.save_png` / `save_jpg` / `save_webp` / `save_exr` | `tier2.image.save_png` etc.                      |
| `Resource.take_over_path`                                | `tier2.resource.take_over_path`                  |
| `ZIPPacker` (any usage)                                  | `tier2.archive.ZIPPacker`                        |
| `PCKPacker` (any usage)                                  | `tier2.archive.PCKPacker`                        |
| `ResourceUID.add_id` / `set_id` / `remove_id`            | `tier2.uid.ResourceUID.add_id` etc.              |

`FileAccess.open` is conservatively flagged uniformly. The READ vs WRITE distinction lives in the second argument; we accept the false-positive cost on read-only opens to keep the rule simple. Confirm "READ mode" and accept the elicitation if your script is reading.

`DirAccess.make_dir` and `make_dir_recursive` are instance methods (`dir.make_dir(path)`), so a `DirAccess.make_dir` chain-prefix rule would never fire on that call form. These two match on their last segment instead, on any receiver - both names are distinctive enough to be safe with no receiver information. Their `_absolute` siblings are static (`DirAccess.make_dir_absolute(path)`) and keep the ordinary two-segment prefix shape.

`ConfigFile`'s own instance methods (`save`, `save_encrypted`, `save_encrypted_pass`) are called the same way - `cf.save(p)`, never `ConfigFile.save(p)`. `save_encrypted` and `save_encrypted_pass` are distinctive enough names to match on their last segment directly. Plain `save` is not - `some_manager.save()` is common, ordinary game code, and a last-segment rule on bare `save` would hard-block it under strict mode. Instead, the rule anchors on the `ConfigFile` class reference itself (typically `ConfigFile.new()`) - the same shape `ZIPPacker` and `PCKPacker` use below - since reaching that class at all is the signal, when none of its generic method names can be matched safely on their own.

That anchor is also the only rule that reaches `cf.load(p)`. The Tier 1 `ConfigFile.load` / `load_encrypted` / `parse` rules are chain-prefix rules and fire only on the static-looking `ConfigFile.load(p)` form; the idiomatic instance form is caught one tier lower, by the class anchor, at the point the script names `ConfigFile`. A last-segment rule on bare `load` would close that gap and is deliberately not used: `save_manager.load(slot)` and `img.load(path)` are ordinary code, and a Tier 1 rule keyed on `load` would hard-block them with no elicitation escape.

`Image.save_png` / `save_jpg` / `save_webp` / `save_exr` go one step further: their idiomatic call form is `tex.get_image().save_png(p)`, where `get_image()` is itself a call sitting between the receiver and the write method. The tokenizer never chains across a call (see `src/utils/gdscript-scanner.ts`), so `save_png` surfaces as a bare identifier with no receiver information at all, not as a two-segment chain - a last-segment rule alone would miss it. These four rules additionally set `matchAsBareIdentifier`, so they fire on the bare identifier form too (`save_png(p)` with no receiver whatsoever also elicits). This is safe specifically because the four names are distinctive image-write verbs; it is not applied to `take_over_path`, `save_encrypted`, or `save_encrypted_pass` above, whose idiomatic forms are plain `receiver.method(...)` with no intervening call, so the ordinary last-segment match already reaches them without widening to a receiver-less match.

### Reflection

| Primitive                            | Rule ID                                      |
| ------------------------------------ | -------------------------------------------- |
| `set_script` (bare, receiver unseen) | `tier2.reflection.set_script.bareIdentifier` |

`Object.set_script` and `Node.set_script` are Tier 1 only when the receiver is the literal class name. The common form is `node.set_script(s)` or `node.get_child(0).set_script(s)`, where a call or subscript sits in front of the method and the tokenizer sees a bare `set_script`; that form elicits at Tier 2 on any receiver.

### Network

| Primitive                       | Rule ID                                   |
| ------------------------------- | ----------------------------------------- |
| `HTTPRequest`                   | `tier2.net.HTTPRequest`                   |
| `HTTPClient`                    | `tier2.net.HTTPClient`                    |
| `TCPServer`                     | `tier2.net.TCPServer`                     |
| `StreamPeerTCP`                 | `tier2.net.StreamPeerTCP`                 |
| `WebSocketPeer`                 | `tier2.net.WebSocketPeer`                 |
| `PacketPeerUDP`                 | `tier2.net.PacketPeerUDP`                 |
| `UDPServer`                     | `tier2.net.UDPServer`                     |
| `StreamPeerTLS`                 | `tier2.net.StreamPeerTLS`                 |
| `IP.resolve_hostname`           | `tier2.net.IP.resolve_hostname`           |
| `IP.resolve_hostname_addresses` | `tier2.net.IP.resolve_hostname_addresses` |

### Generic non-literal dispatch (any receiver)

The named-receiver rules above (`Object.call`, `OS.call`, `Engine.call`, `ClassDB.call`, `ProjectSettings.call`) only fire on those five singletons. `.call`/`.callv` with a non-literal method name on _any other receiver_ - `some_node.call(method_var)` - is still dynamic dispatch that bypasses static analysis, so it's flagged too, matched on the last segment of the member chain rather than a fixed prefix.

| Primitive                           | Rule ID                          |
| ----------------------------------- | -------------------------------- |
| `<any receiver>.call(non_literal)`  | `tier2.generic.call.nonliteral`  |
| `<any receiver>.callv(non_literal)` | `tier2.generic.callv.nonliteral` |

This is Tier 2, not Tier 1: plenty of benign code calls `some_callable.call(...)`, and hard-blocking it would train reflexive elicitation approval. `Object.call(var)` (and the other four named receivers) still hard-blocks via the more specific Tier 1 rule - the generic rule only fires when none of the named rules already matched.

---

## Tier 3 - Warn

Executes. Matched rules attach to a `warnings: string[]` array on the success response.

| Primitive                                          | Rule ID                              |
| -------------------------------------------------- | ------------------------------------ |
| `load("res://…")` (literal)                        | `tier3.literal.load`                 |
| `preload("res://…")` (literal)                     | `tier3.literal.preload`              |
| `ResourceLoader.load("res://…")` (literal)         | `tier3.literal.ResourceLoader.load`  |
| `Object.call("method_name", …)` (literal)          | `tier3.literal.Object.call`          |
| `OS.call("method_name", …)` (literal)              | `tier3.literal.OS.call`              |
| `Engine.call("method_name", …)` (literal)          | `tier3.literal.Engine.call`          |
| `ClassDB.call("method_name", …)` (literal)         | `tier3.literal.ClassDB.call`         |
| `ProjectSettings.call("method_name", …)` (literal) | `tier3.literal.ProjectSettings.call` |
| `OS.alert`                                         | `tier3.os_alert`                     |

Literal `load`/`preload`/`call` are extremely common in real game scripts; gating them in Tier 2 would condition users to click "yes" reflexively. The warn surface keeps the audit trail without blocking the idiom.

---

## Bridge authentication

The McpBridge TCP listener (`127.0.0.1:<port>`) previously dispatched any well-formed frame from any local process that found the port - a `run_script` payload sent directly to the bridge would bypass the static-analysis gate entirely, since the gate runs on the Node side before a command is ever sent. Every request frame now carries a per-session token, and the bridge rejects any frame whose token doesn't match.

**What this buys, stated honestly:** the token stops the _unauthenticated drive-by_ - a process that finds the open port and blasts commands without knowing the secret. It does **not** stop a same-user process that reads the token from the environment (`/proc/<pid>/environ` on Linux, `OpenProcess` on Windows) or from the injected bridge script on disk. That's an accepted limitation of a same-machine, same-user token, not a gap we're hiding.

Token delivery differs by session mode, because the channel available differs:

- **Spawned (`run_project`)**: Node controls the process, so the token travels via the `MCP_SESSION_TOKEN` environment variable. It is never baked into the on-disk script for spawned mode: the env var keeps the secret off disk, the stronger position on Windows (reading another process's environment needs a process handle; reading a file in the project directory does not).
- **Attached (`run_project` with `attach: true`)**: Godot is launched by the user, so Node has no env-var channel into it. The token is baked into the injected `mcp_bridge.gd` copy at inject time instead, the same mechanism used to bake the listen port.

A frame with no token, or the wrong token, gets `{"error": "Unauthorized: invalid or missing session token"}` and is never dispatched to a command handler. The bridge fails open only when no token is configured at all - the standalone script run outside the MCP server (manual debugging, `validate`).

---

## The profiler debug channel

`run_project({ profiling: true })` opens a **second** local TCP channel, and it is not the bridge. Before spawning Godot the server binds a listener on `127.0.0.1:0` and passes `--remote-debug tcp://127.0.0.1:<port>` on the command line, so the engine dials back into it and speaks Godot's own remote-debugger protocol. The measurements are the stock editor ones - nothing is injected into the project - but the channel's properties differ from the bridge's in one way that matters.

**This channel has no token.** The bridge authenticates every frame because both ends are ours. Godot defines the debugger protocol, there is no field to carry a secret, and the engine would not check one. The listener therefore accepts the first connection that arrives and destroys every later one. That is the same trust assumption the bridge token already concedes it cannot exceed: a process able to scan the local TCP table and win the race between bind and the engine's dial-back can equally read `MCP_SESSION_TOKEN` out of the spawned engine's environment and drive the _authenticated_ bridge, which is strictly more powerful. The missing token here does not open a door that a same-user process did not already have.

**What a hostile peer could do, and where it stops.** It is confined to the profiler. The receiver acts on nine message names - `set_pid`, `debug_enter`, `servers:function_signature`, `servers:profile_frame`, `servers:profile_total`, `visual:hardware_info`, `visual:profile_frame`, `performance:profile_names` and `performance:profile_frame` - and drops everything else. It sends only `profiler:servers`, `profiler:visual` and `continue`. None of them reaches script execution, the filesystem, process control, or any other tool's behaviour; the profiler's state is read only by the three profiling tools. The names in a capture (functions, render stages, custom monitors, hardware) are strings the peer supplied. The realistic ceiling is fabricated profiling numbers and denial of profiling for the rest of the session. A peer that connects but never speaks the protocol surfaces as a `profile_timeout` within five seconds, and the engine's own "unable to connect" lands in `get_debug_output`. A peer that _does_ speak it can return plausible-looking measurements with no signal. Treat profiler output as measurement data, not as a trusted assertion about your project.

**Errors still do not pause the game.** A connected debugger normally halts the engine on a script error or `breakpoint`. Every `debug_enter` is answered immediately with `continue`, so profiling mode preserves the behaviour documented under "Runtime errors and `breakpoint`" - the engine runs past errors, `SCRIPT ERROR` output keeps reaching stderr, and `breakpoint` remains a no-op. Verified empirically against a project with a deliberate runtime error: stderr was byte-identical with and without `--remote-debug`, and the game ran on past the fault.

**Lifetime.** The listener is bound only for spawned sessions, and only when `profiling: true` was passed at launch - it cannot be added to a running session, and an attached session never has one. It is closed by `stop_project` (including when the spawn failed and no process exists), by a failed spawn, by the next `run_project` on the same project in either mode (a `run_project` on another project leaves it open), and by the server's own shutdown handlers. It never outlives the server process.

**Not covered by strict mode.** `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_ELICITATION`, and `GODOT_MCP_DISABLE_SECURITY` govern what GDScript may run; they say nothing about this channel. `profiling: true` is a parameter on `run_project` and inherits that tool's pre-flight scan and session-confirmation gate (both skipped when `GODOT_MCP_DISABLE_SECURITY` is set), but none of the three flags separately refuses to open the debugger port.

---

## Strict mode

`GODOT_MCP_STRICT=true` is read once at process start. Only the exact string `true` enables it. Any other value except `false` or an empty one (`1`, `TRUE`, `yes`) leaves it off and is reported on stderr at startup. When enabled:

- Every Tier 2 match becomes Tier 1 (hard reject). No elicitation prompt is sent.
- `run_project` becomes a hard reject if any autoload script or the launched scene's attached scripts contain a Tier 1 primitive.
- A launch this server performs (`run_project` in spawn mode, `render_movie`) is refused when the scene it would run cannot be found or resolved: no `run/main_scene`, a file that does not exist, or a `uid://` nothing carries. With `attach: true` the user starts Godot and may run a scene the server never sees, so a project with no `run/main_scene` only warns; a configured scene that cannot be found is still refused.

This promotion has a consequence worth naming explicitly: the `tier2.config.ConfigFile` class anchor (see "Tier 2 - Elicit" above) matches on `ConfigFile.new()` because none of `ConfigFile`'s own instance methods can be matched safely on their own, and that anchor fires whether the following code path reads or writes. Under strict mode, a pure config **read** - `var cf = ConfigFile.new(); cf.load(path)` and nothing else - hard-blocks exactly like a `save`, since the gate never distinguishes them. This is existing, intended behavior, not a bug to fix: narrowing the anchor to only writes would reopen the hole `cf.load(p)` already can't be matched any other way (see the class-anchor note above).

Default (`GODOT_MCP_STRICT` unset or `"false"`): existing behavior preserved on upgrade.

---

## Disabling elicitation

`GODOT_MCP_DISABLE_ELICITATION=true` is read once at process start, and only the exact string `true` enables it. Any other value except `false` or an empty one is reported on stderr at startup and leaves confirmation prompts on. It is the escape hatch for clients that cannot surface elicitation prompts. Some MCP clients - notably Claude Desktop / the Cowork surface ([anthropics/claude-code#56243](https://github.com/anthropics/claude-code/issues/56243)) - advertise the elicitation capability but auto-answer every `elicitation/create` with `{"action":"cancel"}` within milliseconds, never displaying the prompt. Because the client _responds_ (rather than erroring), the server cannot fall back the way it does for a client that lacks the capability outright: the auto-cancel is read as a user denial, and `run_project` becomes impossible to use.

When enabled, the interactive confirmation is skipped and treated as accepted (**fail-open**):

- The session-confirmation gate shared by `run_project` and `render_movie` is bypassed; the project launches with a `warnings` entry recording the bypass.
- Tier 2 `run_script` findings proceed without a prompt, with the finding surfaced in `warnings` and audited as `elicit_bypassed`.
- **Tier 1 hard-block primitives are unaffected**: they never elicit and always block. This flag only disables the "ask the user" prompts, not the static-analysis gate.

**Strict mode takes precedence.** `GODOT_MCP_STRICT` mandates explicit confirmation, so when both are set, `GODOT_MCP_DISABLE_ELICITATION` is ignored (a startup log records the override). The three states form one axis: default = ask, `DISABLE_ELICITATION` = proceed unprompted, `STRICT` = hard-reject anything that would ask.

Only enable this when you trust the project and the agent driving it - it removes the confirmation step, the same tradeoff as an MCP client's bypass-permissions mode.

---

## Disabling the entire gate

`GODOT_MCP_DISABLE_SECURITY=true` is read once at process start, and only the exact string `true` enables it. Any other value except `false` or an empty one is reported on stderr at startup and leaves the gate on. It is a complete no-op switch for the `run_script` / `run_project` security gate: with it set, there is no static-analysis scan, no Tier 1/2/3 decision, no elicitation, no `warnings`, and no `.policy.json` audit sidecar - for both handlers.

Specifically, this flag skips:

- `run_script`'s static-analysis gate entirely. **Tier 1 hard blocks are included**: unlike `GODOT_MCP_DISABLE_ELICITATION`, which leaves Tier 1 untouched, this flag removes it too. A sandboxed user who opted in explicitly still could not run `OS.execute`, which is precisely what they opted in for; leaving Tier 1 in place would make the flag dishonest about what it does.
- `run_project`'s pre-flight scan of `[autoload]` scripts and the launched scene's attached scripts.
- `run_project`'s session-confirmation elicitation (the "Launching a Godot project executes arbitrary code..." prompt).
- The `.policy.json` audit sidecar write for `run_script`: a record of a gate that isn't running is just a file write, so it is skipped along with everything else.

This exists for experienced users who do not need the gate: developers who accept the risk, sandboxed environments, CI.

**Resolution order (three flags on one axis).** `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_ELICITATION`, and `GODOT_MCP_DISABLE_SECURITY` all govern the same gate. Resolved once, in this order:

1. **`GODOT_MCP_DISABLE_SECURITY=true`**: wins outright. Security is off regardless of the other two flags. A startup log records that strict mode was ignored when both it and strict are set. This is the _opposite_ precedence from the strict/disable-elicitation pair below: disable-security has to be the weakest possible setting a human can opt into, so it wins when set, rather than deferring to strict.
2. **`GODOT_MCP_STRICT=true`** (when disable-security is not set): every Tier 2 match promotes to Tier 1, and `GODOT_MCP_DISABLE_ELICITATION` is ignored if also set.
3. **`GODOT_MCP_DISABLE_ELICITATION=true`** (when neither of the above overrides it): confirmation prompts are skipped fail-open; Tier 1 still blocks.
4. Default: ask, per the elicitation and scan behavior described above.

**Enabling this is a human decision.** An agent asked to set `GODOT_MCP_DISABLE_SECURITY` on a user's behalf should decline and explain that this is an operator-level trust decision, not something to be flipped to route around a gate that's in the way.

---

## `run_project` pre-flight

**Stated plainly: in default mode, `run_project` blocks nothing.** The project launches - autoloads run with full privileges immediately - and the scan below only _warns_. Only strict mode blocks.

`run_project` runs the same scanner over:

1. Every `[autoload]` entry in `project.godot` whose path ends in `.gd` or `.tscn` (case-insensitive). A scene autoload is scanned the way the launched scene is, as in item 2.
2. Every `.gd` file an `[ext_resource path="res://…"]` of the launched scene names, and the source of every inline `[sub_resource type="GDScript"]` it embeds, recursing transitively into every scene it references (cycle-safe). A reference is classified by its path as well as by its `type` attribute: the engine loads the file the path names, and `type` is a hint a hand-edited scene can set to anything, so a `.gd` path is scanned and a `.tscn` or `.scn` path is walked whatever `type` says. The launched scene is the explicit `scene` argument if provided, else `run/main_scene` from `[application]`, else null (no scene scan, autoload-only). A script an instanced node or an instance override attaches is always an ext_resource or an inline sub-resource of the same scene file, so it is covered by the same two forms. Inline findings are labelled `<scene>[GDScript <id>]:<line>`, with the line counted inside the inline source.

A `uid://` value is resolved by reading text, not `.godot/uid_cache.bin`: the walk reads the first line of every `.tscn` for the `uid` in its header and every `*.uid` sidecar for the uid it holds, skipping dot-directories and symbolic links. This is the form the editor writes into `run/main_scene` and into an autoload entry since Godot 4.4. Every file that carries the uid is scanned, and more than one adds a note, because the engine may load any of them. The search stops after a fixed number of files (`UID_SCAN_MAX_FILES`); a uid it does not find, or finds nothing for after being cut short, is reported as `Launch scene <value> could not be resolved to a file (<reason>); scene-script scan skipped.` (or an `Autoload ... was not scanned` entry).

The `scene` argument has to be a scene file, a path ending in `.tscn` or `.scn` in lower case, and the call is refused otherwise. Godot runs a command-line scene only when it carries such an extension and runs `run/main_scene` for anything else, so an argument like `icon.svg` or `scenes/level` would have had the scan read one file while the engine launched another.

Findings are aggregated and:

- **Default mode**: surfaced as `warnings: string[]` on the success response. The project still launches.
- **Strict mode**: any Tier 1 finding hard-rejects before launch. So does a scan that failed on a file it reads: a `.gd` script or a `.tscn` scene that exists and could not be read (a permission error, a directory in its place), or a scan step that threw.

With `attach: true` the same scan runs over the autoloads and `run/main_scene` before the bridge is injected, and findings are handled the same way: `warnings` in default mode, and in strict mode a Tier 1 finding refuses to inject. Attach mode has no confirmation prompt, because MCP launches nothing there.

What the scan cannot read is reported, not skipped. Still not scanned: scripts that are not GDScript (a C# script, an autoload that is neither `.gd` nor `.tscn`), binary `.scn` scenes, scripts carried by non-scene resources a scene references (`.tres` / `.res`), and references with no `res://` path, such as one by `uid://` alone. Each one the scan meets is listed in `warnings` as `Not scanned: <scene>: <reason>` (or an `Autoload ... was not scanned` entry), as is an `[autoload]` line the parser could not read. A resource file is listed once, however many scenes reference it. Findings and these notices are capped separately (10 each, with a `+N more` tail), so a long list of findings never pushes a not-scanned notice out of the answer.

Strict mode separates two kinds of incomplete scan, and refuses outright when it has no scene to scan:

| What was not scanned                                                                                                                                            | Default mode | Strict mode                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- |
| A `.gd` script or `.tscn` scene that exists and could not be read, or a scan step that threw                                                                    | Warned       | The launch is refused      |
| A file of a kind the scan never reads: a C# script, a binary `.scn` scene, a `.tres` / `.res` resource                                                          | Warned       | Warned, the launch goes on |
| The scene to launch: no `run/main_scene`, a file that is not on disk, or a `uid://` nothing carries (attach mode with no `run/main_scene` is the one exception) | Warned       | The launch is refused      |
| A script or scene a reference names that is not on disk, a reference with no `res://` path                                                                      | Warned       | Warned, the launch goes on |
| A malformed header or an unterminated string inside a scene that was read                                                                                       | Warned       | Warned, the launch goes on |

The first row is a scan that set out to read a file and failed, so what it would have found is unknown. The others are known limits of what the scan covers. Whether strict mode should refuse on those too is an open question: refusing on every one would block every C# project and every project with a binary scene or a resource file. See "What this does NOT do."

### Session-confirmation gate

The first `run_project` call against a given `projectPath` in a session prompts one elicitation: "Launching a Godot project executes arbitrary code in its autoloads and main scene. Proceed?" Subsequent calls in the same session against the same project skip. A `cancel` response (client dismissed the prompt without a choice, or auto-cancelled it) is reported distinctly from an explicit `decline` and points the user at `GODOT_MCP_DISABLE_ELICITATION`. When that flag is set, this gate is skipped entirely (see "Disabling elicitation").

`render_movie` launches the project too, so it runs this same pre-flight scan and shares the once-per-session launch confirmation with `run_project`: confirming either one covers both for that project. Strict mode and `GODOT_MCP_DISABLE_SECURITY` apply to it exactly as they do to `run_project`.

---

## Audit trail

Every `run_script` call writes two files to `.mcp/godot-runtime/scripts/`:

- `{timestamp}-{uuid}.gd`: the raw script source.
- `{timestamp}-{uuid}.policy.json`, the policy decision:

```json
{
  "decision": "hard_block" | "elicit_denied" | "elicit_cancelled" | "elicit_accepted" | "elicit_bypassed" | "warn" | "ok",
  "tier": 1,
  "strict_mode": false,
  "promoted_by_strict": false,
  "findings": [
    {
      "rule": "tier1.direct_exec.OS.execute",
      "line": 7,
      "column": 5,
      "matched_text": "OS.execute"
    }
  ],
  "timestamp": "2026-05-27T..."
}
```

`decision` values map to handler outcomes:

- `hard_block`: Tier 1 finding; script refused before reaching the bridge.
- `elicit_denied`: Tier 2 finding; user declined the elicitation OR the client does not support elicitation.
- `elicit_cancelled`: Tier 2 finding; the client dismissed the prompt without a choice (`cancel`). Script refused. Some clients do this without displaying the prompt, so it is recorded apart from a person declining, and the error names `GODOT_MCP_DISABLE_ELICITATION`.
- `elicit_accepted`: Tier 2 finding; user accepted the elicitation. Script executed.
- `elicit_bypassed`: Tier 2 finding; elicitation was disabled (`GODOT_MCP_DISABLE_ELICITATION`), so the finding ran unprompted. Script executed; the finding is in `warnings`.
- `warn`: Tier 3 finding only (no Tier 1 or Tier 2). Script executed; warnings surfaced in the response.
- `ok`: No findings. Script executed unconditionally.

Audit failure (disk full, permission denied) is logged via `logDebug` and never blocks the call.

`run_project` does NOT emit per-call sidecars - findings flow into the response `warnings` array only.

No sidecar is written at all when `GODOT_MCP_DISABLE_SECURITY` is set (see "Disabling the entire gate") - the gate that would have produced the decision never ran.

---

## What this does NOT do

This section exists because the doctrine at the top of this document demands it: a best-effort filter that hides its own holes is worse than one that documents them.

- **No runtime sandbox.** The gate is static-analysis only. Bridge authentication is a per-session token, not process isolation.
- **Tier 2 stops being a user decision whenever the client cannot service elicitation, and the two ways that happens do not fail the same direction.** Elicitation is a real MCP capability, not every client implements it, and some that advertise it auto-cancel every prompt (see "Disabling elicitation"). A client that cannot elicit at all fails _closed_ for `run_script`: the Tier 2 call is refused with an "elicitation unavailable" error and audited `elicit_denied`, so nobody ever approved it and it never ran. `run_project`'s session-confirmation gate fails _open_ on the same client: it launches with a warning, because that gate is UX around a scan that already happened. With `GODOT_MCP_DISABLE_ELICITATION` set, both fail open by design: the Tier 2 finding becomes advisory, running unprompted with the finding in `warnings` and audited `elicit_bypassed`. Only Tier 1 behaves identically regardless. `GODOT_MCP_STRICT` is the way to keep Tier 2 load-bearing without depending on any of it: it promotes every Tier 2 match to Tier 1 before elicitation would otherwise be attempted.
- **The profiler debug channel is unauthenticated.** Godot defines the remote-debugger protocol and it has no place for a token, so the listener accepts the first connection that reaches it. A same-user process that wins that race can feed the server fabricated profiling data. See "The profiler debug channel": it cannot reach anything beyond the profiler, and it is a strictly weaker position than reading the bridge token from the engine's environment.
- **Loopback is not a boundary in every host configuration.** Both listeners bind `127.0.0.1` and are unreachable from the network, but a Linux process under WSL2 in mirrored networking mode shares the Windows host's loopback. The bridge is token-protected there; the profiler channel is not.
- **No GDScript AST parse.** The tokenizer is line-oriented and does not track variable assignments.
- **Identifier aliasing / dataflow is invisible.** `var f = FileAccess; f.open(...)`, or any indirection through a local variable, defeats every chain-based rule, because the scanner is token-level, not a dataflow analysis. This is a structural limit of tokenizer-level matching, not something the next rule addition can close.
- **Some scripts a launch brings in are not scanned by `run_project`'s pre-flight.** Inline `[sub_resource type="GDScript"]` source and scripts attached to instanced scenes are scanned (see "`run_project` pre-flight"). Not scanned: non-GDScript scripts, binary `.scn` scenes, scripts carried by `.tres` / `.res` resources a scene references, and `uid://`-only references. The scan reports each of these it meets in `warnings`, but it does not refuse a launch over them, even in strict mode; strict mode refuses only when a script or text scene it does read exists and could not be read, or the scan itself failed. One mismatch is not reported at all: an `ext_resource` that carries both a `uid` and a `path` is read by its `path`, while the engine prefers the `uid`, so a stale `path` that names a harmless file hides the script the `uid` resolves to. The scene reader also expects one statement per line, the layout Godot writes. In a scene edited by hand to put two statements on one line (a section header followed by another header or by a property, or a property followed by a header), the second statement is not read, so a script it brings in is not scanned.
- **A uid is resolved from scene headers and `.uid` sidecars, not from the engine's cache.** The lookup trusts those files, so a stale or tampered `.godot/uid_cache.bin` can make the engine load a file the scan did not read. A binary `.scn` has no text header and is never found by uid.
- **Only `run/main_scene` is read for the launched scene.** A feature-tagged key such as `run/main_scene.mobile` and an `override.cfg` beside the project are not read, so a launch that the engine redirects through either runs a scene the scan did not choose.
- **A scene header the reader cannot parse loses what is under it.** Every header it cannot read, whatever its tag, is reported as `Not scanned`, and a scene reference that leaves the project (`res://../x.tscn`) is not followed and is reported too; neither refuses a launch, even in strict mode.
- **Bypassable by anyone who reads the open-source rule table and obfuscates.** This is the central, load-bearing limitation: the catalogue above is deliberately auditable, which means an adversary who wants to bypass it can read exactly what triggers each tier and construct GDScript that doesn't. That's accepted as inherent to a best-effort filter aimed at unobfuscated primitives, not a defect to be patched away.
- **Bridge auth doesn't stop a same-user process.** The per-session token stops unauthenticated drive-by connections to the bridge port; it does not stop a process running as the same user that can read the token from the environment or the injected script on disk (see "Bridge authentication").
- No defense against scripts that pass the gate then construct dangerous patterns dynamically through means the tokenizer cannot catch: mitigated, not eliminated, by `Expression`, `Engine.get_singleton`, and non-literal dynamic dispatch all being Tier 1.
- No telemetry / centralized reporting of blocks.
- No per-project or per-user policy overrides beyond `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_ELICITATION`, and `GODOT_MCP_DISABLE_SECURITY` (all process-global, read once at start).
- **`GODOT_MCP_DISABLE_SECURITY` removes Tier 1 too.** Every other escape hatch in this document (`GODOT_MCP_DISABLE_ELICITATION`, `GODOT_MCP_STRICT`'s absence) leaves Tier 1 hard blocks standing. This one does not: see "Disabling the entire gate." Enabling it is a full opt-out, not a UX convenience.
- No retroactive scanning of scripts already in the project: `run_project` scans autoloads + the launched scene's scripts (including subscenes reached via PackedScene) only.
- `run_project` with `attach: true` inherits whatever the externally launched Godot is doing. The pre-flight scan can warn, or in strict mode refuse to inject the bridge, but it cannot stop a Godot you start yourself. Scripts executed via `run_script` against an attached process still go through the gate.
