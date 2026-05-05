# Contributing to godot-mcp-runtime

Thanks for contributing. This guide covers what you need to make a clean PR.

## Setup

```bash
npm install
npm run build
```

Set `GODOT_PATH` to your Godot 4.x executable for runtime tests and manual exercises.

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

All handlers validate paths through `validateProjectArgs` / `validateSceneArgs` from `src/utils/godot-runner.ts`. These reject paths containing `..` and verify that `project.godot` / the scene file exist. Don't construct paths ad hoc with `path.join` — route through the validators so the rules stay centralized.

### Error responses use `createErrorResponse`

Tool handlers return `createErrorResponse(message, possibleSolutions[])`, not raw thrown errors. The MCP client expects the structured `{ content, isError: true }` shape and benefits from the `possibleSolutions` block.

### TypeScript camelCase, GDScript snake_case

Tool input schemas declare camelCase params. `normalizeParameters` converts incoming snake_case to camelCase (for tolerance with clients that send the wire-protocol style); `convertCamelToSnakeCase` converts back when calling GDScript, which expects snake_case. Add new mappings to the `parameterMappings` table in `src/utils/godot-runner.ts`.

### MCP SDK: `Server` vs `McpServer`

`src/index.ts` imports the lower-level `Server` class from `@modelcontextprotocol/sdk`, which is marked `@deprecated`. This is deliberate. The high-level `McpServer` API expects Zod shapes for tool input schemas, but our ~30 tools share a centralized JSON Schema `ToolDefinition` type and a custom dispatch table (`src/dispatch.ts`). The deprecation note explicitly carves out "advanced use cases" — that's us.

The TS6385 strikethrough on the three `Server` references in `src/index.ts` is a suggestion-level diagnostic that `@ts-ignore` and `@ts-expect-error` don't suppress (those only target error-level diagnostics). It does not fail typecheck or build — leave it visible so any future genuine deprecation is not masked. Migration to `McpServer` is planned post-v3.

## Adding a new tool

1. Add a tool definition object to the `*ToolDefinitions` array in the appropriate `src/tools/*.ts` file. Each tool has its own `name`, `description`, and `inputSchema` containing only its relevant params.
2. Create the handler function:
   - Normalize params with `normalizeParameters`
   - Validate with `validateProjectArgs` or `validateSceneArgs`
   - Call the runner
   - Return the response (or `createErrorResponse` on failure)
3. Export the handler and add an entry mapping the tool name to the handler in the `toolDispatch` table in `src/dispatch.ts`.
4. If the tool needs GDScript: add the corresponding function in `src/scripts/godot_operations.gd` (snake_case params) and register the operation name in the `match` statement in `_init()`.
5. Add a unit test for any pure helper logic; add an integration test if the tool touches scene files.

## Release process

1. Bump version in `package.json` and `src/index.ts`
2. Commit and push to `main`
3. Push a `vX.Y.Z` tag — `.github/workflows/publish.yml` runs `npm publish --provenance --access public` and auto-creates the GitHub release with generated notes.

Docker CI runs automatically on push to `main`.

## Known limitations

### Headless mode initializes all autoloads

When Godot runs headlessly, it initializes every registered autoload. A broken autoload (syntax error, missing resource, display-dependent code) crashes the headless process before the operation runs. The runner detects this and surfaces a descriptive error pointing at `list_autoloads` / `remove_autoload`. Use the dedicated autoload tools — they edit `project.godot` directly and need no Godot process.

### `breakpoint` is a no-op

`run_project` spawns Godot without `-d` so runtime errors don't pause the engine and stall the McpBridge. The trade-off is that the `breakpoint` keyword in user code does nothing — there's no debugger attached. Use `print()` and `get_debug_output` instead.

## Questions

Open an issue or start a discussion on GitHub.
