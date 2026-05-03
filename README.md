# Godot MCP Runtime

<a href="https://glama.ai/mcp/servers/@Erodenn/godot-mcp-runtime">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@Erodenn/godot-runtime-mcp/badge" alt="godot-runtime-mcp MCP server" />
</a>

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![npm version](https://img.shields.io/npm/v/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![npm downloads](https://img.shields.io/npm/dt/godot-mcp-runtime)](https://www.npmjs.com/package/godot-mcp-runtime)
[![License: MIT](https://badgen.net/github/license/Erodenn/godot-mcp-runtime)](LICENSE)
[![Node.js](https://img.shields.io/node/v/godot-mcp-runtime)](https://nodejs.org/)

A lightweight [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to a running [Godot](https://godotengine.org/) 4.x game. Not just file editing, not just scene manipulation. Actual runtime control: input simulation, screenshots, UI discovery, and live GDScript execution while the game is running.

**The distinction matters: the AI doesn't just write your game, it can check its work.**

When you run a project through this server, it injects a lightweight UDP bridge as an autoload, and suddenly the AI can interact with your game the same way a player would: press keys, click buttons, read what's on screen, and run arbitrary code against the live scene tree.

**No addon required.** Most Godot MCP servers that offer runtime support ship as a Godot addon — something you install into your project, commit to version control, and manage as a dependency. All this server needs is Node.js and a Godot executable: no addon installation, no project modifications, no cleanup.

Think of it as [Playwright MCP](https://github.com/microsoft/playwright-mcp), but for Godot. This does the same thing for games: run the project, take a screenshot, simulate input, read what's on screen, execute a script against the live scene tree. The agent closes the loop on its own changes rather than handing off to you to verify.

This is not a playtesting replacement. It doesn't catch the subtle feel issues that only a human notices, and it won't tell you if your game is fun. What it does is let an agent confirm that a scene loads, a button responds, a value updated, a script ran without errors. The ability to check work is crucial for AI driven workflows.

Each tool teaches agents how to use it through its description and response messages: what to call next, when to wait, and how to recover from errors. Every operation is its own tool with only its relevant parameters, no operation discriminators and no conditional schemas. This server is built for agents.

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

See [`docs/tools.md`](docs/tools.md) for the full tool reference, grouped by category. Authoring standards for adding or modifying tools live in [`docs/tool-authoring.md`](docs/tool-authoring.md).

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

## Acknowledgments

Built on the foundation laid by [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) for headless Godot operations.

Developed with [Claude Code](https://claude.ai/code).

## License

[MIT](LICENSE)
