# Tests

Index of what is tested where, plus the rubric for when/what/how to test. Update this file when adding a new test file or fixture.

## Layout

```
tests/
├── unit/             Pure-function and shape-contract tests. No Godot, no I/O.
├── integration/      Tests that touch fixtures or run real Godot.
│                     Godot-required tests skip when GODOT_PATH is unset.
├── fixtures/         Committed test inputs.
│   └── godot-project/  Minimal Godot 4 project (Node2D + Label + Sprite2D)
└── README.md         This file.
```

## Coverage map

| File                                          | Covers                                                                                                                   | Notes                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `unit/godot-runner.test.ts`                   | `normalizeParameters`, `convertCamelToSnakeCase`, `validatePath`, `extractGdError`, `createErrorResponse`, `extractJson` | First batch from dev-bootstrap           |
| `unit/godot-runner-extended.test.ts`          | `cleanOutput`, `normalizeForCompare`, `validateProjectArgs`, `validateSceneArgs`                                         |                                          |
| `unit/tool-definitions.test.ts`               | Shape contract for every tool definition; no duplicate names                                                             |                                          |
| `unit/handlers/scene-handlers.test.ts`        | Argument validation in `src/tools/scene-tools.ts` handlers                                                               | Uses `tests/helpers/fake-runner.ts`      |
| `unit/handlers/node-handlers.test.ts`         | Argument validation in `src/tools/node-tools.ts` handlers                                                                | Uses `tests/helpers/fake-runner.ts`      |
| `unit/handlers/project-handlers.test.ts`      | Argument validation for non-runtime project handlers (autoload, fs, search, settings)                                    | Tmp dirs via `fs.mkdtempSync`            |
| `unit/handlers/validate-handler.test.ts`      | `handleValidate` argument validation incl. single vs `targets[]` mode                                                    |                                          |
| `unit/mcp-dispatch.test.ts`                   | Dispatch table ↔ tool-definition parity, unknown-tool error, `instructions` category coverage                            |                                          |
| `integration/runner-executeOperation.test.ts` | `executeOperation` for `validate_resource` (scene + broken GDScript); `handleGetProjectInfo`                             | Requires `GODOT_PATH`                    |
| `integration/scene-roundtrip.test.ts`         | `add_node` / `set_node_property` / `delete_node` round-trip + auto-save invariant (all 3 operations)                     | Requires `GODOT_PATH`; tmp fixture copy  |
| `integration/runtime-smoke.test.ts`           | `run_project` → `take_screenshot` smoke test; skips gracefully if no display server                                      | Requires `GODOT_PATH`; may skip headless |
| `integration/fixture.test.ts`                 | Smoke check that `tests/fixtures/godot-project/` is well-formed                                                          | No Godot required                        |

(Add new rows here as additional test files land.)

## Running

```
npm test              # full suite
npm run test:watch    # watch mode during development
npm run test:coverage # v8 coverage report (no enforcement, just visibility)
```

## Godot-required tests

Tests that need a real Godot process gate themselves with `it.skipIf(!process.env.GODOT_PATH)`. Set `GODOT_PATH` to your Godot 4.x executable to run them locally:

```
# bash / git bash
GODOT_PATH="D:/Godot/Godot_v4.5.1/Godot_v4.5.1-stable_mono_win64.exe" npm test

# PowerShell
$env:GODOT_PATH = "D:/Godot/Godot_v4.5.1/Godot_v4.5.1-stable_mono_win64.exe"; npm test
```

CI does not install Godot, so those tests skip there. This is intentional — runtime/headless integration is verified locally before merge, not in the cloud.

## Adding a fixture

Use a sibling directory under `tests/fixtures/` rather than mutating an existing fixture in place. Existing tests may depend on the current shape.

If the fixture exercises tools that require Godot, add a row to the coverage map noting it requires `GODOT_PATH`.

## Testing rubric

CI does not install Godot. Godot-required tests run only when contributors run them locally with `GODOT_PATH` set. Everything else runs everywhere.

### When to write a test

1. The function bridges a boundary — TS↔GDScript, MCP client↔handler, UDP, child process, fs
2. The function encodes a contract another part of the system depends on — MCP response shape, error response shape, tool input schema, parameter casing
3. The function has more than one branch that `tsc` can't catch — argument validation, error fallbacks, output parsing
4. There's a documented invariant — `console.log` ban, auto-save, `..` rejection, `-d` debugger trap
5. There's a past bug whose fix is not structural (regression test)

### When NOT to write a test

- The thing under test is what `tsc` already verifies (type shape, presence of a property)
- The test snapshots a tool-definition array (brittle; agents will regenerate them reflexively)
- The test mocks an internal helper just to verify the handler "called it" (couples the test to implementation, not behavior)
- The branch is unreachable in practice (defensive `null` checks behind exhaustive types)

### What to test

- **Behavior** (input → output), not implementation (which methods got called)
- **Boundaries**: shape of data crossing TS↔GDScript, MCP↔handler, UDP↔bridge
- **Error paths** with the same care as happy paths — the error response shape is the MCP contract
- **Invariants**: auto-save, path validation, error-response structure, parameter casing round-trip

### How to test

- Prefer real integration when fast — vitest + the committed fixture, no Godot needed
- For Godot-required tests, use `it.skipIf(!process.env.GODOT_PATH)` so the suite stays green without Godot installed
- Mock at the I/O boundary only: `child_process`, `dgram`, destructive `fs` ops. Never mock `godot-runner` from handler tests — pass a fake runner via the handler's runner parameter instead
- One assertion per behavior; don't bundle three contracts into one test
- Test names describe behavior: `"rejects scenePath containing .."` not `"validateSceneArgs handles bad input"`
- Don't write coverage targets. Coverage is a side effect of testing the right things, not a goal

### Anti-patterns specific to this codebase

- Don't test that `console.error` was called — the lint rule already protects the stdout transport
- Don't snapshot whole tool-definition arrays — assert that every entry has the expected fields and that names match handlers
- Don't write integration tests that mutate the committed fixture in place — copy it to a tmp dir first or use a sibling fixture under `tests/fixtures/`
- Don't assert on Godot version banners or stderr formatting — Godot patches change these
