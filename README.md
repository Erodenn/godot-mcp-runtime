# Godot MCP Server

[![npm version](https://img.shields.io/npm/v/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![npm downloads](https://img.shields.io/npm/dm/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![License: MIT](https://badgen.net/github/license/Erodenn/godot-mcp-runtime)](LICENSE)
[![Node.js](https://img.shields.io/node/v/godot-mcp-runtime)](https://nodejs.org/)

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to a running Godot 4.x game. Not just file editing, not just scene manipulation. Actual runtime control: input simulation, screenshots, UI discovery, and live GDScript execution while the game is running.

Most Godot MCP servers operate headlessly. They can create scenes, add nodes, attach scripts. That covers a lot of ground, but stops at the editor boundary. This one doesn't. When you run a project through this server, it injects a lightweight UDP bridge as an autoload, and suddenly the AI can interact with your game the same way a player would: press keys, click buttons, read what's on screen, and run arbitrary code against the live scene tree.

**The distinction matters: the AI doesn't just write your game, it can check its work.**

<a href="https://glama.ai/mcp/servers/@Erodenn/godot-runtime-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@Erodenn/godot-runtime-mcp/badge" alt="godot-runtime-mcp MCP server" />
</a>

Think of it as [Playwright MCP](https://github.com/microsoft/playwright-mcp), but for Godot. Playwright lets agents verify that a web app actually works by driving a real browser. This does the same thing for games: run the project, take a screenshot, simulate input, read what's on screen, execute a script against the live scene tree. The agent closes the loop on its own changes rather than handing off to you to verify.

This is not a playtesting replacement. It doesn't catch the subtle feel issues that only a human notices, and it won't tell you if your game is fun. What it does is let an agent confirm that a scene loads, a button responds, a value updated, a script ran without errors. That's a fundamentally different development workflow, and it's what this server is built for.

This server is built around a small set of composable, wide-reaching tools rather than a long list of narrow ones. Each tool is designed to teach agents how to use it well. Response messages include next steps, timing constraints, and cleanup reminders so agents stay on track without extra prompting.

## What It Does

**Headless editing.** Create scenes, add nodes, set properties, attach scripts, connect signals, manage UIDs, validate GDScript. All the standard operations, no editor window required.

**Runtime bridge.** When `run_project` is called, the server injects `McpBridge` as an autoload. This opens a UDP channel on port 9900 (localhost only) and enables:

- **Screenshots:** Capture the viewport at any point during gameplay
- **Input simulation:** Batched sequences of key presses, mouse clicks, mouse motion, UI element clicks by name or path, Godot action events, and timed waits
- **UI discovery:** Walk the live scene tree and collect every visible Control node with its position, type, text content, and disabled state
- **Live script execution:** Compile and run arbitrary GDScript with full SceneTree access while the game is running

The bridge cleans itself up automatically when `stop_project` is called. No leftover autoloads, no modified project files.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Godot 4.x](https://godotengine.org/)

### Install via npm

```bash
npm install -g godot-mcp-runtime
```

### Or clone from source

```bash
git clone https://github.com/Erodenn/godot-mcp-runtime.git
cd godot-mcp-runtime
npm install
npm run build
```

### Configure Your MCP Client

Add the following to your MCP client config. Works with Claude Code, Claude Desktop, Cursor, or any MCP-compatible client.

**If installed via npm:**

```json
{
  "mcpServers": {
    "godot": {
      "command": "godot-mcp-runtime",
      "env": {
        "GODOT_PATH": "<path-to-godot-executable>"
      }
    }
  }
}
```

**If cloned from source:**

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["<path-to>/godot-mcp-runtime/dist/index.js"],
      "env": {
        "GODOT_PATH": "<path-to-godot-executable>"
      }
    }
  }
}
```

If Godot is on your `PATH`, you can omit `GODOT_PATH` entirely. The server will auto-detect it. Set `"DEBUG": "true"` in `env` for verbose logging.

### Verify

Ask your AI assistant to call `get_project_info`. If it returns a Godot version string (e.g., `4.4.stable`), you're connected and working.

## Tools

This server intentionally keeps the tool count small. Each tool covers a broad surface area through operations and parameters, so agents spend less time finding the right tool and more time doing useful work. Tool descriptions and responses are written to guide agent behavior: what to call next, when to wait, and how to recover from errors.

### Project

| Tool | Description |
|------|-------------|
| `launch_editor` | Open the Godot editor GUI for a project |
| `run_project` | Run a project in debug mode and inject the MCP bridge |
| `stop_project` | Stop the running project and remove the bridge |
| `get_debug_output` | Read stdout/stderr from the running project |
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Get project metadata and Godot version |

### Runtime (requires `run_project` first)

After calling `run_project`, wait 2-3 seconds for the bridge to initialize before using these tools.

| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture a PNG of the running viewport |
| `simulate_input` | Send batched input: key, mouse_button, mouse_motion, click_element, action, wait |
| `get_ui_elements` | Get all visible Control nodes with positions, types, and text |
| `run_script` | Execute arbitrary GDScript at runtime with full SceneTree access |

### Scene: `manage_scene`

All mutation operations save automatically. Use `save` only for save-as (`newPath`) or to re-canonicalize a `.tscn` file.

| Operation | Description |
|-----------|-------------|
| `create` | Create a new scene file |
| `add_node` | Add a node to an existing scene |
| `load_sprite` | Set a texture on a Sprite2D, Sprite3D, or TextureRect |
| `save` | Re-pack and save the scene, or save-as with `newPath` |
| `export_mesh_library` | Export scenes as a MeshLibrary for GridMap |
| `batch` | Execute an ordered sequence of `add_node`, `load_sprite`, and `save` ops across one or more scenes in a single Godot process |

### Node: `manage_node`

All mutation operations save automatically.

| Operation | Description |
|-----------|-------------|
| `get_tree` | Get the full scene tree hierarchy |
| `list` | List direct child nodes of a node |
| `get_properties` | Read properties from one node, or pass a `nodes` array to read from multiple nodes in one process |
| `update_property` | Set a property on a node, or pass an `updates` array to set multiple properties in one process |
| `attach_script` | Attach a GDScript to a node |
| `duplicate` | Duplicate a node within the scene |
| `delete` | Remove a node from the scene |
| `get_signals` | List all signals on a node with their connections |
| `connect_signal` | Connect a signal to a method on another node |
| `disconnect_signal` | Disconnect a signal connection |

### Project Settings: `manage_project`

Edits `project.godot` directly, no Godot process required. Safe to use even when autoloads are broken or headless operations are failing.

| Operation | Description |
|-----------|-------------|
| `list_autoloads` | List all registered autoloads with paths and singleton status |
| `add_autoload` | Register a new autoload |
| `remove_autoload` | Unregister an autoload by name |
| `update_autoload` | Modify an existing autoload's path or singleton flag |
| `get_project_settings` | Read settings from `project.godot` by section and key |
| `get_filesystem_tree` | Get the project file tree with types and extensions |
| `search_in_files` | Search for a string across project source files |
| `get_scene_dependencies` | List all resources a scene depends on |

### Validate: `validate`

Validate before attaching or running. Catches syntax errors and missing resource references before they cause headless crashes or runtime failures.

| Input | Description |
|-------|-------------|
| `scriptPath` | Validate an existing `.gd` file in the project |
| `source` | Validate inline GDScript written to a temp file |
| `scenePath` | Validate a `.tscn` file and check that all `ext_resource` references resolve |
| `targets` | Array of the above — validate multiple scripts or scenes in a single Godot process |

Returns `{ valid, errors: [{ line?, message }] }` per target. Fix reported errors and re-validate before calling `attach_script` or `run_script`.

### UIDs: `manage_uids` (Godot 4.4+)

| Operation | Description |
|-----------|-------------|
| `get` | Get a resource's UID |
| `update` | Resave all resources to update UID references |

## Architecture

```
src/
├── index.ts                # MCP server entry point, routes tool calls
├── tools/
│   ├── project-tools.ts    # Project and runtime tool handlers
│   ├── scene-tools.ts      # Scene operations
│   ├── node-tools.ts       # Node operations
│   └── validate-tools.ts   # GDScript and scene validation
├── scripts/
│   ├── godot_operations.gd # Headless GDScript operations
│   └── mcp_bridge.gd       # UDP autoload for runtime communication
└── utils/
    └── godot-runner.ts     # Process spawning, output parsing
```

Headless operations spawn Godot with `--headless --script godot_operations.gd`, perform the operation, and return JSON. Runtime operations communicate over UDP with the injected `McpBridge` autoload.

## How the Bridge Works

When `run_project` is called:

1. `mcp_bridge.gd` is copied into the project directory
2. It's registered as an autoload in `project.godot`
3. The project launches with the bridge listening on `127.0.0.1:9900`
4. Runtime tools send JSON commands to the bridge and await responses
5. When `stop_project` is called, the autoload entry and bridge script are removed

Files generated during runtime (screenshots, executed scripts) are stored in `.mcp/` inside the project directory. This directory is automatically added to `.gitignore` and has a `.gdignore` so Godot won't import it.

## Broken Autoloads

If any registered autoload fails to initialize (syntax error, missing resource, display dependency), Godot's headless process will crash before any operation runs. Use `manage_project` to inspect and remove the failing autoload. It edits `project.godot` directly, with no Godot process involved.

## Acknowledgments

Built on the foundation laid by [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) for headless Godot operations.

Developed with [Claude Code](https://claude.ai/code).

## License

[MIT](LICENSE)
