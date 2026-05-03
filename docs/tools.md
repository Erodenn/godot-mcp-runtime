# Tools

The full MCP tool reference for `godot-mcp-runtime`. This file always reflects `main`; for older releases, browse the corresponding git tag.

## Project Management

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

## Runtime (requires `run_project` or `attach_project` first)

After `run_project`, or after `attach_project` plus launching Godot manually, wait 2-3 seconds for the bridge to initialize before using these tools.

| Tool              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `take_screenshot` | Capture a PNG of the running viewport                            |
| `simulate_input`  | Send batched input: key, mouse, click_element, action, wait      |
| `get_ui_elements` | Get all visible Control nodes with positions, types, and text    |
| `run_script`      | Execute arbitrary GDScript at runtime with full SceneTree access |

## Scene Editing (headless)

All mutation operations save automatically. Use `save_scene` only for save-as (`newPath`) or to re-canonicalize a `.tscn` file.

| Tool                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `create_scene`           | Create a new scene file                                              |
| `add_node`               | Add a node to an existing scene (supports promoted spatial params)   |
| `load_sprite`            | Set a texture on a Sprite2D, Sprite3D, or TextureRect                |
| `save_scene`             | Re-pack and save the scene, or save-as with `newPath`                |
| `export_mesh_library`    | Export scenes as a MeshLibrary for GridMap                           |
| `batch_scene_operations` | Run multiple add_node/load_sprite/save ops in a single Godot process |

## Node Editing (headless)

All mutation operations save automatically. Property and delete tools take always-array input — pass a single-element array for one-off operations, or many for batched work in one Godot process.

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

## Project Config (no Godot process required)

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

## Validation: `validate`

Validate before attaching or running. Catches syntax errors and missing resource references before they cause headless crashes or runtime failures. Supports `scriptPath`, `source` (inline GDScript), `scenePath`, or a `targets` array for batch validation.
