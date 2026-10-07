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
| `OS.create_instance`     | `tier1.direct_exec.OS.create_instance`     |

### Native libraries

| Primitive                           | Rule ID                                          |
| ----------------------------------- | ------------------------------------------------ |
| `GDExtensionManager.load_extension` | `tier1.native.GDExtensionManager.load_extension` |

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
| `GDScript.new`                     | `tier1.dynamic.GDScript.new`              |
| `str_to_var` (bare)                | `tier1.dynamic.str_to_var`                |
| `bytes_to_var_with_objects` (bare) | `tier1.dynamic.bytes_to_var_with_objects` |
| `ConfigFile.load`                  | `tier1.config.ConfigFile.load`            |
| `ConfigFile.load_encrypted`        | `tier1.config.ConfigFile.load_encrypted`  |
| `ConfigFile.parse`                 | `tier1.config.ConfigFile.parse`           |

`tier1.dynamic.GDScript.new` is keyed on the two-segment chain `GDScript.new`, the call that creates a script object whose `source_code` can then be set and compiled with `reload()`. A reference to the class that constructs nothing (`var s: GDScript`, `-> GDScript`, `Array[GDScript]`, `x is GDScript`, `x as GDScript`) does not match.

### Non-literal indirection

These primitives fire when the call's **whole first argument** does not classify as a lone string literal - not just its first token. `load("res://" + evil_var)` is non-literal (the argument is a string concatenated with a variable) even though a string literal appears first; only a call whose first argument is a single bare string token, like `load("res://main.tscn")`, classifies as literal and drops to Tier 3 (warn). A raw string (`load(r"res://main.tscn")`) and a StringName (`&"..."`) are single string tokens too.

| Primitive                                           | Rule ID                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `load(non_literal)`                                 | `tier1.indirect.load.nonliteral`                                 |
| `preload(non_literal)`                              | `tier1.indirect.preload.nonliteral`                              |
| `ResourceLoader.load(non_literal)`                  | `tier1.indirect.ResourceLoader.load.nonliteral`                  |
| `ResourceLoader.load_threaded_request(non_literal)` | `tier1.indirect.ResourceLoader.load_threaded_request.nonliteral` |
| `<receiver>.call(non_literal, …)`                   | `tier1.indirect.<receiver>.call.nonliteral`                      |
| `<receiver>.callv(non_literal, …)`                  | `tier1.indirect.<receiver>.callv.nonliteral`                     |
| `<receiver>.call_deferred(non_literal, …)`          | `tier1.indirect.<receiver>.call_deferred.nonliteral`             |

`<receiver>` is each of the seven names in `TIER1_DISPATCH_RECEIVERS` (`src/utils/run-script-policy.ts`): `Object`, `OS`, `Engine`, `ClassDB`, `ProjectSettings`, `ResourceLoader` and `GDExtensionManager`. That is 21 rules, one per receiver and dispatch method, for example `tier1.indirect.OS.callv.nonliteral`. These are the receivers that carry Tier 1 chain-prefix rules and can be handed a method name at runtime. `Node`, `ConfigFile` and `GDScript` carry Tier 1 rules too and are left out: they are classes, and their reflective use goes through an instance the scanner cannot see.

The `load`, `preload`, `str_to_var` and `bytes_to_var_with_objects` rules target GDScript global functions. They match only when the name is not preceded by a `.`: `save_manager.load(slot)`, `$SaveManager.load(slot)`, `get_node("Save").load(slot)` and `slots[i].load(d)` call a method of some other object and are not governed by them. The bare form `load(path_var)` is unchanged.

### Call forms every rule reads the same way

These apply to every rule in every tier.

**A reflective call with a literal method name is evaluated as the call it makes.** `call`, `callv`, `call_deferred`, `call_deferred_thread_group` and `call_thread_safe` call the method their first argument names. When that argument is a single string literal that compiles to a method name (`"execute"`, `'execute'`, `&"execute"`, or the same name written with escapes, `"execute"`), the scanner evaluates the direct call: `OS.call("execute", ...)`, `OS.callv("execute", [...])` and `OS.call_deferred("execute", ...)` fire `tier1.direct_exec.OS.execute` exactly as `OS.execute(...)` does, and `img.call("save_png", path)` elicits through `tier2.image.save_png`. The finding keeps the tier of the rule it reaches and reports the dispatch as written, with the method it names (`OS.call("execute")`). The literal is decoded first, the way GDScript compiles it, and a raw string is its own value. A dispatch that names another dispatch is followed to the method it ends at, up to `MAX_DISPATCH_DEPTH` (4) calls: `OS.call("call", "execute")` and `OS.call("callv", "execute", [])` are `OS.execute`. A `callv` in that chain has to be given an array literal. When the name cannot be read (an expression, an escape GDScript does not define, a string that is not an identifier, a chain deeper than the bound, a `callv` argument that is not an array literal), the call is judged as dispatch by a non-literal name. A rule that looks at an argument looks at the one the called method receives: `ResourceLoader.call("load", path_var)` is the non-literal `ResourceLoader.load`, and for `callv` the argument is the first element of the array literal (an array that is not written as a literal counts as non-literal). With no receiver in view (`call("load", slot)`, or `get_node("A").call_deferred("load", slot)`), the target is a method of an object the scanner cannot see, so the global-function rules never fire on it, while method rules such as `set_script` and `save_png` still do. When the named method fires no rule, the call is evaluated as written: a Tier 3 warning on the seven receivers above, nothing on any other receiver.

