#!/usr/bin/env -S godot --headless --script
extends SceneTree

var debug_mode = false

# The marker asks the TS layer to import and re-run the operation; only safe while nothing is written.
var import_marker_armed = true

var last_scene_load_error: String = ""

# The Node side reads only the stdout line carrying this marker; the banner and project prints share stdout.
# KEEP IN SYNC with OPERATION_RESULT_SENTINEL in src/utils/output-parsing.ts.
const OPERATION_RESULT_SENTINEL := "MCP_OPERATION_RESULT:"

# A project script can print the constant sentinel, so each run gets a random token and the Node side accepts only the line echoing it.
# KEEP IN SYNC with OPERATION_RESULT_TOKEN_ENV and OPERATION_RESULT_TOKEN_END in src/utils/output-parsing.ts.
const OPERATION_RESULT_TOKEN_ENV := "MCP_OPERATION_RESULT_TOKEN"
const OPERATION_RESULT_TOKEN_END := ":"

var result_token := ""

# SceneTree.quit(code) only records the code and a later quit() replaces it: the single quit is in _initialize.
const _EXIT_SUCCESS := 0
const _EXIT_FAILURE := 1

var operation_failed := false

# A run that neither emitted a result nor failed was cut short by a script error.
var result_emitted := false

# Warnings raised below the payload builder; emit_result puts them ahead of the payload's own.
var result_warnings: Array = []

const _NON_FINITE_PATH_CAP := 8

const _SELF_CONTAINING_MARKER := "<truncated: this container contains itself>"

# Compared by identity: == on a container that holds itself recurses forever.
func _encloses(enclosing: Array, container) -> bool:
	for outer in enclosing:
		if is_same(outer, container):
			return true
	return false

# Never an edit in place: a payload can hold a node's own typed container, which refuses a null.
func _null_non_finite(value, path: String, found: Array, enclosing: Array):
	match typeof(value):
		TYPE_FLOAT:
			if not is_finite(value):
				found.append(path if path != "" else "(result)")
				return null
		TYPE_DICTIONARY:
			var dict: Dictionary = value
			if _encloses(enclosing, dict):
				return _SELF_CONTAINING_MARKER
			enclosing.append(dict)
			var cleaned_dict: Dictionary = {}
			for key in dict.keys():
				var child_path: String = str(key) if path == "" else path + "." + str(key)
				cleaned_dict[key] = _null_non_finite(dict[key], child_path, found, enclosing)
			enclosing.pop_back()
			return cleaned_dict
		TYPE_ARRAY:
			var arr: Array = value
			if _encloses(enclosing, arr):
				return _SELF_CONTAINING_MARKER
			enclosing.append(arr)
			var cleaned_array: Array = []
			for i in range(arr.size()):
				cleaned_array.append(_null_non_finite(arr[i], path + "[" + str(i) + "]", found, enclosing))
			enclosing.pop_back()
			return cleaned_array
		TYPE_PACKED_FLOAT32_ARRAY:
			var packed32: PackedFloat32Array = value
			return _null_non_finite(Array(packed32), path, found, enclosing)
		TYPE_PACKED_FLOAT64_ARRAY:
			var packed64: PackedFloat64Array = value
			return _null_non_finite(Array(packed64), path, found, enclosing)
	return value

# The warning goes into a Dictionary payload's own `warnings`; an Array payload has nowhere to put one.
func _sanitize_non_finite(payload):
	var found: Array = []
	var cleaned = _null_non_finite(payload, "", found, [])
	if found.is_empty() or not (cleaned is Dictionary):
		return cleaned
	var shown: Array = found.slice(0, _NON_FINITE_PATH_CAP)
	var text := "%d non-finite numbers (INF, NAN) were returned as null at: %s" % [found.size(), ", ".join(PackedStringArray(shown))]
	if found.size() > shown.size():
		text += " (and %d more)" % (found.size() - shown.size())
	var existing = cleaned.get("warnings", [])
	var combined: Array = existing.duplicate() if existing is Array else []
	combined.append(text)
	cleaned["warnings"] = combined
	return cleaned

# The only emitter of a result line; never print one directly.
func emit_result(payload) -> void:
	result_emitted = true
	payload = _sanitize_non_finite(payload)
	if payload is Dictionary and not result_warnings.is_empty():
		var combined: Array = result_warnings.duplicate()
		combined.append_array(payload.get("warnings", []))
		payload["warnings"] = combined
	var token_part := "" if result_token.is_empty() else result_token + OPERATION_RESULT_TOKEN_END
	print(OPERATION_RESULT_SENTINEL + token_part + JSON.stringify(payload))

# Only records the failure: every call must be followed by `return`, or control falls through into success-print and save.
func _fail_operation() -> void:
	operation_failed = true

# Takes the result token and removes it from the environment so a later project script cannot read it back. No operation work belongs here: see _initialize.
func _init() -> void:
	result_token = OS.get_environment(OPERATION_RESULT_TOKEN_ENV)
	# By name: the method is missing from the oldest 4.x releases and a direct call would stop the script compiling there.
	if not result_token.is_empty() and OS.has_method("unset_environment"):
		OS.call("unset_environment", OPERATION_RESULT_TOKEN_ENV)

# Runs after autoload singletons are registered as globals; in _init a scene script naming one fails to compile.
# The work stays in a callee so a runtime error cannot skip the quit. This is the only quit in the file, so nothing replaces its code.
func _initialize():
	_run_from_cmdline()
	quit(_EXIT_FAILURE if operation_failed or not result_emitted else _EXIT_SUCCESS)

func _run_from_cmdline() -> void:
	var args = OS.get_cmdline_args()

	debug_mode = "--debug-godot" in args

	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		_fail_operation()
		return

	var operation_index = script_index + 2
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		log_error("Not enough command-line arguments provided.")
		_fail_operation()
		return

	log_debug("All arguments: " + str(args))

	var operation = args[operation_index]
	var params_json = args[params_index]

	# KEEP IN SYNC with OPERATION_STARTED_MARKER in src/utils/godot-runner.ts: the
	# Node side reads this line as proof that dispatch started.
	log_info("Operation: " + operation)
	log_debug("Params JSON: " + params_json)

	var json = JSON.new()
	var error = json.parse(params_json)
	var params = null

	if error == OK:
		params = json.get_data()
	else:
		log_error("Failed to parse JSON parameters: " + params_json)
		log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
		_fail_operation()
		return

	if not params:
		log_error("Failed to parse JSON parameters: " + params_json)
		_fail_operation()
		return

	log_info("Executing operation: " + operation)

	match operation:
		"create_scene":
			create_scene(params)
		"add_node":
			add_node(params)
		"load_sprite":
			load_sprite(params)
		"export_mesh_library":
			export_mesh_library(params)
		"save_scene":
			save_scene(params)
		"delete_nodes":
			delete_nodes(params)
		"set_node_properties":
			set_node_properties(params)
		"get_node_properties":
			get_node_properties(params)
		"get_scene_tree":
			get_scene_tree(params)
		"attach_script":
			attach_script(params)
		"duplicate_node":
			duplicate_node(params)
		"get_node_signals":
			get_node_signals(params)
		"connect_signal":
			connect_signal(params)
		"disconnect_signal":
			disconnect_signal(params)
		"validate_resource":
			validate_resource(params)
		"validate_checks":
			validate_checks(params)
		"validate_batch":
			validate_batch(params)
		"batch_scene_operations":
			batch_scene_operations(params)
		_:
			log_error("Unknown operation: " + operation)
			_fail_operation()
			return

# Every log line goes to stderr: stdout carries only the sentinel-framed result, and DEBUG must never change a tool's return.
func log_debug(message):
	if debug_mode:
		printerr("[DEBUG] " + message)

func log_info(message):
	printerr("[INFO] " + message)

func log_error(message):
	printerr("[ERROR] " + message)

