/**
 * Declarative policy table + evaluator for run_script / run_project security
 * gating. The rule catalogue here is the single auditable surface — see
 * `docs/security.md` for the rationale on each tier assignment.
 *
 * This is a best-effort filter, not a sound one and not a sandbox: GDScript
 * is Turing-complete and reflective, so no tokenizer-level rule table can be
 * complete. It catches the obvious, unobfuscated dangerous primitive; it does
 * not and cannot defend against an adversary who reads this file (it's open
 * source) and constructs a script the rules don't happen to match. See
 * `docs/security.md` "What this does NOT do" for the specific structural
 * gaps (identifier aliasing/dataflow, inline sub_resource scripts, etc.).
 *
 * Three tiers:
 *  - Tier 1 (hard_block): server refuses; bridge never sees the script.
 *  - Tier 2 (elicit_required): server asks client/user; strict mode promotes
 *    these to Tier 1.
 *  - Tier 3 (warn): executes, appended to the response `warnings` array.
 *
 * The evaluator is pure — no I/O, no client coupling. Handlers integrate the
 * decision with the elicitor and audit sidecar.
 */

import { tokenize, type Token } from './gdscript-scanner.js';

export type Tier = 1 | 2 | 3;

export type Decision = 'hard_block' | 'elicit_required' | 'warn' | 'ok';

export interface PolicyMatch {
  ruleId: string;
  tier: Tier;
  line: number;
  column: number;
  matchedText: string;
  reason: string;
  solutions: string[];
}

export interface PolicyDecision {
  decision: Decision;
  /**
   * Highest tier among matches AFTER strict-mode promotion. `null` when no
   * rule matched (decision === 'ok').
   */
  effectiveTier: Tier | null;
  matches: PolicyMatch[];
  /** True when strict mode rewrote one or more Tier 2 matches to Tier 1. */
  promotedByStrict: boolean;
}

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

/**
 * A rule matches when the tokenizer emits a `memberChain` whose `chain`
 * array starts with `chain` (exact prefix match). `argumentKind` may further
 * narrow the match by classifying the call's *whole* first argument — used
 * to distinguish `load("res://foo")` (literal, Tier 3) from `load(some_var)`
 * or `load("res://" + evil)` (non-literal, Tier 1). See
 * `classifyFirstArgument` — classification looks at everything up to the
 * next top-level `,` or `)`, not just the first token, so `"a" + b` is
 * correctly non-literal rather than mistaken for the literal `"a"`.
 */
interface PolicyRule {
  id: string;
  tier: Tier;
  /** Member chain that must appear as a prefix. e.g. ['OS','execute']. */
  chain: readonly string[];
  /**
   * Optional: require the call's whole first argument to classify as
   * 'literal' (a lone string token) or 'nonliteral' (anything else — an
   * identifier, an expression, multiple tokens). A no-argument call
   * ('none') never matches either kind. If absent, any context matches.
   */
  argumentKind?: 'literal' | 'nonliteral';
  /**
   * Optional: also fire when the chain appears as a bare identifier (e.g.
   * `load(...)` rather than `Foo.load(...)`). Used for the global functions
   * `load`, `preload`, `str_to_var`, `bytes_to_var_with_objects` — and,
   * combined with `matchLastSegment` below, for an instance-method
   * primitive whose receiver expression contains a call
   * (`tex.get_image().save_png(p)`), which the scanner cannot chain at all
   * (a call always breaks chain-building — see gdscript-scanner.ts), so the
   * method surfaces as a bare `identifier` token with zero receiver
   * context. Only set this on a rule whose bare method name is distinctive
   * enough to be safe with no receiver information whatsoever — the same
   * bar `matchLastSegment` alone already applies, just stricter, since a
   * bare-identifier match can't even be narrowed by "is this a two-segment
   * chain."
   */
  matchAsBareIdentifier?: boolean;
  /**
   * Optional: match when `chain`'s single segment appears as the *last*
   * segment of any member chain of length >= 2, rather than as a prefix.
   * Used for the generic non-literal `.call`/`.callv` rule, which must fire
   * on any receiver (`some_node.call(var)`), not just the named singletons
   * that already have dedicated prefix rules above it in the table.
   *
   * May be combined with `matchAsBareIdentifier` on the same rule: the two
   * flags are independent and cover two different token shapes for the
   * same underlying primitive. `matchLastSegment` alone covers
   * `receiver.method(...)` (a genuine two-segment-or-longer memberChain).
   * Adding `matchAsBareIdentifier` additionally covers `method(...)` with
   * no receiver info at all (a bare identifier) — the case produced when a
   * call sits between the real receiver and the method
   * (`foo().method(...)`), which the tokenizer cannot chain across. See
   * `tokenMatchesRule`: when a `matchLastSegment` rule's token isn't a
   * qualifying memberChain, it falls through to the bare-identifier check
   * only if the rule opted into `matchAsBareIdentifier` too.
   */
  matchLastSegment?: boolean;
  reason: string;
  solutions: string[];
}

