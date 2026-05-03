# Tool Authoring Standards

Standards for adding or modifying MCP tools in `godot-mcp-runtime`. Every tool ships on every client handshake — its description, schema, and annotations are the entire interface an LLM agent has to work with. Treat them like a UI, not an API doc.

If you change anything in `src/tools/*.ts`, work this checklist.

---

## 1. Description requirements

Every tool description states, in this order:

1. **Purpose** — what the tool does, in one sentence, in the agent's vocabulary (the outcome it achieves), not the implementation.
2. **Behavior** — non-obvious side effects. Especially: auto-save behavior, overwrite policy, what happens when the target doesn't exist.
3. **Parameter intent** — anything the schema can't express. Defaults, conditional requirements, parameter interactions, auto-conversions (e.g. Vector2/Color from `{x, y}` / `{r, g, b, a}`).
4. **Returns** — explicit return shape. Either an `outputSchema` field, or a `Returns: { … }` line in the description. Never both ambiguous.
5. **Use when / prefer X when** — when an agent should pick this tool over a sibling. Especially important when the server has multiple tools that touch the same resource.
6. **Error disclosure** — one short line per likely failure mode. "Errors if node not found." / "Overwrites silently." / "Returns empty array on no match."

### Description size budget

Soft cap **~500 characters per tool** including newlines. Every tool description ships on every handshake; bloat directly steals from the agent's context budget. If a description grows beyond this, pull background into a `# Notes` section in `docs/tools.md` and link.

### Examples in descriptions

Examples are useful but **contracts**: an example with two array items will produce two-item arrays. Use sparingly; if you must show one, make it minimal and not representative of common usage.

---

## 2. MCP annotations

Every tool definition includes an `annotations` object. Pick from:

| Annotation        | When to set                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `readOnlyHint`    | `true` when the tool only reads state, never mutates files, project, or running process.                                                                     |
| `destructiveHint` | `true` when the tool removes or replaces something hard to recover.                                                                                          |
| `idempotentHint`  | `true` when calling N times with the same args produces the same result as calling once. Setters with absolute values, not appenders.                        |
| `openWorldHint`   | `true` when the tool reaches outside this server's domain (network, foreign filesystem, external service). Most tools here stay in-project — leave unset.    |
| `title`           | Optional human-readable display name. Set when the tool name is awkward to read in client UIs; otherwise omit and the client falls back to the tool name.    |

Defaults: omit annotations only if none apply. `readOnlyHint` and `destructiveHint` should be mutually exclusive.

Why this matters: clients ask for extra confirmation when a tool lacks a `readOnlyHint`. Setting these correctly improves the agent's experience without changing the tool itself.

---

## 3. `outputSchema`

Add an `outputSchema` field when the return shape is non-trivial — anything richer than a simple success/error string. JSON Schema, same shape as `inputSchema`.

If `outputSchema` is impractical (highly variable shape), document the return inline with a `Returns: { … }` line in the description. Don't leave reviewers and agents to guess.

---

## 4. Naming convention

**Verb plurality matches param cardinality.**

- Singular subject → singular verb: `add_node({ nodeType, nodeName, ... })`, `attach_script({ nodePath, scriptPath })`
- Array subject → plural verb: `set_node_properties({ updates: [...] })`, `delete_nodes({ nodePaths: [...] })`, `get_node_properties({ nodes: [...] })`

The `batch_` prefix is **not** a naming convention — it's the symptom of a missed consolidation (see §5). If you're tempted to add `batch_foo`, reconsider whether `foos` should take an array.

Use snake_case for tool names and the GDScript boundary; camelCase inside TypeScript. The `normalizeParameters` / `convertCamelToSnakeCase` helpers in `src/utils/godot-runner.ts` bridge them.

### Implementation helpers

Headless-op handlers (the ~15 in `src/tools/scene-tools.ts` and `src/tools/node-tools.ts`) wrap through `executeSceneOp` from `src/utils/handler-helpers.ts` for the execute + empty-stdout-check + try/catch shell. New headless-op handlers should follow the same shape — keep normalize/validate/build-params in the handler and let `executeSceneOp` own the runner call and error mapping.

---

## 5. Consolidation criteria

**Decompose by outcome, not by parity with the underlying API.**

| Situation                                                              | Pattern                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same outcome, varying cardinality (set property on 1 node vs 50 nodes) | **One tool, array param.** `set_node_properties({ updates: [...] })`. An LLM passing a 1-element array is trivial.                                                                                                                                                                                                                                                                                                                           |
| Different outcomes (delete a node vs duplicate a node)                 | **Separate tools.** Different verbs, different shapes.                                                                                                                                                                                                                                                                                                                                                                                       |
| Heterogeneous ordered operations on shared state in one process        | **One tool with per-item operation field is acceptable** if the discriminator is load-bearing — dropping it would force agents to chain N round-trips and lose the shared-state guarantee. `batch_scene_operations` is the documented exception in this server: the alternative (N singular calls) costs ~3s startup per call and loses the in-process scene cache. **Rare.** Never use as an escape hatch from designing per-outcome tools. |
| Read-only diagnostic that agents almost never need                     | **Drop it.** Don't keep low-value tools in the surface "in case." Every tool ships on every handshake.                                                                                                                                                                                                                                                                                                                                       |

### Discriminator antipattern: how to recognize it

If your tool's `inputSchema` has:

- A field whose enum value gates which other fields are required, AND
- The valid-params-per-enum-value relationship is documented in description text, not enforced by schema

…you have a discriminator antipattern. Agents can't reliably reason about which params are valid given which operation value, and conditional schemas double the validation surface. Either split into separate tools (preferred) or document why the discriminator is load-bearing and the cost of splitting (see `batch_scene_operations`).

---

## 6. Pre-merge checklist

For any PR that adds or changes a tool definition:

- [ ] Description includes purpose, behavior, params intent, returns, "use when", error disclosure (§1)
- [ ] Description under ~500 chars (§1)
- [ ] `annotations` set correctly: `readOnlyHint` / `destructiveHint` / `idempotentHint` (§2)
- [ ] `outputSchema` present, OR description has explicit `Returns: { … }` line (§3)
- [ ] Tool name follows verb-plurality rule (§4); no new `batch_*` unless §5 exception applies
- [ ] Consolidation check: is there already a sibling tool with the same outcome at different cardinality? If so, fold (§5)
- [ ] If discriminator: documented as load-bearing exception with rationale (§5)
- [ ] `docs/tools.md` updated with the new/changed tool entry
- [ ] If breaking (rename, drop, schema change): migration table entry in CHANGELOG / release notes
- [ ] `npm run verify` passes (typecheck → lint → format:check → test → build)