**A parenthesised receiver is read as the receiver.** `(OS).execute(...)`, `((Engine)).get_singleton(...)` and `(GDScript).new()` are the chains `OS.execute`, `Engine.get_singleton` and `GDScript.new`. Only parentheses that group a single identifier qualify. In `wrap(OS).execute()` the parentheses are an argument list and `execute` belongs to whatever `wrap` returns, so no chain rule fires; the `OS` handed to `wrap` is the alias finding described under "Reflection" in Tier 2.

**A member chain is read across whitespace, line breaks, continuations and comments.** `OS .execute`, `OS. execute`, a line break or a `#` comment on either side of the dot, and `OS \` continued by `.execute` on the next line are all the chain `OS.execute`.

**The name a `func` declaration gives is not a use of that name.** `func load(slot):`, `static func load(path):` and `func set_script(value):` declare a method and match nothing. A call inside the body is still evaluated, and so is the body of a lambda (`func(): OS.execute(...)`), which names nothing.

---

## Tier 2 - Elicit

The server pauses and sends an `elicitation/create` request to the client. User accept proceeds; decline returns an error naming the primitive (`User declined: <finding>. The script was not executed.`). A prompt the client dismissed without a choice (`cancel`) is refused too, reported apart from a decline, and is the only refusal that names `GODOT_MCP_DISABLE_ELICITATION`. Elicitation failure (older SDK or unsupported client) falls back to a hard denial with a clear error.

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
| `DirAccess.remove` (static-looking form only)            | `tier2.fs.DirAccess.remove`                      |
| `DirAccess.remove_absolute`                              | `tier2.fs.DirAccess.remove_absolute`             |
| `DirAccess.copy` (static-looking form only)              | `tier2.fs.DirAccess.copy`                        |
| `DirAccess.copy_absolute` (static)                       | `tier2.fs.DirAccess.copy_absolute`               |
| `DirAccess.rename` (static-looking form only)            | `tier2.fs.DirAccess.rename`                      |
| `DirAccess.rename_absolute` (static)                     | `tier2.fs.DirAccess.rename_absolute`             |
| `create_link` (any receiver)                             | `tier2.fs.DirAccess.create_link`                 |
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

`DirAccess.remove`, `copy` and `rename` are chain-prefix rules: they fire when the receiver is the literal class name `DirAccess` and on no other receiver. A call on a `DirAccess` instance held in a variable (`dir.remove(path)`) does not match them, because `remove`, `copy` and `rename` are ordinary method names in game code and a rule keyed on the name alone would refuse that code under strict mode. Instance use is covered one tier lower instead: any script that names `DirAccess` gets the Tier 3 `tier3.fs.DirAccess` warning. `create_link` is distinctive enough to match on its last segment, on any receiver, and the static `DirAccess.copy_absolute` and `DirAccess.rename_absolute` have rules of their own.

`DirAccess.make_dir` and `make_dir_recursive` are instance methods (`dir.make_dir(path)`), so a `DirAccess.make_dir` chain-prefix rule would never fire on that call form. These two match on their last segment instead, on any receiver - both names are distinctive enough to be safe with no receiver information. Their `_absolute` siblings are static (`DirAccess.make_dir_absolute(path)`) and keep the ordinary two-segment prefix shape.

`ConfigFile`'s own instance methods (`save`, `save_encrypted`, `save_encrypted_pass`) are called the same way - `cf.save(p)`, never `ConfigFile.save(p)`. `save_encrypted` and `save_encrypted_pass` are distinctive enough names to match on their last segment directly. Plain `save` is not - `some_manager.save()` is common, ordinary game code, and a last-segment rule on bare `save` would hard-block it under strict mode. Instead, the rule anchors on the `ConfigFile` class reference itself (typically `ConfigFile.new()`) - the same shape `ZIPPacker` and `PCKPacker` use below - since reaching that class at all is the signal, when none of its generic method names can be matched safely on their own.

That anchor is also the only rule that reaches `cf.load(p)`. The Tier 1 `ConfigFile.load` / `load_encrypted` / `parse` rules are chain-prefix rules and fire only on the static-looking `ConfigFile.load(p)` form; the idiomatic instance form is caught one tier lower, by the class anchor, at the point the script names `ConfigFile`. A last-segment rule on bare `load` would close that gap and is deliberately not used: `save_manager.load(slot)` and `img.load(path)` are ordinary code, and a Tier 1 rule keyed on `load` would hard-block them with no elicitation escape.

`Image.save_png` / `save_jpg` / `save_webp` / `save_exr` go one step further: their idiomatic call form is `tex.get_image().save_png(p)`, where `get_image()` is itself a call sitting between the receiver and the write method. The tokenizer never chains across a call (see `src/utils/gdscript-scanner.ts`), so `save_png` surfaces as a bare identifier with no receiver information at all, not as a two-segment chain - a last-segment rule alone would miss it. These four rules additionally set `matchAsBareIdentifier`, so they fire on the bare identifier form too (`save_png(p)` with no receiver whatsoever also elicits). This is safe specifically because the four names are distinctive image-write verbs; it is not applied to `take_over_path`, `save_encrypted`, or `save_encrypted_pass` above, whose idiomatic forms are plain `receiver.method(...)` with no intervening call, so the ordinary last-segment match already reaches them without widening to a receiver-less match.

### Reflection

| Primitive                                                                                                          | Rule ID                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `set_script` (any receiver, or bare)                                                                               | `tier2.reflection.set_script.bareIdentifier` |
| `source_code` (any receiver, or bare)                                                                              | `tier2.dynamic.source_code`                  |
| `JavaScriptBridge.eval`                                                                                            | `tier2.dynamic.JavaScriptBridge.eval`        |
| `instance_from_id` (bare)                                                                                          | `tier2.reflection.instance_from_id`          |
| `OS`, `Engine`, `ClassDB`, `ProjectSettings`, `ResourceLoader`, `GDExtensionManager` or `GDScript` used as a value | `tier2.alias.<Name>`                         |

`Object.set_script` and `Node.set_script` are Tier 1 only when the receiver is the literal class name. `set_script` is an instance method, so the idiomatic forms are `node.set_script(s)` on a variable, `a.b.set_script(s)`, `node.get_child(0).set_script(s)` where a call or subscript breaks the chain, and a bare `set_script(s)` on `self`. All of them elicit at Tier 2: the rule matches the name as the last segment of any chain and as a bare identifier. `get_script` matches nothing.

`source_code` is the text a script object compiles, so assigning it and calling `reload()` runs code held in a string, the other half of `GDScript.new()`. The name is matched wherever it appears, as a member or bare, which also catches a game's own variable of that name: that is why it is Tier 2 and not Tier 1. `JavaScriptBridge.eval` is Tier 2 because a web export calls it for ordinary browser integration. `instance_from_id` returns any live object from a number, past every rule keyed on a name, and matches only as a global function call.

An alias rule fires when one of the seven names above stands where a value does, which is how it gets another name: `var o = OS`, `foo(OS)`, `[OS][0]`, `OS["execute"]`. The name as the head of a member chain (`OS.execute`) is judged by the chain rules, and the name as a type or a declaration is not a value: `var x: OS`, `-> OS`, `is OS`, `as OS`, `extends OS`, `Array[OS]`, `func OS()`. `Object` and `Node` have no alias rule because ordinary code names them in annotations and `extends` throughout, and an alias of the class would not reach what their Tier 1 rules guard anyway. `ConfigFile` needs none: every reference to it already fires `tier2.config.ConfigFile`.

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

The Tier 1 non-literal dispatch rules only fire on the seven named receivers (`Object`, `OS`, `Engine`, `ClassDB`, `ProjectSettings`, `ResourceLoader`, `GDExtensionManager`). `call`/`callv` with a non-literal method name on _any other receiver_ - `some_node.call(method_var)` - is still dynamic dispatch that bypasses static analysis, so it's flagged too, matched on the last segment of the member chain rather than a fixed prefix. Both rules also match the bare identifier: `call(method_var)` with no receiver is `Object.call` on `self`, and `get_node("A").call(method_var)` leaves `call` bare after the call that breaks the chain.

| Primitive                                                 | Rule ID                          |
| --------------------------------------------------------- | -------------------------------- |
| `<any receiver>.call(non_literal)`, `call(non_literal)`   | `tier2.generic.call.nonliteral`  |
| `<any receiver>.callv(non_literal)`, `callv(non_literal)` | `tier2.generic.callv.nonliteral` |

This is Tier 2, not Tier 1: plenty of benign code calls `some_callable.call(...)`, and hard-blocking it would train reflexive elicitation approval. `Object.call(var)` (and the other six named receivers) still hard-blocks via the more specific Tier 1 rule - the generic rule only fires when none of the named rules already matched. A call with no argument (`cb.call()`) and a call with a literal name (`some_node.call("ready")`) do not match. There is no generic rule for `call_deferred`, `call_deferred_thread_group` or `call_thread_safe`: `some_node.call_deferred(method_var)` matches nothing (see "What this does NOT do").

---

## Tier 3 - Warn

Executes. Matched rules attach to a `warnings: string[]` array on the success response.

| Primitive                                                   | Rule ID                                              |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `load("res://…")` (literal)                                 | `tier3.literal.load`                                 |
| `preload("res://…")` (literal)                              | `tier3.literal.preload`                              |
| `ResourceLoader.load("res://…")` (literal)                  | `tier3.literal.ResourceLoader.load`                  |
| `ResourceLoader.load_threaded_request("res://…")` (literal) | `tier3.literal.ResourceLoader.load_threaded_request` |
| `<receiver>.call("method_name", …)` (literal)               | `tier3.literal.<receiver>.call`                      |
| `<receiver>.callv("method_name", …)` (literal)              | `tier3.literal.<receiver>.callv`                     |
| `<receiver>.call_deferred("method_name", …)` (literal)      | `tier3.literal.<receiver>.call_deferred`             |
| `OS.alert`                                                  | `tier3.os_alert`                                     |
| `DirAccess` (any reference no Tier 2 rule matched)          | `tier3.fs.DirAccess`                                 |

`<receiver>` is the same seven names as in the Tier 1 non-literal dispatch rules, so there are 21 literal-dispatch rules. They are reached only for a method no other rule covers: a literal method name is first evaluated as the direct call it makes (see "Call forms every rule reads the same way"), so `OS.call("execute", ...)` is a Tier 1 `OS.execute` finding and `OS.call("get_name")` is the Tier 3 `tier3.literal.OS.call` warning.

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
- A launch this server performs (`run_project` in spawn mode, `render_movie`) is refused when the scene it would run cannot be found or resolved: no `run/main_scene`, a file that does not exist, a value that cannot be resolved to a file inside the project, or a `uid://` no file was found to carry (whether the search finished or was cut short). With `attach: true` the user starts Godot and may run a scene the server never sees, so a project with no `run/main_scene` only warns; a configured scene that cannot be found is still refused.
- A launch is refused when the pre-flight scan failed on something it reads: a `.gd` script or `.tscn` scene that exists and could not be read, a malformed statement inside a scene that was read, a line of `project.godot` that is not in the form Godot writes, an autoload path, scene script path or scene reference that cannot be resolved to a file inside the project (`res://../x.gd`), an autoload `uid://` whose search was cut short before any file carrying it was found, or a scan step that threw. See the table under "`run_project` pre-flight".
- A launch confirmation that cannot be asked is a refusal. Where a client without elicitation launches with a warning in default mode, strict mode answers `Elicitation unavailable (...); strict mode refuses to launch without explicit user confirmation.`