func get_script_by_name(name_of_class):
	if debug_mode:
		printerr("Attempting to get script for class: " + name_of_class)

	# A non-identifier is a script path and is contained like every other path: Godot resolves res://../x outward.
	var direct_path: String = name_of_class
	if not _is_ascii_identifier(name_of_class):
		direct_path = normalize_scene_path(name_of_class)
		if direct_path.is_empty():
			printerr("Path escapes the project root: " + name_of_class)
			return null

	if ResourceLoader.exists(direct_path, "Script"):
		if debug_mode:
			printerr("Resource exists, loading directly: " + direct_path)
		var script = load(direct_path) as Script
		if script:
			if debug_mode:
				printerr("Successfully loaded script from path")
			return script
		else:
			printerr("Failed to load script from path: " + name_of_class)
	elif debug_mode:
		printerr("Resource not found, checking global class registry")

	var global_classes = ProjectSettings.get_global_class_list()
	if debug_mode:
		printerr("Searching through " + str(global_classes.size()) + " global classes")

	for global_class in global_classes:
		var found_name_of_class = global_class["class"]
		var found_path = global_class["path"]

		if found_name_of_class == name_of_class:
			if debug_mode:
				printerr("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
			var script = load(found_path) as Script
			if script:
				if debug_mode:
					printerr("Successfully loaded script from registry")
				return script
			else:
				printerr("Failed to load script from registry path: " + found_path)
				break

	printerr("Could not find script for class: " + name_of_class)
	return null

func instantiate_class(name_of_class):
	if name_of_class.is_empty():
		printerr("Cannot instantiate class: name is empty")
		return null

	var result = null
	if debug_mode:
		printerr("Attempting to instantiate class: " + name_of_class)

	if ClassDB.class_exists(name_of_class):
		if debug_mode:
			printerr("Class exists in ClassDB, using ClassDB.instantiate()")
		if ClassDB.can_instantiate(name_of_class):
			result = ClassDB.instantiate(name_of_class)
			if result == null:
				printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
		else:
			printerr("Class exists but cannot be instantiated: " + name_of_class)
	else:
		if debug_mode:
			printerr("Class not found in ClassDB, trying to get script")
		var script = get_script_by_name(name_of_class)
		if script is GDScript:
			if debug_mode:
				printerr("Found GDScript, creating instance")
			result = script.new()
		else:
			printerr("Failed to get script for class: " + name_of_class)
			return null

	if result == null:
		printerr("Failed to instantiate class: " + name_of_class)
	elif debug_mode:
		printerr("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

	return result

# Rejects any path that escapes the project root (Godot resolves res://../x outward); "" is the rejection and callers must treat it as one.
# Decided on the text after res:// before simplify_path, whose handling of a root or drive prefix differs between engine versions.
func normalize_scene_path(scene_path: String) -> String:
	var written: String = scene_path
	if written.begins_with("res://"):
		written = written.substr("res://".length())
	written = written.replace("\\", "/")
	if written.is_empty() or written.begins_with("/") or written.contains(":"):
		return ""
	var relative: String = written.simplify_path()
	if relative.is_empty() or relative.begins_with("/"):
		return ""
	for segment in relative.split("/"):
		if segment == "..":
			return ""
	return "res://" + relative

# Canonical res:// spelling of a scene file as on disk: Windows and macOS open Player.tscn and player.tscn as one file but caches key by path text.
# A segment is respelled only when the file system resolved it and exactly one entry differs by case alone.
func _scene_file_key(scene_path: String) -> String:
	var normalized := normalize_scene_path(scene_path)
	if normalized.is_empty():
		return ""
	if _scene_file_keys.has(normalized):
		return _scene_file_keys[normalized]
	var resolved := "res://"
	for segment in normalized.substr("res://".length()).split("/"):
		resolved = resolved.path_join(_entry_name_on_disk(resolved, segment))
	_scene_file_keys[normalized] = resolved
	return resolved

var _scene_file_keys: Dictionary = {}

# Called when this process creates a file or directory: the new entry changes answers for its own path, its case variants and everything below.
func _forget_scene_file_keys() -> void:
	_scene_file_keys.clear()

# Returns entry_name unchanged when it is listed exactly, absent, or ambiguous by case alone.
func _entry_name_on_disk(dir_path: String, entry_name: String) -> String:
	var requested := dir_path.path_join(entry_name)
	if not (FileAccess.file_exists(requested) or DirAccess.dir_exists_absolute(requested)):
		return entry_name
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return entry_name
	dir.include_hidden = true
	var entries: Array = Array(dir.get_files())
	entries.append_array(Array(dir.get_directories()))
	if entry_name in entries:
		return entry_name
	var folded := entry_name.to_lower()
	var on_disk := ""
	for candidate in entries:
		if str(candidate).to_lower() != folded:
			continue
		if on_disk != "":
			return entry_name
		on_disk = str(candidate)
	return entry_name if on_disk == "" else on_disk

func _project_relative(res_path: String) -> String:
	if res_path.begins_with("res://"):
		return res_path.substr("res://".length())
	return res_path

# A dependency string is bare "res://x" or uid-form "uid://id::::res://x"; the uid's current path wins because the editor may have moved the file.
# rfind, not get_slice, so a bare path containing "::" still parses.
func _resolve_dep_path(dep: String) -> String:
	var text_path = dep.substr(dep.rfind("::") + 2) if dep.contains("::") else dep
	if not dep.begins_with("uid://"):
		return text_path
	var uid_text = dep.substr(0, dep.find("::")) if dep.contains("::") else dep
	var id := ResourceUID.text_to_id(uid_text)
	if id != ResourceUID.INVALID_ID and ResourceUID.has_id(id):
		return ResourceUID.get_id_path(id)
	return text_path

# Non-res:// paths are always "ok": nothing here can check them.
func _classify_dep_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "ok"
	if ResourceLoader.exists(path):
		return "ok"
	if FileAccess.file_exists(path):
		return "needs_import"
	return "missing"

# The marker asks executeSceneOp to import and re-run the SAME operation, which duplicates nodes once a batch has mutated a scene; disarmed, the failure is loud instead.
# Returns the error string the caller reports for the failed operation.
func _report_import_needed(context: String, paths: String) -> String:
	if import_marker_armed:
		# KEEP IN SYNC with IMPORT_NEEDED_LINE in src/utils/headless-op.ts: the marker and log_error's prefix.
		log_error("[IMPORT_NEEDED] " + context + ": " + paths)
		return "asset not yet imported: " + paths
	log_error("Asset not yet imported, and an earlier operation in this batch has already mutated a scene: " + paths + " (" + context + "). Refusing the automatic import-and-retry, which would re-apply those mutations a second time.")
	return "asset not yet imported, import-and-retry refused because an earlier operation in this batch already mutated a scene: " + paths

# Shared by load_scene_instance and the batch pre-pass: needs_import is on disk but never imported, missing is not on disk.
func _probe_scene_deps(full_path: String) -> Dictionary:
	var deps = ResourceLoader.get_dependencies(full_path)
	var needs_import: Array = []
	var missing: Array = []
	for dep in deps:
		var path = _resolve_dep_path(dep)
		var status = _classify_dep_path(path)
		if status == "needs_import":
			needs_import.append(path)
		elif status == "missing":
			missing.append(path)
	return {"needs_import": needs_import, "missing": missing}

# Probes dependencies before load(): a never-imported one makes load() succeed with null resources (or hang), and the save strips the reference.
# Mechanism and the rejected MissingResource route: docs/architecture.md "Cold Asset Import".
func load_scene_instance(scene_path: String):
	last_scene_load_error = ""
	var full_path = _scene_file_key(scene_path)
	if full_path.is_empty():
		last_scene_load_error = "Path escapes the project root: " + scene_path
		log_error(last_scene_load_error)
		return null
	log_debug("Loading scene from: " + full_path)

	if not FileAccess.file_exists(full_path):
		last_scene_load_error = "Scene file does not exist: " + full_path
		log_error(last_scene_load_error)
		return null

	# Missing files first: a scene with both problems is refused rather than imported and then refused.
	var probe = _probe_scene_deps(full_path)
	if probe.missing.size() > 0:
		last_scene_load_error = "Scene references files that do not exist on disk, refusing to load so the references are not stripped on save: " + ", ".join(probe.missing)
		log_error(last_scene_load_error)
		return null
	if probe.needs_import.size() > 0:
		last_scene_load_error = _report_import_needed(scene_path, ", ".join(probe.needs_import))
		return null

	var scene = load(full_path)
	if not scene:
		last_scene_load_error = "Failed to load scene: " + full_path
		log_error(last_scene_load_error)
		return null

	var instance = _instantiate_packed(scene, true)
	if not instance:
		last_scene_load_error = "Failed to instantiate scene: " + full_path
		log_error(last_scene_load_error)
		return null

	return instance

# pack() tells an override from an inherited value only when instantiated with an edit state; without it a save flattens an inherited scene.
# Edit states exist in editor builds only.
func _instantiate_packed(scene: PackedScene, as_main_scene: bool) -> Node:
	if not OS.has_feature("editor"):
		return scene.instantiate()
	var edit_state := PackedScene.GEN_EDIT_STATE_MAIN if as_main_scene else PackedScene.GEN_EDIT_STATE_INSTANCE
	return scene.instantiate(edit_state)

# Freshly instantiated root of the inherited scene, or null; the caller frees it.
func _instantiate_base_scene(scene_path: String) -> Node:
	var full_path := _scene_file_key(scene_path)
	if full_path.is_empty():
		return null
	var packed = load(full_path)
	if packed == null or not (packed is PackedScene):
		return null
	var base = packed.get_state().get_node_instance(0)
	if base == null or not (base is PackedScene):
		return null
	return base.instantiate()

# Accepts "root", ".", "", the root's name, or either as a first segment ("root/Button"); bare paths resolve normally.
func find_node_by_path(scene_root: Node, node_path: String) -> Node:
	if node_path == "" or node_path == "." or node_path == "root":
		return scene_root
	if node_path == String(scene_root.name):
		return scene_root

	var path = node_path
	var first_slash = path.find("/")
	if first_slash != -1:
		var first_segment = path.substr(0, first_slash)
		if first_segment == "root" or first_segment == String(scene_root.name):
			path = path.substr(first_slash + 1)

	if path.is_empty():
		return scene_root

	return scene_root.get_node_or_null(path)

const _SCENE_HEADER_PREFIX := "[gd_scene"
const _EXT_RESOURCE_PREFIX := "[ext_resource "
const _UID_ATTR := "uid=\""
const _PATH_ATTR := "path=\""
const _SCENE_BODY_PREFIXES: Array = ["[node ", "[sub_resource "]

func _starts_scene_body(line: String) -> bool:
	for prefix in _SCENE_BODY_PREFIXES:
		if line.begins_with(prefix):
			return true
	return false

func _header_attr(line: String, attr: String) -> String:
	var at := line.find(" " + attr)
	if at == -1:
		return ""
	var start := at + 1 + attr.length()
	var end := line.find("\"", start)
	return "" if end == -1 else line.substr(start, end - start)

# Reads the header text, not ResourceLoader.get_resource_uid, which answers -1 on 4.6 in a project with no uid cache.
func _read_scene_uids(full_path: String) -> Dictionary:
	var found := {"scene": "", "ext": {}}
	if not full_path.to_lower().ends_with(".tscn") or not FileAccess.file_exists(full_path):
		return found
	for raw_line in FileAccess.get_file_as_string(full_path).split("\n"):
		var line: String = raw_line.strip_edges()
		if line.begins_with(_SCENE_HEADER_PREFIX):
			found.scene = _header_attr(line, _UID_ATTR)
		elif line.begins_with(_EXT_RESOURCE_PREFIX):
			var uid := _header_attr(line, _UID_ATTR)
			var path := _header_attr(line, _PATH_ATTR)
			if uid != "" and path != "" and not path.contains("\\"):
				found.ext[path] = uid
		elif _starts_scene_body(line):
			break
	return found

const _UID_TEXT_PREFIX := "uid://"
const _UID_SIDECAR_SUFFIX := ".uid"
const _REWRITE_TEMP_SUFFIX := ".mcp-rewrite.tmp"

# The uid the project already records for the file, or ""; never a new id. The engine lookup answers INVALID_ID for some files in a project with no uid cache, so the scene header and .uid sidecar are read too.
# get_resource_uid is called by name so the script compiles on an engine that predates it.
func _recorded_uid_text(res_path: String) -> String:
	if ResourceLoader.has_method("get_resource_uid"):
		var id: int = ResourceLoader.call("get_resource_uid", res_path)
		if id != ResourceUID.INVALID_ID:
			return ResourceUID.id_to_text(id)
	if res_path.to_lower().ends_with(".tscn"):
		return str(_read_scene_uids(res_path).scene)
	var sidecar_path := res_path + _UID_SIDECAR_SUFFIX
	if FileAccess.file_exists(sidecar_path):
		var sidecar_text := FileAccess.get_file_as_string(sidecar_path).strip_edges()
		if sidecar_text.begins_with(_UID_TEXT_PREFIX) and ResourceUID.text_to_id(sidecar_text) != ResourceUID.INVALID_ID:
			return sidecar_text
	return ""

# Writes via a temporary file renamed over the target; if the rename removed the target and could not place the new file, the error says where the text is.
func _replace_file_text(full_path: String, text: String) -> bool:
	var temp_path := full_path + _REWRITE_TEMP_SUFFIX
	var file := FileAccess.open(temp_path, FileAccess.WRITE)
	if file == null:
		log_error("Could not open %s for writing (error %d)" % [temp_path, FileAccess.get_open_error()])
		return false
	file.store_string(text)
	var write_error := file.get_error()
	file.close()
	if write_error != OK:
		log_error("Could not write %s (error %d)" % [temp_path, write_error])
		DirAccess.remove_absolute(temp_path)
		return false
	if FileAccess.get_file_as_string(temp_path) != text:
		log_error("%s does not hold the text that was written to it" % temp_path)
		DirAccess.remove_absolute(temp_path)
		return false
	var dir := DirAccess.open(full_path.get_base_dir())
	if dir == null:
		log_error("Could not open the directory of %s (error %d)" % [full_path, DirAccess.get_open_error()])
		DirAccess.remove_absolute(temp_path)
		return false
	var rename_error := dir.rename(temp_path, full_path)
	if rename_error == OK:
		return true
	if FileAccess.file_exists(full_path):
		log_error("Could not rename %s over %s (error %d)" % [temp_path, full_path, rename_error])
		DirAccess.remove_absolute(temp_path)
	else:
		log_error("Could not rename %s over %s (error %d). %s is gone; its text is in %s" % [temp_path, full_path, rename_error, full_path, temp_path])
	return false

# ResourceSaver.save outside the editor writes neither the scene's own uid nor any ext_resource uid (the id lookup is an editor callback); both are put back here.
# A reference takes the uid the old text gave its path, else the one the project records; a file with no recorded uid stays path-only.
func _restore_scene_uids(full_path: String, scene_uid: String, ext_uids: Dictionary) -> bool:
	if not full_path.to_lower().ends_with(".tscn"):
		return true
	if scene_uid != "":
		var id := ResourceUID.text_to_id(scene_uid)
		if id != ResourceUID.INVALID_ID and ResourceSaver.set_uid(full_path, id) != OK:
			log_error("Could not restore the scene uid on " + full_path)
			return false
	var text := FileAccess.get_file_as_string(full_path)
	if text.is_empty():
		log_error("Could not read the saved scene back to restore its ext_resource uids: %s (error %d)" % [full_path, FileAccess.get_open_error()])
		return false
	var lines := text.split("\n")
	var changed := false
	for i in range(lines.size()):
		var line: String = lines[i]
		if _starts_scene_body(line):
			break
		if not line.begins_with(_EXT_RESOURCE_PREFIX) or line.contains(" " + _UID_ATTR):
			continue
		var path := _header_attr(line, _PATH_ATTR)
		var at := line.find(" " + _PATH_ATTR)
		if path == "" or at == -1 or path.contains("\\"):
			continue
		var uid_text: String = str(ext_uids.get(path, ""))
		if uid_text == "":
			uid_text = _recorded_uid_text(path)
		if uid_text == "":
			continue
		lines[i] = line.substr(0, at) + " " + _UID_ATTR + uid_text + "\"" + line.substr(at)
		changed = true
	if not changed:
		return true
	return _replace_file_text(full_path, "\n".join(lines))

# CACHE_MODE_REPLACE copies the saved content into the cached PackedScene in place (Resource.copy_from), so every holder keeps its object.
# Never swap it (take_over_path): that clears the path other trees hold and pack() then writes a whole sub_resource.
func _refresh_cached_scene(full_path: String) -> void:
	if not ResourceLoader.has_cached(full_path):
		return
	if ResourceLoader.load(full_path, "", ResourceLoader.CACHE_MODE_REPLACE) == null:
		log_error("Could not reload the cached scene after saving it: " + full_path)

# A scene written while its uids could not be put back still returns true with a result_warnings entry: false would make the agent apply the operations a second time.
func save_scene_to_path(scene_root: Node, save_path: String) -> bool:
	var full_path = _scene_file_key(save_path)
	if full_path.is_empty():
		log_error("Path escapes the project root: " + save_path)
		return false

	# The scene's own uid comes only from the file being overwritten (none for a new path); referenced files' uids travel with a save-as.
	var target_uids := _read_scene_uids(full_path)
	var ext_uids: Dictionary = target_uids.ext.duplicate()
	var source_path: String = scene_root.scene_file_path
	if source_path != "" and source_path != full_path:
		ext_uids.merge(_read_scene_uids(source_path).ext)

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result != OK:
		log_error("Failed to pack scene: " + str(result))
		return false

	var is_new_file := not FileAccess.file_exists(full_path)
	var save_error = ResourceSaver.save(packed_scene, full_path)
	if save_error != OK:
		log_error("Failed to save scene: " + str(save_error))
		return false
	if is_new_file:
		_forget_scene_file_keys()

	var uids_restored := _restore_scene_uids(full_path, str(target_uids.scene), ext_uids)
	# A rename that fails half way can leave no file at the path.
	if not FileAccess.file_exists(full_path):
		log_error("Scene was written, but the file is gone after its uid rewrite failed: " + full_path)
		return false
	if not uids_restored:
		result_warnings.append("Scene %s was written, but its uids could not be put back (the file may be locked by another program). The operation is saved, do not apply it again. The scene's own uid or the uid of a file it references may be missing from it until the next save." % _project_relative(full_path))
	_refresh_cached_scene(full_path)
	return true

func _ensure_res_dir(full_res_path: String) -> bool:
	var dir_path = full_res_path.get_base_dir()
	if dir_path == "res://" or dir_path.is_empty():
		return true
	var dir = DirAccess.open("res://")
	if not dir:
		return false
	var relative_dir = dir_path.substr(6) if dir_path.begins_with("res://") else dir_path
	if relative_dir.is_empty() or dir.dir_exists(relative_dir):
		return true
	_forget_scene_file_keys()
	return dir.make_dir_recursive(relative_dir) == OK

func create_scene(params):
	printerr("Creating scene: " + params.scene_path)

	var full_scene_path = normalize_scene_path(params.scene_path)
	if full_scene_path.is_empty():
		log_error("Path escapes the project root: " + params.scene_path)
		_fail_operation()
		return
	log_debug("Scene path: " + full_scene_path)

	var root_node_type = "Node2D"
	if params.has("root_node_type"):
		root_node_type = params.root_node_type
	log_debug("Root node type: " + root_node_type)

	var instantiated: Dictionary = _instantiate_node_class(str(root_node_type))
	if not instantiated.ok:
		log_error(instantiated.error)
		_fail_operation()
		return
	var scene_root: Node = instantiated.node

	scene_root.name = "root"
	scene_root.owner = scene_root

	if not _ensure_res_dir(full_scene_path):
		log_error("Failed to create directory for scene: " + full_scene_path)
		_fail_operation()
		return

	if save_scene_to_path(scene_root, full_scene_path):
		emit_result({"scenePath": _project_relative(full_scene_path)})
	else:
		log_error("Failed to create scene: " + params.scene_path)
		_fail_operation()
		return

# Spatial params add_node accepts at top level. KEEP IN SYNC with PROMOTED_SPATIAL_PARAMS in src/tools/scene-tools.ts.
const _PROMOTED_SPATIAL_PARAMS: Array = ["position", "rotation", "scale", "visible", "modulate"]

# Suffixes of a node type that names a scene to instance. KEEP IN SYNC with NODE_TYPE_SCENE_SUFFIXES in src/utils/path-validation.ts.
const _SCENE_SUFFIXES: Array = [".tscn", ".scn"]

func _is_scene_path(type_or_path: String) -> bool:
	var lowered = type_or_path.to_lower()
	for suffix in _SCENE_SUFFIXES:
		if lowered.ends_with(suffix):
			return true
	return false

# Instantiate a class that must be a Node: a Resource or plain Object has no name, parent or owner, so using one raises and aborts the caller with no reason. Both kinds are checked before anything is built.
# A script that does not say what it extends (it failed to compile) is judged by its instance, freed when not reference counted.
func _instantiate_node_class(name_of_class: String) -> Dictionary:
	var not_a_node := "'%s' is not a Node type, so it cannot be a node of a scene" % name_of_class
	var instance = null
	if ClassDB.class_exists(name_of_class):
		if not ClassDB.is_parent_class(name_of_class, "Node"):
			return {"ok": false, "node": null, "error": not_a_node}
		instance = instantiate_class(name_of_class)
	else:
		var script = get_script_by_name(name_of_class)
		if script is Script:
			var base_type: String = str(script.get_instance_base_type())
			if base_type != "" and not ClassDB.is_parent_class(base_type, "Node"):
				return {"ok": false, "node": null, "error": "%s (its script extends %s)" % [not_a_node, base_type]}
		if script is GDScript:
			# new() on a script that cannot be built raises and stops every caller up to the operation, with no reason.
			var script_label: String = script.resource_path if script.resource_path != "" else name_of_class
			var attachable := _check_script_attachable(script, script_label)
			if not attachable.ok:
				return {"ok": false, "node": null, "error": attachable.error}
			var required_args := _script_init_required_args(script)
			if required_args > 0:
				return {
					"ok": false,
					"node": null,
					"error": "Script '%s' cannot be used as a node type: its _init takes %d required argument(s), and a node of a scene is built with none. Give them default values." % [script_label, required_args],
				}
			instance = script.new()
	if instance == null:
		return {"ok": false, "node": null, "error": "Failed to instantiate node of type: " + name_of_class}
	if not (instance is Node):
		var produced: String = instance.get_class()
		if not (instance is RefCounted):
			instance.free()
		return {"ok": false, "node": null, "error": "%s (it instantiates as %s)" % [not_a_node, produced]}
	return {"ok": true, "node": instance, "error": ""}

# get_script_method_list lists own methods first, so the first _init is the one new() calls.
# Default values are listed by editor builds only: elsewhere 0, never an optional argument counted as required.
func _script_init_required_args(script: Script) -> int:
	if not OS.has_feature("editor"):
		return 0
	for method in script.get_script_method_list():
		if typeof(method) != TYPE_DICTIONARY or str(method.get("name", "")) != "_init":
			continue
		var args = method.get("args", [])
		var defaults = method.get("default_args", [])
		if typeof(args) != TYPE_ARRAY or typeof(defaults) != TYPE_ARRAY:
			return 0
		return maxi(args.size() - defaults.size(), 0)
	return 0

const _STOPPED_BY_SCRIPT_ERROR := "stopped by a script error before it finished, see the engine's error output"

# A script error inside an _apply_*/_instantiate_* function hands back the declared type's default (an empty Dictionary) or null; reading .ok off it raises again and ends the operation with no reason.
func _was_stopped(outcome) -> bool:
	return typeof(outcome) != TYPE_DICTIONARY or not outcome.has("ok")

func _instantiate_node_type(type_or_path: String) -> Dictionary:
	if not _is_scene_path(type_or_path):
		return _instantiate_node_class(type_or_path)

	var scene_full_path = _scene_file_key(type_or_path)
	if scene_full_path.is_empty():
		return {"ok": false, "error": "Scene path escapes the project root: " + type_or_path}
	if not FileAccess.file_exists(scene_full_path):
		return {"ok": false, "error": "Scene file does not exist: " + scene_full_path}
	var packed = load(scene_full_path)
	if packed == null or not (packed is PackedScene):
		return {"ok": false, "error": "Failed to load scene: " + scene_full_path}
	var instanced = _instantiate_packed(packed, false)
	if instanced == null:
		return {"ok": false, "error": "Failed to instantiate scene: " + scene_full_path}
	return {"ok": true, "node": instanced}

func _name_not_kept_warning(requested_name: String, final_name: String) -> String:
	if final_name == requested_name:
		return ""
	return "Requested node name '%s' was not kept: Godot assigned '%s' (the name was taken by a sibling, or held a character a node name cannot hold)" % [requested_name, final_name]

func _apply_add_node(scene_root: Node, op: Dictionary) -> Dictionary:
	# Each is handed to a typed parameter below, where a wrong type raises.
	for string_param in ["parent_node_path", "node_type", "node_name"]:
		if op.has(string_param) and typeof(op[string_param]) != TYPE_STRING:
			return {"ok": false, "error": "%s must be a string" % string_param}
	if op.has("properties") and typeof(op.properties) != TYPE_DICTIONARY:
		return {"ok": false, "error": "properties must be an object"}
	var parent_path = "root"
	if op.has("parent_node_path"):
		parent_path = op.parent_node_path
	var parent = find_node_by_path(scene_root, parent_path)
	if not parent:
		return {"ok": false, "error": "Parent node not found: " + parent_path}
	if not op.has("node_type") or op.node_type == "":
		return {"ok": false, "error": "node_type is required for add_node"}
	if not op.has("node_name") or op.node_name == "":
		return {"ok": false, "error": "node_name is required for add_node"}
	# A scene instanced into itself saves a self-reference the next load cannot resolve; compared as files so case spellings are caught.
	if _is_scene_path(op.node_type) and op.has("scene_path"):
		var target_scene := _scene_file_key(str(op.scene_path))
		if target_scene != "" and target_scene == _scene_file_key(op.node_type):
			return {"ok": false, "error": "Cannot instance scene '%s' into itself" % _project_relative(target_scene)}
	var instantiated = _instantiate_node_type(op.node_type)
	if _was_stopped(instantiated):
		return {"ok": false, "error": "Failed to instantiate node of type: %s (%s)" % [str(op.node_type), _STOPPED_BY_SCRIPT_ERROR]}
	if not instantiated.ok:
		return {"ok": false, "error": instantiated.error}
	var new_node = instantiated.node
	new_node.name = op.node_name
	# The batch path forwards operations raw, so promoted spatial params are folded in; `properties` wins on conflict.
	var props = {}
	if op.has("properties"):
		props = op.properties.duplicate()
	for promoted in _PROMOTED_SPATIAL_PARAMS:
		if op.has(promoted) and not props.has(promoted):
			props[promoted] = op[promoted]
	# The node joins its parent before any property is set: a setter or getter can depend on where the node is (Control layout_mode, anchors_preset).
	parent.add_child(new_node)
	new_node.owner = scene_root
	var warnings: Array = []
	# "script" goes first whatever its JSON order: the variables it declares exist only once it is attached.
	var ordered_properties: Array = props.keys()
	if props.has("script"):
		ordered_properties.erase("script")
		ordered_properties.push_front("script")
	for property in ordered_properties:
		var failure := ""
		var settable = _check_node_property_settable(new_node, property)
		if not settable.ok:
			failure = settable.error
		else:
			var prepared = _prepare_property_value(new_node, property, props[property])
			if not prepared.ok:
				failure = prepared.error
			else:
				var assigned := _assign_property(new_node, property, prepared.value, false)
				failure = assigned.error
				# Verify the script assignment landed -- same backstop as attach_script and _apply_updates (_verify_script_attached).
				if failure == "" and property == "script":
					var verify = _verify_script_attached(new_node, prepared.value)
					if not verify.ok:
						failure = verify.error
				if failure == "":
					if assigned.warning != "":
						warnings.append(assigned.warning)
					var unstored: String = _unstored_script_variable_warning(new_node, property)
					if unstored != "":
						warnings.append(unstored)
		if failure != "":
			# Removed and freed so a later save of this tree (a batch's closing auto-save) does not write a half-built node.
			parent.remove_child(new_node)
			new_node.free()
			return {"ok": false, "error": failure}
	# pack() drops a parent inside an instanced child unless it is editable from the root; claim from the parent, not the new node, and only once the node is known to stay.
	_claim_for_serialization(scene_root, parent)
	# Read the name back: add_child renames collisions and assignment replaces characters a node name cannot hold.
	var final_name := String(new_node.name)
	var name_warning := _name_not_kept_warning(str(op.node_name), final_name)
	if name_warning != "":
		warnings.append(name_warning)
	return {
		"ok": true,
		"error": "",
		"warnings": warnings,
		"payload": {
			"nodeName": final_name,
			"nodeType": new_node.get_class(),
			"nodePath": _relative_path(scene_root, new_node),
		},
	}

func _apply_load_sprite(scene_root: Node, op: Dictionary) -> Dictionary:
	if not op.has("node_path") or op.node_path == "":
		return {"ok": false, "error": "node_path is required for load_sprite"}
	if not op.has("texture_path") or op.texture_path == "":
		return {"ok": false, "error": "texture_path is required for load_sprite"}
	var sprite_node = find_node_by_path(scene_root, op.node_path)
	if not sprite_node:
		return {"ok": false, "error": "Node not found: " + op.node_path}
	if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
		return {"ok": false, "error": "Node is not a sprite-compatible type: " + sprite_node.get_class()}
	var full_texture_path = normalize_scene_path(op.texture_path)
	if full_texture_path.is_empty():
		return {"ok": false, "error": "Path escapes the project root: " + op.texture_path}
	# First reference to an asset the scene-load probe never saw: check the cold-import state before load().
	if _classify_dep_path(full_texture_path) == "needs_import":
		return {"ok": false, "error": _report_import_needed("load_sprite " + op.node_path, full_texture_path)}
	var texture = load(full_texture_path)
	if not texture:
		return {"ok": false, "error": "Failed to load texture: " + full_texture_path}
	if not (texture is Texture2D):
		return {"ok": false, "error": "Loaded resource is not a Texture2D: " + full_texture_path}
	# A texture without a resource_path cannot be serialized by pack(), so the assignment would vanish on save.
	if texture.resource_path == "":
		return {"ok": false, "error": "Texture was imported but has no resource_path - the import likely failed for this asset. Check stderr for the import error."}
	_claim_for_serialization(scene_root, sprite_node)
	sprite_node.texture = texture
	# Read back from the node, not the request.
	var assigned = sprite_node.texture
	if assigned == null or assigned.resource_path == "":
		return {"ok": false, "error": "Texture assignment did not land on the node: " + full_texture_path}
	return {
		"ok": true,
		"error": "",
		"payload": {
			"nodePath": _relative_path(scene_root, sprite_node),
			"nodeType": sprite_node.get_class(),
			"texturePath": _project_relative(assigned.resource_path),
		},
	}

func add_node(params):
	printerr("Adding node to scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var result = _apply_add_node(scene_root, params)
	if not result.ok:
		log_error(result.error)
		_fail_operation()
		return

	if save_scene_to_path(scene_root, params.scene_path):
		var payload: Dictionary = result.payload
		if not result.warnings.is_empty():
			payload["warnings"] = result.warnings
		emit_result(payload)
	else:
		log_error("Failed to save scene after adding node")
		_fail_operation()
		return

func load_sprite(params):
	printerr("Loading sprite into scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var result = _apply_load_sprite(scene_root, params)
	if not result.ok:
		log_error(result.error)
		_fail_operation()
		return

	if save_scene_to_path(scene_root, params.scene_path):
		emit_result(result.payload)
	else:
		log_error("Failed to save scene after loading sprite")
		_fail_operation()
		return

func export_mesh_library(params):
	printerr("Exporting MeshLibrary from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var mesh_library = MeshLibrary.new()

	var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
	var use_specific_items = mesh_item_names.size() > 0

	var item_id = 0

	for child in scene_root.get_children():
		if use_specific_items and not (child.name in mesh_item_names):
			continue

		var mesh_instance = null
		if child is MeshInstance3D:
			mesh_instance = child
		else:
			for descendant in child.get_children():
				if descendant is MeshInstance3D:
					mesh_instance = descendant
					break

		if mesh_instance and mesh_instance.mesh:
			mesh_library.create_item(item_id)
			mesh_library.set_item_name(item_id, child.name)
			mesh_library.set_item_mesh(item_id, mesh_instance.mesh)

			for collision_child in child.get_children():
				if collision_child is CollisionShape3D and collision_child.shape:
					mesh_library.set_item_shapes(item_id, [collision_child.shape])
					break

			mesh_library.set_item_preview(item_id, mesh_instance.mesh)

			item_id += 1

	if item_id > 0:
		var full_output_path = normalize_scene_path(params.output_path)
		if full_output_path.is_empty():
			log_error("Path escapes the project root: " + params.output_path)
			_fail_operation()
			return

		if not _ensure_res_dir(full_output_path):
			log_error("Failed to create directory for MeshLibrary: " + full_output_path)
			_fail_operation()
			return

		var error = ResourceSaver.save(mesh_library, full_output_path)
		if error == OK:
			# Read back from the library, not the loop counter.
			var exported_names: Array = []
			for id in mesh_library.get_item_list():
				exported_names.append(mesh_library.get_item_name(id))
			var payload := {
				"outputPath": _project_relative(full_output_path),
				"itemCount": exported_names.size(),
				"itemNames": exported_names,
			}
			if use_specific_items:
				var not_exported: Array = []
				for requested in mesh_item_names:
					if not (str(requested) in exported_names):
						not_exported.append(str(requested))
				if not not_exported.is_empty():
					payload["warnings"] = ["Requested mesh items were not exported (no child with that name, or the child has no mesh): " + ", ".join(not_exported)]
			emit_result(payload)
		else:
			log_error("Failed to save MeshLibrary: " + str(error))
			_fail_operation()
			return
	else:
		log_error("No valid meshes found in the scene")
		_fail_operation()
		return

func save_scene(params):
	printerr("Saving scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var save_path = params.new_path if params.has("new_path") else params.scene_path

	if not save_scene_to_path(scene_root, save_path):
		log_error("Failed to save scene")
		_fail_operation()
		return

	# Confirm the file on disk before reporting it as written.
	var saved_full_path = normalize_scene_path(str(save_path))
	if not FileAccess.file_exists(saved_full_path):
		log_error("Scene save reported success but the file is not on disk: " + saved_full_path)
		_fail_operation()
		return
	emit_result({
		"scenePath": _project_relative(normalize_scene_path(str(params.scene_path))),
		"savedScenePath": _project_relative(saved_full_path),
	})

func delete_nodes(params):
	printerr("Deleting nodes from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var node_paths: Array = params.node_paths
	var results: Array = []
	var any_deleted := false
	# A node the base scene defines is rebuilt on every load, so a deletion would be reported saved and come back.
	var base_root = _instantiate_base_scene(params.scene_path)

	for node_path in node_paths:
		var entry = {"nodePath": node_path}
		var node = find_node_by_path(scene_root, node_path)
		# A %Name path says nothing about where its node sits; the Node side needs the place to tell this deletion from a node the save lost.
		if node:
			entry["resolvedNodePath"] = _relative_path(scene_root, node)
		if not node:
			entry["error"] = "Node not found: " + node_path
		elif node == scene_root:
			entry["error"] = "Cannot delete the root node"
		elif node.owner != scene_root:
			# An instance re-creates its inner nodes on every load, so a deletion would come back; the instance's own root is owned by this scene and stays deletable.
			entry["error"] = "Node '%s' belongs to an instanced scene (or is not owned by this scene) and cannot be deleted from here; edit the scene it comes from" % node_path
		elif base_root != null and base_root.has_node(scene_root.get_path_to(node)):
			entry["error"] = "Node '%s' is inherited from the scene this one extends and cannot be deleted from here: it is re-created on every load. Delete it in the base scene." % node_path
		else:
			var parent = node.get_parent()
			parent.remove_child(node)
			node.queue_free()
			entry["success"] = true
			any_deleted = true
		results.append(entry)

	if base_root != null:
		base_root.free()

	if any_deleted:
		if not save_scene_to_path(scene_root, params.scene_path):
			log_error("Failed to save scene after deleting nodes")
			_fail_operation()
			return

	emit_result({"results": results})

# pack() silently drops overrides on nodes inside an instanced scene (not owned by the scene root) while the operation reports success.
# Mark each instanced ancestor editable FROM THE SCENE ROOT (receiver is the root, argument the instanced child); never reassign the target's owner, which makes pack() write a shadowing duplicate node.
func _claim_for_serialization(scene_root: Node, target: Node) -> void:
	var cur := target.get_parent()
	while cur != null and cur != scene_root:
		if cur.get_scene_file_path() != "":
			scene_root.set_editable_instance(cur, true)
		cur = cur.get_parent()

# "warnings" holds one sentence per update set on the loaded scene that the scene file does not store or that reads back another value, prefixed with its index.
# Updates apply in the order given; an update that depends on another (a script variable and its script) is the caller's to order.
func _apply_updates(scene_root: Node, updates: Array, abort_on_error: bool) -> Dictionary:
	var results: Array = []
	var warnings: Array = []
	var any_set := false

	for i in range(updates.size()):
		var update = updates[i]
		# A malformed item is reported here; dot access on a missing key raises.
		var well_formed: bool = (
			typeof(update) == TYPE_DICTIONARY
			and update.has("node_path")
			and update.has("property")
			and update.has("value")
			and typeof(update.get("node_path")) == TYPE_STRING
			and typeof(update.get("property")) == TYPE_STRING
		)
		var result = {"nodePath": "", "property": ""}
		if not well_formed:
			result["error"] = "updates[%d] must be an object with nodePath, property and value" % i
		else:
			result["nodePath"] = update.node_path
			result["property"] = update.property
			var node = find_node_by_path(scene_root, update.node_path)
			var settable: Dictionary = {"ok": false, "error": ""}
			if node != null:
				result["resolvedNodePath"] = _relative_path(scene_root, node)
				settable = _check_node_property_settable(node, update.property)
			if node == null:
				result["error"] = "Node not found: " + update.node_path
			elif not settable.ok:
				result["error"] = settable.error
			else:
				var prepared = _prepare_property_value(node, update.property, update.value)
				if not prepared.ok:
					result["error"] = prepared.error
				else:
					_claim_for_serialization(scene_root, node)
					var assigned := _assign_property(node, update.property, prepared.value, true)
					var assign_error: String = assigned.error
					# Verify the script assignment landed (_verify_script_attached); a failed backstop is a per-update error, so any_set stays false for it.
					var backstop_ok := assign_error == ""
					if not backstop_ok:
						result["error"] = assign_error
					elif update.property == "script":
						var verify = _verify_script_attached(node, prepared.value)
						if not verify.ok:
							result["error"] = verify.error
							backstop_ok = false
					if backstop_ok:
						result["success"] = true
						any_set = true
						if assigned.warning != "":
							warnings.append("updates[%d]: %s" % [i, assigned.warning])
						var unstored: String = _unstored_script_variable_warning(node, update.property)
						if unstored != "":
							warnings.append("updates[%d]: %s" % [i, unstored])
		results.append(result)
		if abort_on_error and result.has("error"):
			break

	# Updates after an abort were never attempted: list each as skipped so results stays one entry per update.
	for skipped_index in range(results.size(), updates.size()):
		var skipped_update = updates[skipped_index]
		var skipped_entry := {"nodePath": "", "property": "", "skipped": true}
		if typeof(skipped_update) == TYPE_DICTIONARY:
			if typeof(skipped_update.get("node_path")) == TYPE_STRING:
				skipped_entry["nodePath"] = skipped_update.get("node_path")
			if typeof(skipped_update.get("property")) == TYPE_STRING:
				skipped_entry["property"] = skipped_update.get("property")
		results.append(skipped_entry)

	return {"ok": true, "any_set": any_set, "error": "", "results": results, "warnings": warnings}

func set_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var applied = _apply_updates(scene_root, params.updates, params.get("abort_on_error", false))
	if applied.any_set:
		if not save_scene_to_path(scene_root, params.scene_path):
			log_error("Failed to save scene after updates")
			_fail_operation()
			return

	var payload: Dictionary = {"results": applied.results}
	if not applied.warnings.is_empty():
		payload["warnings"] = applied.warnings
	emit_result(payload)

func get_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var results: Array = []
	var defaults_cache: Dictionary = {}

	for i in range(params.nodes.size()):
		var node_spec = params.nodes[i]
		# An empty or missing node_path resolves to the scene root, so a mistyped key would read the wrong node.
		if typeof(node_spec) != TYPE_DICTIONARY or typeof(node_spec.get("node_path", "")) != TYPE_STRING or node_spec.get("node_path", "") == "":
			results.append({"nodePath": "", "error": "nodes[%d] is missing nodePath" % i})
			continue
		var node_path: String = node_spec.node_path
		var changed_only = node_spec.get("changed_only", false)
		var node = find_node_by_path(scene_root, node_path)
		if node == null:
			results.append({"nodePath": node_path, "error": "Node not found"})
		else:
			var props = _collect_node_properties(node, changed_only, defaults_cache)
			results.append({"nodePath": node_path, "nodeType": node.get_class(), "properties": props})

	for klass in defaults_cache:
		var inst = defaults_cache[klass]
		if inst:
			inst.free()

	emit_result({"results": results})

func get_scene_tree(params):
	printerr("Getting scene tree for: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var tree_root = scene_root
	if params.has("parent_path") and params.parent_path:
		tree_root = find_node_by_path(scene_root, params.parent_path)
		if not tree_root:
			log_error("Parent node not found: " + str(params.parent_path))
			_fail_operation()
			return

	var max_depth = -1
	if params.has("max_depth"):
		max_depth = int(params.max_depth)

	var depth_cut := {"nodes": 0}
	var tree = build_tree_recursive(tree_root, scene_root, 0, max_depth, depth_cut)
	if depth_cut.nodes > 0:
		tree["warnings"] = ["maxDepth %d cut the tree: %d node(s) have children null and a childCount" % [max_depth, depth_cut.nodes]]
	emit_result(tree)

# A node at the depth limit with children reports children null and a childCount (not listed, not absent); without children, an empty list.
func build_tree_recursive(node: Node, scene_root: Node, depth: int, max_depth: int, depth_cut: Dictionary) -> Dictionary:
	var script_path = ""
	var script = node.get_script()
	if script and script.resource_path:
		script_path = script.resource_path

	var entry := {
		"name": node.name,
		"type": node.get_class(),
		"path": _relative_path(scene_root, node),
		"script": script_path,
	}
	if max_depth < 0 or depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(build_tree_recursive(child, scene_root, depth + 1, max_depth, depth_cut))
		entry["children"] = children
	elif node.get_child_count() > 0:
		entry["children"] = null
		entry["childCount"] = node.get_child_count()
		depth_cut["nodes"] += 1
	else:
		entry["children"] = []
	return entry

# The extension is the only signal available before load() has run; _check_script_attachable also accepts a CSharpScript class.
func _is_csharp_script_path(path: String) -> bool:
	return path.to_lower().ends_with(".cs")

# On a build with no C# module load() on a .cs fails with a generic message; checked before load() so this one pre-empts it.
# Always ok for a non-.cs path.
func _check_csharp_support(path: String) -> Dictionary:
	if _is_csharp_script_path(path) and not ClassDB.class_exists("CSharpScript"):
		return {"ok": false, "error": "Cannot attach '%s': this Godot build has no C# support. Point GODOT_PATH at the Godot .NET build." % path}
	return {"ok": true, "error": ""}

# set_script() fails SILENTLY on an unusable script (an ERROR on stderr, get_script() stays null), so check before it runs.
# can_instantiate() misses a GDScript declared @abstract (still true on 4.7.2), so is_abstract() is checked too.
func _check_script_attachable(script: Script, path: String) -> Dictionary:
	var is_abstract: bool = script.has_method("is_abstract") and script.is_abstract()
	if script.can_instantiate() and not is_abstract:
		return {"ok": true, "error": ""}
	if script.get_class() == "CSharpScript" or _is_csharp_script_path(path):
		return {
			"ok": false,
			"error": "Script '%s' cannot be instantiated: its C# class is not present in the compiled game assembly. Build the project (`dotnet build` in the project directory, or Build in the Godot editor) and retry. The class name must match the file name exactly (case-sensitive)." % path
		}
	if path.to_lower().ends_with(".gd"):
		if is_abstract:
			return {
				"ok": false,
				"error": "Script '%s' cannot be instantiated: it is declared @abstract. Remove @abstract (or the @abstract methods forcing it) to attach it directly." % path
			}
		return {
			"ok": false,
			"error": "Script '%s' cannot be instantiated: it has parse errors. Run the validate tool with scriptPath set to this file to see them." % path
		}
	return {"ok": false, "error": "Script '%s' cannot be instantiated." % path}

# Even past _check_script_attachable, verify get_script() reflects the assigned Script (or null when clearing): a silent failed assignment must not report success.
func _verify_script_attached(node: Object, expected) -> Dictionary:
	if node.get_script() == expected:
		return {"ok": true, "error": ""}
	var desc = expected.resource_path if (expected is Script and expected.resource_path != "") else str(expected)
	return {
		"ok": false,
		"error": "Script was loaded but Godot did not attach it to the node (get_script() does not reflect it after the assignment): " + desc
	}

func attach_script(params):
	printerr("Attaching script to node in scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		_fail_operation()
		return

	var full_script_path = normalize_scene_path(params.script_path)
	if full_script_path.is_empty():
		log_error("Path escapes the project root: " + params.script_path)
		_fail_operation()
		return

	if not FileAccess.file_exists(full_script_path):
		log_error("Script file does not exist: " + full_script_path)
		_fail_operation()
		return

	var csharp_support = _check_csharp_support(full_script_path)
	if not csharp_support.ok:
		log_error(csharp_support.error)
		_fail_operation()
		return

	var script = load(full_script_path)
	if not script:
		log_error("Failed to load script: " + full_script_path)
		_fail_operation()
		return

	var attach_check = _check_script_attachable(script, full_script_path)
	if not attach_check.ok:
		log_error(attach_check.error)
		_fail_operation()
		return

	_claim_for_serialization(scene_root, node)
	node.set_script(script)

	var verify = _verify_script_attached(node, script)
	if not verify.ok:
		log_error(verify.error)
		_fail_operation()
		return

	if save_scene_to_path(scene_root, params.scene_path):
		# Both paths read from the node and the loaded path, not copied from the request.
		emit_result({
			"nodePath": _relative_path(scene_root, node),
			"scriptPath": _project_relative(full_script_path)
		})
	else:
		log_error("Failed to save scene after attaching script")
		_fail_operation()
		return

const _UNBOUND_COUNT_MIN_MINOR := 4

# The parameter is untyped on purpose: the method is looked up when the line runs, so the script compiles on an engine that predates it.
func _unbound_argument_count(callable) -> int:
	if not _engine_minor_at_least(_UNBOUND_COUNT_MIN_MINOR):
		return 0
	return int(callable.get_unbound_arguments_count())

# The copy has already left the donor tree, so its own nodes answer false.
func _is_donor_node(value, donor_root: Node) -> bool:
	return value is Node and (value == donor_root or donor_root.is_ancestor_of(value))

# A copy taken from a donor tree can still point at donor nodes outside the copy (persistent signal connections, Node-valued properties); those die with the donor, so each is re-pointed at the node on the same path in the edited scene.
func _retarget_donor_references(copy: Node, donor_root: Node, scene_root: Node) -> void:
	for current in _iter_subtree(copy):
		for signal_info in current.get_signal_list():
			for conn in current.get_signal_connection_list(signal_info.name):
				var callable: Callable = conn["callable"]
				var target = callable.get_object()
				if (int(conn["flags"]) & CONNECT_PERSIST) == 0 or not _is_donor_node(target, donor_root):
					continue
				current.disconnect(signal_info.name, callable)
				var counterpart = scene_root.get_node_or_null(donor_root.get_path_to(target))
				if counterpart == null:
					continue
				var retargeted := Callable(counterpart, callable.get_method())
				var bound: Array = callable.get_bound_arguments()
				if not bound.is_empty():
					retargeted = retargeted.bindv(bound)
				var unbound := _unbound_argument_count(callable)
				if unbound > 0:
					retargeted = retargeted.unbind(unbound)
				if not current.is_connected(signal_info.name, retargeted):
					current.connect(signal_info.name, retargeted, int(conn["flags"]))
		for descriptor in current.get_property_list():
			if (int(descriptor.usage) & PROPERTY_USAGE_STORAGE) == 0:
				continue
			var value = current.get(descriptor.name)
			if _is_donor_node(value, donor_root):
				current.set(descriptor.name, scene_root.get_node_or_null(donor_root.get_path_to(value)))
			elif typeof(value) == TYPE_ARRAY:
				var any_retargeted := false
				for i in range(value.size()):
					if _is_donor_node(value[i], donor_root):
						value[i] = scene_root.get_node_or_null(donor_root.get_path_to(value[i]))
						any_retargeted = true
				if any_retargeted:
					current.set(descriptor.name, value)

func duplicate_node(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		_fail_operation()
		return
	if node == scene_root:
		log_error("Cannot duplicate the root node")
		_fail_operation()
		return

	var parent = node.get_parent()
	if params.has("target_parent_path"):
		parent = find_node_by_path(scene_root, params.target_parent_path)
		if not parent:
			log_error("Target parent not found: " + params.target_parent_path)
			_fail_operation()
			return

	# Not Node.duplicate(): it re-creates an instanced scene without an edit state, so pack() writes the copy as a typed node with every non-default property.
	# The copy comes out of a second instantiation (the donor) of the same file, whose nodes carry the same edit states, editable marks, groups and connections.
	var donor_root = load_scene_instance(params.scene_path)
	if not donor_root:
		_fail_operation()
		return
	var duplicate = find_node_by_path(donor_root, params.node_path)
	if duplicate == null or duplicate == donor_root:
		donor_root.free()
		log_error("Node not found in a second instance of the scene: " + params.node_path)
		_fail_operation()
		return
	duplicate.get_parent().remove_child(duplicate)
	# An owner has to be an ancestor, so every owner outside the copy is cleared before add_child. Inner nodes owned by an instance root inside the copy keep it: the instance re-creates them on load, and re-owning them would make pack() write them twice.
	# The walk still goes through an instance, because a node this scene added under one is owned by the scene.
	for current in _iter_subtree(duplicate):
		var current_owner: Node = current.owner
		if current_owner != null and not (current_owner == duplicate or duplicate.is_ancestor_of(current_owner)):
			current.owner = null

	var requested_name: String = str(params.new_name) if params.has("new_name") else String(node.name) + "2"
	duplicate.name = requested_name

	parent.add_child(duplicate)
	_claim_for_serialization(scene_root, parent)
	# pack() drops a node whose owner it does not reach, so each ownerless node of the copy gets this scene as owner.
	for current in _iter_subtree(duplicate):
		if current.owner == null:
			current.owner = scene_root
	_retarget_donor_references(duplicate, donor_root, scene_root)
	donor_root.free()

	if save_scene_to_path(scene_root, params.scene_path):
		var payload := {
			"nodePath": _relative_path(scene_root, node),
			"newNodePath": _relative_path(scene_root, duplicate)
		}
		# Final name read back: add_child renames a name taken by a sibling.
		var name_warning := _name_not_kept_warning(requested_name, String(duplicate.name))
		if name_warning != "":
			payload["warnings"] = [name_warning]
		emit_result(payload)
	else:
		log_error("Failed to save scene after duplicating node")
		_fail_operation()
		return

func get_node_signals(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		_fail_operation()
		return

	var signals = []
	for sig in node.get_signal_list():
		var sig_name = sig["name"]
		var connections = []
		for conn in node.get_signal_connection_list(sig_name):
			var target_object = conn["callable"].get_object()
			# get_object().get_path() returns "" for any node outside the live SceneTree, which headless scenes always are; report the target in the "root/..." form connect_signal accepts so it round-trips.
			var target_str = "unknown"
			if target_object == scene_root:
				target_str = "root"
			elif target_object is Node:
				target_str = "root/" + String(scene_root.get_path_to(target_object))
			connections.append({
				"signal": sig_name,
				"target": target_str,
				"method": conn["callable"].get_method()
			})
		signals.append({
			"name": sig_name,
			"connections": connections
		})

	emit_result({
		"nodePath": _relative_path(scene_root, node),
		"nodeType": node.get_class(),
		"signals": signals
	})

func _collect_connection_issues(scope: Node, scene_root: Node, issues: Array) -> void:
	for node in _iter_subtree(scope):
		var node_rel = _relative_path(scene_root, node)
		for sig in node.get_signal_list():
			var sig_name = sig["name"]
			for conn in node.get_signal_connection_list(sig_name):
				var callable: Callable = conn["callable"]
				var target_object = callable.get_object()
				var method = String(callable.get_method())
				# CONNECT_PERSIST marks a connection authored in the scene file; the engine's own connections carry no flag. It gates only the missing-handler check below:
				# the other checks have no engine-connection false positive to guard against, and gating them could only hide findings.
				var is_persisted := (int(conn.get("flags", 0)) & CONNECT_PERSIST) != 0

				# _relative_path checks is_ancestor_of first: get_path_to on a node outside the tree prints a Godot error to stderr.
				var target_rel := ""
				if target_object is Node:
					target_rel = _relative_path(scene_root, target_object)

				if target_rel.is_empty():
					issues.append({
						"node": node_rel,
						"signal": sig_name,
						"target": "unknown",
						"method": method,
						"problem": "target_not_in_scene"
					})
					continue

				if not target_object.has_method(method):
					if not is_persisted:
						continue
					if _is_engine_internal_connection(target_object, method):
						continue
					issues.append({
						"node": node_rel,
						"signal": sig_name,
						"target": target_rel,
						"method": method,
						"problem": "method_missing_on_target"
					})
					continue

				if not method.begins_with("_on_"):
					issues.append({
						"node": node_rel,
						"signal": sig_name,
						"target": target_rel,
						"method": method,
						"problem": "naming_convention"
					})

func _collect_orphaned_handlers(scope: Node, scene_root: Node, issues: Array) -> void:
	# Index targets across the whole scene so a handler connected from outside the scope is not reported; keyed by (node_path, method) because Object identity does not match across iterations.
	var wired_pairs := {}
	for node in _iter_subtree(scene_root):
		for sig in node.get_signal_list():
			var sig_name = sig["name"]
			for conn in node.get_signal_connection_list(sig_name):
				var callable: Callable = conn["callable"]
				var target_object = callable.get_object()
				if target_object is Node:
					# Engine-internal connections do not make a user handler wired.
					if _is_engine_internal_connection(target_object, String(callable.get_method())):
						continue
					var target_path = _relative_path(scene_root, target_object)
					var method_name = String(callable.get_method())
					if not target_path.is_empty():
						wired_pairs[target_path + "::" + method_name] = true

	for node in _iter_subtree(scope):
		var node_rel = _relative_path(scene_root, node)
		if node_rel.is_empty():
			continue
		var script_methods = _get_script_user_defined_methods(node)
		for method_name in script_methods:
			if not method_name.begins_with("_on_"):
				continue
			var pair_key = node_rel + "::" + method_name
			if not wired_pairs.has(pair_key):
				issues.append({
					"node": node_rel,
					"signal": "",
					"target": node_rel,
					"method": method_name,
					"problem": "orphaned_handler"
				})

func _iter_subtree(root: Node) -> Array:
	var out := [root]
	var cursor := 0
	while cursor < out.size():
		for child in out[cursor].get_children():
			out.append(child)
		cursor += 1
	return out

# Scene-root-relative path in the "root/..." form, "" when node is outside the tree.
func _relative_path(scene_root: Node, node: Node) -> String:
	if node == scene_root:
		return "root"
	if not scene_root.is_ancestor_of(node):
		return ""
	return "root/" + String(scene_root.get_path_to(node))

# A connection is engine-internal when its method resolves to no script handler (engine code connects private slots such as Label::_maximum_size_changed).
# The "::" branch matters to orphaned-handler detection, which sees runtime connections; persisted ones always carry a bare method name.
func _is_engine_internal_connection(target_object: Object, method: String) -> bool:
	# A "Class::method" name is an engine callable bound to a private C++ slot; user connections always report a bare name. The only place that knows the "::" form.
	if method.contains("::"):
		return true
	if _is_user_script_method(target_object, method):
		return false
	if target_object.has_method(method):
		return true
	return _is_engine_builtin_declared(target_object, method)

func _is_user_script_method(target_object: Object, method: String) -> bool:
	var script = target_object.get_script()
	if script == null:
		return false
	for m in script.get_script_method_list():
		if String(m["name"]) == method:
			return true
	return false

# has_method() misses private slots and virtuals a headless instance does not expose; ClassDB knows them.
# Nothing else earns a pass: a "_" prefix alone once hid every typo in a private handler, and a missing script does not make a missing handler valid.
func _is_engine_builtin_declared(target_object: Object, method: String) -> bool:
	# A lambda Callable reports no method name; an unnamed callable is not a missing handler.
	if method.is_empty():
		return true
	var cls := target_object.get_class()
	return ClassDB.class_exists(cls) and ClassDB.class_has_method(cls, method, false)

# get_script_method_list() covers the script's own methods and those of any GDScript it extends; only _on_* names are kept.
func _get_script_user_defined_methods(node: Node) -> Array:
	var script = node.get_script()
	if script == null:
		return []

	var methods := []
	for m in script.get_script_method_list():
		var method_name = String(m["name"])
		if method_name.begins_with("_on_"):
			methods.append(method_name)

	return methods

# Bypasses the resource cache so the result is what the file holds, not the instance just packed.
func _reload_saved_scene(scene_path: String):
	var full_path = _scene_file_key(scene_path)
	if full_path.is_empty():
		return null
	var packed = ResourceLoader.load(full_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if packed == null or not (packed is PackedScene):
		return null
	return packed.instantiate()

func _count_signal_connections(source: Node, signal_name: String, target: Node, method: String) -> int:
	var count := 0
	for conn in source.get_signal_connection_list(signal_name):
		var callable: Callable = conn["callable"]
		if callable.get_object() == target and String(callable.get_method()) == method:
			count += 1
	return count

# read is false when the saved scene could not be loaded or a node was not found: nothing is then known about the connection.
func _read_back_connection(scene_path: String, node_path: String, signal_name: String, target_node_path: String, method: String) -> Dictionary:
	var outcome := {"read": false, "connected": false, "source": "", "target": ""}
	var reloaded = _reload_saved_scene(scene_path)
	if reloaded == null:
		return outcome
	var source = find_node_by_path(reloaded, node_path)
	var target = find_node_by_path(reloaded, target_node_path)
	if source != null and target != null:
		outcome = {
			"read": true,
			"connected": _count_signal_connections(source, signal_name, target, method) > 0,
			"source": _relative_path(reloaded, source),
			"target": _relative_path(reloaded, target),
		}
	reloaded.free()
	return outcome

# connected comes from the saved scene read back; when that failed it is null with a warning, not the state the request asked for.
func _signal_result_payload(scene_root: Node, source: Node, target: Node, params, read_back: Dictionary) -> Dictionary:
	var payload := {
		"nodePath": _relative_path(scene_root, source),
		"signal": str(params.signal),
		"targetNodePath": _relative_path(scene_root, target),
		"method": str(params.method),
		"connected": null,
	}
	if read_back.read:
		payload["nodePath"] = read_back.source
		payload["targetNodePath"] = read_back.target
		payload["connected"] = read_back.connected
	else:
		payload["warnings"] = ["The scene was saved, but it could not be read back to confirm the connection, so connected is null"]
	return payload

func connect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		_fail_operation()
		return

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		_fail_operation()
		return

	if not source.has_signal(params.signal):
		log_error("Signal does not exist: " + params.signal + " on " + source.get_class())
		_fail_operation()
		return

	if not target.has_method(params.method):
		log_error("Method does not exist: " + params.method + " on " + target.get_class())
		_fail_operation()
		return

	# CONNECT_PERSIST is required for the connection to be serialized; without it the connection disappears on save.
	var err = source.connect(params.signal, Callable(target, params.method), CONNECT_PERSIST)
	if err != OK:
		log_error("Failed to connect signal: " + str(err))
		_fail_operation()
		return
	# pack() writes a connection only when both ends are owned by the scene root or sit inside an editable instance.
	_claim_for_serialization(scene_root, source)
	_claim_for_serialization(scene_root, target)

	if not save_scene_to_path(scene_root, params.scene_path):
		log_error("Failed to save scene after connecting signal")
		_fail_operation()
		return

	var read_back = _read_back_connection(params.scene_path, params.node_path, params.signal, params.target_node_path, params.method)
	if read_back.read and not read_back.connected:
		log_error("Signal was connected and the scene saved, but the saved scene does not hold the connection when it is read back")
		_fail_operation()
		return
	emit_result(_signal_result_payload(scene_root, source, target, params, read_back))

func disconnect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		_fail_operation()
		return

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		_fail_operation()
		return

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		_fail_operation()
		return

	if not source.is_connected(params.signal, Callable(target, params.method)):
		log_error("Signal connection does not exist")
		_fail_operation()
		return

	source.disconnect(params.signal, Callable(target, params.method))

	if not save_scene_to_path(scene_root, params.scene_path):
		log_error("Failed to save scene after disconnecting signal")
		_fail_operation()
		return

	var read_back = _read_back_connection(params.scene_path, params.node_path, params.signal, params.target_node_path, params.method)
	if read_back.read and read_back.connected:
		log_error("Signal was disconnected and the scene saved, but the saved scene still holds the connection when it is read back")
		_fail_operation()
		return
	emit_result(_signal_result_payload(scene_root, source, target, params, read_back))

func validate_resource(params):
	if not (params.has("script_path") or params.has("scene_path")):
		log_error("validate_resource requires script_path or scene_path")
		_fail_operation()
		return
	var result = _validate_single(params)
	emit_result({"valid": result.valid, "errors": result.errors})

func validate_checks(params):
	var outcome = _run_scene_checks(str(params.scene_path), params.checks if params.has("checks") else [])
	if not outcome.ok:
		log_error(outcome.error)
		_fail_operation()
		return
	emit_result({"valid": outcome.errors.is_empty(), "errors": outcome.errors})

# ok=false means the scene could not be loaded; load_scene_instance has already written its diagnosis (including [IMPORT_NEEDED]) to stderr.
# Never quits: validate_batch needs per-target isolation. Freeing the instance here keeps a batch of N scenes from holding N live trees.
func _run_scene_checks(scene_path: String, checks) -> Dictionary:
	var scene_root = load_scene_instance(scene_path)
	if not scene_root:
		# The reason goes in the result: the [ERROR] line on stderr is not a form the diagnostic parser reads.
		var skipped := "Scene checks skipped: could not load scene " + scene_path
		if last_scene_load_error != "":
			skipped += " (" + last_scene_load_error + ")"
		return {"ok": false, "error": skipped, "errors": []}
	var errors := _collect_check_errors(scene_root, checks)
	scene_root.free()
	return {"ok": true, "error": "", "errors": errors}

# Does not free scene_root; the caller owns it. Every entry is hedged rather than trusted: a malformed entry must be reported, not raise.
func _collect_check_errors(scene_root: Node, checks) -> Array:
	var errors: Array = []
	if typeof(checks) != TYPE_ARRAY:
		return errors
	for check in checks:
		if not (check is Dictionary):
			errors.append({
				"check": "",
				"message": "Invalid check entry: expected an object, got " + type_string(typeof(check)),
			})
			continue
		var check_type = str(check.get("type", ""))
		if check_type == "structure":
			var schema = check.get("schema", {})
			var missing_nodes: Array = []
			var missing_properties: Array = []
			var issues: Array = []
			_validate_schema_node(scene_root, scene_root, schema, missing_nodes, missing_properties, issues)
			for mn in missing_nodes:
				var mn_expected = str(mn.get("expected", "?"))
				var mn_path = str(mn.get("path", "?"))
				# An unmatched child is a finding about the parent named in path; a type mismatch names the type actually there.
				var mn_message = "Expected node of type %s at %s, found %s" % [mn_expected, mn_path, str(mn.get("actual", "?"))]
				if mn.get("unmatched_child", false):
					mn_message = "No child of type %s under %s" % [mn_expected, mn_path]
				errors.append({
					"check": "structure",
					"path": str(mn.get("path", "")),
					"message": mn_message,
				})
			for mp in missing_properties:
				errors.append({
					"check": "structure",
					"path": str(mp.get("path", "")),
					"message": "Property %s not set on %s" % [str(mp.get("property", "?")), str(mp.get("path", "?"))],
				})
			for issue in issues:
				errors.append({"check": "structure", "message": str(issue)})
		elif check_type == "signals":
			var scope_node = scene_root
			if check.has("node_path") and str(check.node_path) != "":
				scope_node = find_node_by_path(scene_root, str(check.node_path))
				if not scope_node:
					errors.append({
						"check": "signals",
						"message": "Node not found: " + str(check.node_path),
					})
					continue
			var sig_issues: Array = []
			_collect_connection_issues(scope_node, scene_root, sig_issues)
			_collect_orphaned_handlers(scope_node, scene_root, sig_issues)
			for si in sig_issues:
				var entry = {
					"check": "signals",
					"node": str(si.get("node", "")),
					"signal": str(si.get("signal", "")),
					"target": str(si.get("target", "")),
					"method": str(si.get("method", "")),
					"problem": str(si.get("problem", "")),
					"message": str(si.get("problem", "")),
				}
				errors.append(entry)
		else:
			errors.append({
				"check": check_type,
				"message": "Unknown check type: " + check_type + " (expected \"structure\" or \"signals\")",
			})

	return errors

func _validate_schema_node(node: Node, scene_root: Node, schema, missing_nodes: Array, missing_properties: Array, issues: Array) -> void:
	# A malformed entry is reported, not fatal.
	if not (schema is Dictionary):
		issues.append("Invalid schema entry: expected an object, got " + type_string(typeof(schema)))
		return

	if schema.has("type"):
		var expected_type = str(schema.type)
		if node.get_class() != expected_type:
			missing_nodes.append({
				"path": _relative_path(scene_root, node),
				"expected": expected_type,
				"actual": node.get_class()
			})

	if schema.has("has_property"):
		var prop_name = str(schema.has_property)
		if not _node_has_property_set(node, prop_name):
			missing_properties.append({
				"path": _relative_path(scene_root, node),
				"property": prop_name
			})

	if schema.has("children"):
		var children_schema = schema.children
		if typeof(children_schema) == TYPE_ARRAY:
			# Consumed children are tracked so two schema entries of the same type match two distinct nodes.
			var available := node.get_children().duplicate()
			for child_schema in children_schema:
				var found = _find_child_matching(available, child_schema)
				if found:
					available.erase(found)
					_validate_schema_node(found, scene_root, child_schema, missing_nodes, missing_properties, issues)
				else:
					var expected_type = str(child_schema.get("type", "?")) if child_schema is Dictionary else "?"
					missing_nodes.append({
						"path": _relative_path(scene_root, node),
						"expected": expected_type,
						"unmatched_child": true
					})

func _find_child_matching(available: Array, child_schema) -> Node:
	var expected_type = str(child_schema.get("type", "")) if child_schema is Dictionary else ""
	for child in available:
		if expected_type.is_empty() or child.get_class() == expected_type:
			return child
	return null

func _node_has_property_set(node: Node, prop_name: String) -> bool:
	# `in` guards against Godot printing "Invalid get index" for properties the node type does not declare.
	if not (prop_name in node):
		return false
	var val = node.get(prop_name)
	if val == null:
		return false
	if typeof(val) == TYPE_STRING and str(val).is_empty():
		return false
	return true


# Every vector and color component must be a JSON number before a dictionary is coerced: a constructor handed anything else raises, the coercion yields null, and null is a value some properties accept.
func _is_json_number(value) -> bool:
	return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT

# Components not all numbers: returned unchanged so the caller's type check reports it instead of a constructor failing.
func _coerce_property_value(value):
	if typeof(value) != TYPE_DICTIONARY:
		return value
	# Only an exact key set is a vector or a color; any other dictionary is the author's own data and is returned as it came.
	var count: int = value.size()
	if count == 2 and value.has("x") and value.has("y"):
		if _is_json_number(value.x) and _is_json_number(value.y):
			return Vector2(value.x, value.y)
	elif count == 3 and value.has("x") and value.has("y") and value.has("z"):
		if _is_json_number(value.x) and _is_json_number(value.y) and _is_json_number(value.z):
			return Vector3(value.x, value.y, value.z)
	elif count == 4 and value.has("x") and value.has("y") and value.has("z") and value.has("w"):
		if _is_json_number(value.x) and _is_json_number(value.y) and _is_json_number(value.z) and _is_json_number(value.w):
			return Vector4(value.x, value.y, value.z, value.w)
	elif count == 3 and value.has("r") and value.has("g") and value.has("b"):
		if _is_json_number(value.r) and _is_json_number(value.g) and _is_json_number(value.b):
			return Color(value.r, value.g, value.b)
	elif count == 4 and value.has("r") and value.has("g") and value.has("b") and value.has("a"):
		if _is_json_number(value.r) and _is_json_number(value.g) and _is_json_number(value.b) and _is_json_number(value.a):
			return Color(value.r, value.g, value.b, value.a)
	return value

# Any element that is not, and cannot be coerced into, the packed element type fails the whole assignment: node.set() would store the zero value for every element and report success.
# The accepted set comes from _PACKED_ARRAY_ELEMENT_TYPE plus _ELEMENT_TYPE_COMPAT and fails CLOSED on a missing row; accepting it would reinstate the silent zero-write.
func _prepare_packed_array_elements(property: String, node_class: String, declared: int, arr: Array) -> Dictionary:
	var elem_type: int = _PACKED_ARRAY_ELEMENT_TYPE.get(declared, TYPE_NIL)
	if elem_type == TYPE_NIL or not _ELEMENT_TYPE_COMPAT.has(elem_type):
		return {
			"ok": false,
			"value": null,
			"error": "Cannot set property '%s' on node of type '%s': element validation has no rule for %s, so the array was not assigned" % [
				property, node_class, type_string(declared)],
		}
	var accepted: Array = _ELEMENT_TYPE_COMPAT[elem_type]
	var out: Array = []
	for i in range(arr.size()):
		var element = _coerce_property_value(arr[i])
		if not (typeof(element) in accepted):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) cannot be coerced to the element type of %s" % [
					property, node_class, i, str(element), type_string(declared)],
			}
		if elem_type == TYPE_INT and _is_fractional_float(element):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) is not a whole number, and %s holds integers" % [
					property, node_class, i, str(element), type_string(declared)],
			}
		if elem_type == TYPE_INT:
			var int_problem := _json_int_problem(element)
			if int_problem != "":
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) %s" % [
						property, node_class, i, str(element), int_problem],
				}
			# Exact after _json_int_problem, so the range is compared between integers.
			var whole: int = int(element)
			var bounds: Array = _PACKED_INT_RANGE[declared]
			if whole < bounds[0] or whole > bounds[1]:
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) is outside the range %s holds (%d to %d)" % [
						property, node_class, i, str(element), type_string(declared), bounds[0], bounds[1]],
				}
			element = whole
		out.append(element)
	return {"ok": true, "value": out, "error": ""}

