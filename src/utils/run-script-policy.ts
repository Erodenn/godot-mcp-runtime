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
 * gaps (identifier aliasing/dataflow, scripts in binary resources, etc.).
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

import { decodeStringLiteral, tokenize, type Token } from './gdscript-scanner.js';

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
  /**
   * Optional: the rule targets a GDScript global function (`load`, `preload`,
   * `str_to_var`), so a token immediately preceded by a `.` member access is a
   * method of some other receiver and never matches. The scanner leaves the
   * name a bare identifier after a call, subscript or `$Node` path
   * (`get_node("A").load(x)`, `$A.load(x)`), so without this a Tier 1 rule
   * on `load` hard-blocks ordinary `save_manager.load(slot)`-style code. Never
   * set on a method primitive (`set_script`, `save_png`): those must keep
   * matching after a dot.
   */
  globalFunctionOnly?: boolean;
  /**
   * Optional: require the token to be used as a call, i.e. followed by `(`.
   * For a class name whose constructor is the target (`Callable(self, "m")`)
   * but which also appears as a type annotation (`cb: Callable`).
   */
  callOnly?: boolean;
  /**
   * Optional: the rule targets a guarded class or singleton name used as a
   * value, which is how it gets another name (`var o = OS`, `foo(OS)`,
   * `[OS][0]`, `OS["execute"]`). It matches the name only as a bare
   * identifier: not the head of a member chain (the chain rules judge that),
   * not after a `.`, and not where the name is a type or is being declared
   * (`valueReferencePositions`). Only for a name whose every use as a value
   * is worth a prompt; never above Tier 2.
   */
  valueReferenceOnly?: boolean;
  reason: string;
  solutions: string[];
}

// ---------------------------------------------------------------------------
// Argument classification
// ---------------------------------------------------------------------------

export type ArgumentClassification = 'literal' | 'nonliteral' | 'none';

/**
 * Token visits one `evaluateScript` call may spend on scanning argument lists,
 * per token of the script. Each reflective call scans forward to its closing
 * `)`, so nested calls (`a.call(a.call(...))`) re-scan the whole inner region
 * at every level; the budget keeps the total linear in the script. An ordinary
 * script spends a small multiple of its token count.
 */
const SCAN_BUDGET_PER_TOKEN = 64;

/** The token visits left for argument scanning in one `evaluateScript` call. */
interface ScanBudget {
  remaining: number;
}

function newScanBudget(tokenCount: number): ScanBudget {
  return { remaining: tokenCount * SCAN_BUDGET_PER_TOKEN };
}

/**
 * The tokens of each top-level argument of the call whose `(` is at
 * `openParenIndex`. Bracket depth is tracked so a nested `(...)` or `[...]`
 * (e.g. `foo(bar(x), y)`) does not end an argument early: a top-level `,`
 * ends one argument and a top-level `)` ends the call. Newline tokens carry no
 * argument content and are skipped. A call with no arguments has one empty
 * argument. Null when the scan budget ran out before the call's end: the
 * arguments are then unknown.
 */
function argumentsOf(
  tokens: readonly Token[],
  openParenIndex: number,
  budget: ScanBudget,
): Token[][] | null {
  const args: Token[][] = [[]];
  let depth = 0;

  for (let j = openParenIndex + 1; j < tokens.length; j++) {
    if (budget.remaining-- <= 0) return null;
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;
    const current = args[args.length - 1]!;

    if (tok.kind === 'punct') {
      if (tok.text === '(' || tok.text === '[') {
        depth++;
      } else if (tok.text === ')') {
        if (depth === 0) break; // terminator: end of the call
        depth--;
      } else if (tok.text === ']') {
        if (depth > 0) depth--;
      } else if (tok.text === ',' && depth === 0) {
        args.push([]);
        continue;
      }
    }
    current.push(tok);
  }
  return args;
}

/**
 * Classify the tokens of one whole argument.
 *
 * - No tokens → 'none' (a no-arg call — must not match a non-literal rule,
 *   preserving "don't fire on load()").
 * - Exactly one token and it is a string literal → 'literal'.
 * - Anything else (an identifier, an operator, multiple tokens) → 'nonliteral'.
 */
/** The classification of an argument list the scan budget cut short. */
const UNREADABLE_ARGUMENT: ArgumentClassification = 'nonliteral';

function classifyArgument(argument: readonly Token[]): ArgumentClassification {
  if (argument.length === 0) return 'none';
  if (argument.length === 1 && argument[0]!.kind === 'string') return 'literal';
  return 'nonliteral';
}