The three scan refusals start with `Strict mode: refusing to launch project because ...` and name what caused them; the Tier 1 and failed-scan refusals show at most five lines (`MAX_STRICT_REJECT_LINES_SHOWN`) and count the rest. No strict-mode launch refusal suggests unsetting the flag. Each of the four carries the same closing instruction, `Strict mode (GODOT_MCP_STRICT) is an operator setting: report this refusal to the user rather than changing it`, because strict mode is how an operator bounds a run nobody is watching. A `run_script` hard block reads `Blocked: <finding>. The script was not executed.` in both modes and does not say whether strict mode promoted it; the audit sidecar's `promoted_by_strict` does.

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

1. Every autoload in `project.godot` whose path ends in `.gd` or `.tscn` (case-insensitive). An autoload is the setting `autoload/<Name>` however the file spells it: `Name=` under `[autoload]`, or a top-level `autoload/Name=` line outside any section. A value that starts on the line after its `=` is read as that entry's value, as the engine reads it, and is reported as a line not in the form Godot writes. A name assigned more than once is scanned once, at its last assignment, the one the engine keeps. A scene autoload is scanned the way the launched scene is, as in item 2. This server's own `McpBridge` entry is skipped; an `McpBridge` entry that points anywhere the server does not own is scanned like any other. An entry's value has to be exactly one quoted string: a bare value, a `&"..."` StringName and a line carrying a second statement are not entries.