# 2^53: a larger JSON number may already be a different integer from the one written.
const _MAX_EXACT_FLOAT_INT := 9007199254740992

# First float above the 64-bit integer range (2^63), for a number read from text.
const _INT64_FLOAT_LIMIT := 9223372036854775808.0

# Why a JSON number cannot be stored as an integer (the tail of a sentence), or "" when it can. The one check every integer target shares.
# The target's width is unknown here: packed arrays and vectors check their own range, an int property is read back in _assign_property.
func _json_int_problem(value) -> String:
	if typeof(value) != TYPE_FLOAT:
		return ""
	if not is_finite(value):
		return "is not a finite number"
	if value != floorf(value):
		return "is not a whole number"
	if absf(value) > float(_MAX_EXACT_FLOAT_INT):
		return "is beyond the whole numbers a JSON number carries exactly (-%d to %d)" % [_MAX_EXACT_FLOAT_INT, _MAX_EXACT_FLOAT_INT]
	return ""

# Inclusive range of a signed 32-bit integer, the narrowest width an engine
# setter commonly declares for an int property.
const _INT32_MIN := -2147483648
const _INT32_MAX := 2147483647

# set() wraps or saturates an int that does not fit the property's width (process_priority is 32-bit) without reporting it, so an int is read back. Outside 32 bits and different: error. Within 32 bits and different: kept with a warning (a setter may normalize, a getter may answer from the node's surroundings).
# restore_on_error writes the previous value back through the setter, sound only because the error cases are an overflowed integer and a refused object; a caller that discards the node passes false.
func _assign_property(target: Object, property: String, value, restore_on_error: bool) -> Dictionary:
	var checks_int: bool = (
		typeof(value) == TYPE_INT
		and not property.begins_with(_METADATA_PREFIX)
		and _declared_property_type(target, property) == TYPE_INT
	)
	# set() of an object the property's class does not accept stores nothing or clears the property and reports neither; the property must read back the very object assigned.
	var checks_object: bool = typeof(value) == TYPE_OBJECT and is_instance_valid(value)
	var previous = target.get(property) if (checks_int or checks_object) and restore_on_error else null
	target.set(property, value)
	if checks_object:
		var held = target.get(property)
		if is_same(held, value):
			return {"error": "", "warning": ""}
		if typeof(held) == TYPE_OBJECT and is_instance_valid(held):
			return {
				"error": "",
				"warning": "Property '%s' on node of type '%s' was assigned a %s and holds another object afterwards (a %s): its setter replaced or copied the value. The scene stores what the node holds." % [
					property, target.get_class(), value.get_class(), held.get_class()],
			}
		if restore_on_error:
			target.set(property, previous)
		return {
			"error": "Cannot set property '%s' on node of type '%s': the %s was not stored, the property holds nothing after the assignment. The property does not accept an object of that class. A property declared as a Node takes a node of the scene, which a file path or an inline resource cannot name.%s" % [
				property, target.get_class(), value.get_class(), " The property was left as it was." if restore_on_error else ""],
			"warning": "",
		}
	if not checks_int:
		return {"error": "", "warning": ""}
	var stored = target.get(property)
	if typeof(stored) == TYPE_INT and stored == value:
		return {"error": "", "warning": ""}
	if value >= _INT32_MIN and value <= _INT32_MAX:
		return {
			"error": "",
			"warning": "Property '%s' on node of type '%s' was assigned %d and reads %s afterwards: its setter changed or ignored the value, or the property answers from the node's place in the scene instead of from what was assigned. The scene stores what the node holds." % [
				property, target.get_class(), value, str(stored)],
		}
	if restore_on_error:
		target.set(property, previous)
	return {
		"error": "Cannot set property '%s' on node of type '%s': %d was not stored, the property held %s after the assignment. The value is outside the range this property holds.%s" % [
			property, target.get_class(), value, str(stored), " The property was left as it was." if restore_on_error else ""],
		"warning": "",
	}

