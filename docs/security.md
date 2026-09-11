# Security Model: `run_script` and `run_project`

GDScript executed via `run_script` runs inside the live Godot process with full user privileges. `run_project` launches the configured main scene and all `[autoload]` scripts, which is equally arbitrary code. Treat both as user-level RCE primitives.

**This is a best-effort accident guard, not a sandbox and not a security boundary.** It exists to catch the _obvious, unobfuscated_ dangerous primitive when it appears verbatim in a `run_script` payload, or in an autoload/scene script that `run_project` is about to launch — the "a non-programmer downloaded a malicious Godot project and ran it through the server" case. It does **not** defend against an adversary who knows the ruleset (the tool is open source), and it _cannot_ — GDScript is Turing-complete and reflective, and tokenizer-level static analysis of it is unsound by construction.

The defense has two parts: a **three-tier static-analysis gate** that inspects GDScript before it reaches the bridge, and a **per-session bridge auth token** on every bridge frame (see "Bridge authentication" below). Together: every bridge frame is authenticated with a per-session token and every `run_script` payload is scanned, but the scan is a best-effort filter with known holes, and neither the token nor the scan is a hard sandbox. MCP client bypass-permissions modes (Claude Code `--dangerously-skip-permissions`, Cursor YOLO, etc.) auto-answer elicitation requests, so elicitation alone is a UX speed bump, not a hard boundary. Strict mode (`GODOT_MCP_STRICT=true`) lets operators running unattended opt into hard-rejecting everything the filter would otherwise elicit — it raises the floor, it does not close the structural gaps listed under "What this does NOT do."

The rule catalogue below is the auditable surface, and because it's auditable, anyone can read it and construct a bypass — that's accepted as inherent to a best-effort filter, not a bug we're hiding. Tier assignments were calibrated against nine real Godot projects under `D:/Godot/Projects` — `OS.execute` and family have zero hits in real game code; literal `load()` / `preload()` / `call()` appear in nearly every game script and were demoted to Tier 3 to avoid conditioning users to click "yes" reflexively.

---

## Tier 1 — Hard block

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

These primitives fire when the call's **whole first argument** does not classify as a lone string literal — not just its first token. `load("res://" + evil_var)` is non-literal (the argument is a string concatenated with a variable) even though a string literal appears first; only a call whose first argument is a single bare string token, like `load("res://main.tscn")`, classifies as literal and drops to Tier 3 (warn).

| Primitive                          | Rule ID                                         |
| ---------------------------------- | ----------------------------------------------- |
| `load(non_literal)`                | `tier1.indirect.load.nonliteral`                |
| `preload(non_literal)`             | `tier1.indirect.preload.nonliteral`             |
| `ResourceLoader.load(non_literal)` | `tier1.indirect.ResourceLoader.load.nonliteral` |
| `Object.call(non_literal, …)`      | `tier1.indirect.Object.call.nonliteral`         |
| `Object.callv(non_literal, …)`     | `tier1.indirect.Object.callv.nonliteral`        |

---

## Tier 2 — Elicit

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
| `ConfigFile` (any usage — see note below)                | `tier2.config.ConfigFile`                        |
| `ConfigFile.save_encrypted`                              | `tier2.config.ConfigFile.save_encrypted`         |
| `ConfigFile.save_encrypted_pass`                         | `tier2.config.ConfigFile.save_encrypted_pass`    |
| `Image.save_png` / `save_jpg` / `save_webp` / `save_exr` | `tier2.image.save_png` etc.                      |
| `Resource.take_over_path`                                | `tier2.resource.take_over_path`                  |
| `ZIPPacker` (any usage)                                  | `tier2.archive.ZIPPacker`                        |
| `PCKPacker` (any usage)                                  | `tier2.archive.PCKPacker`                        |
| `ResourceUID.add_id` / `set_id` / `remove_id`            | `tier2.uid.ResourceUID.add_id` etc.              |

`FileAccess.open` is conservatively flagged uniformly. The READ vs WRITE distinction lives in the second argument; we accept the false-positive cost on read-only opens to keep the rule simple. Confirm "READ mode" and accept the elicitation if your script is reading.

