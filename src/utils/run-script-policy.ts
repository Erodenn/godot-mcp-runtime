/** Declarative policy table and evaluator for run_script / run_project gating: a best-effort filter, not a sandbox (see `docs/security.md`, 'What this does NOT do'). */

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
  /** Highest tier among matches after strict-mode promotion; null when nothing matched. */
  effectiveTier: Tier | null;
  matches: PolicyMatch[];
  promotedByStrict: boolean;
}

/** A rule matches when a `memberChain` starts with `chain`; `argumentKind` classifies the call's whole first argument, so `"a" + b` is non-literal, not the literal `"a"`. */
interface PolicyRule {
  id: string;
  tier: Tier;
  chain: readonly string[];
  /** A no-argument call ('none') never matches either kind; absent means any context matches. */
  argumentKind?: 'literal' | 'nonliteral';
  /** Also fire as a bare identifier: global functions and, with `matchLastSegment`, a method whose receiver contains a call (`tex.get_image().save_png(p)`), which the scanner cannot chain.
   * Only for names distinctive enough to match with no receiver at all. */
  matchAsBareIdentifier?: boolean;
  /** Match when the single `chain` segment is the last of any chain of length >= 2, for the generic `.call`/`.callv` rule that must fire on any receiver.
   * With `matchAsBareIdentifier` it also covers `foo().method(...)`, where a call breaks the chain. */
  matchLastSegment?: boolean;
  /** Rule targets a global function (`load`, `preload`, `str_to_var`): a token after `.` is another receiver's method and never matches, or `save_manager.load(slot)` would be hard-blocked.
   * Never set on a method primitive (`set_script`, `save_png`). */
  globalFunctionOnly?: boolean;
  /** Require the token to be called (followed by `(`), for a constructor name that also appears as a type annotation (`cb: Callable`). */
  callOnly?: boolean;
  /** The rule targets a guarded name used as a value (`var o = OS`, `OS["execute"]`): a bare identifier only, not a chain head, after `.`, or where it is a type or declaration. Never above Tier 2. */
  valueReferenceOnly?: boolean;
  reason: string;
  solutions: string[];
}

export type ArgumentClassification = 'literal' | 'nonliteral' | 'none';

/** Token visits per script token that argument scanning may spend: nested calls re-scan the inner region at every level, so the budget keeps the total linear. */
const SCAN_BUDGET_PER_TOKEN = 64;

interface ScanBudget {
  remaining: number;
}

function newScanBudget(tokenCount: number): ScanBudget {
  return { remaining: tokenCount * SCAN_BUDGET_PER_TOKEN };
}

/** The tokens of each top-level argument of the call opened at `openParenIndex`; null when the scan budget ran out, so the arguments are unknown. */
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

/** No tokens is 'none' (a no-arg call must not match a non-literal rule); one string literal is 'literal'; anything else is 'nonliteral'. */
const UNREADABLE_ARGUMENT: ArgumentClassification = 'nonliteral';

function classifyArgument(argument: readonly Token[]): ArgumentClassification {
  if (argument.length === 0) return 'none';
  if (argument.length === 1 && argument[0]!.kind === 'string') return 'literal';
  return 'nonliteral';
}

/** Classifies the whole first argument, so `load("res://" + evil_var)` is 'nonliteral' rather than matching on the leading literal. */
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

/** Receivers of Tier 1 chain-prefix rules that can be handed a method name at runtime: naming one with a non-literal string reaches every Tier 1 primitive it has.
 * `Node` and `ConfigFile` are deliberately absent (classes, reached only through instances the scanner cannot see); a new Tier 1 singleton belongs here and the rule-table unit test fails without it. */
export const TIER1_DISPATCH_RECEIVERS: readonly string[] = [
  'Object',
  'OS',
  'Engine',
  'ClassDB',
  'ProjectSettings',
  'ResourceLoader',
  'GDExtensionManager',
];

const OBJECT_DISPATCH_METHODS: readonly string[] = ['call', 'callv', 'call_deferred'];

/** The dispatch method whose forwarded arguments are the elements of an array. */
const ARRAY_DISPATCH_METHOD = 'callv';

/** Every method that calls a method named by its first argument; a literal name is evaluated as the call it makes (`reflectiveCallTarget`). */
const REFLECTIVE_DISPATCH_METHODS: ReadonlySet<string> = new Set([
  ...OBJECT_DISPATCH_METHODS,
  'call_deferred_thread_group',
  'call_thread_safe',
]);