const _INT_VECTOR_COMPONENTS: Dictionary = {
	TYPE_VECTOR2I: ["x", "y"],
	TYPE_VECTOR3I: ["x", "y", "z"],
	TYPE_VECTOR4I: ["x", "y", "z", "w"],
}

const _INT_VECTOR_COMPONENT_RANGE: Array = [-2147483648, 2147483647]

# _coerce_property_value makes a float vector (32-bit floats): a whole number above 2^24 is rounded there and one outside the 32-bit range wraps in the typed setter, silently. Here each component is checked as the JSON number it is.
# built is false with an empty problem when the shape does not match or a component is fractional: the caller continues with the coerced float vector, whose checks report those.
func _int_vector_from_json(vector_type: int, raw: Dictionary) -> Dictionary:
	var not_built := {"built": false, "value": null, "problem": ""}
	var keys: Array = _INT_VECTOR_COMPONENTS[vector_type]
	if raw.size() != keys.size() or not raw.has_all(keys):
		return not_built
	var components: Array = []
	for key in keys:
		var component = raw[key]
		if not _is_json_number(component) or _is_fractional_float(component):
			return not_built
		var problem := _json_int_problem(component)
		if problem == "" and (int(component) < _INT_VECTOR_COMPONENT_RANGE[0] or int(component) > _INT_VECTOR_COMPONENT_RANGE[1]):
			problem = "is outside the range a component of %s holds (%d to %d)" % [
				type_string(vector_type), _INT_VECTOR_COMPONENT_RANGE[0], _INT_VECTOR_COMPONENT_RANGE[1]]
		if problem != "":
			not_built["problem"] = "component %s (%s) %s" % [key, str(component), problem]
			return not_built
		components.append(int(component))
	var built = null
	match vector_type:
		TYPE_VECTOR2I:
			built = Vector2i(components[0], components[1])
		TYPE_VECTOR3I:
			built = Vector3i(components[0], components[1], components[2])
		TYPE_VECTOR4I:
			built = Vector4i(components[0], components[1], components[2], components[3])
	return {"built": true, "value": built, "problem": ""}