`DirAccess.make_dir` and `make_dir_recursive` are instance methods (`dir.make_dir(path)`), so a `DirAccess.make_dir` chain-prefix rule would never fire on that call form. These two match on their last segment instead, on any receiver — both names are distinctive enough to be safe with no receiver information. Their `_absolute` siblings are static (`DirAccess.make_dir_absolute(path)`) and keep the ordinary two-segment prefix shape.

`ConfigFile`'s own instance methods (`save`, `save_encrypted`, `save_encrypted_pass`) are called the same way — `cf.save(p)`, never `ConfigFile.save(p)`. `save_encrypted` and `save_encrypted_pass` are distinctive enough names to match on their last segment directly. Plain `save` is not — `some_manager.save()` is common, ordinary game code, and a last-segment rule on bare `save` would hard-block it under strict mode. Instead, the rule anchors on the `ConfigFile` class reference itself (typically `ConfigFile.new()`) — the same shape `ZIPPacker` and `PCKPacker` use below — since reaching that class at all is the signal, when none of its generic method names can be matched safely on their own.

That anchor is also the only rule that reaches `cf.load(p)`. The Tier 1 `ConfigFile.load` / `load_encrypted` / `parse` rules are chain-prefix rules and fire only on the static-looking `ConfigFile.load(p)` form; the idiomatic instance form is caught one tier lower, by the class anchor, at the point the script names `ConfigFile`. A last-segment rule on bare `load` would close that gap and is deliberately not used: `save_manager.load(slot)` and `img.load(path)` are ordinary code, and a Tier 1 rule keyed on `load` would hard-block them with no elicitation escape.

`Image.save_png` / `save_jpg` / `save_webp` / `save_exr` go one step further: their idiomatic call form is `tex.get_image().save_png(p)`, where `get_image()` is itself a call sitting between the receiver and the write method. The tokenizer never chains across a call (see `src/utils/gdscript-scanner.ts`), so `save_png` surfaces as a bare identifier with no receiver information at all, not as a two-segment chain — a last-segment rule alone would miss it. These four rules additionally set `matchAsBareIdentifier`, so they fire on the bare identifier form too (`save_png(p)` with no receiver whatsoever also elicits). This is safe specifically because the four names are distinctive image-write verbs; it is not applied to `take_over_path`, `save_encrypted`, or `save_encrypted_pass` above, whose idiomatic forms are plain `receiver.method(...)` with no intervening call, so the ordinary last-segment match already reaches them without widening to a receiver-less match.

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

The named-receiver rules above (`Object.call`, `OS.call`, `Engine.call`, `ClassDB.call`, `ProjectSettings.call`) only fire on those five singletons. `.call`/`.callv` with a non-literal method name on _any other receiver_ — `some_node.call(method_var)` — is still dynamic dispatch that bypasses static analysis, so it's flagged too, matched on the last segment of the member chain rather than a fixed prefix.

| Primitive                           | Rule ID                          |
| ----------------------------------- | -------------------------------- |
| `<any receiver>.call(non_literal)`  | `tier2.generic.call.nonliteral`  |
| `<any receiver>.callv(non_literal)` | `tier2.generic.callv.nonliteral` |

This is Tier 2, not Tier 1: plenty of benign code calls `some_callable.call(...)`, and hard-blocking it would train reflexive elicitation approval. `Object.call(var)` (and the other four named receivers) still hard-blocks via the more specific Tier 1 rule — the generic rule only fires when none of the named rules already matched.

---

## Tier 3 — Warn

Executes. Matched rules attach to a `warnings: string[]` array on the success response.

| Primitive                                  | Rule ID                             |
| ------------------------------------------ | ----------------------------------- |
| `load("res://…")` (literal)                | `tier3.literal.load`                |
| `preload("res://…")` (literal)             | `tier3.literal.preload`             |
| `ResourceLoader.load("res://…")` (literal) | `tier3.literal.ResourceLoader.load` |
| `Object.call("method_name", …)` (literal)  | `tier3.literal.Object.call`         |
| `OS.alert`                                 | `tier3.os_alert`                    |

Literal `load`/`preload`/`call` are extremely common in real game scripts; gating them in Tier 2 would condition users to click "yes" reflexively. The warn surface keeps the audit trail without blocking the idiom.

---

## Bridge authentication