/**
 * Classify a call's whole first argument, not just its first token — so
 * `load("res://" + evil_var)` is correctly 'nonliteral' instead of matching
 * on the leading string literal alone. See `argumentsOf` and
 * `classifyArgument`.
 */
export function classifyFirstArgument(
  tokens: readonly Token[],
  openParenIndex: number,
  budget: ScanBudget = newScanBudget(tokens.length),
): ArgumentClassification {
  const args = argumentsOf(tokens, openParenIndex, budget);
  // An argument list the budget cut short is one the policy cannot read.
  if (args === null) return UNREADABLE_ARGUMENT;
  return classifyArgument(args[0] ?? []);
}

// ---------------------------------------------------------------------------
// Reflective dispatch
// ---------------------------------------------------------------------------

/**
 * The receivers of the Tier 1 chain-prefix rules that can be handed a method
 * name at runtime: the engine singletons, and `Object` for the static-looking
 * `Object.call(...)` form. Naming a method on one of them with a non-literal
 * string reaches every Tier 1 primitive it has, so the dispatch itself is
 * Tier 1 (`reflectiveDispatchRules`). `Node` and `ConfigFile` carry Tier 1
 * rules too and are deliberately absent: they are classes, a script names
 * them to construct or annotate, and their reflective use goes through an
 * instance the scanner cannot see. A new Tier 1 singleton belongs here; the
 * unit test over the rule table fails when one is missing.
 */
export const TIER1_DISPATCH_RECEIVERS: readonly string[] = [
  'Object',
  'OS',
  'Engine',
  'ClassDB',
  'ProjectSettings',
  'ResourceLoader',
  'GDExtensionManager',
];

/** The `Object` methods that call a method named by their first argument. */
const OBJECT_DISPATCH_METHODS: readonly string[] = ['call', 'callv', 'call_deferred'];

/** The dispatch method whose forwarded arguments are the elements of an array. */
const ARRAY_DISPATCH_METHOD = 'callv';

/**
 * Every method that calls a method named by its first argument: the three on
 * `Object`, and the two `Node` adds. A call to one of them with a literal name
 * is evaluated as the call it makes (`reflectiveCallTarget`).
 */
const REFLECTIVE_DISPATCH_METHODS: ReadonlySet<string> = new Set([
  ...OBJECT_DISPATCH_METHODS,
  'call_deferred_thread_group',
  'call_thread_safe',
]);

/** A string literal that can be a method name. */
const METHOD_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How many dispatch methods a reflective call may name in a row
 * (`OS.call("call", "callv", ...)`) before the policy stops following and
 * treats the method as not known.
 */
const MAX_DISPATCH_DEPTH = 4;

/**
 * The guarded names that are a value in their own right, so that giving one
 * another name carries every Tier 1 primitive it has past the chain rules:
 * the engine singletons with Tier 1 chain rules, and `GDScript`, whose static
 * `new()` is the primitive. Each gets a Tier 2 `tier2.alias.<Name>` rule.
 */
export const TIER1_ALIASABLE_NAMES: readonly string[] = [
  'OS',
  'Engine',
  'ClassDB',
  'ProjectSettings',
  'ResourceLoader',
  'GDExtensionManager',
  'GDScript',
];

/**
 * Heads of Tier 1 chain rules that get no alias rule, with the reason. The
 * unit test over the rule table fails when a Tier 1 chain head is in neither
 * list.
 *  - `Object`, `Node`: classes named in annotations, `extends` and
 *    `is_instance_of` throughout ordinary code. Their Tier 1 rules guard the
 *    static-looking spelling of an instance method, which an alias of the
 *    class does not reach either.
 *  - `ConfigFile`: every reference already fires `tier2.config.ConfigFile`.
 */
export const TIER1_NAMES_WITHOUT_ALIAS_RULE: readonly string[] = ['Object', 'Node', 'ConfigFile'];

/** One Tier 2 rule per aliasable name: the name used as a value. */
function aliasRules(): PolicyRule[] {
  return TIER1_ALIASABLE_NAMES.map((name) => ({
    id: `tier2.alias.${name}`,
    tier: 2 as const,
    chain: [name],
    valueReferenceOnly: true,
    reason: `${name} is used as a value, so it can be called under another name or by subscript, past the ${name}.* rules`,
    solutions: [`Call ${name} methods directly as ${name}.method(...)`],
  }));
}