# JSON numbers arrive as floats; a float is valid for an int property only when whole, otherwise the typed setter truncates silently.
func _is_fractional_float(value) -> bool:
	return typeof(value) == TYPE_FLOAT and value != floorf(value)

# A JSON object coerces to the float vector and the typed setter then truncates silently ((1.5, 2.7) on a Vector2i stores (1, 2)).
const _INT_VECTOR_TYPES: Array = [TYPE_VECTOR2I, TYPE_VECTOR3I, TYPE_VECTOR4I]

# Inclusive element range per packed integer array: the typed setter wraps (Byte, Int32) or saturates (Int64) an out-of-range element silently.
# The 64-bit minimum is a sum because its magnitude does not fit an int literal.
const _PACKED_INT_RANGE: Dictionary = {
	TYPE_PACKED_BYTE_ARRAY: [0, 255],
	TYPE_PACKED_INT32_ARRAY: [-2147483648, 2147483647],
	TYPE_PACKED_INT64_ARRAY: [-9223372036854775807 - 1, 9223372036854775807],
}

func _has_fractional_component(value) -> bool:
	var components: Array = []
	match typeof(value):
		TYPE_VECTOR2:
			components = [value.x, value.y]
		TYPE_VECTOR3:
			components = [value.x, value.y, value.z]
		TYPE_VECTOR4:
			components = [value.x, value.y, value.z, value.w]
	for component in components:
		if component != floorf(component):
			return true
	return false

const _METADATA_PREFIX: String = "metadata/"

# Compared by character, not code point or an engine helper whose name changed across 4.x.
const _IDENTIFIER_LEADING_CHARS: String = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_"
const _IDENTIFIER_DIGIT_CHARS: String = "0123456789"

func _is_ascii_identifier(text: String) -> bool:
	if text.is_empty():
		return false
	for i in range(text.length()):
		var character := text[i]
		var allowed := _IDENTIFIER_LEADING_CHARS.contains(character)
		if i > 0 and _IDENTIFIER_DIGIT_CHARS.contains(character):
			allowed = true
		if not allowed:
			return false
	return true