`project.godot` is read for the form Godot writes: a blank line, a `;` comment, a `[section]` header alone on its line, and one `key=value` statement per line with exactly one complete value after the `=`. The engine reads the file as a stream of tokens and accepts more than that: a header and an assignment on one line, two statements on one line, blanks inside a key, a quoted key, an autoload on the `[autoload]` header line, an entry trailing another on one line, and a `#` line (only `;` starts a comment). The scan does not reproduce that parser, so it cannot say which autoload or main scene such a line registers. Every line outside the canonical form is a `warnings` entry that names the first five by line number and counts the rest, in default mode and in strict mode, and strict mode refuses the launch (see the table below). `list_autoloads` leads with the same warning. A junk token before a repeated header is reported too, although Godot 4.6.2 was observed to load nothing from it: the scan treats every non-canonical line as unreadable instead of guessing which ones the engine accepts. 2. Every `.gd` file an `[ext_resource path="res://…"]` of the launched scene names, and the source of every inline `[sub_resource type="GDScript"]` it embeds, recursing transitively into every scene it references (cycle-safe). A reference is classified by its path as well as by its `type` attribute: the engine loads the file the path names, and `type` is a hint a hand-edited scene can set to anything, so a `.gd` path is scanned and a `.tscn` or `.scn` path is walked whatever `type` says. The launched scene is the explicit `scene` argument if provided, else the setting `application/run/main_scene` (under `[application]`, under `[application/run]` or at the top level; the last assignment wins), else null (no scene scan, autoload-only). A script an instanced node or an instance override attaches is always an ext_resource or an inline sub-resource of the same scene file, so it is covered by the same two forms. Inline findings are labelled `<scene>[GDScript <id>]:<line>`, with the line counted inside the inline source.