/**
 * One Tier 1 rule and one Tier 3 rule per dispatch receiver and method: a
 * non-literal method name is dynamic dispatch onto a receiver whose methods
 * include Tier 1 primitives; a literal name that reached this rule names a
 * method no other rule covers, and is only noted. "Literal" means the policy
 * read the method the call ends at (`resolveReflectiveCall`): a first argument
 * that is a string but does not compile to an identifier, or that names a
 * further dispatch the policy could not follow, counts as non-literal.
 */
function reflectiveDispatchRules(tier: 1 | 3): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const receiver of TIER1_DISPATCH_RECEIVERS) {
    for (const method of OBJECT_DISPATCH_METHODS) {
      rules.push(
        tier === 1
          ? {
              id: `tier1.indirect.${receiver}.${method}.nonliteral`,
              tier: 1,
              chain: [receiver, method],
              argumentKind: 'nonliteral',
              reason: `${receiver}.${method} with a non-literal method name is dynamic dispatch that bypasses the ${receiver}.* rules`,
              solutions: [`Call the ${receiver} method directly by name`],
            }
          : {
              id: `tier3.literal.${receiver}.${method}`,
              tier: 3,
              chain: [receiver, method],
              argumentKind: 'literal',
              reason: `${receiver}.${method} with a literal method name`,
              solutions: [`Consider calling the ${receiver} method directly`],
            },
      );
    }
  }
  return rules;
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

  {
    id: 'tier1.direct_exec.OS.create_instance',
    tier: 1,
    chain: ['OS', 'create_instance'],
    reason: 'OS.create_instance starts another Godot process with arbitrary arguments',
    solutions: ['Restructure the script to operate only on the scene tree'],
  },
  {
    id: 'tier1.native.GDExtensionManager.load_extension',
    tier: 1,
    chain: ['GDExtensionManager', 'load_extension'],
    reason: 'GDExtensionManager.load_extension loads a native library into the process',
    solutions: ['Register extensions in the project, not from a script at runtime'],
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
    callOnly: true,
    reason:
      'Callable(target, "method") constructs runtime dynamic dispatch that bypasses static analysis',
    solutions: ['Call the method directly by name instead of constructing a Callable'],
  },
  // `set_script` is an instance method: the idiomatic call is
  // `node.set_script(s)` on a local, which the two class-name rules above
  // never see. The name is distinctive, so it is matched on any receiver, and
  // bare (on self, or after a call that breaks the chain).
  {
    id: 'tier2.reflection.set_script.bareIdentifier',
    tier: 2,
    chain: ['set_script'],
    matchLastSegment: true,
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
  // `GDScript.new()` is how source held in a string becomes running code
  // (`source_code = ...` then `reload()`), which is what `Expression` does for
  // one expression. Keyed on the `.new` chain, a static constructor whose
  // receiver is always the literal class name, so a `: GDScript` annotation
  // and an `is GDScript` test are not matched.
  {
    id: 'tier1.dynamic.GDScript.new',
    tier: 1,
    chain: ['GDScript', 'new'],
    reason:
      'GDScript.new() creates a script object whose source can be set and compiled at runtime',
    solutions: [
      'Write the code as a script file in the project and attach it with the attach_script MCP tool',
    ],
  },
  {
    id: 'tier1.dynamic.str_to_var',
    tier: 1,
    chain: ['str_to_var'],
    matchAsBareIdentifier: true,
    globalFunctionOnly: true,
    reason: 'str_to_var deserializes GDScript values, including code-bearing types',
    solutions: ['Parse the input format manually'],
  },
  {
    id: 'tier1.dynamic.bytes_to_var_with_objects',
    tier: 1,
    chain: ['bytes_to_var_with_objects'],
    matchAsBareIdentifier: true,
    globalFunctionOnly: true,
    reason: 'bytes_to_var_with_objects deserializes objects, including scripts',
    solutions: ['Use bytes_to_var (no _with_objects) for data-only deserialization'],
  },

  // Reading or assigning a script's source at runtime is the other half of
  // `GDScript.new()`: `get_script().duplicate()` gives a script object without
  // naming the class, and `source_code = ...` then `reload()` compiles it.
  // Tier 2, not Tier 1: `source_code` is also a plausible name for a game's
  // own variable (a code-editor widget, a programming puzzle), and a bare
  // name cannot be told from the `Script` property.
  {
    id: 'tier2.dynamic.source_code',
    tier: 2,
    chain: ['source_code'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    reason:
      'source_code is the text a script object compiles: assigning it and reloading runs code held in a string',
    solutions: [
      'Write the code as a script file in the project and attach it with the attach_script MCP tool',
      'Rename the variable if `source_code` is a name of your own',
    ],
  },
  // `JavaScriptBridge` is a singleton, so the class name is the receiver.
  // Tier 2: a web export calls it for ordinary browser integration.
  {
    id: 'tier2.dynamic.JavaScriptBridge.eval',
    tier: 2,
    chain: ['JavaScriptBridge', 'eval'],
    reason: 'JavaScriptBridge.eval runs a string as JavaScript in the hosting page (web exports)',
    solutions: ['Confirm the JavaScript being evaluated is intentional'],
  },
  // An instance id is a number, so the object it names is invisible to every
  // receiver-based rule.
  {
    id: 'tier2.reflection.instance_from_id',
    tier: 2,
    chain: ['instance_from_id'],
    matchAsBareIdentifier: true,
    globalFunctionOnly: true,
    reason: 'instance_from_id returns any live object by number, past every rule keyed on a name',
    solutions: ['Reach the object through the scene tree or a reference you already hold'],
  },
  // A guarded singleton or class used as a value: `var o = OS`, `foo(OS)`,
  // `[OS][0]`, `OS["execute"]`.
  ...aliasRules(),

  // ---- Tier 1: ConfigFile load family ----
  // These three fire only on the static-looking `ConfigFile.method(p)` form.
  // The idiomatic form is an instance method (`var cf := ConfigFile.new();
  // cf.load(p)`), which a chain-prefix rule cannot reach and which no
  // last-segment rule may reach either: `load`, `save`, and `parse` are
  // generic names that appear on unrelated receivers throughout ordinary
  // game code, so keying on them alone would hard-block that code. Instance
  // usage is covered instead by the `tier2.config.ConfigFile` class anchor
  // further down, which fires on the `ConfigFile` reference itself.
  {
    id: 'tier1.config.ConfigFile.load',
    tier: 1,
    chain: ['ConfigFile', 'load'],
    reason: 'ConfigFile.load can pull in attacker-controlled config',
    solutions: ['Load configuration from a known-safe path via FileAccess.READ'],
  },
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
    globalFunctionOnly: true,
    argumentKind: 'nonliteral',
    reason: 'load() with a non-literal path can be redirected to any resource',
    solutions: ['Pass a literal `res://...` path string to load()'],
  },
  {
    id: 'tier1.indirect.preload.nonliteral',
    tier: 1,
    chain: ['preload'],
    matchAsBareIdentifier: true,
    globalFunctionOnly: true,
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
    id: 'tier1.indirect.ResourceLoader.load_threaded_request.nonliteral',
    tier: 1,
    chain: ['ResourceLoader', 'load_threaded_request'],
    argumentKind: 'nonliteral',
    reason: 'ResourceLoader.load_threaded_request with a non-literal path can be redirected',
    solutions: ['Pass a literal `res://...` path to ResourceLoader.load_threaded_request'],
  },
  // A method name that is not a literal, on a receiver that carries Tier 1
  // primitives: `OS.call(name)`, `Engine.callv(name, args)`,
  // `ClassDB.call_deferred(name)`.
  ...reflectiveDispatchRules(1),

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
  // `remove`, `copy` and `rename` are instance methods with generic names, so
  // these three guard the static-looking spelling only; instance use is noted
  // by the `tier3.fs.DirAccess` class anchor (docs/security.md).
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
    id: 'tier2.fs.DirAccess.copy_absolute',
    tier: 2,
    chain: ['DirAccess', 'copy_absolute'],
    reason: 'DirAccess.copy_absolute writes a file anywhere on disk',
    solutions: ['Confirm the copy is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.rename_absolute',
    tier: 2,
    chain: ['DirAccess', 'rename_absolute'],
    reason: 'DirAccess.rename_absolute moves or renames a file anywhere on disk',
    solutions: ['Confirm the rename is intentional'],
  },
  {
    id: 'tier2.fs.DirAccess.create_link',
    tier: 2,
    chain: ['create_link'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
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
    globalFunctionOnly: true,
    argumentKind: 'literal',
    reason: 'load() with a literal path can run _init code in the loaded resource',
    solutions: ['Verify the resource path is trusted'],
  },
  {
    id: 'tier3.literal.preload',
    tier: 3,
    chain: ['preload'],
    matchAsBareIdentifier: true,
    globalFunctionOnly: true,
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
    id: 'tier3.literal.ResourceLoader.load_threaded_request',
    tier: 3,
    chain: ['ResourceLoader', 'load_threaded_request'],
    argumentKind: 'literal',
    reason: 'ResourceLoader.load_threaded_request with a literal path can run _init code',
    solutions: ['Verify the resource path is trusted'],
  },
  // A literal method name is first evaluated as the call it makes, so these
  // are reached only for a method no other rule covers.
  ...reflectiveDispatchRules(3),
  {
    id: 'tier3.os_alert',
    tier: 3,
    chain: ['OS', 'alert'],
    reason: 'OS.alert opens a modal dialog and blocks the project',
    solutions: ['Remove the OS.alert call if running headlessly'],
  },

  // ---- Tier 2: resource and filesystem write primitives ----
  // Every rule below is Tier 2; strict mode promotes each to Tier 1 for free
  // via the evaluator's existing promotion step. Scope is runtime-reachable
  // classes only — no EditorInterface / editor-only surface. Shape choice:
  // matchLastSegment for distinctive method names that appear on arbitrary receivers (an instance-method primitive
  // whose receiver is a local variable, never the literal class name — the
  // exact bug this sweep is closing elsewhere); a two-segment chain prefix
  // for methods that are singletons or static (so `ClassName.method(...)`
  // really is the idiomatic call form); a single-segment class anchor for a
  // class whose own generic-named instance methods (bare `save`, etc.) are
  // unreachable by a token-level scanner, so the class reference itself
  // (typically `ClassName.new()`) is the signal instead. No bare `save` or
  // `call`-style last-segment rule is added — see the negative tests in
  // `run-script-policy.test.ts` "write-primitive negatives".
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
  // matchLastSegment: the idiomatic form is `tex.get_image().save_png(p)`
  // — a call (`get_image()`) sits between the receiver and the write method,
  // which the scanner cannot chain across, so `save_png` etc. surface as a
  // bare identifier with zero receiver context (see tokenMatchesRule's
  // matchLastSegment fallthrough). Safe to match with no receiver at all
  // because these names are distinctive image-write verbs, not a generic
  // name like `save` that appears on unrelated objects. That same reasoning
  // is why `take_over_path`, `save_encrypted`, and `save_encrypted_pass`
  // above do NOT get this flag — their idiomatic forms are plain
  // `receiver.method(...)` with no intervening call, so matchLastSegment
  // alone already reaches them.
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
  // After every DirAccess rule above, so a call one of them names keeps its
  // own finding. Tier 3, one below the primitives it stands for.
  {
    id: 'tier3.fs.DirAccess',
    tier: 3,
    chain: ['DirAccess'],
    reason:
      'A DirAccess instance can remove, copy and rename files, and those method names are too common to match on their own',
    solutions: ['Check what the script does with the directory it opens'],
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
  // reflexive elicitation approval. Both also match as a bare identifier:
  // `call(name)` with no receiver is `Object.call` on self, and
  // `get_node("A").call(name)` leaves `call` bare after the call that breaks
  // the chain. The name is `Object`'s own method in either position.
  {
    id: 'tier2.generic.call.nonliteral',
    tier: 2,
    chain: ['call'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
    argumentKind: 'nonliteral',
    reason:
      'A non-literal .call on an arbitrary receiver is dynamic dispatch that bypasses static analysis',
    solutions: [
      'Call the method directly by name',
      `If the receiver is ${TIER1_DISPATCH_RECEIVERS.join('/')}, that dedicated rule already governs this call`,
    ],
  },
  {
    id: 'tier2.generic.callv.nonliteral',
    tier: 2,
    chain: ['callv'],
    matchLastSegment: true,
    matchAsBareIdentifier: true,
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

function tokenMatchesRule(tok: Token, rule: PolicyRule, isValueReference: boolean): boolean {
  if (rule.globalFunctionOnly && tok.precededByDot) return false;
  if (rule.valueReferenceOnly) {
    return (
      isValueReference &&
      tok.kind === 'identifier' &&
      !tok.precededByDot &&
      tok.text === rule.chain[0]
    );
  }
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

/**
 * The first rule the token fires, or undefined. `openParen` is the index of
 * the `(` of the call the token makes, or -1 when it is not called;
 * `firstArgument` classifies the argument an `argumentKind` rule looks at;
 * `isValueReference` says whether the token stands where a value does (see
 * `valueReferencePositions`).
 */
function firstMatchingRule(
  tok: Token,
  openParen: number,
  firstArgument: () => ArgumentClassification,
  isValueReference: boolean,
): PolicyRule | undefined {
  for (const rule of policyRules) {
    if (!tokenMatchesRule(tok, rule, isValueReference)) continue;
    if (rule.callOnly && openParen === -1) continue;
    if (rule.argumentKind) {
      if (openParen === -1) continue;
      if (firstArgument() !== rule.argumentKind) continue;
    }
    return rule;
  }
  return undefined;
}

/** The call a reflective dispatch makes, as the policy evaluates it. */
interface ReflectiveCallTarget {
  /** The token of the equivalent direct call: `OS.execute` for `OS.call("execute", ...)`. */
  token: Token;
  /** The dispatch as written, with the method names it gives: `OS.call("execute")`. */
  matchedText: string;
  /** Classification of the first argument that call receives. */
  firstArgument: () => ArgumentClassification;
}

/**
 * What a reflective dispatch resolves to: the direct call it stands for, or
 * `opaque` when the method it names cannot be read from the source.
 */
type DispatchResolution = { kind: 'target'; target: ReflectiveCallTarget } | { kind: 'opaque' };

const OPAQUE_DISPATCH: DispatchResolution = { kind: 'opaque' };

/**
 * The method name an argument gives, or null when it is not one plain string
 * literal whose compiled value is an identifier. The literal is decoded first,
 * so `"\u0065xecute"` names `execute`; an expression, an escape GDScript does
 * not define, and a string that is not an identifier all give null.
 */
function methodNameOf(argument: readonly Token[]): string | null {
  if (argument.length !== 1 || argument[0]!.kind !== 'string') return null;
  const name = decodeStringLiteral(argument[0]!);
  return name !== null && METHOD_NAME_REGEX.test(name) ? name : null;
}

/** True when an argument is one string literal that decodes (it has no undefined escape). */
function isPlainTextArgument(argument: readonly Token[]): boolean {
  return (
    argument.length === 1 &&
    argument[0]!.kind === 'string' &&
    decodeStringLiteral(argument[0]!) !== null
  );
}

/**
 * True when the call's receiver is one the Tier 1 dispatch rules cover. Those
 * rules match on the head of the chain (`OS.call`), so the head is tested.
 */
function isTier1DispatchReceiver(chain: readonly string[]): boolean {
  return chain.length >= 2 && TIER1_DISPATCH_RECEIVERS.includes(chain[0]!);
}

/**
 * The elements of an argument that is exactly one array literal, or null when
 * it is anything else (a variable, `[a] + b`, no argument at all). The literal
 * is looked for from `callOpenParen` on: a search from the start of the script
 * would cost its whole length at every call.
 */
function arrayLiteralElements(
  tokens: readonly Token[],
  argument: readonly Token[],
  callOpenParen: number,
  budget: ScanBudget,
): Token[][] | null {
  const first = argument[0];
  if (first === undefined || first.kind !== 'punct' || first.text !== '[') return null;
  let depth = 0;
  for (let k = 0; k < argument.length; k++) {
    const tok = argument[k]!;
    if (tok.kind !== 'punct') continue;
    if (tok.text === '[' || tok.text === '(') depth++;
    else if (tok.text === ']' || tok.text === ')') depth--;
    // The bracket that opened the argument must close on its last token.
    if (depth === 0 && k < argument.length - 1) return null;
  }
  if (depth !== 0) return null;
  return argumentsOfArray(tokens, tokens.indexOf(first, callOpenParen), budget);
}

/**
 * `X.call("m", a)`, `X.callv("m", [a])` and `X.call_deferred("m", a)` call
 * `X.m(a)`. When the token at `tokens[i]` is such a dispatch, resolve the call
 * it stands for, so the same rule fires at the same tier as the direct
 * spelling. A method that is itself a dispatch (`X.call("callv", "m", [a])`)
 * is followed to the method it names in turn, up to `MAX_DISPATCH_DEPTH`.
 *
 * Null when the token is not a dispatch method, or is one called with no
 * argument. `opaque` when the method cannot be read: the name is not a plain
 * string literal that compiles to an identifier, a `callv` in the chain gets
 * something other than an array literal, or the chain is deeper than the
 * bound. The caller then judges the call as dispatch by a non-literal name.
 *
 * With no receiver in the token (`call("m")` on self, or after a call that
 * broke the chain) the target is a method of an object the scanner cannot
 * see, so it is marked as following a `.`: rules for a global function never
 * read it as one.
 */
function resolveReflectiveCall(
  tokens: readonly Token[],
  i: number,
  openParen: number,
  budget: ScanBudget,
): DispatchResolution | null {
  const tok = tokens[i]!;
  const chain = tok.kind === 'memberChain' && tok.chain ? tok.chain : [tok.text];
  let dispatch = chain[chain.length - 1]!;
  if (!REFLECTIVE_DISPATCH_METHODS.has(dispatch)) return null;

  const firstScan = argumentsOf(tokens, openParen, budget);
  if (firstScan === null) return OPAQUE_DISPATCH;
  let args: Token[][] = firstScan;
  if ((args[0] ?? []).length === 0) return null;

  const names: string[] = [];
  for (let depth = 0; depth < MAX_DISPATCH_DEPTH; depth++) {
    const method = methodNameOf(args[0] ?? []);
    if (method === null) {
      // The first argument is a text that is not a method name (`cb.call("Level
      // complete!")`): an ordinary call with a string argument, not dispatch.
      // A Tier 1 receiver keeps its decision, since the dispatch rules for it
      // judge any name the policy cannot read. Only the first name is judged
      // this way; after a nested dispatch the text is a forwarded argument.
      if (depth === 0 && isPlainTextArgument(args[0] ?? []) && !isTier1DispatchReceiver(chain)) {
        return null;
      }
      return OPAQUE_DISPATCH;
    }
    names.push(method);
    // callv forwards the elements of its array argument; the others forward
    // what follows the name.
    const forwardedArray = args[1] ?? [];
    const forwarded =
      dispatch === ARRAY_DISPATCH_METHOD
        ? arrayLiteralElements(tokens, forwardedArray, openParen, budget)
        : args.slice(1);

    if (REFLECTIVE_DISPATCH_METHODS.has(method)) {
      if (forwarded === null) return OPAQUE_DISPATCH;
      dispatch = method;
      args = forwarded;
      continue;
    }

    const receiver = chain.slice(0, -1);
    const token: Token =
      receiver.length > 0
        ? { ...tok, kind: 'memberChain', chain: [...receiver, method] }
        : { ...tok, kind: 'identifier', text: method, precededByDot: true };
    const firstArgument = (): ArgumentClassification => {
      // Anything but an array literal is an argument list the scanner cannot read.
      if (forwarded === null) return forwardedArray.length === 0 ? 'none' : 'nonliteral';
      return classifyArgument(forwarded[0] ?? []);
    };
    const matchedText = `${tok.text}(${names.map((name) => `"${name}"`).join(', ')})`;
    return { kind: 'target', target: { token, matchedText, firstArgument } };
  }
  return OPAQUE_DISPATCH;
}

/** The tokens of each top-level element of the array literal whose `[` is at `openBracketIndex`. */
function argumentsOfArray(
  tokens: readonly Token[],
  openBracketIndex: number,
  budget: ScanBudget,
): Token[][] | null {
  const elements: Token[][] = [[]];
  let depth = 0;
  for (let j = openBracketIndex + 1; j < tokens.length; j++) {
    if (budget.remaining-- <= 0) return null;
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;
    if (tok.kind === 'punct') {
      if (tok.text === '(' || tok.text === '[') {
        depth++;
      } else if (tok.text === ']' || tok.text === ')') {
        if (depth === 0) break;
        depth--;
      } else if (tok.text === ',' && depth === 0) {
        elements.push([]);
        continue;
      }
    }
    elements[elements.length - 1]!.push(tok);
  }
  return elements;
}

/** Keywords after which a name is a type, not a value. */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set(['as', 'is', 'extends']);
/** Keywords after which a name is being declared. */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'var',
  'const',
  'func',
  'class',
  'class_name',
  'signal',
  'enum',
]);
/** The generic containers whose `[...]` holds types: `Array[OS]`, `Dictionary[String, OS]`. */
const TYPED_CONTAINER_NAMES: ReadonlySet<string> = new Set(['Array', 'Dictionary']);
const OPENING_BRACKETS: ReadonlySet<string> = new Set(['(', '[', '{']);
const CLOSING_BRACKETS: ReadonlySet<string> = new Set([')', ']', '}']);
const DICTIONARY_OPEN = '{';

/**
 * For every token index, whether an identifier there stands where a value
 * does. False where the name is a type or is being declared:
 *  - after `:` that follows a name outside a dictionary literal (`var x: OS`,
 *    `func f(a: OS)`); inside `{...}` the colon separates a key from a value;
 *  - after `->` (a return type), `as`, `is`, `is not` and `extends`;
 *  - inside the brackets of `Array[...]` or `Dictionary[...]`;
 *  - after `var`, `const`, `func`, `class`, `class_name`, `signal`, `enum`.
 * `:=` is an assignment, so the name after it is a value.
 */
function valueReferencePositions(tokens: readonly Token[]): boolean[] {
  const positions: boolean[] = new Array<boolean>(tokens.length).fill(false);
  const open: Array<{ bracket: string; holdsTypes: boolean }> = [];
  let previous: Token | undefined;
  let beforePrevious: Token | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'newline') continue;
    const innermost = open[open.length - 1];

    if (tok.kind === 'identifier') {
      const afterAnnotationColon =
        previous?.kind === 'other' &&
        previous.text === ':' &&
        beforePrevious?.kind === 'identifier' &&
        innermost?.bracket !== DICTIONARY_OPEN;
      const afterArrow =
        previous?.kind === 'other' &&
        previous.text === '>' &&
        beforePrevious?.kind === 'other' &&
        beforePrevious.text === '-';
      const afterKeyword =
        previous?.kind === 'identifier' &&
        (TYPE_KEYWORDS.has(previous.text) ||
          DECLARATION_KEYWORDS.has(previous.text) ||
          (previous.text === 'not' &&
            beforePrevious?.kind === 'identifier' &&
            beforePrevious.text === 'is'));
      positions[i] =
        !afterAnnotationColon && !afterArrow && !afterKeyword && innermost?.holdsTypes !== true;
    }

    if (OPENING_BRACKETS.has(tok.text) && (tok.kind === 'punct' || tok.kind === 'other')) {
      open.push({
        bracket: tok.text,
        holdsTypes:
          tok.text === '[' &&
          previous?.kind === 'identifier' &&
          TYPED_CONTAINER_NAMES.has(previous.text),
      });
    } else if (CLOSING_BRACKETS.has(tok.text) && (tok.kind === 'punct' || tok.kind === 'other')) {
      open.pop();
    }
    beforePrevious = previous;
    previous = tok;
  }
  return positions;
}

/** The first argument of a dispatch whose method name the policy could not read. */
const UNREADABLE_METHOD_NAME: ArgumentClassification = 'nonliteral';

export function evaluateScript(source: string, strict = false): PolicyDecision {
  const tokens = tokenize(source);
  const budget = newScanBudget(tokens.length);
  const valueReferences = valueReferencePositions(tokens);
  const matches: PolicyMatch[] = [];
  let promotedByStrict = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind !== 'identifier' && tok.kind !== 'memberChain') continue;
    // The name a `func` declaration gives is not a use of that name.
    if (tok.precededByFunc) continue;

    const openParen = indexOfOpenParen(tokens, i);

    // A reflective dispatch with a literal method name is the direct call it
    // makes. When that call fires a rule, the finding is that rule's; when it
    // fires none, the token is evaluated as written. A dispatch whose method
    // name cannot be read is evaluated as written too, as dispatch by a
    // non-literal name, whatever its first argument looks like.
    let matched: { rule: PolicyRule; text: string } | undefined;
    const dispatch = openParen === -1 ? null : resolveReflectiveCall(tokens, i, openParen, budget);
    if (dispatch?.kind === 'target') {
      const { target } = dispatch;
      const rule = firstMatchingRule(target.token, openParen, target.firstArgument, false);
      if (rule !== undefined) matched = { rule, text: target.matchedText };
    }
    if (matched === undefined) {
      // Each token may only fire one rule (the first match wins). Subsequent
      // rules of the same kind would only duplicate the finding.
      const firstArgument =
        dispatch?.kind === 'opaque'
          ? (): ArgumentClassification => UNREADABLE_METHOD_NAME
          : (): ArgumentClassification => classifyFirstArgument(tokens, openParen, budget);
      const rule = firstMatchingRule(tok, openParen, firstArgument, valueReferences[i] === true);
      if (rule !== undefined) matched = { rule, text: tok.text };
    }
    if (matched === undefined) continue;

    let effectiveTier: Tier = matched.rule.tier;
    if (strict && matched.rule.tier === 2) {
      effectiveTier = 1;
      promotedByStrict = true;
    }

    matches.push({
      ruleId: matched.rule.id,
      tier: effectiveTier,
      line: tok.line,
      column: tok.column,
      matchedText: matched.text,
      reason: matched.rule.reason,
      solutions: matched.rule.solutions,
    });
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
  return `line ${m.line} ${m.matchedText} - ${m.reason}`;
}

/**
 * Build the human-readable warnings array attached to a `warn` decision.
 */
export function matchesToWarnings(matches: readonly PolicyMatch[]): string[] {
  return matches.map((m) => `Warning line ${m.line}: ${m.matchedText} - ${m.reason}`);
}