# Can `property` be set AND survive pack()? Run before _prepare_property_value so a write that cannot persist is an error naming the key. Metadata keys: only the name is checked.
# A slash key must be declared by the live property list as a real typed entry; a plain name needs a property-list entry, and an unexported script variable is accepted (existing scripted-node behavior sets it).
func _check_node_property_settable(node: Node, property: String) -> Dictionary:
	var node_class := node.get_class()
	if property.begins_with(_METADATA_PREFIX):
		if not _is_ascii_identifier(property.substr(_METADATA_PREFIX.length())):
			return {"ok": false, "error": "Metadata key '%s' is not a valid name: use letters, digits and underscore, not starting with a digit" % property}
		return {"ok": true, "error": ""}

	if "/" in property:
		var slash_descriptor = _find_property_descriptor(node, property)
		var declared := false
		if slash_descriptor != null:
			var slash_usage: int = slash_descriptor.get("usage", 0)
			var is_pseudo_entry: bool = (slash_usage & _NON_SETTABLE_PROPERTY_USAGE_MASK) != 0
			var has_declared_type: bool = slash_descriptor.type != TYPE_NIL or (slash_usage & PROPERTY_USAGE_NIL_IS_VARIANT) != 0
			var is_persistable: bool = (slash_usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_CHECKABLE)) != 0
			declared = not is_pseudo_entry and has_declared_type and is_persistable
		if not declared:
			return {"ok": false, "error": "Property '%s' is not declared by node of type '%s', so its value cannot be type-checked. Set it with run_script." % [property, node_class]}
		return {"ok": true, "error": ""}

	if not (property in node):
		return {"ok": false, "error": "Property '%s' does not exist on node of type '%s'" % [property, node_class]}
	var descriptor = _find_property_descriptor(node, property)
	if descriptor == null:
		return {"ok": false, "error": "Property '%s' on node of type '%s' has no entry in its property list (a constant, or a value served by _get), so it cannot be stored in a scene file" % [property, node_class]}
	return {"ok": true, "error": ""}

# A script variable declared without @export is set on the loaded instance but pack() writes stored properties only, so the write succeeds and this warning says it is not in the file.
# Native properties without the storage flag (rotation_degrees, global_position) are saved through their alias, so nothing is claimed.
func _unstored_script_variable_warning(node: Node, property: String) -> String:
	var descriptor = _find_property_descriptor(node, property)
	if descriptor == null:
		return ""
	var usage: int = descriptor.get("usage", 0)
	if (usage & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0 or (usage & PROPERTY_USAGE_STORAGE) != 0:
		return ""
	return "Property '%s' is a script variable declared without @export. It was set on the loaded scene, but a scene file stores exported variables only, so the value is not saved. Add @export to keep it, or set it at runtime with run_script." % property

func _find_property_descriptor(node: Object, property: String):
	for p in node.get_property_list():
		if p.name == property:
			return p
	return null

func _declared_property_type(node: Object, property: String) -> int:
	var descriptor = _find_property_descriptor(node, property)
	if descriptor == null:
		return TYPE_NIL
	return descriptor.type

# Keyed by declared Variant type, valued by the raw types accepted; a type with no entry needs an exact match, and TYPE_NIL is handled before this table and accepts anything.
const _PROPERTY_TYPE_COMPAT: Dictionary = {
	TYPE_INT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_FLOAT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_BOOL: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_STRING: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_STRING_NAME: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_NODE_PATH: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_VECTOR2: [TYPE_VECTOR2, TYPE_VECTOR2I],
	TYPE_VECTOR2I: [TYPE_VECTOR2, TYPE_VECTOR2I],
	TYPE_VECTOR3: [TYPE_VECTOR3, TYPE_VECTOR3I],
	TYPE_VECTOR3I: [TYPE_VECTOR3, TYPE_VECTOR3I],
	TYPE_VECTOR4: [TYPE_VECTOR4, TYPE_VECTOR4I],
	TYPE_VECTOR4I: [TYPE_VECTOR4, TYPE_VECTOR4I],
	TYPE_COLOR: [TYPE_COLOR],
	TYPE_DICTIONARY: [TYPE_DICTIONARY],
	TYPE_PACKED_BYTE_ARRAY: [TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY],
	TYPE_PACKED_INT32_ARRAY: [TYPE_ARRAY, TYPE_PACKED_INT32_ARRAY],
	TYPE_PACKED_INT64_ARRAY: [TYPE_ARRAY, TYPE_PACKED_INT64_ARRAY],
	TYPE_PACKED_FLOAT32_ARRAY: [TYPE_ARRAY, TYPE_PACKED_FLOAT32_ARRAY],
	TYPE_PACKED_FLOAT64_ARRAY: [TYPE_ARRAY, TYPE_PACKED_FLOAT64_ARRAY],
	TYPE_PACKED_STRING_ARRAY: [TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY],
	TYPE_PACKED_VECTOR2_ARRAY: [TYPE_ARRAY, TYPE_PACKED_VECTOR2_ARRAY],
	TYPE_PACKED_VECTOR3_ARRAY: [TYPE_ARRAY, TYPE_PACKED_VECTOR3_ARRAY],
	TYPE_PACKED_COLOR_ARRAY: [TYPE_ARRAY, TYPE_PACKED_COLOR_ARRAY],
	TYPE_PACKED_VECTOR4_ARRAY: [TYPE_ARRAY, TYPE_PACKED_VECTOR4_ARRAY],
}

# Membership is also the gate in _prepare_property_value: a declared type absent here skips element validation entirely.
const _PACKED_ARRAY_ELEMENT_TYPE: Dictionary = {
	TYPE_PACKED_BYTE_ARRAY: TYPE_INT,
	TYPE_PACKED_INT32_ARRAY: TYPE_INT,
	TYPE_PACKED_INT64_ARRAY: TYPE_INT,
	TYPE_PACKED_FLOAT32_ARRAY: TYPE_FLOAT,
	TYPE_PACKED_FLOAT64_ARRAY: TYPE_FLOAT,
	TYPE_PACKED_STRING_ARRAY: TYPE_STRING,
	TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2,
	TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
	TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
	TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR,
}

# Element type -> raw element types accepted. No Dictionary row: elements pass _coerce_property_value first, so a Dictionary element type could never be honoured.
# An element type absent here is REJECTED by all three element paths: the typed containers cannot be built, and passing the raw value to set() would store an empty container while reporting success.
const _ELEMENT_TYPE_COMPAT: Dictionary = {
	TYPE_BOOL: [TYPE_BOOL, TYPE_INT, TYPE_FLOAT],
	TYPE_INT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_FLOAT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_STRING: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_STRING_NAME: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_NODE_PATH: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_VECTOR2: [TYPE_VECTOR2, TYPE_VECTOR2I],
	TYPE_VECTOR2I: [TYPE_VECTOR2, TYPE_VECTOR2I],
	TYPE_VECTOR3: [TYPE_VECTOR3, TYPE_VECTOR3I],
	TYPE_VECTOR3I: [TYPE_VECTOR3, TYPE_VECTOR3I],
	TYPE_VECTOR4: [TYPE_VECTOR4, TYPE_VECTOR4I],
	TYPE_VECTOR4I: [TYPE_VECTOR4, TYPE_VECTOR4I],
	TYPE_COLOR: [TYPE_COLOR],
}

# ClassDB and is_class() know engine classes only; a property declared with a script class_name is matched through the project's global class list.
func _script_chain_has_global_class(object: Object, class_label: String) -> bool:
	var script_paths: Dictionary = {}
	var current = object.get_script()
	while current is Script:
		if current.resource_path != "":
			script_paths[current.resource_path] = true
		current = current.get_base_script()
	if script_paths.is_empty():
		return false
	for global_class in ProjectSettings.get_global_class_list():
		if str(global_class.get("class", "")) == class_label and script_paths.has(str(global_class.get("path", ""))):
			return true
	return false

# The res:// load path and inline construction share this so both reject a wrong-class resource identically. A property with no resource-type hint always passes.
func _check_resource_hint_class(descriptor, res, property: String, origin: String) -> Dictionary:
	if descriptor == null or descriptor.get("hint") != PROPERTY_HINT_RESOURCE_TYPE or descriptor.get("hint_string", "") == "":
		return {"ok": true, "error": ""}
	for allowed_class in descriptor.hint_string.split(","):
		if ClassDB.is_parent_class(res.get_class(), allowed_class) or res.is_class(allowed_class):
			return {"ok": true, "error": ""}
		if not ClassDB.class_exists(allowed_class) and _script_chain_has_global_class(res, allowed_class):
			return {"ok": true, "error": ""}
	return {"ok": false, "error": "%s resource is a %s, but property '%s' expects %s" % [origin, res.get_class(), property, descriptor.hint_string]}

const _NON_SETTABLE_PROPERTY_USAGE_MASK: int = (
	PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY
)

# Group/subgroup/category pseudo-entries (TYPE_NIL, no STORAGE bit) must not pass the existence gate: TYPE_NIL means "accept anything", so instance.set() would no-op silently while the tool reports success.
func _is_settable_property_descriptor(descriptor) -> bool:
	if descriptor == null:
		return false
	var usage: int = descriptor.get("usage", 0)
	if usage & _NON_SETTABLE_PROPERTY_USAGE_MASK != 0:
		return false
	return usage & PROPERTY_USAGE_STORAGE != 0

const _SHADER_PARAMETER_PREFIX: String = "shader_parameter/"

# Zero while a shader is assigned but failed to compile or declares no uniforms: attributes the existence-gate error correctly.
func _shader_parameter_count(instance: Object) -> int:
	var count: int = 0
	for p in instance.get_property_list():
		if String(p.name).begins_with(_SHADER_PARAMETER_PREFIX):
			count += 1
	return count

# Class eligibility is settled against ClassDB before instantiate(): a constructed Resource is RefCounted and cannot be free()d from GDScript, a non-Resource class is manually managed and would leak, so neither can be dropped after the fact.
# Inner properties go through _prepare_property_value, so every level has the same error contract.
func _construct_inline_resource(node: Object, property: String, spec: Dictionary) -> Dictionary:
	var class_name_str = spec.type
	if not ClassDB.class_exists(class_name_str):
		return {"ok": false, "value": null, "error": "Cannot construct resource for property '%s': unknown class '%s'" % [property, class_name_str]}
	if not ClassDB.is_parent_class(class_name_str, "Resource"):
		return {"ok": false, "value": null, "error": "Cannot construct resource for property '%s': class '%s' is not a Resource (only Resource subclasses can be constructed inline)" % [property, class_name_str]}
	if not ClassDB.can_instantiate(class_name_str):
		return {"ok": false, "value": null, "error": "Cannot construct resource for property '%s': class '%s' cannot be instantiated (abstract or native-only)" % [property, class_name_str]}
	var instance = ClassDB.instantiate(class_name_str)
	if instance == null:
		return {"ok": false, "value": null, "error": "Failed to instantiate class '%s' for property '%s'" % [class_name_str, property]}

	var hint_check = _check_resource_hint_class(_find_property_descriptor(node, property), instance, property, "Constructed")
	if not hint_check.ok:
		return {"ok": false, "value": null, "error": hint_check.error}

	# Plain properties first: virtual keys such as ShaderMaterial shader_parameter/<uniform> exist only once the resource they depend on is assigned.
	var ordered_keys: Array = []
	var virtual_keys: Array = []
	for inner_prop in spec.keys():
		if inner_prop == "type":
			continue
		if "/" in String(inner_prop):
			virtual_keys.append(inner_prop)
		else:
			ordered_keys.append(inner_prop)
	ordered_keys.append_array(virtual_keys)

	for inner_prop in ordered_keys:
		# The `in` operator misses shader_parameter/<uniform> keys even after the shader is assigned, so a slash key is also accepted when it resolves to a real settable entry in the live property list.
		# set() alone must not be the gate: it accepts unknown names silently.
		var exists: bool = inner_prop in instance
		if not exists and "/" in String(inner_prop):
			exists = _is_settable_property_descriptor(_find_property_descriptor(instance, String(inner_prop)))
		if not exists:
			if "/" in String(inner_prop):
				if String(inner_prop).begins_with(_SHADER_PARAMETER_PREFIX) and _find_property_descriptor(instance, "shader") != null and instance.get("shader") != null and _shader_parameter_count(instance) == 0:
					return {"ok": false, "value": null, "error": "Property '%s' does not resolve on resource of type '%s' (constructed for property '%s') -- a shader is assigned but exposes no shader_parameter/* uniforms, which usually means it failed to compile or declares none; check stderr, or run validate" % [inner_prop, class_name_str, property]}
				return {"ok": false, "value": null, "error": "Property '%s' does not resolve on resource of type '%s' (constructed for property '%s') -- for shader_parameter/<name>, the shader must be assigned first and <name> must be a uniform it declares" % [inner_prop, class_name_str, property]}
			return {"ok": false, "value": null, "error": "Property '%s' does not exist on resource of type '%s' (constructed for property '%s')" % [inner_prop, class_name_str, property]}
		var prepared = _prepare_property_value(instance, inner_prop, spec[inner_prop])
		if not prepared.ok:
			return {"ok": false, "value": null, "error": "Cannot set inner property '%s' on %s constructed for property '%s': %s" % [inner_prop, class_name_str, property, prepared.error]}
		var assigned := _assign_property(instance, inner_prop, prepared.value, false)
		if assigned.error != "":
			return {"ok": false, "value": null, "error": "Cannot set inner property '%s' on %s constructed for property '%s': %s" % [inner_prop, class_name_str, property, assigned.error]}
		if assigned.warning != "":
			result_warnings.append("Inner property '%s' on %s constructed for property '%s': %s" % [inner_prop, class_name_str, property, assigned.warning])

	return {"ok": true, "value": instance, "error": ""}

# The live value's Array.get_typed_builtin() wins; the hint_string's leading integer is the fallback. Composite forms ("24/17:Texture2D") resolve to TYPE_OBJECT/TYPE_ARRAY, absent from _ELEMENT_TYPE_COMPAT, so the caller rejects them.
# TYPE_NIL means an untyped Array, the only pass-through case.
func _typed_array_element_type(node: Object, property: String) -> int:
	var current = node.get(property)
	if typeof(current) == TYPE_ARRAY and current.is_typed():
		return current.get_typed_builtin()
	var descriptor = _find_property_descriptor(node, property)
	if descriptor != null and descriptor.get("hint") == PROPERTY_HINT_ARRAY_TYPE:
		var hint: String = str(descriptor.get("hint_string", ""))
		var digits := ""
		for i in range(hint.length()):
			var character := hint[i]
			if not character.is_valid_int():
				break
			digits += character
		if digits != "":
			return int(digits)
	return TYPE_NIL

# Duplicate-and-clear keeps the element type, class name and script, which the typed-Array constructor would need spelled out.
func _emptied_typed_array(node: Object, property: String):
	var current = node.get(property)
	if typeof(current) != TYPE_ARRAY or not current.is_typed():
		return null
	var emptied: Array = current.duplicate()
	emptied.clear()
	return emptied

# set() on an Array[T] property refuses an untyped Array (an empty one too), leaves an empty typed array behind and only prints an engine error, so the typed-Array constructor builds the container. It converts each element as a typed assign would, hence the size check below instead of a read-back.
# The caller has already confirmed the element type has a rule.
func _prepare_typed_array_elements(property: String, node_class: String, elem_type: int, arr: Array) -> Dictionary:
	var accepted: Array = _ELEMENT_TYPE_COMPAT[elem_type]
	var out: Array = []
	for i in range(arr.size()):
		var element = _coerce_property_value(arr[i])
		if elem_type in _INT_VECTOR_TYPES and typeof(arr[i]) == TYPE_DICTIONARY:
			var int_vector: Dictionary = _int_vector_from_json(elem_type, arr[i])
			if int_vector.problem != "":
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': element %d of the array: %s" % [
						property, node_class, i, int_vector.problem],
				}
			if int_vector.built:
				element = int_vector.value
		if not (typeof(element) in accepted):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) cannot be coerced to the element type %s" % [
					property, node_class, i, str(element), type_string(elem_type)],
			}
		if elem_type == TYPE_INT and _is_fractional_float(element):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) is not a whole number, and the element type is %s" % [
					property, node_class, i, str(element), type_string(elem_type)],
			}
		if elem_type == TYPE_INT:
			var int_problem := _json_int_problem(element)
			if int_problem != "":
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) %s" % [
						property, node_class, i, str(element), int_problem],
				}
			element = int(element)
		if elem_type in _INT_VECTOR_TYPES and _has_fractional_component(element):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) has fractional components, and the element type %s holds whole numbers" % [
					property, node_class, i, str(element), type_string(elem_type)],
			}
		out.append(element)
	# Builtin element types only: Array[Node] and friends have no _ELEMENT_TYPE_COMPAT row and are rejected before this runs.
	var typed: Array = Array(out, elem_type, &"", null)
	if typed.size() != out.size():
		return {
			"ok": false,
			"value": null,
			"error": "Cannot set property '%s' on node of type '%s': the array could not be converted to a typed array of %s" % [
				property, node_class, type_string(elem_type)],
		}
	return {"ok": true, "value": typed, "error": ""}

# Dictionary[K, V] arrived in Godot 4.4; before it neither the type nor the methods called on it exist.
const _TYPED_DICTIONARY_MIN_MINOR := 4

# JSON object keys are always strings, so a typed key must be buildable from one. TYPE_NIL is an untyped key.
const _JSON_KEY_TYPES: Array = [TYPE_NIL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]

func _engine_has_typed_dictionaries() -> bool:
	return _engine_minor_at_least(_TYPED_DICTIONARY_MIN_MINOR)

func _engine_minor_at_least(minor: int) -> bool:
	var version := Engine.get_version_info()
	return int(version.major) > 4 or (int(version.major) == 4 and int(version.minor) >= minor)

func _typed_dictionary_error(message: String) -> Dictionary:
	return {"ok": false, "value": null, "error": message, "typed": false}