// ---------------------------------------------------------------------------
// Argument classification
// ---------------------------------------------------------------------------

export type ArgumentClassification = 'literal' | 'nonliteral' | 'none';

/**
 * Classify a call's whole first argument, not just its first token — so
 * `load("res://" + evil_var)` is correctly 'nonliteral' instead of matching
 * on the leading string literal alone.
 *
 * Scans from `openParenIndex + 1`, tracking bracket depth so nested
 * `(...)`/`[...]` in the first argument (e.g. `foo(bar(x), y)`) don't
 * mistake an inner terminator for the outer one. A top-level `,` or `)` ends
 * the argument. Newline tokens are skipped (they carry no argument content).
 *
 * - Zero collected tokens → 'none' (a no-arg call — must not match a
 *   non-literal rule, preserving "don't fire on load()").
 * - Exactly one collected token and it is a string literal → 'literal'.
 * - Anything else (an identifier, an operator, multiple tokens) → 'nonliteral'.
 */
export function classifyFirstArgument(
  tokens: readonly Token[],
  openParenIndex: number,
): ArgumentClassification {
  let depth = 0;
  const collected: Token[] = [];

  for (let j = openParenIndex + 1; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;

    if (tok.kind === 'punct') {
      if (tok.text === '(' || tok.text === '[') {
        depth++;
        collected.push(tok);
        continue;
      }
      if (tok.text === ')') {
        if (depth === 0) break; // terminator: end of the call
        depth--;
        collected.push(tok);
        continue;
      }
      if (tok.text === ']') {
        if (depth > 0) depth--;
        collected.push(tok);
        continue;
      }
      if (tok.text === ',' && depth === 0) {
        break; // terminator: end of the first argument
      }
    }

    collected.push(tok);
  }

  if (collected.length === 0) return 'none';
  if (collected.length === 1 && collected[0]!.kind === 'string') return 'literal';
  return 'nonliteral';
}

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

