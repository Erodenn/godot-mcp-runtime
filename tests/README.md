# Tests

Index of what is tested where, plus the rubric for when/what/how to test. Update this file when adding a new test file or fixture.

## Layout

```
tests/
├── unit/             Pure-function and shape-contract tests. No Godot, no I/O.
├── integration/      Tests that touch fixtures or run real Godot.
│                     Godot-required tests skip when GODOT_PATH is unset.
├── fixtures/         Committed test inputs.
│   ├── godot-project/  Minimal Godot 4 project (Node2D + Label + Sprite2D),
│   │                   plus the input_probe.tscn probe scene and a probe_move action
│   └── godot-profiling-project/  Same, with a hot _process loop for the profiler tests
└── README.md         This file.
```

## Coverage map

| File                                                | Covers                                                                                                                                                                               | Notes                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `unit/godot-runner.test.ts`                         | `normalizeParameters`, `convertCamelToSnakeCase`, `validatePath`, `extractGdError`, `createErrorResponse`, `extractJson`                                                             | First batch from dev-bootstrap                                              |
| `unit/godot-runner-extended.test.ts`                | `cleanOutput`, `normalizeForCompare`, `parseProjectArgs`, `parseSceneArgs`                                                                                                           |                                                                             |
| `unit/tool-definitions.test.ts`                     | Shape contract for every tool definition; no duplicate names                                                                                                                         |                                                                             |
| `unit/handlers/scene-handlers.test.ts`              | Argument validation in `src/tools/scene-tools.ts` handlers                                                                                                                           | Uses `tests/helpers/fake-runner.ts`                                         |
| `unit/handlers/node-handlers.test.ts`               | Argument validation in `src/tools/node-tools.ts` handlers                                                                                                                            | Uses `tests/helpers/fake-runner.ts`                                         |
| `unit/handlers/project-handlers.test.ts`            | Argument validation for project introspection handlers (files, search, scene deps, settings, list_projects, check_project)                                                           | Tmp dirs via `useTmpDirs()` from `tests/helpers/tmp.ts`                     |
| `unit/handlers/check-project.test.ts`               | `handleCheckProject`'s always-present `runtime` block: no session, active+responsive, exited process, ping failure                                                                   | Uses `tests/helpers/runtime-fakes.ts`                                       |
| `unit/handlers/autoload-handlers.test.ts`           | Argument validation for `list/add/remove/update_autoload` handlers                                                                                                                   | Tmp dirs via `useTmpDirs()` from `tests/helpers/tmp.ts`                     |
| `unit/handlers/validate-handler.test.ts`            | `handleValidate` argument validation incl. single vs `targets[]` mode                                                                                                                |                                                                             |
| `unit/bridge-manager.test.ts`                       | `BridgeManager` inject/cleanup/repair lifecycle against tmp project fixtures                                                                                                         | Tmp dirs via `useTmpDirs()`                                                 |
| `unit/mcp-dispatch.test.ts`                         | Dispatch table ↔ tool-definition parity, unknown-tool error, `instructions` category coverage                                                                                        |                                                                             |
| `unit/godot-runner-session-lifecycle.test.ts`       | Spawned-exit auto-clear and its session-epoch guard, idempotent `stopProject`, attached-mode disconnect probe                                                                        | Mocks `child_process.spawn`; loopback bridge for disconnects                |
| `unit/process-lifecycle.test.ts`                    | `registerProcessLifecycle` signal / stdin-close / sync-exit wiring with an injected fake `process`                                                                                   | Tmp dirs via `useTmpDirs()`                                                 |
| `integration/runner-executeOperation.test.ts`       | `executeOperation` for `validate_resource` (scene + broken GDScript); `handleCheckProject`                                                                                           | Requires `GODOT_PATH`                                                       |
| `integration/scene-roundtrip.test.ts`               | `add_node` / `set_node_properties` / `delete_nodes` round-trip + auto-save invariant (all 3 operations)                                                                              | Requires `GODOT_PATH`; tmp fixture copy                                     |
| `integration/runtime-smoke.test.ts`                 | `run_project` → `take_screenshot` smoke test; skips gracefully if no display server                                                                                                  | Requires `GODOT_PATH`; may skip headless                                    |
| `integration/bridge-namespace.test.ts`              | Bridge autoload loads from `.mcp/godot-runtime/bridge/` under `.gdignore`; screenshots and audit pairs survive `stop_project`                                                        | Requires `GODOT_PATH`; may skip headless                                    |
| `unit/godot-variant.test.ts`                        | Variant encode/decode round-trip and malformed-packet rejection                                                                                                                      |                                                                             |
| `unit/profiler.test.ts`                             | `DebuggerProfiler` against a fake Godot debugger peer: frame aggregation, auto-stop, break-continue, error codes                                                                     |                                                                             |
| `unit/handlers/profiler-handlers.test.ts`           | Argument defaults, sort enum, and ProfilerError mapping in `src/tools/profiler-tools.ts`                                                                                             |                                                                             |
| `integration/profiler-smoke.test.ts`                | `run_project({ profiling: true })` → `profile_project` / `start_profiler` + `stop_profiler` against a real engine                                                                    | Requires `GODOT_PATH`; needs a display server                               |
| `integration/session-lifecycle.test.ts`             | A real Godot killed from outside clears its own session and artifacts; `get_debug_output` and `stop_project` after the exit                                                          | Requires `GODOT_PATH`; may skip headless                                    |
| `integration/simulate-input-observed.test.ts`       | `simulate_input` per-action results against `input_probe.tscn`: signals, `hit` and occlusion, UI delta, watch samples, held keys, error attribution                                  | Requires `GODOT_PATH`; `hit` assertions branch on an engine probe           |
| `integration/fixture.test.ts`                       | Smoke check that `tests/fixtures/godot-project/` is well-formed, probe scene and `probe_move` action included                                                                        | No Godot required                                                           |
| `unit/bridge-protocol.test.ts`                      | Frame encode/decode, the 16 MiB cap, and the action-boundary sentinel parser                                                                                                         |                                                                             |
| `unit/bridge-keep-in-sync.test.ts`                  | The KEEP IN SYNC constants in `mcp_bridge.gd` against their TypeScript twins                                                                                                         | Reads the GDScript as text                                                  |
| `unit/bridge-readiness-budget.test.ts`              | Ordering relationships between the spawned and attached bridge readiness constants                                                                                                   |                                                                             |
| `unit/godot-runner-runtime-errors.test.ts`          | `ingestStderrChunk` bookkeeping: the split-line rejoin, the 500-line ring, per-action attribution                                                                                    |                                                                             |
| `unit/run-project-scene-arg.test.ts`                | `run_project`'s positional scene argument reaches the spawn command line                                                                                                             | Mocks `child_process.spawn`                                                 |
| `unit/output-schemas.test.ts`                       | Every declared `outputSchema` compiles, the allowlist of tools that declare one, and the `simulate_input` / `check_project` payload shapes                                           | ajv over the live definitions                                               |
| `unit/handlers/validate-checks-schema.test.ts`      | Single-mode `checks[]` shape guards, including recursive structure-schema validation                                                                                                 |                                                                             |
| `unit/handlers/validate-batch-checks.test.ts`       | `targets[].checks` in one Godot process: per-target isolation, the same shape guards, one import retry                                                                               |                                                                             |
| `unit/handlers/validate-structure-checks.test.ts`   | Structure-check finding shapes as the handler merges them                                                                                                                            |                                                                             |
| `unit/handlers/validate-signals-checks.test.ts`     | Signal-check finding shapes as the handler merges them                                                                                                                               |                                                                             |
| `integration/validate-structure-checks.test.ts`     | `checks: [{ type: "structure" }]` against a real instantiated scene                                                                                                                  | Requires `GODOT_PATH`                                                       |
| `integration/validate-signals-checks.test.ts`       | `checks: [{ type: "signals" }]` against a real instantiated scene, including private handlers                                                                                        | Requires `GODOT_PATH`                                                       |
| `integration/validate-batch-checks.test.ts`         | A `targets[]` batch with checks running in a single Godot process                                                                                                                    | Requires `GODOT_PATH`                                                       |
| `integration/set-node-properties-typecheck.test.ts` | Declared-type validation before `set()`, packed arrays, and typed `Array[T]` elements                                                                                                | Requires `GODOT_PATH`; tmp fixture copy                                     |
| `integration/shader-material-parameters.test.ts`    | Inline `ShaderMaterial` construction with `shader_parameter/*` virtual keys                                                                                                          | Requires `GODOT_PATH`                                                       |
| `integration/camelcase-user-keys.test.ts`           | User-authored keys under `properties` / `value` reach Godot byte for byte                                                                                                            | Requires `GODOT_PATH`                                                       |
| `integration/script-attach-validation.test.ts`      | `attach_script` / `set_node_properties` / `add_node` reject a script that cannot be instantiated (parse error, unbuilt C# class); no-C#-support message; valid script still attaches | Requires `GODOT_PATH`; opt-in C# case requires `GODOT_MONO_PATH` + `dotnet` |

(Add new rows here as additional test files land. The map indexes the
load-bearing files rather than every file in the suite.)

## Running

```
npm test              # full suite
npm run test:watch    # watch mode during development
npm run test:coverage # v8 coverage report (no enforcement, just visibility)
```

## Godot-required tests

Tests that need a real Godot process gate themselves with the `itGodot` wrapper from `tests/helpers/godot-skip.ts` (which is `it.skipIf(!process.env.GODOT_PATH)`). Set `GODOT_PATH` to your Godot 4.x executable to run them locally:

```
# bash / git bash
GODOT_PATH="/path/to/godot" npm test

# PowerShell
$env:GODOT_PATH = "C:/path/to/godot.exe"; npm test
```

CI installs Godot too: the `godot-integration` job in `.github/workflows/ci.yml` downloads Godot 4.5.1 and 4.6.2 and runs the full suite with `GODOT_PATH` set, in a matrix separate from the Godot-less job that runs everywhere else. Locally, these tests skip cleanly unless you set `GODOT_PATH` yourself.

`GODOT_MONO_PATH` (a Godot .NET/Mono build) gates the opt-in C# case in `integration/script-attach-validation.test.ts` the same way `GODOT_PATH` gates the rest: skipped cleanly when unset, and also skipped when `dotnet` is not on `PATH`. CI never sets it. Set it alongside `GODOT_PATH` to also exercise the C# attach-script path locally:

```
GODOT_PATH="/path/to/godot" GODOT_MONO_PATH="/path/to/godot-mono" npm test
```

## Adding a fixture

Use a sibling directory under `tests/fixtures/` rather than mutating an existing fixture in place. Existing tests may depend on the current shape.

If the fixture exercises tools that require Godot, add a row to the coverage map noting it requires `GODOT_PATH`.

## Gotchas worth knowing before debugging a test

- **`root/...` is a virtual path prefix, not the fixture's actual root node name.** The committed fixture's root node is `[node name="Main"]`, but tests address it as `root/Label`, `root/Sprite2D`, etc. The bridge in `src/scripts/godot_operations.gd::find_node_by_path` translates `root` → the actual scene root regardless of its name. Don't go hunting in the `.tscn` for a node literally called `root`.

## Testing rubric

CI installs Godot in a dedicated `godot-integration` matrix job (see above); Godot-required tests otherwise run only when contributors set `GODOT_PATH` locally. Everything else runs everywhere.

### When to write a test

1. The function bridges a boundary: TS↔GDScript, MCP client↔handler, TCP, child process, fs
2. The function encodes a contract another part of the system depends on: MCP response shape, error response shape, tool input schema, parameter casing
3. The function has more than one branch that `tsc` can't catch: argument validation, error fallbacks, output parsing
4. There's a documented invariant: `console.log` ban, auto-save, `..` rejection, `-d` debugger trap
5. There's a past bug whose fix is not structural (regression test)

### When NOT to write a test

- The thing under test is what `tsc` already verifies (type shape, presence of a property)
- The test snapshots a tool-definition array (brittle; agents will regenerate them reflexively)
- The test mocks an internal helper just to verify the handler "called it" (couples the test to implementation, not behavior)
- The branch is unreachable in practice (defensive `null` checks behind exhaustive types)

### What to test

- **Behavior** (input → output), not implementation (which methods got called)
- **Boundaries**: shape of data crossing TS↔GDScript, MCP↔handler, TCP↔bridge
- **Error paths** with the same care as happy paths: the error response shape is the MCP contract
- **Invariants**: auto-save, path validation, error-response structure, parameter casing round-trip

### How to test

- Prefer real integration when fast: vitest + the committed fixture, no Godot needed
- For Godot-required tests, use the `itGodot` wrapper from `tests/helpers/godot-skip.ts` so the suite stays green without Godot installed
- Mock at the I/O boundary only: `child_process`, `net` (bridge transport), destructive `fs` ops. Never mock `godot-runner` from handler tests: pass a fake runner via the handler's runner parameter instead
- One assertion per behavior; don't bundle three contracts into one test
- Test names describe behavior: `"rejects scenePath containing .."` not `"parseSceneArgs handles bad input"`
- Don't write coverage targets. Coverage is a side effect of testing the right things, not a goal

### Anti-patterns specific to this codebase

- Don't test that `console.error` was called: the lint rule already protects the stdout transport
- Don't snapshot whole tool-definition arrays: assert that every entry has the expected fields and that names match handlers
- Don't write integration tests that mutate the committed fixture in place: copy it to a tmp dir first or use a sibling fixture under `tests/fixtures/`
- Don't assert on Godot version banners or stderr formatting: Godot patches change these