# set() with an untyped dictionary on a typed property is refused without an error, so the container is built here: the current value is duplicated and cleared (keeps its key and value types without a typed-dictionary constructor, a compile error below 4.4). Every entry is validated before anything is assigned, because assigning a wrong-typed value raises and aborts this function.
# `current` is deliberately untyped so the file compiles on engines that predate Dictionary.is_typed().
func _prepare_typed_dictionary(node: Object, property: String, raw: Dictionary) -> Dictionary:
	var current = node.get(property)
	if not _engine_has_typed_dictionaries() or typeof(current) != TYPE_DICTIONARY or not current.is_typed():
		return {"ok": true, "value": null, "error": "", "typed": false}
	var node_class := node.get_class()
	var key_type: int = current.get_typed_key_builtin()
	var value_type: int = current.get_typed_value_builtin()
	if not (key_type in _JSON_KEY_TYPES):
		return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': it is a Dictionary keyed by %s, and keys of that type cannot be built from JSON object keys. Assign it with run_script instead." % [
			property, node_class, type_string(key_type)])
	if value_type != TYPE_NIL and not _ELEMENT_TYPE_COMPAT.has(value_type):
		return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': it is a Dictionary with values of %s, and values of that type cannot be built from JSON. Assign it with run_script instead." % [
			property, node_class, type_string(value_type)])

	var typed_keys: Array = []
	var typed_values: Array = []
	for raw_key in raw:
		var key = raw_key
		if key_type == TYPE_INT:
			if not str(raw_key).is_valid_int():
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': key \"%s\" is not a whole number, and the dictionary is keyed by int" % [
					property, node_class, str(raw_key)])
			if absf(str(raw_key).to_float()) >= _INT64_FLOAT_LIMIT:
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': key \"%s\" is outside the range an int key holds (%d to %d)" % [
					property, node_class, str(raw_key), _PACKED_INT_RANGE[TYPE_PACKED_INT64_ARRAY][0], _PACKED_INT_RANGE[TYPE_PACKED_INT64_ARRAY][1]])
			key = int(str(raw_key))
		elif key_type == TYPE_FLOAT:
			if not str(raw_key).is_valid_float():
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': key \"%s\" is not a number, and the dictionary is keyed by float" % [
					property, node_class, str(raw_key)])
			key = float(str(raw_key))
		elif key_type != TYPE_NIL:
			key = type_convert(raw_key, key_type)
		var element = raw[raw_key]
		if value_type != TYPE_NIL:
			element = _coerce_property_value(element)
			if value_type in _INT_VECTOR_TYPES and typeof(raw[raw_key]) == TYPE_DICTIONARY:
				var int_vector: Dictionary = _int_vector_from_json(value_type, raw[raw_key])
				if int_vector.problem != "":
					return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': value at key \"%s\": %s" % [
						property, node_class, str(raw_key), int_vector.problem])
				if int_vector.built:
					element = int_vector.value
			var accepted: Array = _ELEMENT_TYPE_COMPAT[value_type]
			if not (typeof(element) in accepted):
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': value at key \"%s\" (%s) cannot be coerced to the value type %s" % [
					property, node_class, str(raw_key), str(element), type_string(value_type)])
			if value_type == TYPE_INT and _is_fractional_float(element):
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': value at key \"%s\" (%s) is not a whole number, and the value type is int" % [
					property, node_class, str(raw_key), str(element)])
			if value_type == TYPE_INT:
				var int_problem := _json_int_problem(element)
				if int_problem != "":
					return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': value at key \"%s\" (%s) %s" % [
						property, node_class, str(raw_key), str(element), int_problem])
			if value_type in _INT_VECTOR_TYPES and _has_fractional_component(element):
				return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': value at key \"%s\" (%s) has fractional components, and the value type %s holds whole numbers" % [
					property, node_class, str(raw_key), str(element), type_string(value_type)])
			element = type_convert(element, value_type)
		typed_keys.append(key)
		typed_values.append(element)

	var typed = current.duplicate()
	typed.clear()
	for i in range(typed_keys.size()):
		typed[typed_keys[i]] = typed_values[i]
	if typed.size() != raw.size():
		return _typed_dictionary_error("Cannot set property '%s' on node of type '%s': two keys of the object became the same %s key, so the dictionary could not be built" % [
			property, node_class, type_string(key_type)])
	return {"ok": true, "value": typed, "error": "", "typed": true}

# set() casts through the property's typed setter with no validity return: an incompatible value silently stores the declared type's zero value (a String on an int stores 0), so the value is checked against get_property_list() first.
# Object-typed: a plain value is rejected except a res:// string (auto-loaded) or a {type} dict (constructed inline). Dictionary-typed: coercion is skipped. TYPE_NIL accepts anything; null passes only for Object-typed or untyped properties.
func _prepare_property_value(node: Object, property: String, raw_value) -> Dictionary:
	# A metadata entry is untyped whatever the property list says: stored as sent, even a dictionary shaped like a vector.
	var is_metadata: bool = property.begins_with(_METADATA_PREFIX)
	var declared = TYPE_NIL if is_metadata else _declared_property_type(node, property)
	var coerced = raw_value if (declared == TYPE_DICTIONARY or is_metadata) else _coerce_property_value(raw_value)
	if coerced == null:
		# null clears an Object-typed property, removes a metadata entry and resets an untyped Variant; on any other type the setter stores the zero value silently.
		if declared == TYPE_OBJECT or declared == TYPE_NIL:
			return {"ok": true, "value": coerced, "error": ""}
		return {
			"ok": false,
			"value": null,
			"error": "Cannot set property '%s' on node of type '%s': expected %s, got Nil" % [property, node.get_class(), type_string(declared)],
		}

	# Built from the JSON numbers themselves, not the float vector coerced above (_int_vector_from_json).
	if declared in _INT_VECTOR_TYPES and typeof(raw_value) == TYPE_DICTIONARY:
		var int_vector: Dictionary = _int_vector_from_json(declared, raw_value)
		if int_vector.problem != "":
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': %s" % [property, node.get_class(), int_vector.problem],
			}
		if int_vector.built:
			coerced = int_vector.value

	# Packed arrays: JSON sends a plain Array of raw elements and the typed setter silently casts each to the zero value, so each is coerced and fails loudly.
	if _PACKED_ARRAY_ELEMENT_TYPE.has(declared) and typeof(coerced) == TYPE_ARRAY:
		var element_prep = _prepare_packed_array_elements(property, node.get_class(), declared, coerced)
		if not element_prep.ok:
			return {"ok": false, "value": null, "error": element_prep.error}
		coerced = element_prep.value

	# A script-declared Array[T] has plain TYPE_ARRAY as its declared type, so the element type is recovered from the value or descriptor. set() refuses an untyped Array (an empty one too) and reports nothing, so a typed one is built; an element type with no _ELEMENT_TYPE_COMPAT row (Object types such as Array[Texture2D] included) is rejected, never passed through.
	# With no elements to convert, [] can still be emptied from the typed array the property holds.
	if declared == TYPE_ARRAY and typeof(coerced) == TYPE_ARRAY:
		var elem_type := _typed_array_element_type(node, property)
		if elem_type != TYPE_NIL:
			var emptied = _emptied_typed_array(node, property) if coerced.is_empty() else null
			if _ELEMENT_TYPE_COMPAT.has(elem_type):
				var typed_prep = _prepare_typed_array_elements(property, node.get_class(), elem_type, coerced)
				if not typed_prep.ok:
					return {"ok": false, "value": null, "error": typed_prep.error}
				coerced = typed_prep.value
			elif emptied != null:
				coerced = emptied
			else:
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': it is a typed Array of %s, and element values of that type cannot be built from JSON. Assign it with run_script instead." % [
						property, node.get_class(), type_string(elem_type)],
				}

	# A script-declared Dictionary[K, V] refuses an untyped dictionary like a typed Array: set() reports nothing. Untyped properties and engines without typed dictionaries come back typed false and keep the raw value.
	if declared == TYPE_DICTIONARY and typeof(coerced) == TYPE_DICTIONARY:
		var dict_prep = _prepare_typed_dictionary(node, property, coerced)
		if not dict_prep.ok:
			return {"ok": false, "value": null, "error": dict_prep.error}
		if dict_prep.typed:
			coerced = dict_prep.value

	if declared == TYPE_OBJECT and typeof(coerced) != TYPE_OBJECT:
		if typeof(coerced) == TYPE_STRING and coerced.begins_with("res://"):
			# A property value is the one path the Node-side validators never contained: Godot resolves res://../x outward, so it goes through normalize_scene_path and the normalized path is the one probed and loaded.
			var res_path: String = normalize_scene_path(coerced)
			if res_path.is_empty():
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': path escapes the project root: %s" % [property, node.get_class(), coerced],
				}
			# First reference to an asset the scene-load probe never saw: check the cold-import state before load().
			if _classify_dep_path(res_path) == "needs_import":
				return {"ok": false, "value": null, "error": _report_import_needed("property " + property, res_path)}
			# Same pre-load C#-support check as attach_script: without a C# module load() on a .cs fails with a generic message.
			if property == "script":
				var csharp_support = _check_csharp_support(res_path)
				if not csharp_support.ok:
					return {"ok": false, "value": null, "error": csharp_support.error}
			var res = load(res_path)
			if not res:
				return {"ok": false, "value": null, "error": "Failed to load resource: " + res_path}
			if res.resource_path == "":
				return {"ok": false, "value": null, "error": "Resource was imported but has no resource_path - the import likely failed for this asset. Check stderr for the import error."}
			var hint_check = _check_resource_hint_class(_find_property_descriptor(node, property), res, property, "Loaded")
			if not hint_check.ok:
				return {"ok": false, "value": null, "error": hint_check.error}
			# Only the node's own script slot silently drops an unattachable Script (parse errors, @abstract, unbuilt C# class), so gate on the property name, not on `res is Script` (_check_script_attachable).
			if property == "script" and res is Script:
				var attach_check = _check_script_attachable(res, res_path)
				if not attach_check.ok:
					return {"ok": false, "value": null, "error": attach_check.error}
			return {"ok": true, "value": res, "error": ""}

		if typeof(coerced) == TYPE_DICTIONARY and coerced.has("type") and typeof(coerced.type) == TYPE_STRING:
			var constructed = _construct_inline_resource(node, property, coerced)
			if not constructed.ok:
				return {"ok": false, "value": null, "error": constructed.error}
			return {"ok": true, "value": constructed.value, "error": ""}

		return {
			"ok": false,
			"value": null,
			"error": "Cannot set property '%s' on node of type '%s': it is Object-typed (Resource or Node) and cannot be assigned a plain value. Pass a res:// path to load a saved resource, a {\"type\": \"ClassName\", ...} dict to construct one inline, or use run_script." % [property, node.get_class()],
		}

	if declared != TYPE_NIL:
		var accepted_types = _PROPERTY_TYPE_COMPAT.get(declared, [declared])
		if not (typeof(coerced) in accepted_types):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': expected %s, got %s" % [property, node.get_class(), type_string(declared), type_string(typeof(coerced))],
			}
		if declared == TYPE_INT and _is_fractional_float(coerced):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': expected a whole number for an int property, got %s" % [property, node.get_class(), str(coerced)],
			}
		if declared == TYPE_INT:
			var int_problem := _json_int_problem(coerced)
			if int_problem != "":
				return {
					"ok": false,
					"value": null,
					"error": "Cannot set property '%s' on node of type '%s': %s %s" % [property, node.get_class(), str(coerced), int_problem],
				}
			# The integer itself, which _assign_property compares with what the property holds afterwards.
			coerced = int(coerced)
		if declared in _INT_VECTOR_TYPES and _has_fractional_component(coerced):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': expected whole-number components for %s, got %s" % [property, node.get_class(), type_string(declared), str(coerced)],
			}

	return {"ok": true, "value": coerced, "error": ""}

# changed_only compares against a default instance per class kept in defaults_cache; the caller frees the cache.
func _collect_node_properties(node: Node, changed_only: bool, defaults_cache: Dictionary) -> Dictionary:
	var default_node = null
	if changed_only:
		var klass = node.get_class()
		if defaults_cache.has(klass):
			default_node = defaults_cache[klass]
		else:
			default_node = instantiate_class(klass)
			defaults_cache[klass] = default_node

	var properties = {}
	var property_list = node.get_property_list()

	for prop in property_list:
		var prop_name = prop["name"]
		var prop_usage = prop["usage"]

		if prop_usage & PROPERTY_USAGE_STORAGE or prop_usage & PROPERTY_USAGE_EDITOR:
			var value = node.get(prop_name)

			if default_node and default_node.get(prop_name) == value:
				continue

			if value is Vector2:
				properties[prop_name] = {"x": value.x, "y": value.y}
			elif value is Vector3:
				properties[prop_name] = {"x": value.x, "y": value.y, "z": value.z}
			elif value is Color:
				properties[prop_name] = {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
			elif value is Transform2D:
				properties[prop_name] = str(value)
			elif value is Transform3D:
				properties[prop_name] = str(value)
			elif value is Object:
				if value:
					properties[prop_name] = value.get_class()
				else:
					properties[prop_name] = null
			elif typeof(value) in [TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_ARRAY, TYPE_DICTIONARY]:
				properties[prop_name] = value
			else:
				properties[prop_name] = str(value)

	return properties

# "valid" is the engine's verdict: load() returns a non-null Script even for one with parse errors, so a script is valid only when it can also be instantiated, and a scene only when it loaded as a PackedScene.
# "resolvedPath" is the normalized path the engine reports diagnostics against, so the TS layer can match stderr to this target.
func _validate_single(target: Dictionary) -> Dictionary:
	if target.has("script_path") and target.script_path != "":
		var path = normalize_scene_path(target.script_path)
		if path.is_empty():
			return {"valid": false, "errors": [{"message": "Path escapes the project root: " + target.script_path}], "target": target.script_path}
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.script_path}
		var resource = load(path)
		# A file that loads as anything but a GDScript was not checked here; reporting it valid would be a verdict nobody reached.
		if resource != null and not (resource is GDScript):
			return {
				"valid": false,
				"errors": [{"message": "Not validated: %s loaded as %s, not as a GDScript. scriptPath checks GDScript (.gd) files only; pass a scene as scenePath." % [target.script_path, resource.get_class()]}],
				"target": target.script_path,
				"resolvedPath": path,
			}
		# Actual parse errors go to stderr and are parsed by TypeScript
		var script_valid: bool = resource != null
		if script_valid:
			# An @abstract script is valid whether or not this engine's can_instantiate() stays true for one; errors still reach stderr and the Node side overlays them.
			script_valid = resource.can_instantiate() or (resource.has_method("is_abstract") and resource.is_abstract())
		return {"valid": script_valid, "errors": [], "target": target.script_path, "resolvedPath": path}
	elif target.has("scene_path") and target.scene_path != "":
		var path = normalize_scene_path(target.scene_path)
		if path.is_empty():
			return {"valid": false, "errors": [{"message": "Path escapes the project root: " + target.scene_path}], "target": target.scene_path}
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.scene_path}
		var scene = load(path)
		return {"valid": scene is PackedScene, "errors": [], "target": target.scene_path, "resolvedPath": path}
	else:
		return {"valid": false, "errors": [{"message": "No valid target: provide script_path or scene_path"}], "target": ""}

# A target with a non-empty checks[] also gets the structural and signal checks here, reported in "checkErrors".
# checkErrors is separate from "errors" because the TS layer overlays stderr diagnostics over "errors" for any target that produced some, which would discard merged check errors. Every failure lands on its own target and the loop continues.
func validate_batch(params: Dictionary) -> void:
	var results: Array = []
	for target in params.targets:
		var result = _validate_single(target)
		var checks = target.get("checks", []) if target is Dictionary else []
		if typeof(checks) == TYPE_ARRAY and not checks.is_empty():
			var scene_path = str(target.get("scene_path", ""))
			var outcome = _run_scene_checks(scene_path, checks)
			if not outcome.ok:
				result["checkErrors"] = [{"message": outcome.error}]
				result["valid"] = false
			elif not outcome.errors.is_empty():
				result["checkErrors"] = outcome.errors
				result["valid"] = false
			else:
				result["checkErrors"] = []
		results.append(result)
	emit_result({"results": results})

# Collects every res:// string in a JSON-sourced value (a bare path, an inline resource spec nesting one, arrays or dicts of them) so assets are probed before a mutation. JSON cannot produce a cycle.
func _collect_res_paths(value, out: Array) -> void:
	match typeof(value):
		TYPE_STRING:
			if (value as String).begins_with("res://"):
				out.append(value)
		TYPE_DICTIONARY:
			for key in value:
				_collect_res_paths(value[key], out)
		TYPE_ARRAY:
			for item in value:
				_collect_res_paths(item, out)

# A path PARAMETER follows the tool surface's convention (project-relative or res://), so it is normalized with normalize_scene_path, unlike property VALUES where only a res:// string is a reference (_collect_res_paths). A scene (is_scene) is probed for its own dependencies, any other asset is classified directly.
# An escaping path is not probed: the apply site rejects it per operation, which keeps the rejection out of the other operations' results.
func _prepass_path_param(raw_path: String, is_scene: bool, seen_paths: Dictionary, needs_import: Array, missing: Array) -> void:
	if raw_path == "":
		return
	var full_path = normalize_scene_path(raw_path)
	if full_path.is_empty() or full_path in seen_paths:
		return
	seen_paths[full_path] = true
	if not is_scene:
		if _classify_dep_path(full_path) == "needs_import":
			needs_import.append(full_path)
		return
	if not FileAccess.file_exists(full_path):
		return
	var probe = _probe_scene_deps(full_path)
	missing.append_array(probe.missing)
	needs_import.append_array(probe.needs_import)

# _prepare_property_value loads a res:// string only on an Object-typed property. Unknown targets (node not found, property not declared yet because the same batch attaches its script) answer true: probing too much asks for an import, too little lets a cold asset surface after earlier operations saved.
func _value_may_load_asset(node: Object, property: String) -> bool:
	if node == null:
		return true
	if property.begins_with(_METADATA_PREFIX):
		return false
	var descriptor = _find_property_descriptor(node, property)
	if descriptor == null:
		return true
	return descriptor.type == TYPE_OBJECT

