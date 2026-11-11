# Security

## Trust model

Godot MCP Runtime gives an AI agent the same power over a Godot project that you have in the editor and a terminal. It does not sandbox anything, and it does not inspect the code it runs. Use it on projects you trust, or inside a container or a separate OS account.

## What runs code

- **Launching.** `run_project` (spawn mode) and `render_movie` start Godot on the project. That runs the project's autoloads, its main scene and anything they load, as you. Almost any file the engine loads can carry a script: scenes, resources, import remaps, theme settings and the main loop class. That is how Godot works, and nothing the server does changes it.
- **`run_script`.** This runs GDScript the agent wrote inside the running game. It can read and write files, use the network and start programs, like any GDScript.
- **Headless tools.** Every tool that starts a headless Godot (the scene, node and resource tools, `validate`, `export_mesh_library`) loads the project the way the engine does. Every registered autoload is created, so its `_init` runs, and the scenes and resources the tool loads can run their `_init` and `@tool` code. None of these tools asks first.
- **The Godot editor.** `launch_editor` opens the editor, which runs `@tool` scripts and enabled plugins on open. It does not ask first. The server adds nothing the editor lacks.

## What the agent can change

The agent can create, edit and delete any file inside the project, including scripts and `project.godot`. Writes outside the project directory are refused. Paths are resolved before they are checked, so `..` segments and links that leave the project do not get around the check. Reads may follow a link out of the project, for example to a shared `addons` checkout.

Keep the project in version control. A bad edit, or a deleted file, is then one command away from undone.

## What the prompts do and do not protect

The server asks you to confirm twice, each time once per project per server session:

- Before the first launch of a project (`run_project` in spawn mode, and `render_movie`).
- Before the first `run_script` on a project. A launch confirmation does not cover it, and an attached session (`run_project` with `attach: true`, which spawns nothing) asks too.

After you accept, the rest of that session runs without asking. The prompts inspect no code. They tell you that code is about to run with your permissions, and they give you the chance to say no. If you decline, the call is refused and the agent is told not to retry unless you ask.

The prompts are a heads-up, not a barrier. They cover the launch and `run_script` paths and nothing else, and an agent that can write files can run code without either one. It can register a script as an autoload with `add_autoload`, or edit a script that already is one, and then call any headless tool: the script's `_init` runs with no prompt. It can also put code in the `_init` of a script attached to a scene a headless tool loads, or open the editor. A barrier has to come from outside the server: your client's per-tool approval, version control, or a container or separate OS account.

Some behaviors to know:

- A client that does not support elicitation proceeds with a warning in the response to the first call on a project, whether that call succeeds or fails. Later calls on that project go ahead without one.
- A prompt that goes unanswered, or is cancelled, refuses the call.
- MCP client bypass modes can answer prompts for you.
- `GODOT_MCP_DISABLE_ELICITATION=true` skips both prompts. Set it only if your client cannot display them (Claude Desktop auto-cancels them, for example), and rely on the client's own per-tool approval instead.

The client's per-tool approval is the other layer. It sees each call, which the server's prompts do not, including the headless calls and `launch_editor` that never prompt.

## Local network surface

The runtime bridge listens on `127.0.0.1` and checks a per-session token on every frame. The token stops a process that finds the open port and sends commands without knowing it. It does not stop a process running as the same user, which can read the token from the game's environment or from the injected bridge script. Loopback is also shared with the host in some setups, such as WSL2 in mirrored networking mode.

The profiler channel (`run_project` with `profiling: true`) has no token, because Godot's remote debugger protocol has no place for one. It accepts the first connection and drops later ones. A process that wins that race is confined to profiler messages. The realistic worst case is fabricated profiling numbers, so treat profiler output as measurement data and not as proof about your project. The channel exists only for spawned sessions started with `profiling: true`, and `stop_project` closes it.

## Removed in 4.0

Earlier versions scanned GDScript before it ran. The scan sorted `run_script` source into three tiers (block, ask, warn). For a launch it scanned the project's autoloads and launch scene, listed what it found in the response and asked once, refusing only under `GODOT_MCP_STRICT`. Each `run_script` call also wrote a copy of the script plus a `.policy.json` file under `.mcp/godot-runtime/scripts/`. Version 4.0 removes all of it, along with `GODOT_MCP_STRICT`, `GODOT_MCP_DISABLE_SECURITY` and those files. Both flags are ignored if set.

I removed it because it could not do the job. A denylist cannot cover a reflective language, or an engine that loads code from many file types, and every review round found another way past it. A scan that reports nothing also invites trust it has not earned. What remains is two plain statements: code runs as you, and the server asks once before it does.

The [4.0 migration guide](docs/migration-4.0.md#the-script-security-gate-is-removed) lists what changed and what to do about it.

## Reporting a vulnerability

Report privately through GitHub: open the Security tab of [Erodenn/godot-mcp-runtime](https://github.com/Erodenn/godot-mcp-runtime) and choose "Report a vulnerability". Please do not open a public issue for one.

In scope:

- A path escape on write, where a tool changes a file outside the project.
- A bypass of the bridge token.
- `run_project` in spawn mode, `render_movie` or `run_script` running on a project the user has not confirmed in this server session, with elicitation available and not turned off.

Out of scope: anything this file describes as working by design. That includes what a launched project, `run_script` or the editor can do, code that runs from the headless tools or from autoloads with no prompt, and anything a client bypass mode or `GODOT_MCP_DISABLE_ELICITATION` answers for you.

The latest 4.x release is supported.
