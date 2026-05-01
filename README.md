# Godot MCP Runtime

[![npm version](https://img.shields.io/npm/v/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![npm downloads](https://img.shields.io/npm/dt/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![License: MIT](https://badgen.net/github/license/Erodenn/godot-mcp-runtime)](LICENSE)
[![Node.js](https://img.shields.io/node/v/godot-mcp-runtime)](https://nodejs.org/)

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to a running Godot 4.x game. Not just file editing, not just scene manipulation. Actual runtime control: input simulation, screenshots, UI discovery, and live GDScript execution while the game is running.

When you run a project through this server, it injects a lightweight UDP bridge as an autoload, and suddenly the AI can interact with your game the same way a player would: press keys, click buttons, read what's on screen, and run arbitrary code against the live scene tree.

**The distinction matters: the AI doesn't just write your game, it can check its work.**

**No addon required.** Most Godot MCP servers that offer runtime support ship as a Godot addon — something you install into your project, commit to version control, and manage as a dependency. This server does none of that. The bridge script is injected on `run_project` or `attach_project`, then removed on `stop_project` or `detach_project`. Your project files are left exactly as they were. All you need is Node.js and a Godot executable, no addon installation, no project modifications, no cleanup.

Think of it as [Playwright MCP](https://github.com/microsoft/playwright-mcp), but for Godot. Playwright lets agents verify that a web app actually works by driving a real browser. This does the same thing for games: run the project, take a screenshot, simulate input, read what's on screen, execute a script against the live scene tree. The agent closes the loop on its own changes rather than handing off to you to verify.

This is not a playtesting replacement. It doesn't catch the subtle feel issues that only a human notices, and it won't tell you if your game is fun. What it does is let an agent confirm that a scene loads, a button responds, a value updated, a script ran without errors. That's a fundamentally different development workflow, and it's what this server is built for.

Every operation is its own tool with only its relevant parameters, no operation discriminators, no conditional schemas. Each tool teaches agents how to use it through its description and response messages: what to call next, when to wait, and how to recover from errors.

<a href="https://glama.ai/mcp/servers/@Erodenn/godot-runtime-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@Erodenn/godot-runtime-mcp/badge" alt="godot-runtime-mcp MCP server" />
</a>

## What It Does

**Headless editing.** Create scenes, add nodes, set properties, attach scripts, connect signals, manage UIDs, validate GDScript. All the standard operations, no editor window required.

**Runtime bridge.** When `run_project` or `attach_project` is called, the server injects `McpBridge` as an autoload. This opens a UDP channel on port 9900 (localhost only) and enables:

- **Screenshots:** Capture the viewport at any point during gameplay
- **Input simulation:** Batched sequences of key presses, mouse clicks, mouse motion, UI element clicks by name or path, Godot action events, and timed waits
- **UI discovery:** Walk the live scene tree and collect every visible Control node with its position, type, text content, and disabled state
- **Live script execution:** Compile and run arbitrary GDScript with full SceneTree access while the game is running

**Background mode.** Pass `background: true` to `run_project` and the Godot window moves off-screen with physical input blocked: borderless, unfocusable, mouse-passthrough. Programmatic input, screenshots, and all runtime tools work exactly the same. Useful for automated agent-driven testing where the window shouldn't be visible or interactive.

**Manual attach mode.** When something other than MCP launches the game (a CI pipeline, an external debugger, your own shell), call `attach_project` first. It injects the bridge and marks the project active without spawning Godot, so when you launch the game manually, runtime tools work against it. The tradeoff: `get_debug_output` is unavailable in attached mode because stdout and stderr only flow through processes MCP started itself. Use `detach_project` when done.

The bridge cleans itself up automatically when `stop_project` or `detach_project` is called. No leftover autoloads, no modified project files.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Godot 4.x](https://godotengine.org/)

That's it. No Godot addon, no project modifications.

### Configure Your MCP Client

Add the following to your MCP client config. Works with Claude Code, Claude Desktop, Cursor, or any MCP-compatible client.

**Zero-install via npx (recommended):**

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "godot-mcp-runtime"],
      "env": {
        "GODOT_PATH": "<path-to-godot-executable>"
      }
    }
  }
}
```

**Or install globally:**

```bash
npm install -g godot-mcp-runtime
```

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

**Or clone from source:**

```bash
git clone https://github.com/Erodenn/godot-mcp-runtime.git
cd godot-mcp-runtime
npm install
npm run build
```

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

### Project Management

| Tool               | Description                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- |
| `launch_editor`    | Open the Godot editor GUI for a project                                                |
| `run_project`      | Run a project and inject the MCP bridge. Pass `background: true` to hide the window    |
| `attach_project`   | Inject the MCP bridge for a project you'll launch yourself                             |
| `detach_project`   | Remove the injected bridge after manual-launch use, leaving the external process alone |
| `stop_project`     | Stop the running project and remove the bridge (also detaches attached-mode state)     |
| `get_debug_output` | Read stdout/stderr from an MCP-spawned project (unavailable in attached mode)          |
| `list_projects`    | Find Godot projects in a directory                                                     |
| `get_project_info` | Get project metadata and Godot version                                                 |

### Runtime (requires `run_project` or `attach_project` first)

After `run_project`, or after `attach_project` plus launching Godot manually, wait 2-3 seconds for the bridge to initialize before using these tools.

| Tool              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `take_screenshot` | Capture a PNG of the running viewport                            |
| `simulate_input`  | Send batched input: key, mouse, click_element, action, wait      |
| `get_ui_elements` | Get all visible Control nodes with positions, types, and text    |
| `run_script`      | Execute arbitrary GDScript at runtime with full SceneTree access |

### Scene Editing (headless)

All mutation operations save automatically. Use `save_scene` only for save-as (`newPath`) or to re-canonicalize a `.tscn` file.

| Tool                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `create_scene`           | Create a new scene file                                              |
| `add_node`               | Add a node to an existing scene (supports promoted spatial params)   |
| `load_sprite`            | Set a texture on a Sprite2D, Sprite3D, or TextureRect                |
| `save_scene`             | Re-pack and save the scene, or save-as with `newPath`                |
| `export_mesh_library`    | Export scenes as a MeshLibrary for GridMap                           |
| `batch_scene_operations` | Run multiple add_node/load_sprite/save ops in a single Godot process |

### Node Editing (headless)

All mutation operations save automatically.

| Tool                        | Description                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `get_scene_tree`            | Get the full scene tree hierarchy (use `maxDepth: 1` for shallow listing) |
| `get_node_properties`       | Read properties from a node                                               |
| `batch_get_node_properties` | Read properties from multiple nodes in one process                        |
| `set_node_property`         | Set a property on a node                                                  |
| `batch_set_node_properties` | Set multiple properties in one process                                    |
| `attach_script`             | Attach a GDScript to a node                                               |
| `duplicate_node`            | Duplicate a node within the scene                                         |
| `delete_node`               | Remove a node from the scene                                              |
| `get_node_signals`          | List all signals on a node with their connections                         |
| `connect_signal`            | Connect a signal to a method on another node                              |
| `disconnect_signal`         | Disconnect a signal connection                                            |

### Project Config (no Godot process required)

These tools edit `project.godot` directly or read the filesystem. Safe to use even when autoloads are broken.

| Tool                     | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `list_autoloads`         | List all registered autoloads with paths and singleton status |
| `add_autoload`           | Register a new autoload                                       |
| `remove_autoload`        | Unregister an autoload by name                                |
| `update_autoload`        | Modify an existing autoload's path or singleton flag          |
| `get_project_settings`   | Read settings from `project.godot` by section and key         |
| `get_project_files`      | Get the project file tree with types and extensions           |
| `search_project`         | Search for a string across project source files               |
| `get_scene_dependencies` | List all resources a scene depends on                         |

### Validation: `validate`

Validate before attaching or running. Catches syntax errors and missing resource references before they cause headless crashes or runtime failures. Supports `scriptPath`, `source` (inline GDScript), `scenePath`, or a `targets` array for batch validation.

### UIDs: `manage_uids` (Godot 4.4+)

| Operation | Description                                   |
| --------- | --------------------------------------------- |
| `get`     | Get a resource's UID                          |
| `update`  | Resave all resources to update UID references |

## Architecture

```
src/
├── index.ts                # MCP server entry point, routes tool calls
├── tools/
│   ├── project-tools.ts    # Project, runtime, autoload, filesystem, search, settings
│   ├── scene-tools.ts      # Scene creation, node addition, sprite loading, batch ops, UIDs
│   ├── node-tools.ts       # Node properties, scripts, tree, duplication, signals
│   └── validate-tools.ts   # GDScript and scene validation
├── scripts/
│   ├── godot_operations.gd # Headless GDScript operations
│   └── mcp_bridge.gd       # UDP autoload for runtime communication
└── utils/
    └── godot-runner.ts     # Process spawning, output parsing, shared validation helpers
```

Headless operations spawn Godot with `--headless --script godot_operations.gd`, perform the operation, and return JSON. Runtime operations communicate over UDP with the injected `McpBridge` autoload.

## How the Bridge Works

When `run_project` or `attach_project` is called:

1. `mcp_bridge.gd` is copied into the project directory
2. It's registered as an autoload in `project.godot`
3. Godot launches with the bridge listening on `127.0.0.1:9900`. With `run_project`, MCP spawns the process; with `attach_project`, you launch it yourself.
4. Runtime tools send JSON commands to the bridge and await responses
5. `stop_project` or `detach_project` removes the bridge script and autoload entry

Files generated during runtime (screenshots, executed scripts) are stored in `.mcp/` inside the project directory. This directory is automatically added to `.gitignore` and has a `.gdignore` so Godot won't import it.

## Broken Autoloads

If any registered autoload fails to initialize (syntax error, missing resource, display dependency), Godot's headless process will crash before any operation runs. Use `list_autoloads` and `remove_autoload` to inspect and remove the failing autoload. These tools edit `project.godot` directly, with no Godot process involved.

## Acknowledgments

Built on the foundation laid by [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) for headless Godot operations.

Developed with [Claude Code](https://claude.ai/code).

## License

[MIT](LICENSE)