The scan follows a path through a symbolic link or junction that sits inside the project, such as an `addons/<plugin>` folder linked to a shared checkout, because the engine loads through it: a script reached that way is scanned. A reference that resolves outside the project is still not followed (`res://../x.gd`).

A `uid://` value is resolved by reading text, not `.godot/uid_cache.bin`: the walk reads the first line of every `.tscn` for the `uid` in its header and every `*.uid` sidecar for the uid it holds, skipping dot-directories and symbolic links. This is the form the editor writes into `run/main_scene` and into an autoload entry since Godot 4.4. Every file that carries the uid is scanned, and more than one adds a note, because the engine may load any of them. The search is cut short after `UID_SCAN_MAX_FILES` files (5000), and also by a folder, scene header or `.uid` sidecar that could not be read, since any of them may carry the uid. A uid it does not find, or finds nothing for after being cut short, is reported as `Launch scene <value> could not be resolved to a file (<reason>); scene-script scan skipped.` (or an `Autoload ... was not scanned` entry). A search that was cut short after finding at least one file scans what it found and adds a note that another file may carry the uid and was not scanned.

The `scene` argument has to be a scene file, a path ending in `.tscn` or `.scn` in lower case, and the call is refused otherwise. Godot runs a command-line scene only when it carries such an extension and runs `run/main_scene` for anything else, so an argument like `icon.svg` or `scenes/level` would have had the scan read one file while the engine launched another.

Findings are aggregated and:

- **Default mode**: surfaced as `warnings: string[]` on the success response. The project still launches.
- **Strict mode**: any Tier 1 finding hard-rejects before launch. So does a scan that failed on something it reads: a `.gd` script or a `.tscn` scene that exists and could not be read (a permission error, a directory in its place), a malformed statement inside a scene that was read (the engine may load from it something the scan did not see), a line of `project.godot` that is not in the form Godot writes, a path that cannot be resolved to a file inside the project, an autoload `uid://` whose search was cut short before a file carrying it was found, or a scan step that threw.

With `attach: true` the same scan runs over the autoloads and `run/main_scene` before the bridge is injected, and findings are handled the same way: `warnings` in default mode, and in strict mode a Tier 1 finding refuses to inject. Attach mode has no confirmation prompt, because MCP launches nothing there.

