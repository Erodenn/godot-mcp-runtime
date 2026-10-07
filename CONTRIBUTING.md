# Contributing to Godot MCP Runtime

Thanks for contributing. This guide covers what you need to make a clean PR.

## Setup

```bash
npm install
npm run build
```

Set `GODOT_PATH` to your Godot 4.x executable for runtime tests and manual exercises. Optionally set `GODOT_MONO_PATH` to a Godot .NET build to also run the opt-in C# attach-script test (see `tests/README.md`).

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

| Command                 | What it does                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`         | Compile TypeScript and copy GDScript files into `dist/`                                                                                             |
| `npm run dev`           | Build and launch the MCP server on stdio (needs a connected MCP client; use `npm run build` alone for a compilation check)                          |
| `npm run typecheck`     | `tsc --noEmit` - fast type pass, no output                                                                                                          |
| `npm run lint`          | ESLint over the repo                                                                                                                                |
| `npm run lint:fix`      | ESLint with autofix                                                                                                                                 |
| `npm run format`        | Prettier write                                                                                                                                      |
| `npm run format:check`  | Prettier check, no writes                                                                                                                           |
| `npm test`              | Vitest run (only for isolated test runs - `verify` already runs the suite)                                                                          |
| `npm run test:watch`    | Vitest watch mode                                                                                                                                   |
| `npm run test:coverage` | Vitest with v8 coverage                                                                                                                             |
| `npm run verify`        | **Single entrypoint.** Runs typecheck → lint → format → test → build, stops on first failure. Set `GODOT_PATH` to also run Godot integration tests. |

CI runs typecheck → lint → test → build on Node 20, 22, 24 for every push and PR to `main`. Formatting never fails CI: every push and PR gets a warning annotation per unformatted file.

Run `npm run install-hooks` once per clone. The pre-commit hook formats staged files with Prettier (via lint-staged, so partially staged files keep their unstaged hunks) and fails a commit whose `package-lock.json` is missing the Linux-only entries `npm install` prunes on Windows (use `npm run safe-install` there).

## Branch and commit conventions

- `main` is the published branch; all work goes through PRs
- Conventional-commits prefixes are encouraged but not enforced: `chore:`, `fix:`, `feat:`, `docs:`, `style:`, `ci:`, `refactor:`, `test:`
- Keep commits scoped: formatting sweeps and behavior changes are separate commits

## Testing

See `tests/README.md` for the test layout, the rubric on when/what/how to test, and the coverage map. `npm run verify` is the single entrypoint - it runs the suite plus typecheck, lint, format, and build in the same order CI does, applying formatting rather than checking it. Set `GODOT_PATH` (e.g. `GODOT_PATH=/path/to/godot npm run verify`) to also run the Godot integration tests; without it those tests skip cleanly.

The integration suite hides game windows by default. Set `GODOT_MCP_TEST_SHOW_WINDOWS=1` to watch them.

On Windows the suite compiles a small helper from `tests/helpers/private-desktop-launcher.cs` on first run (cached under `node_modules/.cache`) and starts every Godot process on a private desktop, so test runs do not take keyboard focus. `GODOT_MCP_TEST_SHOW_WINDOWS=1` turns this off. When the compiler is unavailable the suite falls back to hidden windows, which can still take focus. Anything a game pops up (a dialog, a crash box) appears on the private desktop where it cannot be seen, so a test that hangs under the launcher should be re-run with the opt-out. Details are in `tests/README.md`.

## Architectural invariants

These rules are not all encodable in the linter, but they hold across the codebase. Changes that violate them should be flagged in review.

### MCP stdio transport - `console.log` is forbidden

stdout is reserved for the MCP protocol. Any `console.log` in this server corrupts the JSON-RPC stream that the client reads. Use:

- `console.error` for operational messages
- `console.warn` sparingly
- `logError(message)` and `logDebug(message)` from `src/utils/logger.ts` when you want the `[SERVER]` / `[DEBUG]` prefix and `DEBUG=true` gating

ESLint enforces this via `no-console` with `["error", "warn"]` allowed.

### Mutation operations auto-save

Every operation that mutates a scene (`add_node`, `load_sprite`, `set_node_properties`, `delete_nodes`, `attach_script`, etc.) saves the scene before returning. The `save_scene` operation exists only for save-as (`newPath`) or re-canonicalization. This applies to batch operations too - after the loop, `batch_scene_operations` saves each scene an operation succeeded on and no `save` item has written since. A scene nothing changed is not rewritten.

Never document or implement batch as "accumulate and require explicit save."

### Path traversal protection

All handlers validate paths through `parseProjectArgs` / `parseSceneArgs` / `parseNodePath` from `src/utils/arg-parsing.ts`, each returning `Result<T, ToolResponse>`. `parseProjectArgs` rejects a `..` segment in the project directory and verifies `project.godot` exists. `parseSceneArgs` additionally resolves `scenePath` through `resolveProjectPath` and returns the resolved path alongside the project-relative one, and always requires `scenePath` to be present (pass `{ requireExists: false }` to opt out of the on-disk existence check, e.g. for `create_scene`). For scene-tree node paths (e.g. `root/Player`), use `parseNodePath` / `parseRequiredNodePath` / `parseOptionalNodePath` - they allow the relative-path style that `resolveProjectPath` rejects. Any other project sub-path a tool accepts goes through `resolveProjectPath` (`src/utils/path-validation.ts`), which takes a required `'read'` or `'write'` intent (a call site that cannot say which is a write) and returns `relPath` for GDScript, `absPath` for fs calls and `resPath` for `project.godot` and the Godot command line. Inside a project, containment is decided by resolving the path, not by its shape: a `..` that stays inside is accepted, and a path that resolves outside, has a name ending in a dot or a space or a Windows device name (`NUL`, `con.txt`), or carries a colon past the drive prefix is refused. A `'write'` path whose real location leaves the project through a symlink or junction is refused too, while a `'read'` path follows the link, so a project can link in shared assets. Every path field of a `batch_scene_operations` item goes through it. Refusals use the shared wording `projectSubPathError` and `PROJECT_SUB_PATH_SOLUTIONS`. Don't construct paths ad hoc with `path.join` - route through these parsers so the rules stay centralized.

### Error responses use `Result<HandlerResult, ToolResponse>`

Tool handlers return `Result<HandlerResult, ToolResponse>`, not a raw `ToolResponse` and not a thrown error. The failure path is `return err(createErrorResponse(message, possibleSolutions[]))`; `createErrorResponse` builds the structured `{ content, isError: true }` shape the MCP client expects, with the `possibleSolutions` block appended. `src/dispatch.ts` unwraps the `Result` at the edge (`isOk(result) ? result.value : result.error`), so only the handler/parser layer needs to know about the `Result` wrapper.

### TypeScript camelCase, GDScript snake_case

Tool input schemas declare camelCase params. `normalizeParameters` converts incoming snake_case to camelCase (for tolerance with clients that send the wire-protocol style); `convertCamelToSnakeCase` converts back when calling GDScript, which expects snake_case. Add new mappings to the `parameterMappings` table in `src/utils/parameter-conversion.ts`. Keys under `properties` and `value` are opaque and are never converted, in either direction.

### `run_script` and `run_project` security gate

`run_script` accepts arbitrary GDScript and forwards it to a running Godot process, where it executes with full user privileges. `run_project` launches autoloads and the main scene, which is equally arbitrary code. Both route through a static-analysis gate in `src/utils/run-script-policy.ts` before reaching the bridge.

The gate emits a three-tier decision:

- **Tier 1: hard block.** Direct exec (`OS.execute`/`shell_open`/`create_instance`), native libraries (`GDExtensionManager.load_extension`), reflection bypasses (`ClassDB.instantiate`, `Object.set_script`), dynamic code (`Expression`, `GDScript.new`, `str_to_var`), non-literal indirection (`load(var)`, `Object.call(var)`). A reflective call with a literal method name is judged as the call it makes, after its escapes are decoded and any dispatch it names is followed, so `OS.call("execute", ...)` and `OS.call("call", "\u0065xecute")` are blocked like `OS.execute(...)`. Server rejects without forwarding.
- **Tier 2: elicit.** Filesystem and resource writes (`FileAccess.open`, `DirAccess.remove` and the `make_dir` family, `ResourceSaver.save`, `ConfigFile`, `Image.save_png` and siblings, `take_over_path`, `ZIPPacker`/`PCKPacker`, the `ResourceUID` mutators, `OS.move_to_trash`), a guarded singleton used as a value (`var o = OS`), `source_code`, `instance_from_id`, `JavaScriptBridge.eval`, and network primitives (`HTTPRequest`, `TCPServer`, `IP.resolve_hostname`). Server pauses for user confirmation via MCP elicitation. Declines and elicitation-unsupported clients both map to denial.
- **Tier 3: warn.** Literal `load("res://…")`, `OS.alert`, and common idioms. Executes; findings surface in the response `warnings` array.

`GODOT_MCP_STRICT=true` promotes every Tier 2 finding to Tier 1, and makes `run_project` hard-reject on any Tier 1 finding in autoloads or the launched scene. This is the unattended-operation switch - MCP client bypass-permissions modes auto-answer elicitation, so strict mode is the only real boundary when no human is in the loop.

`GODOT_MCP_DISABLE_ELICITATION=true` is the opposite escape hatch, for clients that cannot display elicitation prompts (e.g. Claude Desktop, which auto-cancels them). It skips the confirmation prompts and proceeds fail-open: the launch gate shared by `run_project` and `render_movie` is bypassed and Tier 2 `run_script` findings run with a warning (audited as `elicit_bypassed`). Tier 1 hard blocks are unaffected. When both flags are set, strict mode wins and `GODOT_MCP_DISABLE_ELICITATION` is ignored.

`GODOT_MCP_DISABLE_SECURITY=true` turns the whole gate off: no scan, no tier decision, no elicitation, no warnings, no sidecar, for both handlers. Tier 1 is included, unlike the elicitation opt-out. It outranks both flags above, which is the reverse of the strict/disable-elicitation precedence - a flag whose purpose is turning the gate off would be useless if a stricter flag outranked it. Enabling it is an operator's decision, not an agent's.

Every `run_script` call writes a `.policy.json` sidecar next to the audit-trail `.gd` file in `.mcp/godot-runtime/scripts/`, unless the gate is disabled. See `docs/security.md` for the full rule catalogue and the three-flag resolution order.

When adding a new tool that forwards GDScript to the bridge, route it through the same policy evaluator - don't inline rejection logic.

### MCP SDK: `Server` vs `McpServer`

`src/index.ts` imports the lower-level `Server` class from `@modelcontextprotocol/sdk`, which is marked `@deprecated`. This is deliberate. The high-level `McpServer` API expects Zod shapes for tool input schemas, but our 39 tools share a centralized JSON Schema `ToolDefinition` type and a custom dispatch table (`src/dispatch.ts`). The deprecation note explicitly carves out "advanced use cases" - that's us.

The TS6385 strikethrough on the three `Server` references in `src/index.ts` is a suggestion-level diagnostic that `@ts-ignore` and `@ts-expect-error` don't suppress (those only target error-level diagnostics). It does not fail typecheck or build - leave it visible so any future genuine deprecation is not masked. Migration to `McpServer` is not scheduled.

## Adding a new tool

1. Add a tool definition object to the `*ToolDefinitions` array in the appropriate `src/tools/*.ts` file. Each tool has its own `name`, `description`, and `inputSchema` containing only its relevant params.
2. Create the handler function:
   - Normalize params with `normalizeParameters`
   - Validate with the `parse*` helpers from `src/utils/arg-parsing.ts` (`parseProjectArgs`, `parseSceneArgs`, `parseNodePath` and friends), which return branded `ProjectPath`/`ScenePath`/`NodePath` types (`src/utils/branded.ts`)
   - Call the runner
   - Return `ok(...)` on success or `err(createErrorResponse(...))` on failure (`src/utils/result.ts`)
3. Export the handler and add an entry mapping the tool name to the handler in the `toolDispatch` table in `src/dispatch.ts`.
4. If the tool needs GDScript: add the corresponding function in `src/scripts/godot_operations.gd` (snake_case params) and register the operation name in the `match` statement in `_run_from_cmdline()`.
5. Add a unit test for any pure helper logic; add an integration test if the tool touches scene files.

## Modifying an existing tool

Tool descriptions ship on every handshake - they are the entire UI an agent sees. If you change a tool's behavior, params, or return shape, update the `description`, per-property `description`s, `outputSchema`, and `docs/tools.md` in the same PR. Re-read `docs/tool-authoring.md` for the rules; `npm run verify` runs the description/schema tests.

## Release process

1. Bump version in `package.json`, `src/index.ts` and `server.json` (both its top-level `version` and `packages[].version`)
2. Re-record `docs/assets/demo.gif` if any tool behavior changed since the last release
3. Write `.github/release-notes/vX.Y.Z.md` when the release has something a human should read (new tools, changed behavior, a migration). The publish job prepends it above the generated notes.
4. Commit and push to `main`
5. Push a `vX.Y.Z` tag: `.github/workflows/publish.yml` runs `npm publish --provenance --access public` and auto-creates the GitHub release with generated notes.

Docker CI runs automatically on push and PR to `main`.

## Known limitations

### Headless mode loads all autoloads

When Godot runs headlessly, it loads every registered autoload. The operation is dispatched before any autoload's `_ready`, so an autoload that only errors or quits in `_ready` does not affect it. One that stops the engine before dispatch (a `quit()` in `_init`, for example) fails every headless operation. The runner detects this and surfaces a descriptive error pointing at `list_autoloads` / `remove_autoload`. Use the dedicated autoload tools - they edit `project.godot` directly and need no Godot process.

### `breakpoint` is a no-op

`run_project` spawns Godot without `-d` so runtime errors don't pause the engine and stall the McpBridge. The trade-off is that the `breakpoint` keyword in user code does nothing - there's no debugger attached. Use `print()` and `get_debug_output` instead.

## Questions

Open an issue or start a discussion on GitHub.
