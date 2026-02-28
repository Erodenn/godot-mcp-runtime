# Godot Runtime MCP Server

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to a running Godot 4.x game. Not just file editing, not just scene manipulation, but actual runtime control: input simulation, screenshots, UI discovery, and live GDScript execution while the game is running.

Most Godot MCP servers operate headlessly. They can create scenes, add nodes, attach scripts, and that covers a lot of ground. But they stop at the editor boundary. This one doesn't. When you run a project through this server, it injects a lightweight UDP bridge as an autoload, and suddenly the AI can interact with your game the same way a player would. It presses keys, clicks buttons, reads what's on screen, and runs arbitrary code against the live scene tree.

The distinction matters: the AI doesn't just write your game, it can test it.

## What It Does

**Headless editing**: Create scenes, add nodes, set properties, attach scripts, manage UIDs. All the standard operations you'd expect, no editor window required.

**Runtime bridge**: When `run_project` is called, the server injects `McpBridge` as an autoload. This opens a UDP channel on port 9900 and enables:

- **Screenshots**: Capture the viewport at any point during gameplay
- **Input simulation**: Batched sequences of key presses, mouse clicks and movement, UI element clicks by name or path, Godot action presses, and timed waits
- **UI discovery**: Walk the live scene tree and collect every visible Control node with its position, type, text content, and disabled state
- **Live script execution**: Compile and execute arbitrary GDScript with full SceneTree access while the game is running

The bridge cleans itself up automatically when `stop_project` is called. No leftover autoloads, no modified project files.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Godot 4.x](https://godotengine.org/)

### Install

```bash
git clone https://github.com/Erodenn/godot-mcp-runtime.git
cd godot-mcp-runtime
npm install
npm run build
```

### Configure Your MCP Client

Add the following to your MCP client config. This works with Claude Code, Claude Desktop, Cursor, or any MCP-compatible client:

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

If Godot is on your `PATH`, you can omit `GODOT_PATH` entirely. The server will auto-detect it.

Set `"DEBUG": "true"` in `env` for verbose logging.

### Verify

Ask your AI assistant to call `get_project_info`. If it returns a Godot version string (e.g., `4.4.stable`), you're connected and working.

## Tools

### Project

| Tool | Description |
|------|-------------|
| `launch_editor` | Open the Godot editor for a project |
| `run_project` | Run a project and inject the MCP bridge |
| `stop_project` | Stop the running project and clean up the bridge |
| `get_debug_output` | Read stdout/stderr from the running project |
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Get project metadata, or just the Godot version if no project path is given |

### Runtime (requires `run_project` first)

| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture a PNG of the running viewport |
| `simulate_input` | Batched input: key, mouse_button, mouse_motion, click_element, action, wait |
| `get_ui_elements` | Get visible Control nodes with positions, types, and text |
| `run_script` | Execute GDScript at runtime with full SceneTree access |

### Scene: `manage_scene`

| Operation | Description |
|-----------|-------------|
| `create` | Create a new scene file |
| `add_node` | Add a node to an existing scene |
| `load_sprite` | Set a texture on a Sprite2D, Sprite3D, or TextureRect |
| `save` | Save a scene, or save-as with `newPath` |
| `export_mesh_library` | Export scenes as a MeshLibrary for GridMap |

### UIDs: `manage_uids` (Godot 4.4+)

| Operation | Description |
|-----------|-------------|
| `get` | Get a resource's UID |
| `update` | Resave all resources to update UID references |

### Node: `manage_node`

| Operation | Description |
|-----------|-------------|
| `delete` | Remove a node from a scene |
| `update_property` | Set a property on a node |
| `get_properties` | Read node properties |
| `attach_script` | Attach a GDScript to a node |
| `list` | List child nodes |
| `get_tree` | Get the full scene tree hierarchy |

## Architecture

```
src/
├── index.ts                # MCP server entry point, routes tool calls
├── tools/
│   ├── project-tools.ts    # Project and runtime tool handlers
│   ├── scene-tools.ts      # Scene operations
│   └── node-tools.ts       # Node operations
├── scripts/
│   ├── godot_operations.gd # Headless GDScript operations
│   └── mcp_bridge.gd       # UDP autoload for runtime communication
└── utils/
    └── godot-runner.ts     # Process spawning, output parsing
```

Headless operations spawn Godot with `--headless --script godot_operations.gd`, perform the operation, and return JSON.

Runtime operations communicate over UDP with the injected `McpBridge` autoload in the running game.

## How the Bridge Works

When `run_project` is called:

1. `mcp_bridge.gd` is copied into the project directory
2. It's registered as an autoload in `project.godot`
3. The project launches with the bridge listening on UDP port 9900
4. Runtime tools send JSON commands to the bridge and await responses
5. When `stop_project` is called, the autoload entry and bridge script are removed

Files generated during runtime (screenshots, executed scripts) are stored in `.mcp/` inside the project directory. This directory is automatically added to `.gitignore` and has a `.gdignore` so Godot won't import it.

## Acknowledgments

Built on the foundation laid by [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) for headless Godot operations.

Developed with [Claude Code](https://claude.ai/code).

## License

[MIT](LICENSE)