const METHOD_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How many dispatch methods a reflective call may name in a row before the policy stops following and treats the method as unknown. */
const MAX_DISPATCH_DEPTH = 4;

/** Guarded names that are values in their own right: giving one another name carries its Tier 1 primitives past the chain rules, so each gets a Tier 2 `tier2.alias.<Name>` rule. */
export const TIER1_ALIASABLE_NAMES: readonly string[] = [
  'OS',
  'Engine',
  'ClassDB',
  'ProjectSettings',
  'ResourceLoader',
  'GDExtensionManager',
  'GDScript',
];

/** Tier 1 chain heads with no alias rule (the rule-table unit test fails when a head is in neither list): `Object` and `Node` are classes named in annotations throughout ordinary code, and `ConfigFile` already fires `tier2.config.ConfigFile` on every reference. */
export const TIER1_NAMES_WITHOUT_ALIAS_RULE: readonly string[] = ['Object', 'Node', 'ConfigFile'];

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

/** One Tier 1 and one Tier 3 rule per dispatch receiver and method: a non-literal name is dynamic dispatch onto Tier 1 primitives, a literal that reached here names a method no other rule covers. A string that does not compile to an identifier counts as non-literal. */
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

export const policyRules: readonly PolicyRule[] = [
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
  // `node.set_script(s)` on a local is the idiomatic call and invisible to the class-name rules above: matched on any receiver, and bare.
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

  {
    id: 'tier1.dynamic.Expression',
    tier: 1,
    chain: ['Expression'],
    reason: 'Expression evaluates arbitrary GDScript expressions at runtime',
    solutions: ['Compute the value directly in GDScript instead of via Expression'],
  },
  // `GDScript.new()` turns source held in a string into running code. Keyed on the `.new` chain, so a `: GDScript` annotation or `is GDScript` test is not matched.
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

  // Reading or assigning `source_code` is the other half of `GDScript.new()`. Tier 2, not 1: a game may name its own variable `source_code`,
  // and a bare name cannot be told from the `Script` property.
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
  // A singleton, so the class name is the receiver. Tier 2: a web export uses it for ordinary browser integration.
  {
    id: 'tier2.dynamic.JavaScriptBridge.eval',
    tier: 2,
    chain: ['JavaScriptBridge', 'eval'],
    reason: 'JavaScriptBridge.eval runs a string as JavaScript in the hosting page (web exports)',
    solutions: ['Confirm the JavaScript being evaluated is intentional'],
  },
  // An instance id is a number, so the object it names is invisible to every receiver-based rule.
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

  // Static-looking `ConfigFile.method(p)` only: instance use is out of reach of a prefix rule, and `load`/`save`/`parse` are too generic for a last-segment rule.
  // Instances are covered by the `tier2.config.ConfigFile` class anchor below.
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
  // Non-literal method name on a receiver carrying Tier 1 primitives: `OS.call(name)`, `Engine.callv(name, args)`.
  ...reflectiveDispatchRules(1),

  // FileAccess.open is flagged uniformly at Tier 2 rather than inspecting the mode, biasing toward over-eliciting filesystem mutation.
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
  // `remove`, `copy` and `rename` are generic instance methods, so these guard the static spelling only; instance use is noted by the `tier3.fs.DirAccess` class anchor.
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

  // Tier 2 write primitives (strict mode promotes them). Instance-method primitives use `matchLastSegment`, static ones a two-segment prefix, and classes with
  // generic instance methods a class anchor; no bare `save`/`call` last-segment rule (see 'write-primitive negatives' in run-script-policy.test.ts).
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
  // The four Image writers also set matchAsBareIdentifier: in `tex.get_image().save_png(p)` a call sits between receiver and method, which the scanner cannot chain across.
  // Safe because these are distinctive verbs; the writers above take a plain `receiver.method(...)` and need no flag.
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

  // After every named-receiver `.call`/`.callv` rule (first match wins). Tier 2: benign code does `some_callable.call(...)`, and over-blocking trains reflexive approval.
  // Both also match bare: `call(name)` is `Object.call` on self, and `get_node("A").call(name)` leaves `call` bare after the chain-breaking call.
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

/** Index of the `(` following token `i` (newlines allowed between), or -1. */
function indexOfOpenParen(tokens: readonly Token[], i: number): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;
    if (tok.kind === 'punct' && tok.text === '(') return j;
    return -1;
  }
  return -1;
}