# Collects the property VALUES one batch operation can assign, for the res:// walk: a reference found only at assignment time would emit [IMPORT_NEEDED] mid-batch, after earlier operations mutated. Only values on Object-typed targets are returned (_value_may_load_asset).
# Update targets are looked up in `probe_scenes` (normalized path -> instance or null), loaded on first use; the caller frees them.
func _prepass_value_roots(op: Dictionary, op_name, probe_scenes: Dictionary) -> Array:
	var value_roots: Array = []
	if op_name == "add_node" and typeof(op.get("properties", null)) == TYPE_DICTIONARY:
		var found: Array = []
		_collect_res_paths(op.properties, found)
		if found.is_empty():
			return []
		var made = _instantiate_node_type(str(op.get("node_type", "")))
		if _was_stopped(made) or not made.ok:
			value_roots.append(op.properties)
			return value_roots
		var kept: Dictionary = {}
		for key in op.properties:
			if _value_may_load_asset(made.node, str(key)):
				kept[key] = op.properties[key]
		if not (made.node is RefCounted):
			made.node.free()
		value_roots.append(kept)
	elif op_name == "set_node_properties" and op.has("updates") and op.updates is Array:
		var update_values: Array = []
		for update in op.updates:
			if typeof(update) == TYPE_DICTIONARY and update.has("value"):
				update_values.append(update)
		var found_in_updates: Array = []
		for update in update_values:
			_collect_res_paths(update.value, found_in_updates)
		if found_in_updates.is_empty():
			return []
		var scene_root = null
		var scene_key := normalize_scene_path(str(op.get("scene_path", "")))
		if scene_key != "":
			if not probe_scenes.has(scene_key):
				probe_scenes[scene_key] = load_scene_instance(scene_key)
			scene_root = probe_scenes[scene_key]
		for update in update_values:
			var node = null
			if scene_root != null and typeof(update.get("node_path", null)) == TYPE_STRING:
				node = find_node_by_path(scene_root, update.node_path)
			if _value_may_load_asset(node, str(update.get("property", ""))):
				value_roots.append(update.value)
	return value_roots

# Returns true when it exited the batch (the caller returns at once).
func _prepass_refuses(missing: Array, needs_import: Array) -> bool:
	if missing.size() > 0:
		log_error("Scene references files that do not exist on disk, refusing to load so the references are not stripped on save: " + ", ".join(missing))
		_fail_operation()
		return true
	if needs_import.size() > 0:
		_report_import_needed("batch", ", ".join(needs_import))
		_fail_operation()
		return true
	return false

# Scene files `scene_key` is built from, directly or through others (inherited and instanced), as a set that never holds `scene_key`.
# Two sources, neither complete: the file's own references, and the live tree's instance roots, which also hold what this batch instanced and no file records yet.
func _scene_dependency_keys(scene_key: String, scene_root: Node) -> Dictionary:
	var found: Dictionary = {}
	var to_read: Array = [scene_key]
	if scene_root != null:
		for node in _iter_subtree(scene_root):
			if node == scene_root or node.scene_file_path == "":
				continue
			var instanced_key := _scene_file_key(node.scene_file_path)
			if instanced_key != "" and instanced_key != scene_key and not found.has(instanced_key):
				found[instanced_key] = true
				to_read.append(instanced_key)
	while not to_read.is_empty():
		var current: String = to_read.pop_back()
		if not FileAccess.file_exists(current):
			continue
		for dep in ResourceLoader.get_dependencies(current):
			var dep_path := _resolve_dep_path(dep)
			if not _is_scene_path(dep_path):
				continue
			var dep_key := _scene_file_key(dep_path)
			if dep_key == "" or dep_key == scene_key or found.has(dep_key):
				continue
			found[dep_key] = true
			to_read.append(dep_key)
	return found

# Orders `keys` so every scene comes before the scenes it is built from. If two keys ever name each other the first waiting is taken, so the loop ends.
func _dependents_first(keys: Array, dependencies: Dictionary) -> Array:
	var ordered: Array = []
	var waiting: Array = keys.duplicate()
	while not waiting.is_empty():
		var picked := 0
		for i in range(waiting.size()):
			var needed_by_another := false
			for other in waiting:
				if other != waiting[i] and dependencies[other].has(waiting[i]):
					needed_by_another = true
					break
			if not needed_by_another:
				picked = i
				break
		ordered.append(waiting[picked])
		waiting.remove_at(picked)
	return ordered

# A save to the scene's own path keeps the tree cached; a save-as onto a path the batch also holds replaces that tree, and is refused before writing when that tree has successful operations not yet written.
# A cached tree built from the file being written must never be packed after it: pack() would save the old values as overrides. Dependents with unwritten operations are written first (named in also_saved), then every dependent leaves the cache.
func _apply_batch_save(scene_root: Node, scene_key: String, op: Dictionary, scene_cache: Dictionary, unsaved_results_by_scene: Dictionary) -> Dictionary:
	var target_key := scene_key
	if op.get("new_path", null) != null:
		if typeof(op.new_path) != TYPE_STRING:
			return {"ok": false, "error": "new_path must be a string", "saved_path": "", "also_saved": []}
		target_key = _scene_file_key(op.new_path)
		if target_key.is_empty():
			return {"ok": false, "error": "Path escapes the project root: " + op.new_path, "saved_path": "", "also_saved": []}
	var replaces_cached_tree: bool = target_key != scene_key and scene_cache.has(target_key)
	if replaces_cached_tree:
		var pending: Array = unsaved_results_by_scene.get(target_key, [])
		if not pending.is_empty():
			var target_label := _project_relative(target_key)
			return {
				"ok": false,
				"error": "Cannot save %s as %s: %d earlier operation(s) of this batch changed %s and are not written yet, and the save-as would discard them. Put the save-as before them, or save %s first if it is meant to be overwritten." % [
					_project_relative(scene_key), target_label, pending.size(), target_label, target_label],
				"saved_path": "",
				"also_saved": [],
			}

	var dependents: Array = []
	var pending_dependents: Array = []
	var dependencies: Dictionary = {}
	for cached_key in scene_cache:
		if cached_key == target_key:
			continue
		var built_from: Dictionary = _scene_dependency_keys(cached_key, scene_cache[cached_key])
		if not built_from.has(target_key):
			continue
		dependents.append(cached_key)
		dependencies[cached_key] = built_from
		if not unsaved_results_by_scene.get(cached_key, []).is_empty():
			pending_dependents.append(cached_key)
	var also_saved: Array = []
	for dependent_key in _dependents_first(pending_dependents, dependencies):
		if not save_scene_to_path(scene_cache[dependent_key], dependent_key):
			return {
				"ok": false,
				"error": "Cannot save %s: %s is built from it and holds operations of this batch that are not written yet. They have to be written before it changes, and saving %s failed." % [
					_project_relative(target_key), _project_relative(dependent_key), _project_relative(dependent_key)],
				"saved_path": "",
				"also_saved": also_saved,
			}
		unsaved_results_by_scene.erase(dependent_key)
		also_saved.append(_project_relative(dependent_key))

	if not save_scene_to_path(scene_root, target_key):
		return {"ok": false, "error": "Failed to save scene: " + _project_relative(target_key), "saved_path": "", "also_saved": also_saved}
	if target_key == scene_key:
		unsaved_results_by_scene.erase(scene_key)
	elif replaces_cached_tree:
		scene_cache[target_key].free()
		scene_cache.erase(target_key)
	for dependent_key in dependents:
		scene_cache[dependent_key].free()
		scene_cache.erase(dependent_key)
	return {"ok": true, "error": "", "saved_path": _project_relative(target_key), "also_saved": also_saved}

# Each scene is loaded once and cached by _scene_file_key; a tree leaves the cache only in _apply_batch_save.
func batch_scene_operations(params: Dictionary) -> void:
	var abort_on_error = params.get("abort_on_error", false)
	var results: Array = []
	var scene_cache: Dictionary = {}
	var batch_warnings: Array = []
	# Scene cache key -> indexes into `results` of successful mutations not yet written; a failed save must reach exactly these.
	var unsaved_results_by_scene: Dictionary = {}

	# Pre-pass: probe everything the batch will load for cold-import and missing files BEFORE any mutation. A cold asset found mid-batch would make the TS layer replay the batch and duplicate mutations already saved; once this passes, no _apply_* can reach one (the disarm below is the backstop).
	# Path PARAMETERS and property VALUES are different (_prepass_path_param, _collect_res_paths); phase B loads scenes, so it runs only after phase A proved dependencies present. Plain scene load failures stay lazy for per-operation reporting.
	var seen_paths: Dictionary = {}
	var prepass_missing: Array = []
	var prepass_needs_import: Array = []
	for op in params.operations:
		if typeof(op) != TYPE_DICTIONARY:
			continue
		var op_name = op.get("operation", "")

		_prepass_path_param(str(op.get("scene_path", "")), true, seen_paths, prepass_needs_import, prepass_missing)
		if op_name == "load_sprite":
			_prepass_path_param(str(op.get("texture_path", "")), false, seen_paths, prepass_needs_import, prepass_missing)
		elif op_name == "add_node":
			# node_type may name a scene: _instantiate_node_type loads it directly, bypassing load_scene_instance's probe.
			var node_type = str(op.get("node_type", ""))
			if _is_scene_path(node_type):
				_prepass_path_param(node_type, true, seen_paths, prepass_needs_import, prepass_missing)

	if _prepass_refuses(prepass_missing, prepass_needs_import):
		return

	var probe_scenes: Dictionary = {}
	for op in params.operations:
		if typeof(op) != TYPE_DICTIONARY:
			continue
		var res_paths: Array = []
		for value_root in _prepass_value_roots(op, op.get("operation", ""), probe_scenes):
			_collect_res_paths(value_root, res_paths)
		for raw_path in res_paths:
			_prepass_path_param(str(raw_path), false, seen_paths, prepass_needs_import, prepass_missing)
	for probe_key in probe_scenes:
		if probe_scenes[probe_key] != null:
			probe_scenes[probe_key].free()
	if _prepass_refuses(prepass_missing, prepass_needs_import):
		return

	for op in params.operations:
		if typeof(op) != TYPE_DICTIONARY:
			results.append({"operation": "", "scenePath": "", "error": "operations[%d] must be an object" % results.size()})
			if abort_on_error:
				break
			continue
		# A non-string operation is treated as an omitted one (the hint path below names it).
		var op_name = op.get("operation", "")
		if typeof(op_name) != TYPE_STRING:
			op_name = ""
		var scene_path = op.get("scene_path", "")
		if typeof(scene_path) != TYPE_STRING:
			results.append({"operation": op_name, "scenePath": "", "error": "scene_path must be a string"})
			if abort_on_error:
				break
			continue
		var result = {"operation": op_name, "scenePath": scene_path}

		# Keyed on the file, not the spelling ("a.tscn", "./a.tscn", "A.tscn" where case is ignored): independent trees would be written over each other by the closing save.
		var scene_key := ""
		if scene_path != "":
			scene_key = _scene_file_key(scene_path)
			if scene_key.is_empty():
				result["error"] = "Path escapes the project root: " + scene_path
				results.append(result)
				if abort_on_error:
					break
				continue

		if scene_key != "" and scene_key not in scene_cache:
			var loaded_root = load_scene_instance(scene_key)
			if loaded_root:
				scene_cache[scene_key] = loaded_root
			else:
				result["error"] = "Failed to load scene: " + scene_path
				results.append(result)
				if abort_on_error:
					break
				continue

		var scene_root = scene_cache.get(scene_key, null) if scene_key != "" else null

		# KEEP IN SYNC with BATCH_OPERATION_NAMES in src/utils/arg-parsing.ts: the arms below and the list in the hint.
		match op_name:
			"add_node":
				if scene_root == null:
					result["error"] = "scene_path required for add_node"
				else:
					var apply_result = _apply_add_node(scene_root, op)
					if _was_stopped(apply_result):
						result["error"] = "%s was %s" % [op_name, _STOPPED_BY_SCRIPT_ERROR]
					elif not apply_result.ok:
						result["error"] = apply_result.error
					else:
						result["success"] = true
						result.merge(apply_result.payload)
						for add_warning in apply_result.warnings:
							batch_warnings.append("operations[%d]: %s" % [results.size(), add_warning])
			"load_sprite":
				if scene_root == null:
					result["error"] = "scene_path required for load_sprite"
				else:
					var apply_result = _apply_load_sprite(scene_root, op)
					if _was_stopped(apply_result):
						result["error"] = "%s was %s" % [op_name, _STOPPED_BY_SCRIPT_ERROR]
					elif not apply_result.ok:
						result["error"] = apply_result.error
					else:
						result["success"] = true
						result.merge(apply_result.payload)
			"set_node_properties":
				if scene_root == null:
					result["error"] = "scene_path required for set_node_properties"
				elif not op.has("updates") or (op.updates is Array and op.updates.is_empty()):
					result["error"] = "non-empty updates array required for set_node_properties"
				else:
					var apply_result = _apply_updates(scene_root, op.updates, op.get("abort_on_error", false))
					if _was_stopped(apply_result):
						result["error"] = "%s was %s" % [op_name, _STOPPED_BY_SCRIPT_ERROR]
					else:
						if apply_result.any_set:
							result["success"] = true
						else:
							result["error"] = "no properties were set"
						if apply_result.results.size() > 0:
							result["updates"] = apply_result.results
						# The entry reads as a success once any update lands, so the failed ones would sit two levels down unseen.
						var failed_updates := 0
						for update_result in apply_result.results:
							if update_result.has("error"):
								failed_updates += 1
						if apply_result.any_set and failed_updates > 0:
							batch_warnings.append("operations[%d]: %d of %d updates failed, see results[%d].updates" % [results.size(), failed_updates, apply_result.results.size(), results.size()])
						for update_warning in apply_result.warnings:
							batch_warnings.append("operations[%d]: %s" % [results.size(), update_warning])
			"save":
				if scene_root == null:
					result["error"] = "scene_path required for save"
				else:
					var saved = _apply_batch_save(scene_root, scene_key, op, scene_cache, unsaved_results_by_scene)
					if _was_stopped(saved):
						result["error"] = "%s was %s" % [op_name, _STOPPED_BY_SCRIPT_ERROR]
					else:
						if saved.ok:
							result["success"] = true
							result["savedScenePath"] = saved.saved_path
						else:
							result["error"] = saved.error
						# Written ahead of this save whether or not it succeeded: those operations are in their file now.
						for dependent_label in saved.also_saved:
							batch_warnings.append("operations[%d]: %s is built from the scene this item saves and held operations of this batch that were not written yet, so it was saved first" % [results.size(), dependent_label])
			_:
				# An omitted "operation" key is the common mistake: name the item index and hint at inference when the shape identifies the op.
				var hint = ""
				if op_name == null or op_name == "":
					hint = " - operations[%d] is missing the required 'operation' key (one of: add_node, load_sprite, set_node_properties, save)." % results.size()
					# convertCamelToSnakeCase converts operations[] recursively, so keys arrive snake_cased here.
					if op.has("node_name") or op.has("node_type"):
						hint += " (node_name/node_type present: did you mean operation 'add_node'?)"
					elif op.has("updates"):
						hint += " (updates present: did you mean operation 'set_node_properties'?)"
					elif op.has("texture_path"):
						hint += " (texture_path present: did you mean operation 'load_sprite'?)"
				result["error"] = "Unknown batch operation: " + str(op_name) + hint

		results.append(result)
		if result.get("success", false):
			# From here a cold asset the pre-pass missed must fail the batch, not ask the TS layer to replay it: every cached scene is saved before return, and a replay would duplicate nodes.
			import_marker_armed = false
			if op_name != "save":
				if not unsaved_results_by_scene.has(scene_key):
					unsaved_results_by_scene[scene_key] = []
				unsaved_results_by_scene[scene_key].append(results.size() - 1)
		if abort_on_error and result.has("error"):
			break

	# Operations after an abort start at results.size(); each is listed as skipped so results stays one entry per operation.
	for skipped_index in range(results.size(), params.operations.size()):
		var skipped_op = params.operations[skipped_index]
		var skipped_entry := {"operation": "", "scenePath": "", "skipped": true}
		if typeof(skipped_op) == TYPE_DICTIONARY:
			if typeof(skipped_op.get("operation", "")) == TYPE_STRING:
				skipped_entry["operation"] = skipped_op.get("operation", "")
			if typeof(skipped_op.get("scene_path", "")) == TYPE_STRING:
				skipped_entry["scenePath"] = skipped_op.get("scene_path", "")
		results.append(skipped_entry)

	# Auto-save each cached scene an operation succeeded on and no save has written since; a scene nothing succeeded on is never rewritten (it could only canonicalize or lose content). A scene that cannot be written has its entries rewritten to say so.
	# Dependents first (see _apply_batch_save), not load order: packed after a scene it is built from was rewritten, it would save that file's old values as overrides.
	var closing_keys: Array = []
	var closing_dependencies: Dictionary = {}
	for scene_key in scene_cache:
		if unsaved_results_by_scene.get(scene_key, []).is_empty():
			continue
		closing_keys.append(scene_key)
		closing_dependencies[scene_key] = _scene_dependency_keys(scene_key, scene_cache[scene_key])
	for scene_key in _dependents_first(closing_keys, closing_dependencies):
		var unsaved: Array = unsaved_results_by_scene.get(scene_key, [])
		if save_scene_to_path(scene_cache[scene_key], scene_key):
			continue
		var scene_label := _project_relative(scene_key)
		for result_index in unsaved:
			var unsaved_entry: Dictionary = results[result_index]
			unsaved_entry.erase("success")
			unsaved_entry["error"] = "applied in memory but the scene could not be saved: " + scene_label
		batch_warnings.append("Scene %s could not be saved; %d operation(s) on it were not written" % [scene_label, unsaved.size()])

	var batch_payload := {"results": results}
	if not batch_warnings.is_empty():
		batch_payload["warnings"] = batch_warnings
	emit_result(batch_payload)