export const policyRules: readonly PolicyRule[] = [
  // ---- Tier 1: direct exec ----
  {
    id: 'tier1.direct_exec.OS.execute',
    tier: 1,
    chain: ['OS', 'execute'],
    reason: 'OS.execute can run arbitrary OS commands',
    solutions: [
      'Use the scene_tree argument to interact with the project',
      'For OS-level work, use a separate authorized tool outside the run_script gate',
    ],
  },
  {
    id: 'tier1.direct_exec.OS.create_process',
    tier: 1,
    chain: ['OS', 'create_process'],
    reason: 'OS.create_process spawns external processes',
    solutions: ['Restructure the script to operate only on the scene tree'],
  },
  {
    id: 'tier1.direct_exec.OS.execute_with_pipe',
    tier: 1,
    chain: ['OS', 'execute_with_pipe'],
    reason: 'OS.execute_with_pipe spawns external processes',
    solutions: ['Restructure the script to operate only on the scene tree'],
  },
  {
    id: 'tier1.direct_exec.OS.shell_open',
    tier: 1,
    chain: ['OS', 'shell_open'],
    reason: 'OS.shell_open hands a path to the host shell',
    solutions: ['Remove the shell_open call'],
  },
  {
    id: 'tier1.direct_exec.OS.kill',
    tier: 1,
    chain: ['OS', 'kill'],
    reason: 'OS.kill terminates external processes',
    solutions: ['Remove the kill call'],
  },
  {
    id: 'tier1.direct_exec.OS.set_environment',
    tier: 1,
    chain: ['OS', 'set_environment'],
    reason: 'OS.set_environment mutates the process environment',
    solutions: ['Remove the environment mutation'],
  },
  {
    id: 'tier1.direct_exec.OS.unset_environment',
    tier: 1,
    chain: ['OS', 'unset_environment'],
    reason: 'OS.unset_environment mutates the process environment',
    solutions: ['Remove the environment mutation'],
  },
  {
    id: 'tier1.direct_exec.OS.set_restart_on_exit',
    tier: 1,
    chain: ['OS', 'set_restart_on_exit'],
    reason: 'OS.set_restart_on_exit changes process restart behavior',
    solutions: ['Remove the call'],
  },

  // ---- Tier 1: resource-pack persistence ----
  {
    id: 'tier1.resource_pack.load',
    tier: 1,
    chain: ['ProjectSettings', 'load_resource_pack'],
    reason: 'ProjectSettings.load_resource_pack mounts arbitrary PCK files',
    solutions: ['Remove the load_resource_pack call'],
  },
  {
    id: 'tier1.resource_pack.save',
    tier: 1,
    chain: ['ProjectSettings', 'save'],
    reason: 'ProjectSettings.save writes a new project.godot',
    solutions: ['Modify ProjectSettings only via the dedicated MCP tools'],
  },
  {
    id: 'tier1.resource_pack.save_custom',
    tier: 1,
    chain: ['ProjectSettings', 'save_custom'],
    reason: 'ProjectSettings.save_custom writes a project.godot variant',
    solutions: ['Modify ProjectSettings only via the dedicated MCP tools'],
  },

  // ---- Tier 1: engine tampering ----
  {
    id: 'tier1.engine.get_singleton',
    tier: 1,
    chain: ['Engine', 'get_singleton'],
    reason: 'Engine.get_singleton can return user-mutable global state',
    solutions: ['Access singletons by name directly, not through Engine.get_singleton'],
  },
  {
    id: 'tier1.engine.register_singleton',
    tier: 1,
    chain: ['Engine', 'register_singleton'],
    reason: 'Engine.register_singleton injects global state',
    solutions: ['Remove the register_singleton call'],
  },
  {
    id: 'tier1.engine.register_script_language',
    tier: 1,
    chain: ['Engine', 'register_script_language'],
    reason: 'Engine.register_script_language extends the runtime',
    solutions: ['Remove the register_script_language call'],
  },

  // ---- Tier 1: reflection bypasses ----
  {
    id: 'tier1.reflection.ClassDB.instantiate',
    tier: 1,
    chain: ['ClassDB', 'instantiate'],
    reason: 'ClassDB.instantiate can construct any registered class by name',
    solutions: ['Construct the class directly: `var x = TheClass.new()`'],
  },
  {
    id: 'tier1.reflection.ClassDB.class_call_static',
    tier: 1,
    chain: ['ClassDB', 'class_call_static'],
    reason: 'ClassDB.class_call_static invokes arbitrary static methods by name',
    solutions: ['Call the static method directly with its qualified name'],
  },
  {
    id: 'tier1.reflection.Object.set_script',
    tier: 1,
    chain: ['Object', 'set_script'],
    reason: 'set_script attaches arbitrary code to an object',
    solutions: ['Attach scripts at scene-edit time via the attach_script MCP tool'],
  },
  {
    id: 'tier1.reflection.Node.set_script',
    tier: 1,
    chain: ['Node', 'set_script'],
    reason: 'set_script attaches arbitrary code to a node',
    solutions: ['Attach scripts at scene-edit time via the attach_script MCP tool'],
  },
  {
    id: 'tier1.reflection.Callable',
    tier: 1,
    chain: ['Callable'],
    matchAsBareIdentifier: true,
    reason:
      'Callable(target, "method") constructs runtime dynamic dispatch that bypasses static analysis',
    solutions: ['Call the method directly by name instead of constructing a Callable'],
  },
  {
    id: 'tier2.reflection.set_script.bareIdentifier',
    tier: 2,
    chain: ['set_script'],
    matchAsBareIdentifier: true,
    reason: 'set_script attaches arbitrary code to an object (receiver type not statically known)',
    solutions: [
      'Attach scripts at scene-edit time via the attach_script MCP tool',
      'Rename the property if `set_script` is being used as a user-defined setter',
    ],
  },

  // ---- Tier 1: dynamic code ----
  {
    id: 'tier1.dynamic.Expression',
    tier: 1,
    chain: ['Expression'],
    reason: 'Expression evaluates arbitrary GDScript expressions at runtime',
    solutions: ['Compute the value directly in GDScript instead of via Expression'],
  },
  {
    id: 'tier1.dynamic.str_to_var',
    tier: 1,
    chain: ['str_to_var'],
    matchAsBareIdentifier: true,
    reason: 'str_to_var deserializes GDScript values, including code-bearing types',
    solutions: ['Parse the input format manually'],
  },
  {
    id: 'tier1.dynamic.bytes_to_var_with_objects',
    tier: 1,
    chain: ['bytes_to_var_with_objects'],
    matchAsBareIdentifier: true,
    reason: 'bytes_to_var_with_objects deserializes objects, including scripts',
    solutions: ['Use bytes_to_var (no _with_objects) for data-only deserialization'],
  },

  // ---- Tier 1: ConfigFile load family ----
  // NOTE: `ConfigFile.load` itself moved further down in this table (search
  // "ConfigFile.load prefix-hole fix") — its idiomatic call form is an
  // instance method (`var cf := ConfigFile.new(); cf.load(p)`), never the
  // static-looking `ConfigFile.load(p)` a two-segment chain prefix requires,
  // so it now uses matchLastSegment instead and had to move past every
  // ResourceLoader.load rule to preserve first-match-wins ordering.
  {
    id: 'tier1.config.ConfigFile.load_encrypted',
    tier: 1,
    chain: ['ConfigFile', 'load_encrypted'],
    reason: 'ConfigFile.load_encrypted decrypts and loads attacker-controlled data',
    solutions: ['Remove the ConfigFile.load_encrypted call'],
  },
  {
    id: 'tier1.config.ConfigFile.parse',
    tier: 1,
    chain: ['ConfigFile', 'parse'],
    reason: 'ConfigFile.parse evaluates arbitrary config strings',
    solutions: ['Remove the ConfigFile.parse call'],
  },

  // ---- Tier 1: non-literal load/preload/call ----
  {
    id: 'tier1.indirect.load.nonliteral',
    tier: 1,
    chain: ['load'],
    matchAsBareIdentifier: true,
    argumentKind: 'nonliteral',
    reason: 'load() with a non-literal path can be redirected to any resource',
    solutions: ['Pass a literal `res://...` path string to load()'],
  },
  {
    id: 'tier1.indirect.preload.nonliteral',
    tier: 1,
    chain: ['preload'],
    matchAsBareIdentifier: true,
    argumentKind: 'nonliteral',
    reason: 'preload() with a non-literal path can be redirected',
    solutions: ['Pass a literal `res://...` path string to preload()'],
  },
  {
    id: 'tier1.indirect.ResourceLoader.load.nonliteral',
    tier: 1,
    chain: ['ResourceLoader', 'load'],
    argumentKind: 'nonliteral',
    reason: 'ResourceLoader.load with a non-literal path can be redirected',
    solutions: ['Pass a literal `res://...` path to ResourceLoader.load'],
  },
  {
    id: 'tier1.indirect.Object.call.nonliteral',
    tier: 1,
    chain: ['Object', 'call'],
    argumentKind: 'nonliteral',
    reason: 'Object.call with a non-literal method name is a dynamic dispatch',
    solutions: ['Call the method directly by name'],
  },
  {
    id: 'tier1.indirect.Object.callv.nonliteral',
    tier: 1,
    chain: ['Object', 'callv'],
    argumentKind: 'nonliteral',
    reason: 'Object.callv with a non-literal method name is a dynamic dispatch',
    solutions: ['Call the method directly by name'],
  },
  {
    id: 'tier1.indirect.OS.call.nonliteral',
    tier: 1,
    chain: ['OS', 'call'],
    argumentKind: 'nonliteral',
    reason: 'OS.call with a non-literal method name bypasses the OS.* allowlist',
    solutions: ['Call the OS method directly by name'],
  },
  {
    id: 'tier1.indirect.Engine.call.nonliteral',
    tier: 1,
    chain: ['Engine', 'call'],
    argumentKind: 'nonliteral',
    reason: 'Engine.call with a non-literal method name bypasses the Engine.* allowlist',
    solutions: ['Call the Engine method directly by name'],
  },
  {
    id: 'tier1.indirect.ClassDB.call.nonliteral',
    tier: 1,
    chain: ['ClassDB', 'call'],
    argumentKind: 'nonliteral',
    reason: 'ClassDB.call with a non-literal method name bypasses the ClassDB.* allowlist',
    solutions: ['Call the ClassDB method directly by name'],
  },
  {
    id: 'tier1.indirect.ProjectSettings.call.nonliteral',
    tier: 1,
    chain: ['ProjectSettings', 'call'],
    argumentKind: 'nonliteral',
    reason:
      'ProjectSettings.call with a non-literal method name bypasses the ProjectSettings.* allowlist',
    solutions: ['Call the ProjectSettings method directly by name'],
  },

  // ---- Tier 2: filesystem writes ----
  // NOTE: FileAccess.open with WRITE mode requires looking at the second
  // argument; we conservatively flag FileAccess.open uniformly at Tier 2 and
  // rely on the warn-tier surface for the read-only literal case. This
  // matches the spec's bias toward over-eliciting filesystem mutation.
  {
    id: 'tier2.fs.FileAccess.open',
    tier: 2,
    chain: ['FileAccess', 'open'],
    reason: 'FileAccess.open may write to disk depending on the mode flag',
    solutions: [
      'If reading, confirm READ mode and continue',
      'If writing, restructure the script to use a dedicated MCP write tool',
    ],
  },
  {
    id: 'tier2.fs.DirAccess.remove',
    tier: 2,
    chain: ['DirAccess', 'remove'],
    reason: 'DirAccess.remove deletes files',
    solutions: ['Confirm the deletion is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.remove_absolute',
    tier: 2,
    chain: ['DirAccess', 'remove_absolute'],
    reason: 'DirAccess.remove_absolute deletes files outside the project root',
    solutions: ['Remove the call'],
  },
  {
    id: 'tier2.fs.DirAccess.copy',
    tier: 2,
    chain: ['DirAccess', 'copy'],
    reason: 'DirAccess.copy writes files',
    solutions: ['Confirm the copy is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.rename',
    tier: 2,
    chain: ['DirAccess', 'rename'],
    reason: 'DirAccess.rename mutates the filesystem',
    solutions: ['Confirm the rename is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.create_link',
    tier: 2,
    chain: ['DirAccess', 'create_link'],
    reason: 'DirAccess.create_link creates filesystem links',
    solutions: ['Confirm the link creation is intentional'],
  },

  // ---- Tier 2: network ----
  {
    id: 'tier2.net.HTTPRequest',
    tier: 2,
    chain: ['HTTPRequest'],
    reason: 'HTTPRequest opens outbound HTTP connections',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.HTTPClient',
    tier: 2,
    chain: ['HTTPClient'],
    reason: 'HTTPClient opens outbound HTTP connections',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.TCPServer',
    tier: 2,
    chain: ['TCPServer'],
    reason: 'TCPServer opens an inbound TCP listener',
    solutions: ['Confirm the listener is intentional'],
  },
  {
    id: 'tier2.net.StreamPeerTCP',
    tier: 2,
    chain: ['StreamPeerTCP'],
    reason: 'StreamPeerTCP opens outbound TCP connections',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.WebSocketPeer',
    tier: 2,
    chain: ['WebSocketPeer'],
    reason: 'WebSocketPeer opens WebSocket connections',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.PacketPeerUDP',
    tier: 2,
    chain: ['PacketPeerUDP'],
    reason: 'PacketPeerUDP opens UDP sockets',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.UDPServer',
    tier: 2,
    chain: ['UDPServer'],
    reason: 'UDPServer opens UDP listeners',
    solutions: ['Confirm the listener is intentional'],
  },
  {
    id: 'tier2.net.StreamPeerTLS',
    tier: 2,
    chain: ['StreamPeerTLS'],
    reason: 'StreamPeerTLS opens TLS connections',
    solutions: ['Confirm the network call is intentional'],
  },
  {
    id: 'tier2.net.IP.resolve_hostname',
    tier: 2,
    chain: ['IP', 'resolve_hostname'],
    reason: 'IP.resolve_hostname makes DNS queries',
    solutions: ['Confirm the DNS lookup is intentional'],
  },
  {
    id: 'tier2.net.IP.resolve_hostname_addresses',
    tier: 2,
    chain: ['IP', 'resolve_hostname_addresses'],
    reason: 'IP.resolve_hostname_addresses makes DNS queries',
    solutions: ['Confirm the DNS lookup is intentional'],
  },

  // ---- Tier 3: warn (literal load/preload/call) ----
  {
    id: 'tier3.literal.load',
    tier: 3,
    chain: ['load'],
    matchAsBareIdentifier: true,
    argumentKind: 'literal',
    reason: 'load() with a literal path can run _init code in the loaded resource',
    solutions: ['Verify the resource path is trusted'],
  },
  {
    id: 'tier3.literal.preload',
    tier: 3,
    chain: ['preload'],
    matchAsBareIdentifier: true,
    argumentKind: 'literal',
    reason: 'preload() with a literal path can run _init code in the loaded resource',
    solutions: ['Verify the resource path is trusted'],
  },
  {
    id: 'tier3.literal.ResourceLoader.load',
    tier: 3,
    chain: ['ResourceLoader', 'load'],
    argumentKind: 'literal',
    reason: 'ResourceLoader.load with a literal path can run _init code',
    solutions: ['Verify the resource path is trusted'],
  },
  {
    id: 'tier3.literal.Object.call',
    tier: 3,
    chain: ['Object', 'call'],
    argumentKind: 'literal',
    reason: 'Object.call with a literal method name',
    solutions: ['Consider calling the method directly'],
  },
  {
    id: 'tier3.literal.OS.call',
    tier: 3,
    chain: ['OS', 'call'],
    argumentKind: 'literal',
    reason: 'OS.call with a literal method name',
    solutions: ['Consider calling the OS method directly'],
  },
  {
    id: 'tier3.literal.Engine.call',
    tier: 3,
    chain: ['Engine', 'call'],
    argumentKind: 'literal',
    reason: 'Engine.call with a literal method name',
    solutions: ['Consider calling the Engine method directly'],
  },
  {
    id: 'tier3.literal.ClassDB.call',
    tier: 3,
    chain: ['ClassDB', 'call'],
    argumentKind: 'literal',
    reason: 'ClassDB.call with a literal method name',
    solutions: ['Consider calling the ClassDB method directly'],
  },
  {
    id: 'tier3.literal.ProjectSettings.call',
    tier: 3,
    chain: ['ProjectSettings', 'call'],
    argumentKind: 'literal',
    reason: 'ProjectSettings.call with a literal method name',
    solutions: ['Consider calling the ProjectSettings method directly'],
  },
  {
    id: 'tier3.os_alert',
    tier: 3,
    chain: ['OS', 'alert'],
    reason: 'OS.alert opens a modal dialog and blocks the project',
    solutions: ['Remove the OS.alert call if running headlessly'],
  },

  // ---- Tier 1: ConfigFile.load prefix-hole fix (D5) ----
  // Moved here (after every ResourceLoader.load rule above, both the Tier 1
  // non-literal and Tier 3 literal forms) so that a `ResourceLoader.load`
  // memberChain keeps matching its own more specific rule first — first
  // match wins per token, in table order. See the shape rationale where
  // `tier1.config.ConfigFile.load_encrypted` used to sit, above.
  {
    id: 'tier1.config.ConfigFile.load',
    tier: 1,
    chain: ['load'],
    matchLastSegment: true,
    reason: 'ConfigFile.load can pull in attacker-controlled config',
    solutions: ['Load configuration from a known-safe path via FileAccess.READ'],
  },

  // ---- Tier 2: write-primitive sweep (AC1.1, harness Phase 1 / handoff PR 1) ----
  // Every rule below is Tier 2 per D3 (strict mode promotes each to Tier 1
  // for free via the evaluator's existing promotion step). Scope is
  // runtime-reachable classes only (D4) — no EditorInterface / editor-only
  // surface. Shape choice per D1: matchLastSegment for distinctive method
  // names that appear on arbitrary receivers (an instance-method primitive
  // whose receiver is a local variable, never the literal class name — the
  // exact bug this sweep is closing elsewhere); a two-segment chain prefix
  // for methods that are singletons or static (so `ClassName.method(...)`
  // really is the idiomatic call form); a single-segment class anchor for a
  // class whose own generic-named instance methods (bare `save`, etc.) are
  // unreachable by a token-level scanner, so the class reference itself
  // (typically `ClassName.new()`) is the signal instead. No bare `save` or
  // `call`-style last-segment rule is added — see the negative tests in
  // `run-script-policy.test.ts` "write-primitive sweep negatives".
  {
    id: 'tier2.resource_saver.save',
    tier: 2,
    chain: ['ResourceSaver', 'save'],
    reason: 'ResourceSaver.save writes a resource to disk (with or without an explicit path)',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.config.ConfigFile',
    tier: 2,
    chain: ['ConfigFile'],
    reason:
      'ConfigFile instances can write arbitrary config data via save/save_encrypted/save_encrypted_pass, none of which carry a distinctive-enough method name to match on their own',
    solutions: ['Confirm the ConfigFile usage only reads, or that the write is intentional'],
  },
  {
    id: 'tier2.config.ConfigFile.save_encrypted',
    tier: 2,
    chain: ['save_encrypted'],
    matchLastSegment: true,
    reason: 'ConfigFile.save_encrypted writes an encrypted config file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.config.ConfigFile.save_encrypted_pass',
    tier: 2,
    chain: ['save_encrypted_pass'],
    matchLastSegment: true,
    reason: 'ConfigFile.save_encrypted_pass writes an encrypted config file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  // The four Image writers below carry matchAsBareIdentifier in addition to
  // matchLastSegment: AC1.1's idiomatic form is `tex.get_image().save_png(p)`
  // — a call (`get_image()`) sits between the receiver and the write method,
  // which the scanner cannot chain across, so `save_png` etc. surface as a
  // bare identifier with zero receiver context (see tokenMatchesRule's
  // matchLastSegment fallthrough). Safe to match with no receiver at all
  // because these names are distinctive image-write verbs, not a generic
  // name like `save` that appears on unrelated objects (the reasoning D1
  // used to reject a bare `save` rule applies equally here and is why
  // `take_over_path`, `save_encrypted`, and `save_encrypted_pass` above do
  // NOT get this flag — their AC1.1 idiomatic forms are plain
  // `receiver.method(...)` with no intervening call, so matchLastSegment
  // alone already reaches them).
  {
    id: 'tier2.image.save_png',
    tier: 2,
    chain: ['save_png'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    reason: 'Image.save_png writes an image file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.image.save_jpg',
    tier: 2,
    chain: ['save_jpg'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    reason: 'Image.save_jpg writes an image file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.image.save_webp',
    tier: 2,
    chain: ['save_webp'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    reason: 'Image.save_webp writes an image file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.image.save_exr',
    tier: 2,
    chain: ['save_exr'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    reason: 'Image.save_exr writes an image file to disk',
    solutions: ['Confirm the write is intentional'],
  },
  {
    id: 'tier2.resource.take_over_path',
    tier: 2,
    chain: ['take_over_path'],
    matchLastSegment: true,
    reason: "Resource.take_over_path rewrites the resource's on-disk path binding",
    solutions: ['Confirm the path reassignment is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.open_encrypted',
    tier: 2,
    chain: ['FileAccess', 'open_encrypted'],
    reason: 'FileAccess.open_encrypted may return a writable encrypted file handle',
    solutions: ['Confirm the mode flag and that the write is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.open_encrypted_with_pass',
    tier: 2,
    chain: ['FileAccess', 'open_encrypted_with_pass'],
    reason: 'FileAccess.open_encrypted_with_pass may return a writable encrypted file handle',
    solutions: ['Confirm the mode flag and that the write is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.open_compressed',
    tier: 2,
    chain: ['FileAccess', 'open_compressed'],
    reason: 'FileAccess.open_compressed may return a writable compressed file handle',
    solutions: ['Confirm the mode flag and that the write is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.create_temp',
    tier: 2,
    chain: ['FileAccess', 'create_temp'],
    reason: 'FileAccess.create_temp writes a new temporary file to disk',
    solutions: ['Confirm the temp-file write is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.set_read_only_attribute',
    tier: 2,
    chain: ['FileAccess', 'set_read_only_attribute'],
    reason: 'FileAccess.set_read_only_attribute mutates a file attribute on disk',
    solutions: ['Confirm the attribute change is intentional'],
  },
  {
    id: 'tier2.fs.FileAccess.set_hidden_attribute',
    tier: 2,
    chain: ['FileAccess', 'set_hidden_attribute'],
    reason: 'FileAccess.set_hidden_attribute mutates a file attribute on disk',
    solutions: ['Confirm the attribute change is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.make_dir',
    tier: 2,
    chain: ['make_dir'],
    matchLastSegment: true,
    reason: 'DirAccess.make_dir creates a directory on disk',
    solutions: ['Confirm the directory creation is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.make_dir_absolute',
    tier: 2,
    chain: ['DirAccess', 'make_dir_absolute'],
    reason: 'DirAccess.make_dir_absolute creates a directory on disk',
    solutions: ['Confirm the directory creation is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.make_dir_recursive',
    tier: 2,
    chain: ['make_dir_recursive'],
    matchLastSegment: true,
    reason: 'DirAccess.make_dir_recursive creates a directory tree on disk',
    solutions: ['Confirm the directory creation is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.make_dir_recursive_absolute',
    tier: 2,
    chain: ['DirAccess', 'make_dir_recursive_absolute'],
    reason: 'DirAccess.make_dir_recursive_absolute creates a directory tree on disk',
    solutions: ['Confirm the directory creation is intentional'],
  },
  {
    id: 'tier2.fs.OS.move_to_trash',
    tier: 2,
    chain: ['OS', 'move_to_trash'],
    reason: 'OS.move_to_trash deletes (moves) a file or directory',
    solutions: ['Confirm the deletion is intentional'],
  },
  {
    id: 'tier2.archive.ZIPPacker',
    tier: 2,
    chain: ['ZIPPacker'],
    reason: 'ZIPPacker writes an arbitrary ZIP archive to disk',
    solutions: ['Confirm the archive write is intentional'],
  },
  {
    id: 'tier2.archive.PCKPacker',
    tier: 2,
    chain: ['PCKPacker'],
    reason: 'PCKPacker writes an arbitrary Godot PCK archive to disk',
    solutions: ['Confirm the archive write is intentional'],
  },
  {
    id: 'tier2.uid.ResourceUID.add_id',
    tier: 2,
    chain: ['ResourceUID', 'add_id'],
    reason: 'ResourceUID.add_id mutates the project-wide UID registry',
    solutions: ['Confirm the UID registration is intentional'],
  },
  {
    id: 'tier2.uid.ResourceUID.set_id',
    tier: 2,
    chain: ['ResourceUID', 'set_id'],
    reason: 'ResourceUID.set_id mutates the project-wide UID registry',
    solutions: ['Confirm the UID reassignment is intentional'],
  },
  {
    id: 'tier2.uid.ResourceUID.remove_id',
    tier: 2,
    chain: ['ResourceUID', 'remove_id'],
    reason: 'ResourceUID.remove_id mutates the project-wide UID registry',
    solutions: ['Confirm the UID removal is intentional'],
  },

  // ---- Tier 2: generic non-literal .call/.callv (any receiver) ----
  // Placed after every named-receiver .call/.callv rule above (per-token
  // first-match-wins, so Object.call(var) still fires the more specific
  // Tier 1 rule ahead of this one). Tier 2, not Tier 1: plenty of benign code
  // does `some_callable.call(...)`, and over-blocking here would train
  // reflexive elicitation approval.
  {
    id: 'tier2.generic.call.nonliteral',
    tier: 2,
    chain: ['call'],
    matchLastSegment: true,
    argumentKind: 'nonliteral',
    reason:
      'A non-literal .call on an arbitrary receiver is dynamic dispatch that bypasses static analysis',
    solutions: [
      'Call the method directly by name',
      'If the receiver is OS/Engine/ClassDB/ProjectSettings/Object, that dedicated rule already governs this call',
    ],
  },
  {
    id: 'tier2.generic.callv.nonliteral',
    tier: 2,
    chain: ['callv'],
    matchLastSegment: true,
    argumentKind: 'nonliteral',
    reason:
      'A non-literal .callv on an arbitrary receiver is dynamic dispatch that bypasses static analysis',
    solutions: ['Call the method directly by name'],
  },
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * True when the token at index `i` is followed by a `(` (allowing newlines
 * between for the multi-line call style). Returns the index of the `(`, or
 * -1 if no opening paren follows.
 */
function indexOfOpenParen(tokens: readonly Token[], i: number): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;
    if (tok.kind === 'punct' && tok.text === '(') return j;
    return -1;
  }
  return -1;
}

/**
 * `matchAsBareIdentifier`, evaluated on its own regardless of any other flag
 * on the rule: does this token qualify as the rule's bare identifier form?
 * Shared by the plain bare-identifier path and the `matchLastSegment`
 * fallthrough below, so both stay in sync by construction.
 */
function matchesBareIdentifier(tok: Token, rule: PolicyRule): boolean {
  return (
    !!rule.matchAsBareIdentifier &&
    rule.chain.length === 1 &&
    tok.kind === 'identifier' &&
    tok.text === rule.chain[0]
  );
}

function tokenMatchesRule(tok: Token, rule: PolicyRule): boolean {
  if (rule.matchLastSegment) {
    if (tok.kind === 'memberChain' && tok.chain && tok.chain.length >= 2) {
      return tok.chain[tok.chain.length - 1] === rule.chain[0];
    }
    // Not a qualifying memberChain — e.g. a call broke the chain, leaving
    // the method as a bare identifier (`tex.get_image().save_png(p)`
    // tokenizes `save_png` as `identifier`, not `memberChain`; see
    // gdscript-scanner.ts). Only rules that opted in via
    // `matchAsBareIdentifier` get a second chance here; a rule that sets
    // only `matchLastSegment` returns false, unchanged from before this
    // fallthrough existed.
    return matchesBareIdentifier(tok, rule);
  }
  if (matchesBareIdentifier(tok, rule)) {
    return true;
  }
  if (rule.chain.length === 1) {
    // Single-segment "chain" applied to a type reference like `Expression` or
    // `HTTPRequest` — match against identifier OR the first segment of any
    // member chain (e.g. `HTTPRequest.new` is a chain whose head matches).
    if (tok.kind === 'identifier') return tok.text === rule.chain[0];
    if (tok.kind === 'memberChain' && tok.chain && tok.chain.length > 0) {
      return tok.chain[0] === rule.chain[0];
    }
    return false;
  }
  if (tok.kind !== 'memberChain' || !tok.chain) return false;
  if (tok.chain.length < rule.chain.length) return false;
  for (let i = 0; i < rule.chain.length; i++) {
    if (tok.chain[i] !== rule.chain[i]) return false;
  }
  return true;
}

export function evaluateScript(source: string, strict = false): PolicyDecision {
  const tokens = tokenize(source);
  const matches: PolicyMatch[] = [];
  let promotedByStrict = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind !== 'identifier' && tok.kind !== 'memberChain') continue;

    for (const rule of policyRules) {
      if (!tokenMatchesRule(tok, rule)) continue;

      const openParen = indexOfOpenParen(tokens, i);

      if (rule.argumentKind) {
        if (openParen === -1) continue;
        const classification = classifyFirstArgument(tokens, openParen);
        if (classification !== rule.argumentKind) continue;
      }

      let effectiveTier: Tier = rule.tier;
      if (strict && rule.tier === 2) {
        effectiveTier = 1;
        promotedByStrict = true;
      }

      matches.push({
        ruleId: rule.id,
        tier: effectiveTier,
        line: tok.line,
        column: tok.column,
        matchedText: tok.text,
        reason: rule.reason,
        solutions: rule.solutions,
      });
      // Each token may only fire one rule (the first match wins). Subsequent
      // rules of the same kind would only duplicate the finding.
      break;
    }
  }

  let highest: Tier | null = null;
  for (const m of matches) {
    if (highest === null || m.tier < highest) highest = m.tier;
  }

  let decision: Decision = 'ok';
  if (highest === 1) decision = 'hard_block';
  else if (highest === 2) decision = 'elicit_required';
  else if (highest === 3) decision = 'warn';

  return {
    decision,
    effectiveTier: highest,
    matches,
    promotedByStrict,
  };
}

/**
 * Format a one-line summary of the highest-priority finding. Used to build
 * the agent-facing error message on Tier 1 hard-block and Tier 2 denial.
 */
export function summarizeMatch(m: PolicyMatch): string {
  return `line ${m.line} ${m.matchedText} — ${m.reason}`;
}

/**
 * Build the human-readable warnings array attached to a `warn` decision.
 */
export function matchesToWarnings(matches: readonly PolicyMatch[]): string[] {
  return matches.map((m) => `Warning line ${m.line}: ${m.matchedText} — ${m.reason}`);
}
