/**
 * Policy evaluator tests. Verifies tier assignment, argument-shape checks,
 * strict-mode promotion, and that comments / strings don't false-positive.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateScript,
  policyRules,
  TIER1_ALIASABLE_NAMES,
  TIER1_DISPATCH_RECEIVERS,
  TIER1_NAMES_WITHOUT_ALIAS_RULE,
} from '../../src/utils/run-script-policy.js';

const VALID_PREFIX = 'extends RefCounted\nfunc execute(scene_tree):\n\t';

function evalLine(line: string): ReturnType<typeof evaluateScript> {
  return evaluateScript(VALID_PREFIX + line + '\n');
}

describe('evaluateScript: Tier 1 hard_block', () => {
  it('blocks OS.execute(...)', () => {
    const d = evalLine('OS.execute("rm", ["-rf", "/"])');
    expect(d.decision).toBe('hard_block');
    expect(d.effectiveTier).toBe(1);
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('blocks OS.create_process(...)', () => {
    expect(evalLine('OS.create_process("/bin/sh", [])').decision).toBe('hard_block');
  });

  it('blocks OS.shell_open(url)', () => {
    expect(evalLine('OS.shell_open("https://evil.example")').decision).toBe('hard_block');
  });

  it('blocks ProjectSettings.load_resource_pack(...)', () => {
    expect(evalLine('ProjectSettings.load_resource_pack("res://x.pck")').decision).toBe(
      'hard_block',
    );
  });

  it('blocks Engine.get_singleton(...)', () => {
    expect(evalLine('Engine.get_singleton("Foo")').decision).toBe('hard_block');
  });

  it('blocks ClassDB.instantiate(...)', () => {
    expect(evalLine('ClassDB.instantiate("OS")').decision).toBe('hard_block');
  });

  it('blocks set_script via Object.set_script', () => {
    expect(evalLine('Object.set_script(some_node, my_script)').decision).toBe('hard_block');
  });

  it('blocks Expression usage', () => {
    expect(evalLine('var e = Expression.new()').decision).toBe('hard_block');
  });

  it('blocks str_to_var as a bare identifier', () => {
    expect(evalLine('var v = str_to_var(data)').decision).toBe('hard_block');
  });

  it('blocks load() with a non-literal first argument', () => {
    const d = evalLine('var r = load(path_var)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(true);
  });

  it('blocks ResourceLoader.load with non-literal first arg', () => {
    expect(evalLine('var r = ResourceLoader.load(var_path)').decision).toBe('hard_block');
  });

  it('does NOT block load() with a literal string (Tier 3 warn instead)', () => {
    const d = evalLine('var r = load("res://foo.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.matches.some((m) => m.ruleId === 'tier3.literal.load')).toBe(true);
  });

  it('does NOT block preload() with a literal string', () => {
    const d = evalLine('var r = preload("res://foo.gd")');
    expect(d.decision).toBe('warn');
  });
});

describe('evaluateScript: Tier 2 elicit_required', () => {
  it('elicits on FileAccess.open(...)', () => {
    const d = evalLine('var f = FileAccess.open("res://x.txt", FileAccess.WRITE)');
    expect(d.decision).toBe('elicit_required');
    expect(d.effectiveTier).toBe(2);
  });

  it('elicits on HTTPRequest type reference', () => {
    expect(evalLine('var h = HTTPRequest.new()').decision).toBe('elicit_required');
  });

  it('elicits on TCPServer', () => {
    expect(evalLine('var s = TCPServer.new()').decision).toBe('elicit_required');
  });

  it('elicits on DirAccess.remove(...)', () => {
    expect(evalLine('DirAccess.remove("/x")').decision).toBe('elicit_required');
  });

  it('elicits on IP.resolve_hostname', () => {
    expect(evalLine('IP.resolve_hostname("example.com")').decision).toBe('elicit_required');
  });
});

describe('evaluateScript: Tier 3 warn', () => {
  it('warns on literal load() but executes', () => {
    const d = evalLine('var r = load("res://main.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.effectiveTier).toBe(3);
  });

  it('warns on OS.alert', () => {
    expect(evalLine('OS.alert("hi")').decision).toBe('warn');
  });
});

describe('evaluateScript: clean scripts', () => {
  it('returns ok for a script that touches only scene_tree', () => {
    const d = evaluateScript(
      'extends RefCounted\nfunc execute(scene_tree):\n\treturn scene_tree.get_root().get_child_count()\n',
    );
    expect(d.decision).toBe('ok');
    expect(d.effectiveTier).toBeNull();
    expect(d.matches).toHaveLength(0);
  });

  it('ignores dangerous identifiers in comments', () => {
    const d = evaluateScript(
      'extends RefCounted\nfunc execute(scene_tree):\n\t# OS.execute is dangerous, do not use\n\treturn 1\n',
    );
    expect(d.decision).toBe('ok');
  });

  it('ignores dangerous identifiers in string literals', () => {
    const d = evaluateScript(
      'extends RefCounted\nfunc execute(scene_tree):\n\tvar msg = "OS.execute is blocked"\n\treturn msg\n',
    );
    expect(d.decision).toBe('ok');
  });

  it('ignores dangerous identifiers in triple-quoted docstrings', () => {
    const source = [
      'extends RefCounted',
      'func execute(scene_tree):',
      '\tvar doc = """',
      '\tDo not call OS.execute or HTTPRequest.new() here.',
      '\t"""',
      '\treturn doc',
      '',
    ].join('\n');
    expect(evaluateScript(source).decision).toBe('ok');
  });
});

describe('evaluateScript: strict mode promotion', () => {
  it('promotes Tier 2 to Tier 1 when strict:true', () => {
    const source = VALID_PREFIX + 'var h = HTTPRequest.new()\n';
    const lax = evaluateScript(source, false);
    const strict = evaluateScript(source, true);
    expect(lax.decision).toBe('elicit_required');
    expect(lax.promotedByStrict).toBe(false);
    expect(strict.decision).toBe('hard_block');
    expect(strict.effectiveTier).toBe(1);
    expect(strict.promotedByStrict).toBe(true);
  });

  it('does NOT promote Tier 3 in strict mode', () => {
    const source = VALID_PREFIX + 'var r = load("res://foo.tscn")\n';
    const strict = evaluateScript(source, true);
    expect(strict.decision).toBe('warn');
    expect(strict.promotedByStrict).toBe(false);
  });

  it('promotes only the matching Tier 2 finding; pre-existing Tier 1 stays Tier 1', () => {
    const source = VALID_PREFIX + 'OS.execute("evil")\n' + '\tvar h = HTTPRequest.new()\n';
    const strict = evaluateScript(source, true);
    expect(strict.decision).toBe('hard_block');
    expect(strict.effectiveTier).toBe(1);
    expect(strict.promotedByStrict).toBe(true);
    // Both should have been recorded.
    expect(strict.matches.some((m) => m.ruleId.startsWith('tier1.direct_exec'))).toBe(true);
    expect(strict.matches.some((m) => m.ruleId.startsWith('tier2.net'))).toBe(true);
  });
});

describe('evaluateScript: highest tier wins', () => {
  it('reports hard_block when Tier 1 and Tier 2 both fire', () => {
    const source =
      VALID_PREFIX + 'OS.execute("x")\n' + '\tvar h = HTTPRequest.new()\n' + '\treturn 1\n';
    const d = evaluateScript(source);
    expect(d.decision).toBe('hard_block');
    expect(d.effectiveTier).toBe(1);
  });

  it('reports elicit_required when only Tier 2 and Tier 3 fire', () => {
    const source =
      VALID_PREFIX + 'var r = load("res://x.tscn")\n' + '\tvar h = HTTPRequest.new()\n';
    expect(evaluateScript(source).decision).toBe('elicit_required');
  });
});

describe('evaluateScript: finding line numbers', () => {
  it('records the line number of each match', () => {
    const source =
      'extends RefCounted\n' +
      'func execute(scene_tree):\n' +
      '\tvar a = 1\n' +
      '\tOS.execute("x")\n' +
      '\treturn a\n';
    const d = evaluateScript(source);
    expect(d.matches[0]?.line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Smoke tests for rules not covered above. One positive sample per rule.
// Negative coverage lives in the "clean scripts" block.
// ---------------------------------------------------------------------------

describe('evaluateScript: Tier 1 OS family (smoke)', () => {
  it('blocks OS.kill(...)', () => {
    expect(evalLine('OS.kill(1234)').effectiveTier).toBe(1);
  });
  it('blocks OS.execute_with_pipe(...)', () => {
    expect(evalLine('OS.execute_with_pipe("/bin/sh", [])').effectiveTier).toBe(1);
  });
  it('blocks OS.set_environment(...)', () => {
    expect(evalLine('OS.set_environment("PATH", "/evil")').effectiveTier).toBe(1);
  });
  it('blocks OS.unset_environment(...)', () => {
    expect(evalLine('OS.unset_environment("PATH")').effectiveTier).toBe(1);
  });
  it('blocks OS.set_restart_on_exit(...)', () => {
    expect(evalLine('OS.set_restart_on_exit(true)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 1 ProjectSettings/Engine/ClassDB (smoke)', () => {
  it('blocks ProjectSettings.save(...)', () => {
    expect(evalLine('ProjectSettings.save()').effectiveTier).toBe(1);
  });
  it('blocks ProjectSettings.save_custom(...)', () => {
    expect(evalLine('ProjectSettings.save_custom("res://x.cfg")').effectiveTier).toBe(1);
  });
  it('blocks Engine.register_singleton(...)', () => {
    expect(evalLine('Engine.register_singleton("Foo", obj)').effectiveTier).toBe(1);
  });
  it('blocks Engine.register_script_language(...)', () => {
    expect(evalLine('Engine.register_script_language(lang)').effectiveTier).toBe(1);
  });
  it('blocks ClassDB.class_call_static(...)', () => {
    expect(evalLine('ClassDB.class_call_static("OS", "execute", [])').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 1 reflection + dynamic (smoke)', () => {
  it('blocks Node.set_script(...) literal receiver', () => {
    expect(evalLine('Node.set_script(some_node, my_script)').effectiveTier).toBe(1);
  });
  it('blocks bytes_to_var_with_objects as bare identifier', () => {
    expect(evalLine('var v = bytes_to_var_with_objects(data)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 1 ConfigFile family (smoke)', () => {
  it('blocks ConfigFile.load(...)', () => {
    expect(evalLine('var r = ConfigFile.load("res://x.cfg")').effectiveTier).toBe(1);
  });
  it('blocks ConfigFile.load_encrypted(...)', () => {
    expect(evalLine('ConfigFile.load_encrypted(path, key)').effectiveTier).toBe(1);
  });
  it('blocks ConfigFile.parse(...)', () => {
    expect(evalLine('ConfigFile.parse(data)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 1 Object.callv non-literal (smoke)', () => {
  it('blocks Object.callv with non-literal method name', () => {
    expect(evalLine('Object.callv(method_var, args)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 2 DirAccess writes (smoke)', () => {
  it('elicits on DirAccess.copy(...)', () => {
    expect(evalLine('DirAccess.copy("a", "b")').effectiveTier).toBe(2);
  });
  it('elicits on DirAccess.rename(...)', () => {
    expect(evalLine('DirAccess.rename("a", "b")').effectiveTier).toBe(2);
  });
  it('elicits on DirAccess.create_link(...)', () => {
    expect(evalLine('DirAccess.create_link("a", "b")').effectiveTier).toBe(2);
  });
});

describe('evaluateScript: Tier 2 network (smoke)', () => {
  it('elicits on HTTPClient', () => {
    expect(evalLine('var c = HTTPClient.new()').effectiveTier).toBe(2);
  });
  it('elicits on WebSocketPeer', () => {
    expect(evalLine('var p = WebSocketPeer.new()').effectiveTier).toBe(2);
  });
  it('elicits on PacketPeerUDP', () => {
    expect(evalLine('var p = PacketPeerUDP.new()').effectiveTier).toBe(2);
  });
  it('elicits on UDPServer', () => {
    expect(evalLine('var s = UDPServer.new()').effectiveTier).toBe(2);
  });
  it('elicits on StreamPeerTLS', () => {
    expect(evalLine('var s = StreamPeerTLS.new()').effectiveTier).toBe(2);
  });
  it('elicits on IP.resolve_hostname_addresses', () => {
    expect(evalLine('IP.resolve_hostname_addresses("example.com")').effectiveTier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bypass closure: Callable, OS/Engine/ClassDB/ProjectSettings.call, set_script
// ---------------------------------------------------------------------------

describe('evaluateScript: Tier 1 Callable bypass closure', () => {
  it('blocks Callable(target, "method") as bare identifier', () => {
    const d = evalLine('var c = Callable(self, "run")');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.reflection.Callable')).toBe(true);
  });
});

describe('evaluateScript: Tier 1 per-singleton .call non-literal bypass closure', () => {
  it('blocks OS.call with non-literal first arg', () => {
    const d = evalLine('OS.call(method_var, "bash")');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.OS.call.nonliteral')).toBe(true);
  });
  it('blocks Engine.call with non-literal first arg', () => {
    expect(evalLine('Engine.call(method_var, "x")').effectiveTier).toBe(1);
  });
  it('blocks ClassDB.call with non-literal first arg', () => {
    expect(evalLine('ClassDB.call(method_var, "x")').effectiveTier).toBe(1);
  });
  it('blocks ProjectSettings.call with non-literal first arg', () => {
    expect(evalLine('ProjectSettings.call(method_var, "x")').effectiveTier).toBe(1);
  });
});

describe('evaluateScript: Tier 3 per-singleton .call literal arg', () => {
  it('warns on OS.call with literal first arg', () => {
    const d = evalLine('OS.call("get_name")');
    expect(d.decision).toBe('warn');
    expect(d.matches.some((m) => m.ruleId === 'tier3.literal.OS.call')).toBe(true);
  });
  it('warns on Engine.call with literal first arg', () => {
    expect(evalLine('Engine.call("get_frames_drawn")').effectiveTier).toBe(3);
  });
  it('warns on ClassDB.call with literal first arg', () => {
    expect(evalLine('ClassDB.call("get_class_list")').effectiveTier).toBe(3);
  });
  it('warns on ProjectSettings.call with literal first arg', () => {
    expect(evalLine('ProjectSettings.call("get")').effectiveTier).toBe(3);
  });
});

describe('evaluateScript: member chain whitespace/newline skeleton key', () => {
  // Regression coverage: the tokenizer used to require the dot to sit
  // immediately against both identifiers, so whitespace or a newline around
  // the `.` dropped `execute` to a bare, unmatched identifier: silently
  // defeating every OS.execute-style rule at once.
  it('blocks OS .execute (space before the dot)', () => {
    const d = evalLine('OS .execute("rm", ["-rf", "/"])');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('blocks OS. execute (space after the dot)', () => {
    const d = evalLine('OS. execute("rm", ["-rf", "/"])');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('blocks OS.\\n  execute (newline inside a call)', () => {
    const source = VALID_PREFIX + 'foo(OS.\n\t\texecute("rm", ["-rf", "/"]))\n';
    const d = evaluateScript(source);
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('does not merge two separate statements into a false chain', () => {
    const source = VALID_PREFIX + 'var a = foo\n\tvar b = bar\n';
    expect(evaluateScript(source).decision).toBe('ok');
  });
});

describe('evaluateScript: whole-first-argument classification', () => {
  // Regression coverage: classification used to look only at the first
  // token after `(`, so `load("res://" + evil)` saw the leading string
  // literal and dropped from Tier 1 (non-literal) to Tier 3 (warn).
  it('blocks load("res://" + x) as non-literal, not warn', () => {
    const d = evalLine('var r = load("res://" + x)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(true);
    expect(d.matches.some((m) => m.ruleId === 'tier3.literal.load')).toBe(false);
  });

  it('blocks obj.call("exec" + "ute") as non-literal, not the literal Tier 3 rule', () => {
    const d = evalLine('Object.call("exec" + "ute")');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.Object.call.nonliteral')).toBe(true);
    expect(d.matches.some((m) => m.ruleId === 'tier3.literal.Object.call')).toBe(false);
  });

  it('regression: lone-literal load("res://main.tscn") stays warn', () => {
    const d = evalLine('var r = load("res://main.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.matches.some((m) => m.ruleId === 'tier3.literal.load')).toBe(true);
  });

  it('regression: load(some_var) stays hard_block', () => {
    const d = evalLine('var r = load(some_var)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(true);
  });

  it('regression: load() with no argument does not match the non-literal rule', () => {
    const d = evalLine('var r = load()');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(false);
    expect(d.decision).toBe('ok');
  });
});

describe('evaluateScript: generic non-literal .call/.callv on any receiver', () => {
  it('elicits on some_node.call(method_var): arbitrary receiver, non-literal', () => {
    const d = evalLine('some_node.call(method_var)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.call.nonliteral')).toBe(true);
  });

  it('elicits on some_node.callv(method_var, args): arbitrary receiver, non-literal', () => {
    const d = evalLine('some_node.callv(method_var, args)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.callv.nonliteral')).toBe(true);
  });

  it('does not match some_node.call("ready"): literal argument', () => {
    const d = evalLine('some_node.call("ready")');
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.call.nonliteral')).toBe(false);
    expect(d.decision).toBe('ok');
  });

  it('still hard_blocks Object.call(var) via the named rule, not the generic one', () => {
    const d = evalLine('Object.call(method_var)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.indirect.Object.call.nonliteral')).toBe(true);
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.call.nonliteral')).toBe(false);
  });
});

describe('evaluateScript: Tier 2 set_script bare identifier', () => {
  it('elicits on set_script(...) called as bare identifier', () => {
    const d = evalLine('set_script(some_node, my_script)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.reflection.set_script.bareIdentifier')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Resource and filesystem write primitives.
// ---------------------------------------------------------------------------

describe('evaluateScript: write primitives', () => {
  it('elicits on ResourceSaver.save(res, path)', () => {
    const d = evalLine('ResourceSaver.save(res, path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.resource_saver.save')).toBe(true);
  });

  it('elicits on ResourceSaver.save(res) - no-path arity', () => {
    const d = evalLine('ResourceSaver.save(res)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.resource_saver.save')).toBe(true);
  });

  it('elicits on cf.save(p) when ConfigFile.new() appears in the same script', () => {
    const d = evalLine('var cf := ConfigFile.new()\n\tcf.save(p)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.config.ConfigFile')).toBe(true);
  });

  it('elicits on cf.save_encrypted(p, key) on any receiver', () => {
    const d = evalLine('cf.save_encrypted(p, key)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.config.ConfigFile.save_encrypted')).toBe(true);
  });

  it('elicits on cf.save_encrypted_pass(p, pass) on any receiver', () => {
    const d = evalLine('cf.save_encrypted_pass(p, pass)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.config.ConfigFile.save_encrypted_pass')).toBe(
      true,
    );
  });

  it('elicits on img.save_png(p) - instance receiver', () => {
    const d = evalLine('img.save_png(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_png')).toBe(true);
  });

  it('elicits on img.save_jpg(p)', () => {
    const d = evalLine('img.save_jpg(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_jpg')).toBe(true);
  });

  it('elicits on img.save_webp(p)', () => {
    const d = evalLine('img.save_webp(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_webp')).toBe(true);
  });

  it('elicits on img.save_exr(p)', () => {
    const d = evalLine('img.save_exr(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_exr')).toBe(true);
  });

  it('elicits on tex.get_image().save_png(p) - the chained-call idiomatic form', () => {
    const d = evalLine('tex.get_image().save_png(p)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_png')).toBe(true);
  });

  it('elicits on tex.get_image().save_jpg(p) - sibling chained-call form', () => {
    const d = evalLine('tex.get_image().save_jpg(p)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_jpg')).toBe(true);
  });

  it('elicits on a bare save_png(p) call with no receiver at all', () => {
    const d = evalLine('save_png(p)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.image.save_png')).toBe(true);
  });

  it('regression: the matchLastSegment fallthrough does not widen bare save() or literal load()', () => {
    expect(evalLine('some_manager.save()').decision).toBe('ok');
    const d = evalLine('var r = load("res://x.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.ruleId).toBe('tier3.literal.load');
  });

  it('elicits on res.take_over_path(p)', () => {
    const d = evalLine('res.take_over_path(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.resource.take_over_path')).toBe(true);
  });

  it('elicits on FileAccess.open_encrypted(...)', () => {
    const d = evalLine('FileAccess.open_encrypted(path, FileAccess.WRITE, key)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.open_encrypted')).toBe(true);
  });

  it('elicits on FileAccess.open_encrypted_with_pass(...)', () => {
    const d = evalLine('FileAccess.open_encrypted_with_pass(path, FileAccess.WRITE, pass)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.open_encrypted_with_pass')).toBe(
      true,
    );
  });

  it('elicits on FileAccess.open_compressed(...)', () => {
    const d = evalLine('FileAccess.open_compressed(path, FileAccess.WRITE)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.open_compressed')).toBe(true);
  });

  it('elicits on dir.make_dir(path) - instance receiver', () => {
    const d = evalLine('dir.make_dir(path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.DirAccess.make_dir')).toBe(true);
  });

  it('elicits on DirAccess.make_dir_absolute(path) - static', () => {
    const d = evalLine('DirAccess.make_dir_absolute(path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.DirAccess.make_dir_absolute')).toBe(true);
  });

  it('elicits on dir.make_dir_recursive(path) - instance receiver', () => {
    const d = evalLine('dir.make_dir_recursive(path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.DirAccess.make_dir_recursive')).toBe(true);
  });

  it('elicits on DirAccess.make_dir_recursive_absolute(path) - static', () => {
    const d = evalLine('DirAccess.make_dir_recursive_absolute(path)');
    expect(d.effectiveTier).toBe(2);
    expect(
      d.matches.some((m) => m.ruleId === 'tier2.fs.DirAccess.make_dir_recursive_absolute'),
    ).toBe(true);
  });

  it('elicits on OS.move_to_trash(p)', () => {
    const d = evalLine('OS.move_to_trash(p)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.OS.move_to_trash')).toBe(true);
  });

  it('elicits on ZIPPacker.new() usage', () => {
    const d = evalLine('var z = ZIPPacker.new()');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.archive.ZIPPacker')).toBe(true);
  });

  it('elicits on PCKPacker.new() usage', () => {
    const d = evalLine('var pck = PCKPacker.new()');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.archive.PCKPacker')).toBe(true);
  });

  it('elicits on ResourceUID.add_id(...)', () => {
    const d = evalLine('ResourceUID.add_id(id, path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.uid.ResourceUID.add_id')).toBe(true);
  });

  it('elicits on ResourceUID.set_id(...)', () => {
    const d = evalLine('ResourceUID.set_id(id, path)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.uid.ResourceUID.set_id')).toBe(true);
  });

  it('elicits on ResourceUID.remove_id(...)', () => {
    const d = evalLine('ResourceUID.remove_id(id)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.uid.ResourceUID.remove_id')).toBe(true);
  });

  it('elicits on FileAccess.create_temp(...)', () => {
    const d = evalLine('FileAccess.create_temp(FileAccess.WRITE)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.create_temp')).toBe(true);
  });

  it('elicits on FileAccess.set_read_only_attribute(...)', () => {
    const d = evalLine('FileAccess.set_read_only_attribute(path, true)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.set_read_only_attribute')).toBe(
      true,
    );
  });

  it('elicits on FileAccess.set_hidden_attribute(...)', () => {
    const d = evalLine('FileAccess.set_hidden_attribute(path, true)');
    expect(d.effectiveTier).toBe(2);
    expect(d.matches.some((m) => m.ruleId === 'tier2.fs.FileAccess.set_hidden_attribute')).toBe(
      true,
    );
  });
});

describe('evaluateScript: write-primitive negatives', () => {
  it('does not flag some_manager.save() - bare "save" stays unmatched', () => {
    expect(evalLine('some_manager.save()').decision).toBe('ok');
  });

  it('does not flag Image construction plus a get_pixel read', () => {
    const d = evalLine('var img := Image.new()\n\timg.get_pixel(0, 0)');
    expect(d.decision).toBe('ok');
  });

  it('load("res://x.tscn") with a literal produces only the existing Tier 3 warn', () => {
    const d = evalLine('var r = load("res://x.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.ruleId).toBe('tier3.literal.load');
  });
});

describe('evaluateScript: ConfigFile instance usage', () => {
  it('elicits on cf.load(path) when ConfigFile.new() appears in the same script', () => {
    const d = evalLine('var cf := ConfigFile.new()\n\tcf.load(path)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.config.ConfigFile')).toBe(true);
  });

  it('does not block a bare receiver.load(x) call: `load` is too generic to key on', () => {
    // `save_manager.load(slot)` is ordinary game code. A last-segment rule on
    // `load` would hard-block it, with a ConfigFile-flavoured reason string.
    expect(evalLine('save_manager.load(slot)').decision).toBe('ok');
    expect(evalLine('img.load("res://x.png")').decision).toBe('ok');
  });

  it('blocks the static-looking ConfigFile.load(path) form', () => {
    const d = evalLine('ConfigFile.load(path)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.config.ConfigFile.load')).toBe(true);
  });

  it('bare load(path) with a non-literal argument still matches only the indirect rule', () => {
    const d = evalLine('var r = load(path)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.ruleId).toBe('tier1.indirect.load.nonliteral');
  });

  it('ResourceLoader.load(non_literal) still matches its own rule', () => {
    const d = evalLine('ResourceLoader.load(var_path)');
    expect(d.decision).toBe('hard_block');
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.ruleId).toBe('tier1.indirect.ResourceLoader.load.nonliteral');
  });

  it('ResourceLoader.load("literal") still warns via its own Tier 3 rule', () => {
    const d = evalLine('ResourceLoader.load("res://x.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.ruleId).toBe('tier3.literal.ResourceLoader.load');
  });
});

describe('evaluateScript: strict mode promotes the write primitives', () => {
  it('promotes ResourceSaver.save to hard_block under strict mode', () => {
    const source = VALID_PREFIX + 'ResourceSaver.save(res, path)\n';
    const strict = evaluateScript(source, true);
    expect(strict.decision).toBe('hard_block');
    expect(strict.promotedByStrict).toBe(true);
  });
});

describe('evaluateScript: chains split by a continuation or hidden by an operator', () => {
  it('blocks OS and .execute split by a backslash continuation', () => {
    const d = evaluateScript(VALID_PREFIX + 'OS \\\n.execute("rm", [])\n');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('blocks OS.execute written after an unspaced caret', () => {
    const d = evalLine('var x = 1^OS.execute("rm", [])');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.direct_exec.OS.execute')).toBe(true);
  });

  it('blocks OS.execute split by a comment inside parentheses', () => {
    const d = evaluateScript(VALID_PREFIX + 'print(OS # note\n\t.execute("rm", []))\n');
    expect(d.decision).toBe('hard_block');
  });

  it('a clean script using a caret and trailing comments stays ok', () => {
    const d = evaluateScript(
      VALID_PREFIX + 'var x = 5 ^ 3 # OS.execute\n\tvar y = x ^x\n\tvar p = ^"A/B"\n\treturn y\n',
    );
    expect(d.decision).toBe('ok');
    expect(d.matches).toEqual([]);
  });

  it('a script with a continuation between unrelated statements stays ok', () => {
    const d = evaluateScript(VALID_PREFIX + 'var a = 1 + \\\n\t2\n\tvar b = a # OS\n\treturn b\n');
    expect(d.decision).toBe('ok');
  });
});

describe('evaluateScript: global-function rules ignore method calls', () => {
  const methodForms = [
    '$SaveManager.load(slot)',
    'get_node("Save").load(slot)',
    'slots[i].load(d)',
    'ConfigFile.new().load(path)',
    'save_manager.load(slot)',
    'get_node("Save").preload(slot)',
  ];

  for (const form of methodForms) {
    it(`does not hard-block ${form} through the load/preload rules`, () => {
      const d = evalLine(form);
      expect(d.matches.some((m) => m.ruleId.startsWith('tier1.indirect.'))).toBe(false);
      expect(d.matches.some((m) => m.ruleId.startsWith('tier3.literal.'))).toBe(false);
    });
  }

  it('leaves the non-strict decision ok for the plain method forms', () => {
    expect(evalLine('$SaveManager.load(slot)').decision).toBe('ok');
    expect(evalLine('get_node("Save").load(slot)').decision).toBe('ok');
    expect(evalLine('slots[i].load(d)').decision).toBe('ok');
  });

  it('still hard-blocks the bare global functions', () => {
    const load = evalLine('var r = load(path_var)');
    expect(load.decision).toBe('hard_block');
    expect(load.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(true);
    expect(evalLine('var r = preload(x)').decision).toBe('hard_block');
    expect(evalLine('var r = str_to_var(s)').decision).toBe('hard_block');
    expect(evalLine('var r = bytes_to_var_with_objects(b)').decision).toBe('hard_block');
  });

  it('does not flag a method named str_to_var after a call', () => {
    expect(evalLine('get_node("P").str_to_var(s)').decision).toBe('ok');
  });

  it('still blocks a global load that follows a statement ending in a dot-free line', () => {
    expect(evaluateScript(VALID_PREFIX + 'var a = 1\n\tvar r = load(p)\n').decision).toBe(
      'hard_block',
    );
  });

  it('keeps matching method primitives after a call', () => {
    const png = evalLine('tex.get_image().save_png(p)');
    expect(png.matches.some((m) => m.ruleId === 'tier2.image.save_png')).toBe(true);
    const script = evalLine('node.get_child(0).set_script(s)');
    expect(
      script.matches.some((m) => m.ruleId === 'tier2.reflection.set_script.bareIdentifier'),
    ).toBe(true);
  });
});

describe('evaluateScript: Callable fires on the constructor only', () => {
  const nonCalls = [
    'func on_done(cb: Callable) -> void:',
    'var handler: Callable',
    'func make() -> Callable:',
    'var list: Array[Callable] = []',
    'var ok = x is Callable',
    'var c = x as Callable',
  ];

  for (const line of nonCalls) {
    it(`does not block ${line}`, () => {
      const d = evalLine(line);
      expect(d.matches.some((m) => m.ruleId === 'tier1.reflection.Callable')).toBe(false);
    });
  }

  it('still blocks Callable(self, "run")', () => {
    expect(evalLine('var c = Callable(self, "run")').decision).toBe('hard_block');
  });

  it('still blocks Callable.create(...)', () => {
    expect(evalLine('var c = Callable.create(self, "run")').decision).toBe('hard_block');
  });
});

describe('evaluateScript: strings spanning raw newlines', () => {
  it('finds OS.execute hidden by a string that ends on the next line', () => {
    const d = evaluateScript('var a = "x\n"; OS.execute("cmd", [])\n');
    expect(d.decision).toBe('hard_block');
    const m = d.matches.find((x) => x.ruleId === 'tier1.direct_exec.OS.execute');
    expect(m?.line).toBe(2);
  });

  it('does not fabricate a match from text inside a multi-line string', () => {
    const d = evaluateScript('var a = "first\nOS.execute(1)\nlast"\nvar b = 2\n');
    expect(d.decision).toBe('ok');
    expect(d.matches).toEqual([]);
  });

  it('does not fabricate a match inside a multi-line single-quoted string', () => {
    expect(evaluateScript("var a = 'first\nOS.execute(1)\nlast'\n").decision).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe('evaluateScript: a declaration is not a call', () => {
  it.each(['load', 'preload', 'str_to_var', 'bytes_to_var_with_objects'])(
    'does not fire on func %s(...)',
    (name) => {
      const d = evaluateScript(`extends Node\nfunc ${name}(slot: int) -> void:\n\tpass\n`);
      expect(d.decision).toBe('ok');
      expect(d.matches).toEqual([]);
    },
  );

  it('does not fire on static func load(...)', () => {
    expect(
      evaluateScript('static func load(path: String) -> Resource:\n\treturn null\n'),
    ).toMatchObject({
      decision: 'ok',
    });
  });

  it('does not fire on a declared method that shares a method-rule name', () => {
    expect(evaluateScript('func set_script(value):\n\tpass\n').decision).toBe('ok');
    expect(evaluateScript('func save_png(path):\n\tpass\n').decision).toBe('ok');
  });

  it('still fires on a call inside the declared function', () => {
    const d = evaluateScript('func load(slot):\n\treturn load(path_for(slot))\n');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.map((m) => [m.ruleId, m.line])).toEqual([
      ['tier1.indirect.load.nonliteral', 2],
    ]);
  });

  it('still fires on a lambda body, which names nothing', () => {
    expect(evalLine('var f = func(): OS.execute("x", [])').decision).toBe('hard_block');
  });
});

// ---------------------------------------------------------------------------
// Reflective dispatch
// ---------------------------------------------------------------------------

describe('evaluateScript: a reflective call with a literal method name is the call it makes', () => {
  it.each([
    ['OS.call("execute", "rm", [])', 'OS.call("execute")'],
    ['OS.callv("execute", ["rm", []])', 'OS.callv("execute")'],
    ['OS.call_deferred("execute", "rm", [])', 'OS.call_deferred("execute")'],
    ["OS.call('execute', 'rm', [])", 'OS.call("execute")'],
    ['OS.call(&"execute", "rm", [])', 'OS.call("execute")'],
    ['OS . callv ( "execute" , [] )', 'OS.callv("execute")'],
  ])('%s fires the OS.execute rule at Tier 1', (line, matchedText) => {
    const d = evalLine(line);
    expect(d.decision).toBe('hard_block');
    expect(d.matches.map((m) => [m.ruleId, m.matchedText])).toEqual([
      ['tier1.direct_exec.OS.execute', matchedText],
    ]);
  });

  it('applies to every Tier 1 primitive, not only OS.execute', () => {
    expect(evalLine('OS.callv("kill", [pid])').matches[0]?.ruleId).toBe(
      'tier1.direct_exec.OS.kill',
    );
    expect(evalLine('Engine.call("get_singleton", "X")').matches[0]?.ruleId).toBe(
      'tier1.engine.get_singleton',
    );
    expect(evalLine('ClassDB.call_deferred("instantiate", "GDScript")').matches[0]?.ruleId).toBe(
      'tier1.reflection.ClassDB.instantiate',
    );
    expect(evalLine('ProjectSettings.callv("save", [])').matches[0]?.ruleId).toBe(
      'tier1.resource_pack.save',
    );
  });

  it('keeps the tier of the rule it reaches', () => {
    expect(evalLine('img.call("save_png", path)')).toMatchObject({ decision: 'elicit_required' });
    expect(evalLine('img.call("save_png", path)').matches[0]?.ruleId).toBe('tier2.image.save_png');
    expect(evalLine('DirAccess.call("remove", path)').matches[0]?.ruleId).toBe(
      'tier2.fs.DirAccess.remove',
    );
    expect(evalLine('node.call_deferred("set_script", s)').matches[0]?.ruleId).toBe(
      'tier2.reflection.set_script.bareIdentifier',
    );
    expect(evalLine('call("set_script", s)').matches[0]?.ruleId).toBe(
      'tier2.reflection.set_script.bareIdentifier',
    );
  });

  it('classifies the argument the called method receives', () => {
    const ruleOf = (line: string) => evalLine(line).matches.map((m) => m.ruleId);
    expect(ruleOf('ResourceLoader.call("load", path_var)')).toEqual([
      'tier1.indirect.ResourceLoader.load.nonliteral',
    ]);
    expect(ruleOf('ResourceLoader.call("load", "res://a.tscn")')).toEqual([
      'tier3.literal.ResourceLoader.load',
    ]);
    expect(ruleOf('ResourceLoader.callv("load", [path_var])')).toEqual([
      'tier1.indirect.ResourceLoader.load.nonliteral',
    ]);
    expect(ruleOf('ResourceLoader.callv("load", ["res://a.tscn"])')).toEqual([
      'tier3.literal.ResourceLoader.load',
    ]);
    expect(ruleOf('ResourceLoader.callv("load", args)')).toEqual([
      'tier1.indirect.ResourceLoader.load.nonliteral',
    ]);
  });

  it('falls back to the literal-dispatch warning when the method fires no rule', () => {
    expect(evalLine('OS.call("get_name")').matches.map((m) => [m.ruleId, m.tier])).toEqual([
      ['tier3.literal.OS.call', 3],
    ]);
    expect(evalLine('OS.call_deferred("get_name")').matches.map((m) => m.ruleId)).toEqual([
      'tier3.literal.OS.call_deferred',
    ]);
    expect(evalLine('Engine.callv("get_frames_drawn", [])').matches.map((m) => m.ruleId)).toEqual([
      'tier3.literal.Engine.callv',
    ]);
  });

  it('leaves ordinary literal dispatch on any other receiver alone', () => {
    for (const line of [
      'some_node.call("ready")',
      'some_node.call_deferred("queue_free")',
      'call_deferred("_refresh")',
      'some_node.callv("apply", [1, 2])',
      'save_manager.call("load", slot)',
      'call("load", slot)',
      'get_node("A").call_deferred("load", slot)',
      'node.call_thread_safe("update")',
    ]) {
      expect(evalLine(line), line).toMatchObject({ decision: 'ok', matches: [] });
    }
  });

  it('does not read a method name out of an expression, a comment or a string', () => {
    expect(evalLine('some_node.call("exe" + "cute")').matches.map((m) => m.ruleId)).toEqual([
      'tier2.generic.call.nonliteral',
    ]);
    expect(evalLine('# OS.callv("execute", [])').decision).toBe('ok');
    expect(evalLine('print("OS.callv(\\"execute\\", [])")').decision).toBe('ok');
  });

  it('a string that cannot be a method name is dispatch by an unreadable name', () => {
    expect(evalLine('some_node.call("not a method name")').matches.map((m) => m.ruleId)).toEqual([
      'tier2.generic.call.nonliteral',
    ]);
    expect(evalLine('OS.call("not a method name")').matches.map((m) => m.ruleId)).toEqual([
      'tier1.indirect.OS.call.nonliteral',
    ]);
  });
});

describe('evaluateScript: a non-literal method name on a Tier 1 receiver', () => {
  const DISPATCH_METHODS = ['call', 'callv', 'call_deferred'];

  it.each(TIER1_DISPATCH_RECEIVERS.flatMap((r) => DISPATCH_METHODS.map((m) => [r, m] as const)))(
    'hard-blocks %s.%s(method_name)',
    (receiver, method) => {
      const d = evalLine(`${receiver}.${method}(method_name, [])`);
      expect(d.decision).toBe('hard_block');
      expect(d.matches.map((m) => m.ruleId)).toEqual([
        `tier1.indirect.${receiver}.${method}.nonliteral`,
      ]);
    },
  );

  it('hard-blocks it through a parenthesised receiver', () => {
    expect(evalLine('(OS).callv(method_name, [])').matches.map((m) => m.ruleId)).toEqual([
      'tier1.indirect.OS.callv.nonliteral',
    ]);
  });

  it('stays where it was on any other receiver', () => {
    expect(evalLine('some_node.call(method_name)').matches.map((m) => [m.ruleId, m.tier])).toEqual([
      ['tier2.generic.call.nonliteral', 2],
    ]);
    expect(evalLine('some_node.callv(method_name, [])').matches.map((m) => m.tier)).toEqual([2]);
    expect(evalLine('some_node.call_deferred(method_name)').decision).toBe('ok');
  });

  it('covers every receiver that carries a Tier 1 chain-prefix rule', () => {
    // Classes a script names to construct or annotate; their reflective use
    // goes through an instance, which no receiver rule can see.
    const classReceivers = ['Node', 'ConfigFile', 'GDScript'];
    const tier1Receivers = new Set(
      policyRules.filter((r) => r.tier === 1 && r.chain.length === 2).map((r) => r.chain[0]!),
    );
    for (const receiver of tier1Receivers) {
      expect([...TIER1_DISPATCH_RECEIVERS, ...classReceivers], receiver).toContain(receiver);
    }
    for (const receiver of TIER1_DISPATCH_RECEIVERS) {
      for (const method of DISPATCH_METHODS) {
        const ids = policyRules.map((r) => r.id);
        expect(ids).toContain(`tier1.indirect.${receiver}.${method}.nonliteral`);
        expect(ids).toContain(`tier3.literal.${receiver}.${method}`);
      }
    }
  });

  it('gives every rule a distinct id', () => {
    const ids = policyRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('evaluateScript: set_script on an instance', () => {
  it('elicits on node.set_script(s), the idiomatic form', () => {
    expect(evalLine('some_node.set_script(s)').matches.map((m) => [m.ruleId, m.tier])).toEqual([
      ['tier2.reflection.set_script.bareIdentifier', 2],
    ]);
    expect(evalLine('get_node("A").set_script(s)').decision).toBe('elicit_required');
    expect(evalLine('a.b.set_script(s)').decision).toBe('elicit_required');
  });

  it('keeps the Tier 1 rules for the class-name forms', () => {
    expect(evalLine('Object.set_script(s)').matches.map((m) => m.ruleId)).toEqual([
      'tier1.reflection.Object.set_script',
    ]);
    expect(evalLine('Node.set_script(s)').matches.map((m) => m.ruleId)).toEqual([
      'tier1.reflection.Node.set_script',
    ]);
  });

  it('does not fire on get_script, a declaration, a string or a comment', () => {
    expect(evalLine('var s = some_node.get_script()').decision).toBe('ok');
    expect(evaluateScript('func set_script(value):\n\tpass\n').decision).toBe('ok');
    expect(evalLine('print("node.set_script(s)")').decision).toBe('ok');
    expect(evalLine('# node.set_script(s)').decision).toBe('ok');
  });
});

describe('evaluateScript: bare call and callv', () => {
  it('elicits on a non-literal method name with no receiver', () => {
    expect(evalLine('call(method_name)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.generic.call.nonliteral',
    ]);
    expect(evalLine('callv(method_name, args)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.generic.callv.nonliteral',
    ]);
  });

  it('elicits on one that follows a call, where the chain is broken', () => {
    expect(evalLine('get_node("A").call(method_name)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.generic.call.nonliteral',
    ]);
  });

  it('does not fire on a literal name, on no argument, or on a declaration', () => {
    expect(evalLine('call("ready")').decision).toBe('ok');
    expect(evalLine('cb.call()').decision).toBe('ok');
    expect(evaluateScript('func call(x):\n\tpass\n').decision).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Parenthesised receivers
// ---------------------------------------------------------------------------

describe('evaluateScript: a parenthesised receiver', () => {
  it('fires the rule of the plain spelling', () => {
    const d = evalLine('(OS).execute("rm", [])');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.map((m) => [m.ruleId, m.matchedText])).toEqual([
      ['tier1.direct_exec.OS.execute', '(OS).execute'],
    ]);
    expect(evalLine('((Engine)).get_singleton("X")').decision).toBe('hard_block');
    expect(evalLine('return (ProjectSettings).save()').decision).toBe('hard_block');
    expect(evalLine('(FileAccess).open(p, 1)').decision).toBe('elicit_required');
  });

  it('is not a receiver when the parentheses are an argument list: the name is a value there', () => {
    expect(evalLine('wrap(OS).execute()').matches.map((m) => m.ruleId)).toEqual(['tier2.alias.OS']);
    expect(
      evalLine('factory.make(Engine).get_singleton("X")').matches.map((m) => m.ruleId),
    ).toEqual(['tier2.alias.Engine']);
    expect(evalLine('wrap(node).execute()')).toMatchObject({ decision: 'ok', matches: [] });
  });

  it('does not fire on a benign method of the same receiver', () => {
    expect(evalLine('print((OS).get_name())').decision).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// New Tier 1 primitives
// ---------------------------------------------------------------------------

describe('evaluateScript: GDScript.new', () => {
  it('hard-blocks creating a script object', () => {
    const d = evalLine('var s = GDScript.new()');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.map((m) => m.ruleId)).toEqual(['tier1.dynamic.GDScript.new']);
    expect(evalLine('var s := (GDScript).new()').decision).toBe('hard_block');
    expect(evalLine('var s = GDScript \\\n\t\t.new()').decision).toBe('hard_block');
  });

  it('hard-blocks the compile-from-string sequence', () => {
    const d = evaluateScript(
      'func run(code: String):\n\tvar s = GDScript.new()\n\ts.source_code = code\n\ts.reload()\n\treturn s.new()\n',
    );
    expect(d.decision).toBe('hard_block');
  });

  it('does not fire on an annotation, a type test, a cast, a string or a comment', () => {
    for (const source of [
      'var s: GDScript = null\n',
      'func f(s: GDScript) -> GDScript:\n\treturn s\n',
      'func f(x):\n\tif x is GDScript:\n\t\tpass\n',
      'func f(x):\n\tvar s = x as GDScript\n',
      'var scripts: Array[GDScript] = []\n',
      'var t = "GDScript.new()"\n',
      '# GDScript.new()\n',
      'func f(s: GDScript):\n\tvar o = s.new()\n',
    ]) {
      expect(evaluateScript(source), source).toMatchObject({ decision: 'ok', matches: [] });
    }
  });
});

describe('evaluateScript: OS.create_instance and GDExtensionManager.load_extension', () => {
  it('hard-blocks OS.create_instance, directly and through dispatch', () => {
    expect(evalLine('OS.create_instance(["--headless"])').matches.map((m) => m.ruleId)).toEqual([
      'tier1.direct_exec.OS.create_instance',
    ]);
    expect(evalLine('OS.callv("create_instance", [[]])').decision).toBe('hard_block');
  });

  it('hard-blocks GDExtensionManager.load_extension, directly and through dispatch', () => {
    expect(
      evalLine('GDExtensionManager.load_extension("res://x.gdextension")').matches.map(
        (m) => m.ruleId,
      ),
    ).toEqual(['tier1.native.GDExtensionManager.load_extension']);
    expect(evalLine('GDExtensionManager.call("load_extension", p)').decision).toBe('hard_block');
  });

  it('does not fire on their neighbours, a string or a comment', () => {
    expect(evalLine('OS.get_process_id()').decision).toBe('ok');
    expect(evalLine('GDExtensionManager.get_loaded_extensions()').decision).toBe('ok');
    expect(evalLine('print("OS.create_instance([])")').decision).toBe('ok');
    expect(evalLine('# GDExtensionManager.load_extension(p)').decision).toBe('ok');
    expect(evaluateScript('func create_instance(args):\n\tpass\n').decision).toBe('ok');
  });
});

describe('evaluateScript: ResourceLoader.load_threaded_request', () => {
  it('hard-blocks a non-literal path, as ResourceLoader.load does', () => {
    expect(
      evalLine('ResourceLoader.load_threaded_request(path_var)').matches.map((m) => m.ruleId),
    ).toEqual(['tier1.indirect.ResourceLoader.load_threaded_request.nonliteral']);
    expect(evalLine('ResourceLoader.load_threaded_request("res://" + name)').decision).toBe(
      'hard_block',
    );
  });

  it('warns on a literal path', () => {
    expect(
      evalLine('ResourceLoader.load_threaded_request("res://a.tscn")').matches.map((m) => [
        m.ruleId,
        m.tier,
      ]),
    ).toEqual([['tier3.literal.ResourceLoader.load_threaded_request', 3]]);
  });

  it('does not fire on the status and get calls, a string or a comment', () => {
    expect(evalLine('ResourceLoader.load_threaded_get_status(path_var)').decision).toBe('ok');
    expect(evalLine('print("ResourceLoader.load_threaded_request(p)")').decision).toBe('ok');
    expect(evalLine('# ResourceLoader.load_threaded_request(p)').decision).toBe('ok');
  });
});

describe('evaluateScript: a method name written with escapes', () => {
  const ids = (line: string): string[] => evalLine(line).matches.map((m) => m.ruleId);

  it.each([
    ['OS.call("\\u0065xecute", "cmd", [])', 'tier1.direct_exec.OS.execute'],
    ['OS.callv("execut\\u0065", ["cmd", []])', 'tier1.direct_exec.OS.execute'],
    ['OS.call_deferred("create_\\u0070rocess", "cmd", [])', 'tier1.direct_exec.OS.create_process'],
    ['ClassDB.call("instantiat\\u0065", "GDScript")', 'tier1.reflection.ClassDB.instantiate'],
    ['OS.call("\\U000065xecute", "cmd", [])', 'tier1.direct_exec.OS.execute'],
    ['OS.call(&"\\u0065xecute", "cmd", [])', 'tier1.direct_exec.OS.execute'],
    ['OS.call(\'exe\\\ncute\', "cmd", [])', 'tier1.direct_exec.OS.execute'],
    ['some_node.call("set_\\u0073cript", s)', 'tier2.reflection.set_script.bareIdentifier'],
  ])('%s is the call it makes', (line, ruleId) => {
    expect(ids(line)).toEqual([ruleId]);
  });

  it.each([
    ['an escape GDScript does not define', 'OS.call("\\qexecute", "cmd")'],
    ['a truncated unicode escape', 'OS.call("\\u00", "cmd")'],
    ['a raw string, whose backslash is literal', 'OS.call(r"\\u0065xecute", "cmd")'],
    ['a name that decodes to something with a blank', 'OS.call("exec\\tute", "cmd")'],
    ['an empty name', 'OS.call("", "cmd")'],
    ['a node path', 'OS.call($Name, "cmd")'],
  ])('%s is non-literal on a Tier 1 receiver', (_name, line) => {
    expect(ids(line)).toEqual(['tier1.indirect.OS.call.nonliteral']);
  });

  it('a benign method written with an escape stays a literal call', () => {
    expect(ids('OS.call("g\\u0065t_name")')).toEqual(['tier3.literal.OS.call']);
  });
});

describe('evaluateScript: a dispatch that names another dispatch', () => {
  const found = (line: string): Array<[string, string]> =>
    evalLine(line).matches.map((m) => [m.ruleId, m.matchedText]);

  it.each([
    ['OS.call("call", "execute", "cmd", [])', 'OS.call("call", "execute")'],
    ['OS.call("callv", "execute", ["cmd", []])', 'OS.call("callv", "execute")'],
    ['OS.call("call_deferred", "execute", "cmd", [])', 'OS.call("call_deferred", "execute")'],
    ['OS.callv("call", ["execute", "cmd", []])', 'OS.callv("call", "execute")'],
    ['OS.callv("callv", ["execute", ["cmd"]])', 'OS.callv("callv", "execute")'],
    ['OS.call("call", "call", "execute", "cmd")', 'OS.call("call", "call", "execute")'],
    [
      'OS.call_deferred("call", "call\\u0076", "execute", [])',
      'OS.call_deferred("call", "callv", "execute")',
    ],
  ])('%s is OS.execute', (line, matchedText) => {
    expect(found(line)).toEqual([['tier1.direct_exec.OS.execute', matchedText]]);
  });

  it.each([
    ['the nested name is a variable', 'OS.call("call", name, "cmd")'],
    ['the nested name is missing', 'OS.call("call")'],
    ['callv is given a variable for its arguments', 'OS.callv("call", args)'],
    ['callv is given an array built by an expression', 'OS.callv("call", ["execute"] + rest)'],
    ['the nested name is an expression', 'OS.callv("call", ["exe" + "cute", "cmd"])'],
    ['the chain is deeper than the bound', 'OS.call("call", "call", "call", "call", "execute")'],
  ])('is non-literal on the receiver when %s', (_name, line) => {
    expect(found(line).map(([ruleId]) => ruleId)).toEqual(
      ['tier1.indirect.OS.call.nonliteral'].map((id) =>
        line.startsWith('OS.callv') ? id.replace('.call.', '.callv.') : id,
      ),
    );
  });

  it('classifies the argument the final call receives', () => {
    expect(found('some_loader.call("call", "load", path)')).toEqual([]);
    expect(
      evalLine('ResourceLoader.call("call", "load", path)').matches.map((m) => m.ruleId),
    ).toEqual(['tier1.indirect.ResourceLoader.load.nonliteral']);
    expect(
      evalLine('ResourceLoader.callv("call", ["load", "res://a.tres"])').matches.map(
        (m) => m.ruleId,
      ),
    ).toEqual(['tier3.literal.ResourceLoader.load']);
  });

  it('follows it on a receiver the scanner cannot see', () => {
    expect(found('node.call("call", "set_script", s)').map(([ruleId]) => ruleId)).toEqual([
      'tier2.reflection.set_script.bareIdentifier',
    ]);
    expect(found('node.call("call", name)').map(([ruleId]) => ruleId)).toEqual([
      'tier2.generic.call.nonliteral',
    ]);
  });

  it('a nested dispatch that ends at a benign method is a literal call', () => {
    expect(found('OS.call("call", "get_name")').map(([ruleId]) => ruleId)).toEqual([
      'tier3.literal.OS.call',
    ]);
  });
});

describe('evaluateScript: script source set at runtime', () => {
  const ids = (source: string): string[] => evaluateScript(source).matches.map((m) => m.ruleId);

  it('elicits on the source_code of a duplicated script', () => {
    const source =
      'extends RefCounted\nfunc execute(scene_tree):\n\tvar x = get_script().duplicate()\n\tx.source_code = "func f(): pass"\n\tx.reload()\n\treturn x.new()\n';
    expect(evaluateScript(source).decision).toBe('elicit_required');
    expect(ids(source)).toEqual(['tier2.dynamic.source_code']);
    expect(evaluateScript(source, true).decision).toBe('hard_block');
  });

  it.each([
    'get_script().source_code = code',
    'print(script.source_code)',
    'obj.get_script().duplicate().source_code = code',
    'set("source_code", code)\n\tsource_code = code',
  ])('elicits on %s', (line) => {
    expect(evalLine(line).matches.map((m) => m.ruleId)).toContain('tier2.dynamic.source_code');
  });

  it('is Tier 2, never a hard block outside strict mode', () => {
    expect(policyRules.find((r) => r.id === 'tier2.dynamic.source_code')?.tier).toBe(2);
    expect(evalLine('var source_code = "print(1)"').decision).toBe('elicit_required');
  });

  it('does not fire on a name that only contains it, a comment or a string', () => {
    for (const line of [
      'var my_source_code_view = 1',
      'label.text = shader_source_codes[0]',
      '# x.source_code = code',
      'print("source_code")',
    ]) {
      expect(evalLine(line), line).toMatchObject({ decision: 'ok', matches: [] });
    }
  });
});

describe('evaluateScript: a guarded name used as a value', () => {
  const ids = (line: string): string[] => evalLine(line).matches.map((m) => m.ruleId);

  it.each([
    ['var o = OS', 'tier2.alias.OS'],
    ['var o := OS', 'tier2.alias.OS'],
    ['o = OS', 'tier2.alias.OS'],
    ['var G = GDScript', 'tier2.alias.GDScript'],
    ['[OS][0].execute("cmd", [])', 'tier2.alias.OS'],
    ['(OS as Object).execute("cmd", [])', 'tier2.alias.OS'],
    ['foo(OS)', 'tier2.alias.OS'],
    ['foo(1, ClassDB)', 'tier2.alias.ClassDB'],
    ['return Engine', 'tier2.alias.Engine'],
    ['var d = {"os": OS}', 'tier2.alias.OS'],
    ['var d = {key: OS}', 'tier2.alias.OS'],
    ['var d = {os = ProjectSettings}', 'tier2.alias.ProjectSettings'],
    ['OS["execute"].call("cmd", [])', 'tier2.alias.OS'],
    ['var f = OS if x else null', 'tier2.alias.OS'],
    ['var a = [ResourceLoader, GDExtensionManager]', 'tier2.alias.ResourceLoader'],
    ['is_instance_of(x, GDScript)', 'tier2.alias.GDScript'],
  ])('elicits on %s', (line, ruleId) => {
    const decision = evalLine(line);
    expect(decision.matches.map((m) => m.ruleId)).toContain(ruleId);
    expect(decision.decision).toBe('elicit_required');
    expect(evaluateScript(`${VALID_PREFIX}${line}\n`, true).decision).toBe('hard_block');
  });

  it('G.new() after var G = GDScript is caught at the alias', () => {
    const source = `${VALID_PREFIX}var G = GDScript\n\treturn G.new()\n`;
    expect(evaluateScript(source).matches.map((m) => m.ruleId)).toEqual(['tier2.alias.GDScript']);
  });

  it.each([
    ['a variable annotation', 'var s: GDScript = null'],
    ['a parameter annotation', 'var f = func(a: OS, b: GDScript = null): pass'],
    ['a return type', 'var f = func() -> GDScript: return null'],
    ['a for-loop annotation', 'for s: GDScript in scripts: pass'],
    ['an is test', 'if x is GDScript: pass'],
    ['an is not test', 'if x is not GDScript: pass'],
    ['an as cast', 'var s = x as GDScript'],
    ['a typed array', 'var a: Array[GDScript] = []'],
    ['a typed dictionary', 'var d: Dictionary[String, GDScript] = {}'],
    ['a nested typed array', 'var a: Array[Array[GDScript]] = []'],
    ['a comment', '# var o = OS'],
    ['a string', 'print("var o = OS", \'OS\')'],
    ['a longer identifier', 'var OSHelper = my_os + OS_NAME + osOS'],
    ['a member of another object', 'var o = platform.OS'],
    ['a member after a call', 'var o = get_platform().OS'],
    ['a direct benign call', 'print(OS.get_name(), Engine.get_version_info())'],
    ['a constant read through the name', 'var c = ClassDB.API_CORE'],
    ['a declaration', 'var OS = 1'],
  ])('does not fire on %s', (_name, line) => {
    expect(evalLine(line), line).toMatchObject({ decision: 'ok', matches: [] });
  });

  it('does not fire on an extends line or a class annotation at the top of a file', () => {
    const source =
      'extends GDScript\nclass_name Engine\nvar s: OS\nfunc f(a: ClassDB) -> ProjectSettings:\n\treturn null\n';
    expect(evaluateScript(source)).toMatchObject({ decision: 'ok', matches: [] });
  });

  it('leaves the chain rules to judge a chain head', () => {
    expect(ids('OS.execute("cmd", [])')).toEqual(['tier1.direct_exec.OS.execute']);
    expect(ids('GDScript.new()')).toEqual(['tier1.dynamic.GDScript.new']);
  });

  it('every alias rule is Tier 2, one per aliasable name', () => {
    const aliasRules = policyRules.filter((r) => r.id.startsWith('tier2.alias.'));
    expect(aliasRules.map((r) => r.chain[0])).toEqual([...TIER1_ALIASABLE_NAMES]);
    expect(aliasRules.every((r) => r.tier === 2)).toBe(true);
  });

  it('every head of a Tier 1 chain rule has an alias rule or a stated exemption', () => {
    const heads = new Set(
      policyRules.filter((r) => r.tier === 1 && r.chain.length === 2).map((r) => r.chain[0]!),
    );
    for (const head of heads) {
      expect([...TIER1_ALIASABLE_NAMES, ...TIER1_NAMES_WITHOUT_ALIAS_RULE], head).toContain(head);
    }
  });

  it('ordinary code that names Node and Object as values is untouched', () => {
    for (const line of ['if is_instance_of(x, Node): pass', 'var t = Object', 'foo(Node)']) {
      expect(evalLine(line), line).toMatchObject({ decision: 'ok', matches: [] });
    }
  });
});

describe('evaluateScript: other one-token routes to an object or to code', () => {
  it('elicits on instance_from_id as a global function only', () => {
    expect(evalLine('var o = instance_from_id(id)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.reflection.instance_from_id',
    ]);
    expect(evalLine('registry.instance_from_id(id)')).toMatchObject({ decision: 'ok' });
    expect(evalLine('lookup().instance_from_id(id)')).toMatchObject({ decision: 'ok' });
  });

  it('elicits on JavaScriptBridge.eval, directly and by a literal dispatch', () => {
    expect(evalLine('JavaScriptBridge.eval(code)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.dynamic.JavaScriptBridge.eval',
    ]);
    expect(evalLine('JavaScriptBridge.call("eval", code)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.dynamic.JavaScriptBridge.eval',
    ]);
    expect(evalLine('JavaScriptBridge.get_interface("window")').decision).toBe('ok');
  });
});

describe('evaluateScript: a raw or prefixed string is a literal', () => {
  const tiers = (line: string): Array<[string, number]> =>
    evalLine(line).matches.map((m) => [m.ruleId, m.tier]);

  it.each([
    ['load(r"res://x.gd")', 'tier3.literal.load'],
    ["load(r'res://x.gd')", 'tier3.literal.load'],
    ['load(r\"\"\"res://x.gd\"\"\")', 'tier3.literal.load'],
    ['preload(r"res://x.gd")', 'tier3.literal.preload'],
    ['ResourceLoader.load(r"res://x.gd")', 'tier3.literal.ResourceLoader.load'],
    [
      'ResourceLoader.load_threaded_request(r"res://x.gd")',
      'tier3.literal.ResourceLoader.load_threaded_request',
    ],
    ['load(&"res://x.gd")', 'tier3.literal.load'],
    ['load(^"res://x.gd")', 'tier3.literal.load'],
  ])('%s is a literal load', (line, ruleId) => {
    expect(tiers(line)).toEqual([[ruleId, 3]]);
  });

  it('a raw string joined to something else is still non-literal', () => {
    expect(tiers('load(r"res://" + name)')).toEqual([['tier1.indirect.load.nonliteral', 1]]);
    expect(tiers('load(r + "x")')).toEqual([['tier1.indirect.load.nonliteral', 1]]);
  });

  it('a variable named r is not a string prefix', () => {
    expect(tiers('load(r)')).toEqual([['tier1.indirect.load.nonliteral', 1]]);
    expect(evalLine('var r = 1\n\tprint(r, "x")').decision).toBe('ok');
  });

  it('code after a raw string that ends in a backslash-quote pair is still read', () => {
    expect(tiers('var p = r"a\\"b"; OS.execute("cmd", [])')).toEqual([
      ['tier1.direct_exec.OS.execute', 1],
    ]);
  });
});

describe('evaluateScript: DirAccess writes on an instance', () => {
  const tiers = (line: string): Array<[string, number]> =>
    evalLine(line).matches.map((m) => [m.ruleId, m.tier]);
  const strictDecision = (line: string): string =>
    evaluateScript(`${VALID_PREFIX}${line}\n`, true).decision;

  it.each([
    ['a variable receiver', 'dir.create_link("a", "b")'],
    ['a call receiver', 'get_dir().create_link("a", "b")'],
  ])('elicits on create_link through %s', (_name, line) => {
    expect(tiers(line)).toEqual([['tier2.fs.DirAccess.create_link', 2]]);
    expect(strictDecision(line)).toBe('hard_block');
  });

  it('elicits on the static copy_absolute and rename_absolute', () => {
    expect(tiers('DirAccess.copy_absolute(a, b)')).toEqual([
      ['tier2.fs.DirAccess.copy_absolute', 2],
    ]);
    expect(tiers('DirAccess.rename_absolute(a, b)')).toEqual([
      ['tier2.fs.DirAccess.rename_absolute', 2],
    ]);
  });

  it('notes a DirAccess instance, whose remove, copy and rename no rule can key on', () => {
    const decision = evalLine('var d = DirAccess.open("user://")\n\td.remove("save.dat")');
    expect(decision).toMatchObject({
      decision: 'warn',
      matches: [{ ruleId: 'tier3.fs.DirAccess', tier: 3, line: 3 }],
    });
    expect(decision.matches).toHaveLength(1);
    expect(tiers('DirAccess.open(p).rename("a", "b")')).toEqual([['tier3.fs.DirAccess', 3]]);
    expect(tiers('var d: DirAccess = null')).toEqual([['tier3.fs.DirAccess', 3]]);
  });

  it('strict mode does not refuse a script for opening a directory', () => {
    const source = `${VALID_PREFIX}var d = DirAccess.open("res://")\n\treturn d.get_files()\n`;
    expect(evaluateScript(source, true)).toMatchObject({
      decision: 'warn',
      promotedByStrict: false,
    });
  });

  it.each(['inventory.remove(item)', 'grid.copy()', 'node.rename("x")', 'tab.remove(0)'])(
    'leaves %s alone: the name is ordinary game code on any other receiver',
    (line) => {
      expect(evalLine(line)).toMatchObject({ decision: 'ok', matches: [] });
      expect(strictDecision(line)).toBe('ok');
    },
  );

  it('the specific DirAccess rules still win over the class note', () => {
    expect(tiers('DirAccess.remove_absolute(p)')).toEqual([
      ['tier2.fs.DirAccess.remove_absolute', 2],
    ]);
    expect(tiers('DirAccess.make_dir_absolute(p)')).toEqual([
      ['tier2.fs.DirAccess.make_dir_absolute', 2],
    ]);
    expect(tiers('DirAccess.remove("x")')).toEqual([['tier2.fs.DirAccess.remove', 2]]);
  });
});

describe('evaluateScript: the scan work is bounded', () => {
  const NESTING = 60_000;
  // The unbounded re-scan is quadratic in the nesting (minutes at this depth);
  // the bounded scan is linear (a second or two).
  const BOUNDED_SCAN_TIMEOUT_MS = 8_000;

  it(
    'evaluates 60000 nested dispatch calls inside the test timeout and fails closed',
    () => {
      const source =
        `${VALID_PREFIX}` + 'a.call('.repeat(NESTING) + 'load("x")' + ')'.repeat(NESTING) + '\n';
      const decision = evaluateScript(source);
      // Past the budget the first argument of the innermost load("x") answers
      // nonliteral, so the literal is reported: the fail-closed side.
      expect(decision.matches.some((m) => m.ruleId === 'tier1.indirect.load.nonliteral')).toBe(
        true,
      );
      expect(decision.decision).toBe('hard_block');
    },
    BOUNDED_SCAN_TIMEOUT_MS,
  );

  it('an ordinary script keeps its findings: a literal load is only noted', () => {
    expect(evalLine('load("res://x.tres")').matches.map((m) => m.ruleId)).toEqual([
      'tier3.literal.load',
    ]);
    expect(evalLine('a.call("set_script", s)').matches.map((m) => m.ruleId)).toEqual([
      'tier2.reflection.set_script.bareIdentifier',
    ]);
    expect(evalLine('OS.call("execute", "ls")').decision).toBe('hard_block');
    expect(evalLine('OS.callv("execute", ["ls"])').decision).toBe('hard_block');
  });
});
