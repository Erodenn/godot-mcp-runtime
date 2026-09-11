/**
 * Policy evaluator tests. Verifies tier assignment, argument-shape checks,
 * strict-mode promotion, and that comments / strings don't false-positive.
 */

import { describe, it, expect } from 'vitest';
import { evaluateScript } from '../../src/utils/run-script-policy.js';

const VALID_PREFIX = 'extends RefCounted\nfunc execute(scene_tree):\n\t';

function evalLine(line: string): ReturnType<typeof evaluateScript> {
  return evaluateScript(VALID_PREFIX + line + '\n');
}

describe('evaluateScript — Tier 1 hard_block', () => {
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

describe('evaluateScript — Tier 2 elicit_required', () => {
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

describe('evaluateScript — Tier 3 warn', () => {
  it('warns on literal load() but executes', () => {
    const d = evalLine('var r = load("res://main.tscn")');
    expect(d.decision).toBe('warn');
    expect(d.effectiveTier).toBe(3);
  });

  it('warns on OS.alert', () => {
    expect(evalLine('OS.alert("hi")').decision).toBe('warn');
  });
});

describe('evaluateScript — clean scripts', () => {
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

describe('evaluateScript — strict mode promotion', () => {
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

describe('evaluateScript — highest tier wins', () => {
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

describe('evaluateScript — finding line numbers', () => {
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

describe('evaluateScript — Tier 1 OS family (smoke)', () => {
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

describe('evaluateScript — Tier 1 ProjectSettings/Engine/ClassDB (smoke)', () => {
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

describe('evaluateScript — Tier 1 reflection + dynamic (smoke)', () => {
  it('blocks Node.set_script(...) literal receiver', () => {
    expect(evalLine('Node.set_script(some_node, my_script)').effectiveTier).toBe(1);
  });
  it('blocks bytes_to_var_with_objects as bare identifier', () => {
    expect(evalLine('var v = bytes_to_var_with_objects(data)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript — Tier 1 ConfigFile family (smoke)', () => {
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

describe('evaluateScript — Tier 1 Object.callv non-literal (smoke)', () => {
  it('blocks Object.callv with non-literal method name', () => {
    expect(evalLine('Object.callv(method_var, args)').effectiveTier).toBe(1);
  });
});

describe('evaluateScript — Tier 2 DirAccess writes (smoke)', () => {
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

describe('evaluateScript — Tier 2 network (smoke)', () => {
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

describe('evaluateScript — Tier 1 Callable bypass closure', () => {
  it('blocks Callable(target, "method") as bare identifier', () => {
    const d = evalLine('var c = Callable(self, "run")');
    expect(d.decision).toBe('hard_block');
    expect(d.matches.some((m) => m.ruleId === 'tier1.reflection.Callable')).toBe(true);
  });
});

describe('evaluateScript — Tier 1 per-singleton .call non-literal bypass closure', () => {
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

describe('evaluateScript — Tier 3 per-singleton .call literal arg', () => {
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

describe('evaluateScript — member chain whitespace/newline skeleton key', () => {
  // Regression coverage: the tokenizer used to require the dot to sit
  // immediately against both identifiers, so whitespace or a newline around
  // the `.` dropped `execute` to a bare, unmatched identifier — silently
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

describe('evaluateScript — whole-first-argument classification', () => {
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

describe('evaluateScript — generic non-literal .call/.callv on any receiver', () => {
  it('elicits on some_node.call(method_var) — arbitrary receiver, non-literal', () => {
    const d = evalLine('some_node.call(method_var)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.call.nonliteral')).toBe(true);
  });

  it('elicits on some_node.callv(method_var, args) — arbitrary receiver, non-literal', () => {
    const d = evalLine('some_node.callv(method_var, args)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.generic.callv.nonliteral')).toBe(true);
  });

  it('does not match some_node.call("ready") — literal argument', () => {
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

describe('evaluateScript — Tier 2 set_script bare identifier', () => {
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

describe('evaluateScript — write primitives', () => {
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

describe('evaluateScript — write-primitive negatives', () => {
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

describe('evaluateScript — ConfigFile instance usage', () => {
  it('elicits on cf.load(path) when ConfigFile.new() appears in the same script', () => {
    const d = evalLine('var cf := ConfigFile.new()\n\tcf.load(path)');
    expect(d.decision).toBe('elicit_required');
    expect(d.matches.some((m) => m.ruleId === 'tier2.config.ConfigFile')).toBe(true);
  });

  it('does not block a bare receiver.load(x) call — `load` is too generic to key on', () => {
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

describe('evaluateScript — strict mode promotes the write primitives', () => {
  it('promotes ResourceSaver.save to hard_block under strict mode', () => {
    const source = VALID_PREFIX + 'ResourceSaver.save(res, path)\n';
    const strict = evaluateScript(source, true);
    expect(strict.decision).toBe('hard_block');
    expect(strict.promotedByStrict).toBe(true);
  });
});
