# Contributing to Godot MCP Runtime

Thanks for contributing. This guide covers what you need to make a clean PR.

## Setup

```bash
npm install
npm run build
```

Set `GODOT_PATH` to your Godot 4.x executable for runtime tests and manual exercises.

### Local MCP client wiring

To exercise your changes against a real MCP client (Claude Code, Cursor, Claude Desktop), drop a project-scoped `.mcp.json` at the repo root pointing at the local build. `.mcp.json` is already gitignored.

```json
{
  "mcpServers": {
    "godot-dev": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "GODOT_PATH": "<path-to-godot-executable>",
        "DEBUG": "true"
      }
    }
  }
}
```

Dev loop: edit → `npm run build` → restart the MCP client (or reconnect the server) to pick up the new `dist/`. The server is stdio-only, so the client owns the process lifecycle.

## Commands

| Command                 | What it does                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`         | Compile TypeScript and copy GDScript files into `dist/`                                                                                                   |
| `npm run dev`           | Build and launch the MCP server on stdio (needs a connected MCP client; use `npm run build` alone for a compilation check)                                |
| `npm run typecheck`     | `tsc --noEmit` — fast type pass, no output                                                                                                                |
| `npm run lint`          | ESLint over the repo                                                                                                                                      |
| `npm run lint:fix`      | ESLint with autofix                                                                                                                                       |
| `npm run format`        | Prettier write                                                                                                                                            |
| `npm run format:check`  | Prettier check (CI uses this)                                                                                                                             |
| `npm test`              | Vitest run (only for isolated test runs — `verify` already runs the suite)                                                                                |
| `npm run test:watch`    | Vitest watch mode                                                                                                                                         |
| `npm run test:coverage` | Vitest with v8 coverage                                                                                                                                   |
| `npm run verify`        | **Single entrypoint.** Runs typecheck → lint → format:check → test → build, stops on first failure. Set `GODOT_PATH` to also run Godot integration tests. |

CI runs typecheck → lint → format:check → test → build on Node 20, 22, 24 for every push and PR to `main`.

## Branch and commit conventions

- `main` is the published branch; all work goes through PRs
- Conventional-commits prefixes are encouraged but not enforced: `chore:`, `fix:`, `feat:`, `docs:`, `style:`, `ci:`, `refactor:`, `test:`
- Keep commits scoped — formatting sweeps and behavior changes are separate commits

## Testing

See `tests/README.md` for the test layout, the rubric on when/what/how to test, and the coverage map. `npm run verify` is the single entrypoint — it runs the suite plus typecheck, lint, format:check, and build in the same order CI does. Set `GODOT_PATH` (e.g. `GODOT_PATH=/path/to/godot npm run verify`) to also run the Godot integration tests; without it those tests skip cleanly.

## Architectural invariants

These rules are not all encodable in the linter, but they hold across the codebase. Changes that violate them should be flagged in review.

### MCP stdio transport — `console.log` is forbidden

stdout is reserved for the MCP protocol. Any `console.log` in this server corrupts the JSON-RPC stream that the client reads. Use:

- `console.error` for operational messages
- `console.warn` sparingly
- `logError(message)` and `logDebug(message)` from `src/utils/logger.ts` when you want the `[SERVER]` / `[DEBUG]` prefix and `DEBUG=true` gating

ESLint enforces this via `no-console` with `["error", "warn"]` allowed.

### Mutation operations auto-save

Every operation that mutates a scene (`add_node`, `load_sprite`, `set_node_properties`, `delete_nodes`, `attach_script`, etc.) saves the scene before returning. The `save_scene` operation exists only for save-as (`newPath`) or re-canonicalization. This applies to batch operations too — `batch_scene_operations` auto-saves any unsaved scenes at the end of the loop.

Never document or implement batch as "accumulate and require explicit save."

### Path traversal protection

All handlers validate paths through `parseProjectArgs` / `parseSceneArgs` / `parseNodePath` from `src/utils/arg-parsing.ts`, each returning `Result<T, ToolResponse>`. `parseProjectArgs` rejects `..` and verifies `project.godot` exists. `parseSceneArgs` additionally rejects absolute paths that escape the project root via `validateSubPath`, and always requires `scenePath` to be present (pass `{ requireExists: false }` to opt out of the on-disk existence check, e.g. for `create_scene`). For scene-tree node paths (e.g. `root/Player`), use `parseNodePath` / `parseRequiredNodePath` / `parseOptionalNodePath` — they allow the relative-path style that `validateSubPath` rejects. Don't construct paths ad hoc with `path.join` — route through these parsers so the rules stay centralized.

### Error responses use `Result<HandlerResult, ToolResponse>`

Tool handlers return `Result<HandlerResult, ToolResponse>`, not a raw `ToolResponse` and not a thrown error. The failure path is `return err(createErrorResponse(message, possibleSolutions[]))`; `createErrorResponse` builds the structured `{ content, isError: true }` shape the MCP client expects, with the `possibleSolutions` block appended. `src/dispatch.ts` unwraps the `Result` at the edge (`isOk(result) ? result.value : result.error`), so only the handler/parser layer needs to know about the `Result` wrapper.

### TypeScript camelCase, GDScript snake_case

Tool input schemas declare camelCase params. `normalizeParameters` converts incoming snake_case to camelCase (for tolerance with clients that send the wire-protocol style); `convertCamelToSnakeCase` converts back when calling GDScript, which expects snake_case. Add new mappings to the `parameterMappings` table in `src/utils/parameter-conversion.ts`.

### `run_script` and `run_project` security gate

`run_script` accepts arbitrary GDScript and forwards it to a running Godot process, where it executes with full user privileges. `run_project` launches autoloads and the main scene, which is equally arbitrary code. Both route through a static-analysis gate in `src/utils/run-script-policy.ts` before reaching the bridge.

The gate emits a three-tier decision:

- **Tier 1 — hard block.** Direct exec (`OS.execute`/`shell_open`), reflection bypasses (`ClassDB.instantiate`, `Object.set_script`), dynamic code (`Expression`, `str_to_var`), non-literal indirection (`load(var)`, `Object.call(var)`). Server rejects without forwarding.
- **Tier 2 — elicit.** Filesystem and resource writes (`FileAccess.open`, `DirAccess.remove` and the `make_dir` family, `ResourceSaver.save`, `ConfigFile`, `Image.save_png` and siblings, `take_over_path`, `ZIPPacker`/`PCKPacker`, the `ResourceUID` mutators, `OS.move_to_trash`) and network primitives (`HTTPRequest`, `TCPServer`, `IP.resolve_hostname`). Server pauses for user confirmation via MCP elicitation. Declines and elicitation-unsupported clients both map to denial.
- **Tier 3 — warn.** Literal `load("res://…")`, `OS.alert`, and common idioms. Executes; findings surface in the response `warnings` array.

`GODOT_MCP_STRICT=true` promotes every Tier 2 finding to Tier 1, and makes `run_project` hard-reject on any Tier 1 finding in autoloads or the launched scene. This is the unattended-operation switch — MCP client bypass-permissions modes auto-answer elicitation, so strict mode is the only real boundary when no human is in the loop.

`GODOT_MCP_DISABLE_ELICITATION=true` is the opposite escape hatch, for clients that cannot display elicitation prompts (e.g. Claude Desktop, which auto-cancels them). It skips the confirmation prompts and proceeds fail-open: `run_project`'s launch gate is bypassed and Tier 2 `run_script` findings run with a warning (audited as `elicit_bypassed`). Tier 1 hard blocks are unaffected. When both flags are set, strict mode wins and `GODOT_MCP_DISABLE_ELICITATION` is ignored.

`GODOT_MCP_DISABLE_SECURITY=true` turns the whole gate off: no scan, no tier decision, no elicitation, no warnings, no sidecar, for both handlers. Tier 1 is included, unlike the elicitation opt-out. It outranks both flags above, which is the reverse of the strict/disable-elicitation precedence — a flag whose purpose is turning the gate off would be useless if a stricter flag outranked it. Enabling it is an operator's decision, not an agent's.

Every `run_script` call writes a `.policy.json` sidecar next to the audit-trail `.gd` file in `.mcp/godot-runtime/scripts/`, unless the gate is disabled. See `docs/security.md` for the full rule catalogue and the three-flag resolution order.

When adding a new tool that forwards GDScript to the bridge, route it through the same policy evaluator — don't inline rejection logic.

### MCP SDK: `Server` vs `McpServer`

`src/index.ts` imports the lower-level `Server` class from `@modelcontextprotocol/sdk`, which is marked `@deprecated`. This is deliberate. The high-level `McpServer` API expects Zod shapes for tool input schemas, but our ~30 tools share a centralized JSON Schema `ToolDefinition` type and a custom dispatch table (`src/dispatch.ts`). The deprecation note explicitly carves out "advanced use cases" — that's us.

The TS6385 strikethrough on the three `Server` references in `src/index.ts` is a suggestion-level diagnostic that `@ts-ignore` and `@ts-expect-error` don't suppress (those only target error-level diagnostics). It does not fail typecheck or build — leave it visible so any future genuine deprecation is not masked. Migration to `McpServer` is planned post-v3.

## Adding a new tool

1. Add a tool definition object to the `*ToolDefinitions` array in the appropriate `src/tools/*.ts` file. Each tool has its own `name`, `description`, and `inputSchema` containing only its relevant params.
2. Create the handler function:
   - Normalize params with `normalizeParameters`
   - Validate with the `parse*` helpers from `src/utils/arg-parsing.ts` (`parseProjectArgs`, `parseSceneArgs`, `parseNodePath` and friends), which return branded `ProjectPath`/`ScenePath`/`NodePath` types (`src/utils/branded.ts`)
   - Call the runner
   - Return `ok(...)` on success or `err(createErrorResponse(...))` on failure (`src/utils/result.ts`)
3. Export the handler and add an entry mapping the tool name to the handler in the `toolDispatch` table in `src/dispatch.ts`.
4. If the tool needs GDScript: add the corresponding function in `src/scripts/godot_operations.gd` (snake_case params) and register the operation name in the `match` statement in `_init()`.
5. Add a unit test for any pure helper logic; add an integration test if the tool touches scene files.

## Modifying an existing tool

Tool descriptions ship on every handshake — they are the entire UI an agent sees. If you change a tool's behavior, params, or return shape, update the `description`, per-property `description`s, `outputSchema`, and `docs/tools.md` in the same PR. Re-read `docs/tool-authoring.md` for the rules; `npm run verify` runs the description/schema tests.

## Release process

1. Bump version in `package.json` and `src/index.ts`
2. Re-record `docs/assets/demo.gif` if any tool behavior changed since the last release
3. Commit and push to `main`
4. Push a `vX.Y.Z` tag — `.github/workflows/publish.yml` runs `npm publish --provenance --access public` and auto-creates the GitHub release with generated notes.

Docker CI runs automatically on push and PR to `main`.

## Known limitations

### Headless mode initializes all autoloads

When Godot runs headlessly, it initializes every registered autoload. A broken autoload (syntax error, missing resource, display-dependent code) crashes the headless process before the operation runs. The runner detects this and surfaces a descriptive error pointing at `list_autoloads` / `remove_autoload`. Use the dedicated autoload tools — they edit `project.godot` directly and need no Godot process.

### `breakpoint` is a no-op

`run_project` spawns Godot without `-d` so runtime errors don't pause the engine and stall the McpBridge. The trade-off is that the `breakpoint` keyword in user code does nothing — there's no debugger attached. Use `print()` and `get_debug_output` instead.

## Questions

Open an issue or start a discussion on GitHub.