The McpBridge TCP listener (`127.0.0.1:<port>`) previously dispatched any well-formed frame from any local process that found the port — a `run_script` payload sent directly to the bridge would bypass the static-analysis gate entirely, since the gate runs on the Node side before a command is ever sent. Every request frame now carries a per-session token, and the bridge rejects any frame whose token doesn't match.

**What this buys, stated honestly:** the token stops the _unauthenticated drive-by_ — a process that finds the open port and blasts commands without knowing the secret. It does **not** stop a same-user process that reads the token from the environment (`/proc/<pid>/environ` on Linux, `OpenProcess` on Windows) or from the injected bridge script on disk. That's an accepted limitation of a same-machine, same-user token, not a gap we're hiding.

Token delivery differs by session mode, because the channel available differs:

- **Spawned (`run_project`)** — Node controls the process, so the token travels via the `MCP_SESSION_TOKEN` environment variable. It is never baked into the on-disk script for spawned mode — the env var keeps the secret off disk, the stronger position on Windows (reading another process's environment needs a process handle; reading a file in the project directory does not).
- **Attached (`attach_project`)** — Godot is launched by the user, so Node has no env-var channel into it. The token is baked into the injected `mcp_bridge.gd` copy at inject time instead, the same mechanism used to bake the listen port.

A frame with no token, or the wrong token, gets `{"error": "Unauthorized: invalid or missing session token"}` and is never dispatched to a command handler. The bridge fails open only when no token is configured at all — the standalone script run outside the MCP server (manual debugging, `validate`).

---

## The profiler debug channel

`run_project({ profiling: true })` opens a **second** local TCP channel, and it is not the bridge. Before spawning Godot the server binds a listener on `127.0.0.1:0` and passes `--remote-debug tcp://127.0.0.1:<port>` on the command line, so the engine dials back into it and speaks Godot's own remote-debugger protocol. The measurements are the stock editor ones — nothing is injected into the project — but the channel's properties differ from the bridge's in one way that matters.

**This channel has no token.** The bridge authenticates every frame because both ends are ours. Godot defines the debugger protocol, there is no field to carry a secret, and the engine would not check one. The listener therefore accepts the first connection that arrives and destroys every later one. That is the same trust assumption the bridge token already concedes it cannot exceed: a process able to scan the local TCP table and win the race between bind and the engine's dial-back can equally read `MCP_SESSION_TOKEN` out of the spawned engine's environment and drive the _authenticated_ bridge, which is strictly more powerful. The missing token here does not open a door that a same-user process did not already have.

**What a hostile peer could do, and where it stops.** It is confined to the profiler. The receiver acts on five message names — `set_pid`, `debug_enter`, `servers:function_signature`, `servers:profile_frame` and `servers:profile_total` — and drops everything else. None of them reaches script execution, the filesystem, process control, or any other tool's behaviour; the profiler's state is read only by the three profiling tools. The realistic ceiling is fabricated profiling numbers and denial of profiling for the rest of the session. A peer that connects but never speaks the protocol surfaces as a `profile_timeout` within five seconds, and the engine's own "unable to connect" lands in `get_debug_output`. A peer that _does_ speak it can return plausible-looking measurements with no signal. Treat profiler output as measurement data, not as a trusted assertion about your project.

**Errors still do not pause the game.** A connected debugger normally halts the engine on a script error or `breakpoint`. Every `debug_enter` is answered immediately with `continue`, so profiling mode preserves the behaviour documented under "Runtime errors and `breakpoint`" — the engine runs past errors, `SCRIPT ERROR` output keeps reaching stderr, and `breakpoint` remains a no-op. Verified empirically against a project with a deliberate runtime error: stderr was byte-identical with and without `--remote-debug`, and the game ran on past the fault.

**Lifetime.** The listener is bound only for spawned sessions, and only when `profiling: true` was passed at launch — it cannot be added to a running session, and `attach_project` never has one. It is closed by `stop_project` (including when the spawn failed and no process exists), by a failed spawn, by the next `run_project` or `attach_project`, and by the server's own shutdown handlers. It never outlives the server process.

**Not covered by strict mode.** `GODOT_MCP_STRICT` and `GODOT_MCP_DISABLE_ELICITATION` govern what GDScript may run; they say nothing about this channel. `profiling: true` is a parameter on `run_project` and inherits that tool's pre-flight scan and session-confirmation gate, but strict mode does not separately refuse to open the debugger port.

---

## Strict mode

`GODOT_MCP_STRICT=true` is read once at process start. When enabled:

- Every Tier 2 match becomes Tier 1 (hard reject). No elicitation prompt is sent.
- `run_project` becomes a hard reject if any autoload script or the launched scene's attached scripts contain a Tier 1 primitive.

Default (`GODOT_MCP_STRICT` unset or `"false"`): existing behavior preserved on upgrade.

---

## Disabling elicitation

`GODOT_MCP_DISABLE_ELICITATION=true` is read once at process start. It is the escape hatch for clients that cannot surface elicitation prompts. Some MCP clients — notably Claude Desktop / the Cowork surface ([anthropics/claude-code#56243](https://github.com/anthropics/claude-code/issues/56243)) — advertise the elicitation capability but auto-answer every `elicitation/create` with `{"action":"cancel"}` within milliseconds, never displaying the prompt. Because the client _responds_ (rather than erroring), the server cannot fall back the way it does for a client that lacks the capability outright: the auto-cancel is read as a user denial, and `run_project` becomes impossible to use.

When enabled, the interactive confirmation is skipped and treated as accepted (**fail-open**):

- `run_project`'s session-confirmation gate is bypassed; the project launches with a `warnings` entry recording the bypass.
- Tier 2 `run_script` findings proceed without a prompt, with the finding surfaced in `warnings` and audited as `elicit_bypassed`.
- **Tier 1 hard-block primitives are unaffected** — they never elicit and always block. This flag only disables the "ask the user" prompts, not the static-analysis gate.

**Strict mode takes precedence.** `GODOT_MCP_STRICT` mandates explicit confirmation, so when both are set, `GODOT_MCP_DISABLE_ELICITATION` is ignored (a startup log records the override). The three states form one axis: default = ask, `DISABLE_ELICITATION` = proceed unprompted, `STRICT` = hard-reject anything that would ask.

Only enable this when you trust the project and the agent driving it — it removes the confirmation step, the same tradeoff as an MCP client's bypass-permissions mode.

---

## `run_project` pre-flight

**Stated plainly: in default mode, `run_project` blocks nothing.** The project launches — autoloads run with full privileges immediately — and the scan below only _warns_. Only strict mode blocks.

`run_project` runs the same scanner over:

1. Every `[autoload]` entry in `project.godot` whose path ends in `.gd`.
2. Every `[ext_resource type="Script" path="res://…"]` attached to the launched scene, recursing transitively into every `[ext_resource type="PackedScene"]` it instances (cycle-safe). The launched scene is the explicit `scene` argument if provided, else `run/main_scene` from `[application]`, else null (no scene scan, autoload-only).

Findings are aggregated and:

- **Default mode**: surfaced as `warnings: string[]` on the success response. The project still launches.
- **Strict mode**: any Tier 1 finding hard-rejects before launch.

Subscene _ext_resource_ recursion (item 2 above) is in scope as of this release. Still not scanned: inline `[sub_resource type="GDScript"]` scripts embedded directly in a `.tscn`, and `[instance]` property overrides — see "What this does NOT do."

### Session-confirmation gate

The first `run_project` call against a given `projectPath` in a session prompts one elicitation: "Launching a Godot project executes arbitrary code in its autoloads and main scene. Proceed?" Subsequent calls in the same session against the same project skip. A `cancel` response (client dismissed the prompt without a choice, or auto-cancelled it) is reported distinctly from an explicit `decline` and points the user at `GODOT_MCP_DISABLE_ELICITATION`. When that flag is set, this gate is skipped entirely (see "Disabling elicitation").

---

## Audit trail

Every `run_script` call writes two files to `.mcp/scripts/`:

- `{timestamp}-{uuid}.gd` — the raw script source.
- `{timestamp}-{uuid}.policy.json` — the policy decision:

```json
{
  "decision": "hard_block" | "elicit_denied" | "elicit_accepted" | "elicit_bypassed" | "warn" | "ok",
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

- `hard_block` — Tier 1 finding; script refused before reaching the bridge.
- `elicit_denied` — Tier 2 finding; user declined the elicitation OR the client does not support elicitation.
- `elicit_accepted` — Tier 2 finding; user accepted the elicitation. Script executed.
- `elicit_bypassed` — Tier 2 finding; elicitation was disabled (`GODOT_MCP_DISABLE_ELICITATION`), so the finding ran unprompted. Script executed; the finding is in `warnings`.
- `warn` — Tier 3 finding only (no Tier 1 or Tier 2). Script executed; warnings surfaced in the response.
- `ok` — No findings. Script executed unconditionally.

Audit failure (disk full, permission denied) is logged via `logDebug` and never blocks the call.

`run_project` does NOT emit per-call sidecars — findings flow into the response `warnings` array only.

---

## What this does NOT do

This section exists because the doctrine at the top of this document demands it: a best-effort filter that hides its own holes is worse than one that documents them.

- **No runtime sandbox.** The gate is static-analysis only. Bridge authentication is a per-session token, not process isolation.
- **Tier 2 degrades to advisory whenever the client cannot service elicitation.** Elicitation is a real MCP capability, not every client implements it, and some that advertise it auto-cancel every prompt (see "Disabling elicitation"). When elicitation isn't actually serviced — the client lacks the capability, or `GODOT_MCP_DISABLE_ELICITATION` is set to work around an auto-cancelling one — a Tier 2 finding stops being a gate and becomes a warning: the call proceeds, and the finding is recorded (`warnings`, `elicit_denied`/`elicit_bypassed` in the audit sidecar) rather than blocked. Only Tier 1 stays a hard block regardless of elicitation support. `GODOT_MCP_STRICT` is the way to keep Tier 2 load-bearing on such a client — it promotes every Tier 2 match to Tier 1 before elicitation would otherwise be attempted.
- **The profiler debug channel is unauthenticated.** Godot defines the remote-debugger protocol and it has no place for a token, so the listener accepts the first connection that reaches it. A same-user process that wins that race can feed the server fabricated profiling data. See "The profiler debug channel" — it cannot reach anything beyond the profiler, and it is a strictly weaker position than reading the bridge token from the engine's environment.
- **Loopback is not a boundary in every host configuration.** Both listeners bind `127.0.0.1` and are unreachable from the network, but a Linux process under WSL2 in mirrored networking mode shares the Windows host's loopback. The bridge is token-protected there; the profiler channel is not.
- **No GDScript AST parse.** The tokenizer is line-oriented and does not track variable assignments.
- **Identifier aliasing / dataflow is invisible.** `var f = FileAccess; f.open(...)` — or any indirection through a local variable — defeats every chain-based rule, because the scanner is token-level, not a dataflow analysis. This is a structural limit of tokenizer-level matching, not something the next rule addition can close.
- **Inline scene scripts and instance overrides are not scanned by `run_project`'s pre-flight.** `[sub_resource type="GDScript"]` embeds GDScript source directly inside a `.tscn`; `[instance]` property overrides can also carry code-bearing values. Neither is chased. (Subscene _ext_resource_ recursion — scripts attached to a referenced PackedScene — IS scanned as of this release; see "`run_project` pre-flight".)
- **Bypassable by anyone who reads the open-source rule table and obfuscates.** This is the central, load-bearing limitation: the catalogue above is deliberately auditable, which means an adversary who wants to bypass it can read exactly what triggers each tier and construct GDScript that doesn't. That's accepted as inherent to a best-effort filter aimed at unobfuscated primitives, not a defect to be patched away.
- **Bridge auth doesn't stop a same-user process.** The per-session token stops unauthenticated drive-by connections to the bridge port; it does not stop a process running as the same user that can read the token from the environment or the injected script on disk (see "Bridge authentication").
- No defense against scripts that pass the gate then construct dangerous patterns dynamically through means the tokenizer cannot catch — mitigated, not eliminated, by `Expression`, `Engine.get_singleton`, and non-literal dynamic dispatch all being Tier 1.
- No telemetry / centralized reporting of blocks.
- No per-project or per-user policy overrides beyond `GODOT_MCP_STRICT` and `GODOT_MCP_DISABLE_ELICITATION` (both process-global, read once at start).
- No retroactive scanning of scripts already in the project — `run_project` scans autoloads + the launched scene's scripts (including subscenes reached via PackedScene) only.
- `attach_project` inherits whatever the externally launched Godot is doing. Scripts executed via `run_script` against an attached process still go through the gate.