What the scan cannot read is reported, not skipped. Still not scanned: scripts that are not GDScript (a C# script, an autoload that is neither `.gd` nor `.tscn`), binary `.scn` scenes, scripts carried by non-scene resources a scene references (`.tres` / `.res`), and references with no `res://` path, such as one by `uid://` alone. Each one the scan meets is listed in `warnings` as `Not scanned: <scene>: <reason>` (or an `Autoload ... was not scanned` entry), as is an `[autoload]` line the parser could not read. A resource file is listed once, however many scenes reference it. Findings and these notices are capped separately (10 each, with a `+N more` tail), so a long list of findings never pushes a not-scanned notice out of the answer.

Strict mode separates two kinds of incomplete scan, and refuses outright when it has no scene to scan:

| What was not scanned                                                                                                                                                                                                           | Default mode | Strict mode                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------- |
| A `.gd` script or `.tscn` scene that exists and could not be read, or a scan step that threw                                                                                                                                   | Warned       | The launch is refused      |
| An autoload path, a scene's script path or a scene reference that cannot be resolved to a file inside the project (`res://../x.gd`)                                                                                            | Warned       | The launch is refused      |
| An autoload `uid://` whose search was cut short before a file carrying it was found                                                                                                                                            | Warned       | The launch is refused      |
| A file of a kind the scan never reads: a C# script, a binary `.scn` scene, a `.tres` / `.res` resource, an autoload that is neither `.gd` nor `.tscn`                                                                          | Warned       | Warned, the launch goes on |
| The scene to launch: no `run/main_scene`, a file that is not on disk, a value that cannot be resolved inside the project, or a `uid://` no file was found to carry (attach mode with no `run/main_scene` is the one exception) | Warned       | The launch is refused      |
| A script or scene a reference names that is not on disk, a reference with no `res://` path, an autoload `uid://` a complete search found no file for                                                                           | Warned       | Warned, the launch goes on |
| A uid search that found at least one file and was cut short, so another carrier may exist                                                                                                                                      | Warned       | Warned, the launch goes on |
| A malformed header or statement, an unterminated string or an unclosed bracket inside a scene that was read, an autoload line the parser could not read, a `project.godot` line not in the form Godot writes                   | Warned       | The launch is refused      |

The first three rows are a scan that set out to read a file and failed, so what it would have found is unknown: the engine would still try to load the file, and the scan did not. The launch-scene row is refused for the same reason. So is the last row: a statement the scan could not take as written may hold something the engine loads. The others are known limits of what the scan covers. Whether strict mode should refuse on those too is an open question: refusing on every one would block every C# project and every project with a binary scene or a resource file. See "What this does NOT do."

### Session-confirmation gate

The first `run_project` call against a given `projectPath` in a session prompts one elicitation: "Launching a Godot project executes arbitrary code in its autoloads and main scene. Proceed?" Subsequent calls in the same session against the same project skip. The two ways the prompt can fail to be accepted are reported apart, and they tell the agent opposite things:

- An explicit `decline` is the user's answer. The error is `User declined <tool>. The project was not launched.` and its one suggestion is `The user declined this launch: do not call <tool> on this project again unless the user asks for it`. It does not mention the elicitation opt-out, because nothing about a decline is to be worked around.
- A `cancel` (the client dismissed the prompt without a choice, or auto-cancelled it) is nobody's answer. The error is `<tool> confirmation was cancelled without an explicit choice. Some MCP clients (e.g. Claude Desktop) auto-cancel elicitation prompts instead of displaying them. The project was not launched.` and its one suggestion is `If your client cannot display confirmation prompts, set GODOT_MCP_DISABLE_ELICITATION=true to skip them`.

Neither records the project as confirmed, so a later call prompts again. A client that cannot elicit at all launches with a warning in default mode and is refused in strict mode. When `GODOT_MCP_DISABLE_ELICITATION` is set, this gate is skipped entirely (see "Disabling elicitation").

`render_movie` launches the project too, so it runs this same pre-flight scan and shares the once-per-session launch confirmation with `run_project`: confirming either one covers both for that project. Strict mode and `GODOT_MCP_DISABLE_SECURITY` apply to it exactly as they do to `run_project`.

---

## Audit trail

Every `run_script` call the gate evaluates writes two files to `.mcp/godot-runtime/scripts/`, one pair per call. A call refused before the gate (no session, a missing `script`, no `func execute`, an invalid `timeout`) writes nothing.

- `{timestamp}-{uuid}.gd`: the raw script source.
- `{timestamp}-{uuid}.policy.json`, the policy decision:

```json
{
  "decision": "hard_block" | "elicit_denied" | "elicit_cancelled" | "not_sent" | "elicit_accepted" | "elicit_bypassed" | "warn" | "ok",
  "admitted_as": "elicit_accepted" | "elicit_bypassed" | "warn" | "ok",
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
- `elicit_accepted`: Tier 2 finding; user accepted the elicitation. Script sent to the game.
- `elicit_bypassed`: Tier 2 finding; elicitation was disabled (`GODOT_MCP_DISABLE_ELICITATION`), so the finding went ahead unprompted. Script sent to the game; the finding is in `warnings`.
- `warn`: Tier 3 finding only (no Tier 1 or Tier 2). Script sent to the game; warnings surfaced in the response.
- `ok`: No findings. Script sent to the game.
- `not_sent`: the policy admitted the script and it never reached the game. Between the policy decision and the send, the session ended or changed to another one, or the call gave up waiting for its turn. A confirmation prompt can be held open for minutes, so the session is checked again when the call's turn comes, and the script runs on no session other than the one it was judged for. `admitted_as` holds what the decision would have been (`ok`, `warn`, `elicit_accepted` or `elicit_bypassed`), so a confirmation a person gave is still on record.

`admitted_as` is present only with `decision: "not_sent"`. The four admitted decisions are written at the moment the script is about to be sent, not when the policy admits it, so each of them means the script was handed to the bridge. They do not say the script compiled or finished: a compile error, a runtime error or a timeout after the send leaves the record as it is. `tier` is the highest tier among the findings after strict-mode promotion, or `null` when there are none.

Audit failure (disk full, permission denied) is logged via `logDebug` and never blocks the call.

`run_project` does NOT emit per-call sidecars - findings flow into the response `warnings` array only.

No sidecar is written at all when `GODOT_MCP_DISABLE_SECURITY` is set (see "Disabling the entire gate") - the gate that would have produced the decision never ran.

---

## What this does NOT do

This section exists because the doctrine at the top of this document demands it: a best-effort filter that hides its own holes is worse than one that documents them.

- **No runtime sandbox.** The gate is static-analysis only. Bridge authentication is a per-session token, not process isolation.
- **Tier 2 stops being a user decision whenever the client cannot service elicitation, and the two ways that happens do not fail the same direction.** Elicitation is a real MCP capability, not every client implements it, and some that advertise it auto-cancel every prompt (see "Disabling elicitation"). A client that cannot elicit at all fails _closed_ for `run_script`: the Tier 2 call is refused with an "elicitation unavailable" error and audited `elicit_denied`, so nobody ever approved it and it never ran. `run_project`'s session-confirmation gate fails _open_ on the same client in default mode: it launches with a warning, because that gate is UX around a scan that already happened. In strict mode it fails closed and the launch is refused. With `GODOT_MCP_DISABLE_ELICITATION` set, both fail open by design: the Tier 2 finding becomes advisory, running unprompted with the finding in `warnings` and audited `elicit_bypassed`. Only Tier 1 behaves identically regardless. `GODOT_MCP_STRICT` is the way to keep Tier 2 load-bearing without depending on any of it: it promotes every Tier 2 match to Tier 1 before elicitation would otherwise be attempted.
- **The profiler debug channel is unauthenticated.** Godot defines the remote-debugger protocol and it has no place for a token, so the listener accepts the first connection that reaches it. A same-user process that wins that race can feed the server fabricated profiling data. See "The profiler debug channel": it cannot reach anything beyond the profiler, and it is a strictly weaker position than reading the bridge token from the engine's environment.
- **Loopback is not a boundary in every host configuration.** Both listeners bind `127.0.0.1` and are unreachable from the network, but a Linux process under WSL2 in mirrored networking mode shares the Windows host's loopback. The bridge is token-protected there; the profiler channel is not.
- **No GDScript AST parse.** The scanner produces tokens, not a syntax tree, and does not track variable assignments or types.
- **Identifier aliasing / dataflow is invisible past the first step.** The one step the scanner can see is answered: a guarded name used as a value (`var o = OS`, `foo(OS)`, `OS["execute"]`) is a Tier 2 alias finding, so `var o = OS; o.execute(...)` asks at the first line. What happens to the value afterwards is not followed. The same indirection through a name with no alias rule is open: `var f = FileAccess; f.open(...)`, a singleton returned by a function or fetched from a container of unguarded names, and any other route that never writes the guarded name as a value. The class-anchor rules (`Expression`, `ConfigFile`, `ZIPPacker`, `PCKPacker`, the network classes) fire on the class name itself, so aliasing those still produces their finding at the line that names the class. This is a structural limit of tokenizer-level matching, not something the next rule addition can close.
- **A chain-prefix rule matches the literal class name and nothing else.** `tier2.fs.DirAccess.remove`, `copy` and `rename` name instance methods, and the idiomatic call is on an instance: `var d = DirAccess.open(p); d.remove(f)` and `DirAccess.open(p).remove(f)` match none of them. Those calls are not confirmed and not refused under strict mode: the script gets the Tier 3 `tier3.fs.DirAccess` warning for naming the class, and nothing at all when the instance arrives from elsewhere without the class being named. The Tier 1 `ConfigFile.load` / `load_encrypted` / `parse` rules have the same shape and are backed the same way, by the `ConfigFile` class anchor one tier down.
- **Rewriting a script's text is covered by name, not by dataflow.** `GDScript.new` is Tier 1, and `source_code` is Tier 2 wherever the name appears, so `get_script().source_code = code` asks before it runs. A script object that already exists is still reachable without naming `source_code`: `get_script().set("source_code", code)` carries the name inside a string, and `set` is an ordinary method that no rule keys on. `reload()` is a generic method name and has no rule.
- **Reflective dispatch is covered where the method name can be read, and not everywhere else.** A literal method name is evaluated as the direct call once it is decoded (escapes included) and once any dispatch it names is followed to its end, up to four calls deep. A name built at runtime is not read: it is Tier 1 on the seven named receivers and only through `call`, `callv` and `call_deferred`; on any other receiver `call` and `callv` are Tier 2, and `call_deferred`, `call_deferred_thread_group` and `call_thread_safe` with a non-literal name match nothing (`some_node.call_deferred(method_var)`). A literal name on an unseen receiver that reaches no rule (`save_manager.call("load", slot)`) matches nothing, by design.
- **Some scripts a launch brings in are not scanned by `run_project`'s pre-flight.** Inline `[sub_resource type="GDScript"]` source and scripts attached to instanced scenes are scanned (see "`run_project` pre-flight"). Not scanned: non-GDScript scripts, binary `.scn` scenes, scripts carried by `.tres` / `.res` resources a scene references, and `uid://`-only references. The scan reports each of these it meets in `warnings`, but it does not refuse a launch over them, even in strict mode; strict mode refuses only when a script or text scene it does read exists and could not be read, when a scene holds a statement the scan could not take as written, when `project.godot` holds a line not in the form Godot writes, when a path cannot be resolved to a file inside the project, when an autoload's uid search was cut short before a file was found, or when the scan itself failed. One mismatch is not reported at all: an `ext_resource` that carries both a `uid` and a `path` is read by its `path`, while the engine prefers the `uid`, so a stale `path` that names a harmless file hides the script the `uid` resolves to. The scene reader reads statements the way the engine does, so a hand-edited scene that puts a second statement after a header or a value on the same line has both read, and the line is reported as malformed. The property before the second statement is dropped, not kept as if the line were ordinary.
- **A uid is resolved from scene headers and `.uid` sidecars, not from the engine's cache.** The lookup trusts those files, so a stale or tampered `.godot/uid_cache.bin` can make the engine load a file the scan did not read. A binary `.scn` has no text header and is never found by uid. A search cut short after it found one carrier scans that file and only warns that another may exist, in strict mode too.
- **Only `project.godot` is read, and only the plain setting names.** The launched scene is `application/run/main_scene` and the autoloads are `autoload/<Name>`, under any section spelling. A feature-tagged key such as `run/main_scene.mobile` and an `override.cfg` beside the project are not read, so a launch that the engine redirects through either runs a scene, or registers an autoload, the scan did not choose.
- **A scene header the reader cannot parse loses what is under it.** Every header it cannot read, whatever its tag, is reported as `Not scanned`, and so is a value whose brackets never close; strict mode refuses the launch on either, because the statement may hold something the engine loads. A scene reference that leaves the project (`res://../x.tscn`) is not followed and is reported; strict mode refuses on that one, because the engine would still try to load it.
- **Bypassable by anyone who reads the open-source rule table and obfuscates.** This is the central, load-bearing limitation: the catalogue above is deliberately auditable, which means an adversary who wants to bypass it can read exactly what triggers each tier and construct GDScript that doesn't. That's accepted as inherent to a best-effort filter aimed at unobfuscated primitives, not a defect to be patched away.
- **Bridge auth doesn't stop a same-user process.** The per-session token stops unauthenticated drive-by connections to the bridge port; it does not stop a process running as the same user that can read the token from the environment or the injected script on disk (see "Bridge authentication").
- No defense against scripts that pass the gate then construct dangerous patterns dynamically through means the tokenizer cannot catch: mitigated, not eliminated, by `Expression`, `GDScript.new`, `Engine.get_singleton`, and non-literal dynamic dispatch on the named receivers all being Tier 1.
- No telemetry / centralized reporting of blocks.
- No per-project or per-user policy overrides beyond `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_ELICITATION`, and `GODOT_MCP_DISABLE_SECURITY` (all process-global, read once at start).
- **`GODOT_MCP_DISABLE_SECURITY` removes Tier 1 too.** Every other escape hatch in this document (`GODOT_MCP_DISABLE_ELICITATION`, `GODOT_MCP_STRICT`'s absence) leaves Tier 1 hard blocks standing. This one does not: see "Disabling the entire gate." Enabling it is a full opt-out, not a UX convenience.
- No retroactive scanning of scripts already in the project: `run_project` scans autoloads + the launched scene's scripts (including subscenes reached via PackedScene) only.
- `run_project` with `attach: true` inherits whatever the externally launched Godot is doing. The pre-flight scan can warn, or in strict mode refuse to inject the bridge, but it cannot stop a Godot you start yourself. Scripts executed via `run_script` against an attached process still go through the gate.