/** `matchAsBareIdentifier` on its own, shared by the bare-identifier path and the `matchLastSegment` fallthrough so the two stay in sync. */
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
    // A call broke the chain, leaving the method a bare identifier (`tex.get_image().save_png(p)`): only rules that opted into `matchAsBareIdentifier` get a second chance.
    return matchesBareIdentifier(tok, rule);
  }
  if (matchesBareIdentifier(tok, rule)) {
    return true;
  }
  if (rule.chain.length === 1) {
    // A single-segment chain on a type reference (`HTTPRequest`) matches an identifier or the head of any chain (`HTTPRequest.new`).
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

/** The first rule the token fires; `openParen` is the call's `(` or -1, `firstArgument` feeds `argumentKind`, `isValueReference` says whether the token stands where a value does. */
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
  matchedText: string;
  firstArgument: () => ArgumentClassification;
}

/** What a dispatch resolves to: the direct call it stands for, or `opaque` when the method name cannot be read. */
type DispatchResolution = { kind: 'target'; target: ReflectiveCallTarget } | { kind: 'opaque' };

const OPAQUE_DISPATCH: DispatchResolution = { kind: 'opaque' };

/** The method name an argument gives, or null unless it is one string literal whose decoded value is an identifier (a unicode-escaped spelling still names its method). */
function methodNameOf(argument: readonly Token[]): string | null {
  if (argument.length !== 1 || argument[0]!.kind !== 'string') return null;
  const name = decodeStringLiteral(argument[0]!);
  return name !== null && METHOD_NAME_REGEX.test(name) ? name : null;
}

function isPlainTextArgument(argument: readonly Token[]): boolean {
  return (
    argument.length === 1 &&
    argument[0]!.kind === 'string' &&
    decodeStringLiteral(argument[0]!) !== null
  );
}

/** True when the call's receiver is one the Tier 1 dispatch rules cover; they match on the chain head. */
function isTier1DispatchReceiver(chain: readonly string[]): boolean {
  return chain.length >= 2 && TIER1_DISPATCH_RECEIVERS.includes(chain[0]!);
}

/** The elements of an argument that is exactly one array literal, else null; searched from `callOpenParen` on, since a search from the script start would cost its whole length per call. */
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

/** Resolves `X.call("m", a)` / `callv` / `call_deferred` to the direct call `X.m(a)`, so the same rule fires at the same tier; nested dispatch is followed up to `MAX_DISPATCH_DEPTH`.
 * Null if the token is no dispatch or has no argument; `opaque` if the method cannot be read. With no receiver the target is marked as following a `.`, so global-function rules never read it. */
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
      // First argument is text, not a method name (`cb.call("Level complete!")`): an ordinary call, unless the receiver is Tier 1, whose dispatch rules judge any unreadable name.
      // Only the first name is judged so; after a nested dispatch it is a forwarded argument.
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

/** For every token index, whether an identifier there stands where a value does; false after `:` outside a dictionary literal, `->`, `as`, `is`, `extends`, inside `Array[...]`/`Dictionary[...]`, and after declaring keywords. */
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

    // A dispatch with a literal method name is the direct call it makes: that rule's finding if it fires one, else the token as written.
    // An unreadable name is evaluated as written, as dispatch by a non-literal name.
    let matched: { rule: PolicyRule; text: string } | undefined;
    const dispatch = openParen === -1 ? null : resolveReflectiveCall(tokens, i, openParen, budget);
    if (dispatch?.kind === 'target') {
      const { target } = dispatch;
      const rule = firstMatchingRule(target.token, openParen, target.firstArgument, false);
      if (rule !== undefined) matched = { rule, text: target.matchedText };
    }
    if (matched === undefined) {
      // Each token fires one rule (first match wins); later rules of the kind would only duplicate the finding.
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

/** One-line summary of the highest-priority finding, for the agent-facing error on a Tier 1 block or Tier 2 denial. */
export function summarizeMatch(m: PolicyMatch): string {
  return `line ${m.line} ${m.matchedText} - ${m.reason}`;
}

export function matchesToWarnings(matches: readonly PolicyMatch[]): string[] {
  return matches.map((m) => `Warning line ${m.line}: ${m.matchedText} - ${m.reason}`);
}
