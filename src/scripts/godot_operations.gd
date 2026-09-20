#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false

func _init():
	var args = OS.get_cmdline_args()

	# Check for debug flag
	debug_mode = "--debug-godot" in args

	# SceneTree.quit(n) only schedules a quit for end-of-frame in Godot 4.
	# Every quit(1) must be followed by `return` to halt the failing path,
	# otherwise control falls through into success-print + scene save.
	# Find the script argument and determine the positions of operation and params
	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		quit(1)
		return

	var operation_index = script_index + 2
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		log_error("Not enough command-line arguments provided.")
		quit(1)
		return

	log_debug("All arguments: " + str(args))

	var operation = args[operation_index]
	var params_json = args[params_index]

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
		quit(1)
		return

	if not params:
		log_error("Failed to parse JSON parameters: " + params_json)
		quit(1)
		return

	log_info("Executing operation: " + operation)

	match operation:
		# Original operations
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
		# Node operations (always-array)
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
		# Batch operations
		"validate_batch":
			validate_batch(params)
		"batch_scene_operations":
			batch_scene_operations(params)
		_:
			log_error("Unknown operation: " + operation)
			quit(1)
			return

	quit()
	return

# Logging functions
func log_debug(message):
	if debug_mode:
		print("[DEBUG] " + message)

func log_info(message):
	printerr("[INFO] " + message)

func log_error(message):
	printerr("[ERROR] " + message)

# Get a script by name or path
func get_script_by_name(name_of_class):
	if debug_mode:
		printerr("Attempting to get script for class: " + name_of_class)

	if ResourceLoader.exists(name_of_class, "Script"):
		if debug_mode:
			printerr("Resource exists, loading directly: " + name_of_class)
		var script = load(name_of_class) as Script
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

# Instantiate a class by name
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

# Normalize a project-relative or res:// path to its res:// form, rejecting any
# path that escapes the project root. Godot resolves "res://../x" outward to a
# real file on disk, so containment is enforced here rather than trusted from
# the caller: this is the single choke point every path-taking operation
# funnels through, batch included -- batch forwards operations to these
# functions without passing through the Node-side path validators.
#
# Returns "" for a rejected path. Callers must treat "" as a rejection.
func normalize_scene_path(scene_path: String) -> String:
	var full_path = scene_path
	if not full_path.begins_with("res://"):
		full_path = "res://" + full_path
	var relative = full_path.substr("res://".length()).simplify_path()
	# A leading ".." escapes the project root. A surviving "://" means a second
	# scheme rode in (e.g. "res://res://../x"), which simplify_path leaves
	# intact -- reject rather than depend on how the engine rewrites it later.
	if relative.is_empty() or relative.begins_with("..") or relative.contains("://"):
		return ""
	return "res://" + relative

# Resolves a ResourceLoader.get_dependencies() entry to its underlying
# res:// path. Dependency strings come in two shapes:
#   - bare:    "res://assets/tex.png"
#   - uid-form: "uid://bq0sxwkx7p5xe::::res://assets/tex.png" (uid::type::path,
#     type empty in practice) -- every scene saved by the Godot editor uses
#     this form.
# rfind (not get_slice) is used so both shapes parse correctly even if a
# bare res:// path ever contained "::" itself. When the string is uid-form,
# the uid is resolved via ResourceUID first and its current path preferred
# over the embedded text path -- the editor may have moved the file since
# the scene was saved.
func _resolve_dep_path(dep: String) -> String:
	var text_path = dep.substr(dep.rfind("::") + 2) if dep.contains("::") else dep
	if not dep.begins_with("uid://"):
		return text_path
	var uid_text = dep.substr(0, dep.find("::")) if dep.contains("::") else dep
	var id := ResourceUID.text_to_id(uid_text)
	if id != ResourceUID.INVALID_ID and ResourceUID.has_id(id):
		return ResourceUID.get_id_path(id)
	return text_path

# Classifies a resolved dependency path for the cold-import probe. Non-res://
# paths (rare, but not impossible in a dependency list) are always "ok" since
# there is nothing this probe can check about them. Shared by the scene-load
# probe, the batch pre-pass, and the first-time asset-reference sites
# (_apply_load_sprite, _prepare_property_value).
func _classify_dep_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "ok"
	if ResourceLoader.exists(path):
		return "ok"
	if FileAccess.file_exists(path):
		return "needs_import"
	return "missing"

# Cold-import + missing-file probe shared by load_scene_instance and the
# batch pre-pass. Returns {"needs_import": [...], "missing": [...]} for the
# ext_resources of `full_path`: "needs_import" are on disk but never
# imported (ResourceLoader.exists false, FileAccess.file_exists true);
# "missing" are not on disk at all.
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

# Load and instantiate a scene. Before loading, probes for the cold-import
# state: files that exist on disk but were never imported (no .godot/imported
# artifacts). In that state ResourceLoader.exists(dep) is false while
# FileAccess.file_exists(dep) is true — loading the scene "succeeds" with
# null resources, and the save cycle silently strips those references from
# the .tscn.
#
# Returns null on failure and prints a structured error line that TS can
# recognize: "[IMPORT_NEEDED] <scene_path>: <unimported_file1>, ...". The TS
# layer catches this, runs the import step, and retries the operation once.
# A dependency that is missing from disk entirely is a different failure and
# refuses the load outright (see below) rather than feeding into the import
# retry loop.
#
# The signal is self-terminating: a failed or broken import still writes the
# .import sidecar, flipping exists() to true, so the same asset is never
# probed again and instead correctly reports as a broken asset downstream.
#
# Tried and rejected: ResourceLoader.set_abort_on_missing_resources(false)
# plus tolerating MissingResource placeholders. This does NOT fix either
# case here -- the missing-file case still silently strips the reference on
# save (a MissingResource still packs as nothing), and the unimported-file
# case hangs the engine instead of returning cleanly. Probing dependencies
# up front, before load() ever runs, is the only approach that avoided both.
func load_scene_instance(scene_path: String):
	var full_path = normalize_scene_path(scene_path)
	if full_path.is_empty():
		log_error("Path escapes the project root: " + scene_path)
		return null
	log_debug("Loading scene from: " + full_path)

	if not FileAccess.file_exists(full_path):
		log_error("Scene file does not exist: " + full_path)
		return null

	# Probe dependencies before loading. Missing files are checked first: a
	# scene with both problems is refused outright rather than imported and
	# then refused, which would leave a half-fixed state behind.
	var probe = _probe_scene_deps(full_path)
	if probe.missing.size() > 0:
		log_error("Scene references files that do not exist on disk, refusing to load so the references are not stripped on save: " + ", ".join(probe.missing))
		return null
	if probe.needs_import.size() > 0:
		log_error("[IMPORT_NEEDED] " + scene_path + ": " + ", ".join(probe.needs_import))
		return null

	var scene = load(full_path)
	if not scene:
		log_error("Failed to load scene: " + full_path)
		return null

	var instance = scene.instantiate()
	if not instance:
		log_error("Failed to instantiate scene: " + full_path)
		return null

	return instance

# Helper to find a node by path. Accepts "root", ".", "" (all → scene_root),
# the actual scene root's name (e.g. "Main"), or a path with either as the first
# segment (e.g. "root/Button" or "Main/Button"). Bare paths ("Button") resolve
# normally via get_node_or_null.
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

# Helper to save a scene
func save_scene_to_path(scene_root: Node, save_path: String) -> bool:
	var full_path = normalize_scene_path(save_path)
	if full_path.is_empty():
		log_error("Path escapes the project root: " + save_path)
		return false

	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)

	if result != OK:
		log_error("Failed to pack scene: " + str(result))
		return false

	var save_error = ResourceSaver.save(packed_scene, full_path)
	if save_error != OK:
		log_error("Failed to save scene: " + str(save_error))
		return false

	return true

# Ensure the parent directory of a res:// path exists, creating it recursively
# if needed. Returns true on success or when the directory already exists.
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
	return dir.make_dir_recursive(relative_dir) == OK

# Create a new scene with a specified root node type
func create_scene(params):
	printerr("Creating scene: " + params.scene_path)

	var full_scene_path = normalize_scene_path(params.scene_path)
	if full_scene_path.is_empty():
		log_error("Path escapes the project root: " + params.scene_path)
		quit(1)
		return
	log_debug("Scene path: " + full_scene_path)

	var root_node_type = "Node2D"
	if params.has("root_node_type"):
		root_node_type = params.root_node_type
	log_debug("Root node type: " + root_node_type)

	var scene_root = instantiate_class(root_node_type)
	if not scene_root:
		log_error("Failed to instantiate node of type: " + root_node_type)
		quit(1)
		return

	scene_root.name = "root"
	scene_root.owner = scene_root

	if not _ensure_res_dir(full_scene_path):
		log_error("Failed to create directory for scene: " + full_scene_path)
		quit(1)
		return

	if save_scene_to_path(scene_root, full_scene_path):
		print(JSON.stringify({"success": true, "scenePath": params.scene_path}))
	else:
		log_error("Failed to create scene: " + params.scene_path)
		quit(1)
		return

# Spatial properties add_node accepts as top-level params instead of under
# `properties`. Mirrored by PROMOTED_SPATIAL_PARAMS in src/tools/scene-tools.ts,
# which merges them on the standalone path -- KEEP IN SYNC.
const _PROMOTED_SPATIAL_PARAMS: Array = ["position", "rotation", "scale", "visible", "modulate"]

# Scene-file suffixes accepted where a node type may name a scene to instance.
const _SCENE_SUFFIXES: Array = [".tscn", ".scn"]

# True when the value names a scene file rather than a Godot class.
func _is_scene_path(type_or_path: String) -> bool:
	var lowered = type_or_path.to_lower()
	for suffix in _SCENE_SUFFIXES:
		if lowered.ends_with(suffix):
			return true
	return false

# Instantiate a node for add_node: a registered Godot class, or an instance of
# an existing scene when node_type names a scene file. Instanced children pack
# back as `instance=ExtResource(...)` on save, so scenes can be composed
# without hand-editing .tscn files.
func _instantiate_node_type(type_or_path: String) -> Dictionary:
	if not _is_scene_path(type_or_path):
		var node = instantiate_class(type_or_path)
		if not node:
			return {"ok": false, "error": "Failed to instantiate node of type: " + type_or_path}
		return {"ok": true, "node": node}

	var scene_full_path = normalize_scene_path(type_or_path)
	if scene_full_path.is_empty():
		return {"ok": false, "error": "Scene path escapes the project root: " + type_or_path}
	if not FileAccess.file_exists(scene_full_path):
		return {"ok": false, "error": "Scene file does not exist: " + scene_full_path}
	var packed = load(scene_full_path)
	if packed == null or not (packed is PackedScene):
		return {"ok": false, "error": "Failed to load scene: " + scene_full_path}
	var instanced = packed.instantiate()
	if instanced == null:
		return {"ok": false, "error": "Failed to instantiate scene: " + scene_full_path}
	return {"ok": true, "node": instanced}

# Add a node to an existing scene
# Apply an add_node mutation without saving. Shared by standalone add_node
# and batch_scene_operations so both paths validate identically.
# Returns {"ok": bool, "error": String}; error is empty on success.
func _apply_add_node(scene_root: Node, op: Dictionary) -> Dictionary:
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
	var instantiated = _instantiate_node_type(op.node_type)
	if not instantiated.ok:
		return {"ok": false, "error": instantiated.error}
	var new_node = instantiated.node
	new_node.name = op.node_name
	# Promoted spatial params may arrive top-level instead of under `properties`
	# — the batch path forwards operations raw, so fold them in before applying
	# properties. `properties` wins on key conflicts (matching handleAddNode).
	var props = {}
	if op.has("properties"):
		props = op.properties.duplicate()
	for promoted in _PROMOTED_SPATIAL_PARAMS:
		if op.has(promoted) and not props.has(promoted):
			props[promoted] = op[promoted]
	for property in props:
		if not (property in new_node):
			var error_message = "Property '%s' does not exist on node of type '%s'" % [property, new_node.get_class()]
			new_node.free()
			return {"ok": false, "error": error_message}
		var prepared = _prepare_property_value(new_node, property, props[property])
		if not prepared.ok:
			new_node.free()
			return {"ok": false, "error": prepared.error}
		new_node.set(property, prepared.value)
	parent.add_child(new_node)
	new_node.owner = scene_root
	return {"ok": true, "error": ""}

# Apply a load_sprite mutation without saving. Shared by standalone load_sprite
# and batch_scene_operations.
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
	# First-time reference to an asset the scene-load probe never saw (e.g. a
	# texture just added to the project): check for the cold-import state
	# before load() runs, same as the scene-dependency probe above.
	if _classify_dep_path(full_texture_path) == "needs_import":
		log_error("[IMPORT_NEEDED] load_sprite " + op.node_path + ": " + full_texture_path)
		return {"ok": false, "error": "asset not yet imported: " + full_texture_path}
	var texture = load(full_texture_path)
	if not texture:
		return {"ok": false, "error": "Failed to load texture: " + full_texture_path}
	if not (texture is Texture2D):
		return {"ok": false, "error": "Loaded resource is not a Texture2D: " + full_texture_path}
	# A texture without a resource_path is a runtime-only object — PackedScene.pack()
	# cannot serialize it, so the assignment would silently vanish on save.
	if texture.resource_path == "":
		return {"ok": false, "error": "Texture was imported but has no resource_path - the import likely failed for this asset. Check stderr for the import error."}
	sprite_node.texture = texture
	return {"ok": true, "error": ""}

func add_node(params):
	printerr("Adding node to scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var result = _apply_add_node(scene_root, params)
	if not result.ok:
		log_error(result.error)
		quit(1)
		return

	if save_scene_to_path(scene_root, params.scene_path):
		print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
	else:
		log_error("Failed to save scene after adding node")
		quit(1)
		return

# Load a sprite into a Sprite2D node
func load_sprite(params):
	printerr("Loading sprite into scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var result = _apply_load_sprite(scene_root, params)
	if not result.ok:
		log_error(result.error)
		quit(1)
		return

	if save_scene_to_path(scene_root, params.scene_path):
		print("Sprite loaded successfully with texture: " + params.texture_path)
	else:
		log_error("Failed to save scene after loading sprite")
		quit(1)
		return

# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
	printerr("Exporting MeshLibrary from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
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
			quit(1)
			return

		if not _ensure_res_dir(full_output_path):
			log_error("Failed to create directory for MeshLibrary: " + full_output_path)
			quit(1)
			return

		var error = ResourceSaver.save(mesh_library, full_output_path)
		if error == OK:
			print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + params.output_path)
		else:
			log_error("Failed to save MeshLibrary: " + str(error))
			quit(1)
			return
	else:
		log_error("No valid meshes found in the scene")
		quit(1)
		return

# Save changes to a scene file
func save_scene(params):
	printerr("Saving scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var save_path = params.new_path if params.has("new_path") else params.scene_path

	if save_scene_to_path(scene_root, save_path):
		print("Scene saved successfully to: " + save_path)
	else:
		log_error("Failed to save scene")
		quit(1)
		return

# ============================================
# NODE OPERATIONS
# ============================================

# Delete one or more nodes from a scene (saves once)
func delete_nodes(params):
	printerr("Deleting nodes from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var node_paths: Array = params.node_paths
	var results: Array = []
	var any_deleted := false

	for node_path in node_paths:
		var entry = {"nodePath": node_path}
		var node = find_node_by_path(scene_root, node_path)
		if not node:
			entry["error"] = "Node not found: " + node_path
		elif node == scene_root:
			entry["error"] = "Cannot delete the root node"
		else:
			var parent = node.get_parent()
			parent.remove_child(node)
			node.queue_free()
			entry["success"] = true
			any_deleted = true
		results.append(entry)

	if any_deleted:
		if not save_scene_to_path(scene_root, params.scene_path):
			print(JSON.stringify({"error": "Failed to save scene after deleting nodes", "results": results}))
			return

	print(JSON.stringify({"results": results}))

# Make a property override on `target` (a node inside an instanced child)
# survive PackedScene.pack(). Nodes inside an instanced scene are not owned
# by the scene root, so pack() silently drops overrides set on them — the
# operation reports success while the change is lost (data loss).
# The fix is the same "editable children" mechanism the Godot editor uses:
# mark each instanced ancestor editable FROM THE SCENE ROOT —
# scene_root.set_editable_instance(instanced_child, true). Note the receiver
# is the ancestor (the scene root) and the argument is the instanced child.
# The target's owner must NOT be reassigned to scene_root: pack() would then
# serialize a second, shadowing node ([node name="Inner" type=... parent="A"])
# instead of an override, duplicating the node on reload and losing the
# override entirely on a second write.
func _claim_for_serialization(scene_root: Node, target: Node) -> void:
	var cur := target.get_parent()
	while cur != null and cur != scene_root:
		if cur.get_scene_file_path() != "":
			scene_root.set_editable_instance(cur, true)
		cur = cur.get_parent()

# Update one or more node properties in a single headless process (saves once)
# Apply one property-update list to a loaded scene without saving. Shared by
# standalone set_node_properties and batch_scene_operations so both paths
# validate identically (including instanced-child serialization claiming).
# Returns {"ok": bool, "any_set": bool, "error": String, "results": Array}.
func _apply_updates(scene_root: Node, updates: Array, abort_on_error: bool) -> Dictionary:
	var results: Array = []
	var any_set := false

	for update in updates:
		var result = {"nodePath": update.node_path, "property": update.property}
		var node = find_node_by_path(scene_root, update.node_path)
		if node == null:
			result["error"] = "Node not found: " + update.node_path
		elif not (update.property in node):
			result["error"] = "Property '%s' does not exist on node of type '%s'" % [update.property, node.get_class()]
		else:
			var prepared = _prepare_property_value(node, update.property, update.value)
			if not prepared.ok:
				result["error"] = prepared.error
			else:
				_claim_for_serialization(scene_root, node)
				node.set(update.property, prepared.value)
				result["success"] = true
				any_set = true
		results.append(result)
		if abort_on_error and result.has("error"):
			break

	return {"ok": true, "any_set": any_set, "error": "", "results": results}

func set_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		print(JSON.stringify({"error": "Failed to load scene: " + params.scene_path, "results": []}))
		return

	var applied = _apply_updates(scene_root, params.updates, params.get("abort_on_error", false))
	if applied.any_set:
		if not save_scene_to_path(scene_root, params.scene_path):
			print(JSON.stringify({"error": "Failed to save scene after updates", "results": applied.results}))
			return

	print(JSON.stringify({"results": applied.results}))

# Get properties from one or more nodes in a single headless process (loads scene once)
func get_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		print(JSON.stringify({"error": "Failed to load scene: " + params.scene_path, "results": []}))
		return

	var results: Array = []
	# Class-name → default-instance cache. Reused across all nodes in this call
	# so we don't instantiate a fresh default per node when changed_only is true.
	var defaults_cache: Dictionary = {}

	for node_spec in params.nodes:
		var node_path = node_spec.get("node_path", "")
		var changed_only = node_spec.get("changed_only", false)
		var node = find_node_by_path(scene_root, node_path)
		if node == null:
			results.append({"nodePath": node_path, "error": "Node not found"})
		else:
			var props = _collect_node_properties(node, changed_only, defaults_cache)
			results.append({"nodePath": node_path, "nodeType": node.get_class(), "properties": props})

	# Free cached default instances; they were created via instantiate_class.
	for klass in defaults_cache:
		var inst = defaults_cache[klass]
		if inst:
			inst.free()

	print(JSON.stringify({"results": results}))

# Get full hierarchical tree structure of a scene
func get_scene_tree(params):
	printerr("Getting scene tree for: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var tree_root = scene_root
	if params.has("parent_path") and params.parent_path:
		tree_root = find_node_by_path(scene_root, params.parent_path)
		if not tree_root:
			log_error("Parent node not found: " + str(params.parent_path))
			quit(1)
			return

	var max_depth = -1
	if params.has("max_depth"):
		max_depth = int(params.max_depth)

	var tree = build_tree_recursive(tree_root, "", 0, max_depth)
	print(JSON.stringify(tree))

func build_tree_recursive(node: Node, path: String, depth: int = 0, max_depth: int = -1) -> Dictionary:
	var node_path = path + "/" + node.name if not path.is_empty() else node.name

	var children = []
	if max_depth < 0 or depth < max_depth:
		for child in node.get_children():
			children.append(build_tree_recursive(child, node_path, depth + 1, max_depth))

	var script_path = ""
	var script = node.get_script()
	if script and script.resource_path:
		script_path = script.resource_path

	return {
		"name": node.name,
		"type": node.get_class(),
		"path": node_path,
		"script": script_path,
		"children": children
	}

# Attach or change a script on a node
func attach_script(params):
	printerr("Attaching script to node in scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)
		return

	var full_script_path = normalize_scene_path(params.script_path)
	if full_script_path.is_empty():
		log_error("Path escapes the project root: " + params.script_path)
		quit(1)
		return

	if not FileAccess.file_exists(full_script_path):
		log_error("Script file does not exist: " + full_script_path)
		quit(1)
		return

	var script = load(full_script_path)
	if not script:
		log_error("Failed to load script: " + full_script_path)
		quit(1)
		return

	node.set_script(script)

	if save_scene_to_path(scene_root, params.scene_path):
		print(JSON.stringify({
			"success": true,
			"nodePath": params.node_path,
			"scriptPath": params.script_path
		}))
	else:
		log_error("Failed to save scene after attaching script")
		quit(1)
		return

# ============================================
# SIGNAL AND DUPLICATE OPERATIONS
# ============================================

# Duplicate a node and its children within a scene
func duplicate_node(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)
		return
	if node == scene_root:
		log_error("Cannot duplicate the root node")
		quit(1)
		return

	var duplicate = node.duplicate()
	if params.has("new_name"):
		duplicate.name = params.new_name
	else:
		duplicate.name = node.name + "2"

	var parent = node.get_parent()
	if params.has("target_parent_path"):
		parent = find_node_by_path(scene_root, params.target_parent_path)
		if not parent:
			log_error("Target parent not found: " + params.target_parent_path)
			quit(1)
			return

	parent.add_child(duplicate)
	duplicate.owner = scene_root
	# Iterative BFS to set owner on all descendants — avoids recursion depth.
	var queue: Array = duplicate.get_children()
	while not queue.is_empty():
		var current = queue.pop_front()
		current.owner = scene_root
		queue.append_array(current.get_children())

	# Compute the new node's scene-relative path: parent path + "/" + duplicate.name.
	# The scene tree isn't attached in headless mode so get_path() is unreliable;
	# derive parent path from the input node_path (or target_parent_path).
	var parent_relative_path: String
	if params.has("target_parent_path"):
		parent_relative_path = params.target_parent_path
	else:
		var last_slash = params.node_path.rfind("/")
		parent_relative_path = params.node_path.substr(0, last_slash) if last_slash > 0 else ""
	var new_path: String
	if parent_relative_path == "":
		new_path = String(duplicate.name)
	else:
		new_path = parent_relative_path + "/" + String(duplicate.name)

	if save_scene_to_path(scene_root, params.scene_path):
		print(JSON.stringify({
			"success": true,
			"originalPath": params.node_path,
			"newPath": new_path
		}))
	else:
		log_error("Failed to save scene after duplicating node")
		quit(1)
		return

# List signals defined on a node and their current connections
func get_node_signals(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)
		return

	var signals = []
	for sig in node.get_signal_list():
		var sig_name = sig["name"]
		var connections = []
		for conn in node.get_signal_connection_list(sig_name):
			var target_object = conn["callable"].get_object()
			# get_object().get_path() returns "" for any node instantiated outside
			# the live SceneTree, which headless scenes always are - that made
			# every connection target empty, not just self-connections. Report the
			# target relative to scene_root in the same "root/..." form
			# connect_signal / disconnect_signal accept as targetNodePath, so a
			# reported connection round-trips without the caller rewriting it.
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

	print(JSON.stringify({
		"nodePath": params.node_path,
		"nodeType": node.get_class(),
		"signals": signals
	}))

# Verify signal wiring across a scene (or a single node subtree) by checking
# four things per connection: the target node is reachable from the scene
# root, the handler method exists on the target, the method follows the
# _on_<node>_<signal> naming convention, and no handler-looking method
# (_on_*) on any node lacks a matching connection (orphaned handlers).

# Check every live connection reachable from scope_node. Target paths are
# resolved against the scene root so they appear in the same "root/..." form
# get_node_signals reports and connect_signal accepts.
func _collect_connection_issues(scope: Node, scene_root: Node, issues: Array) -> void:
	# walk the subtree rooted at scope (includes scope itself)
	for node in _iter_subtree(scope):
		var node_rel = _relative_path(scene_root, node)
		for sig in node.get_signal_list():
			var sig_name = sig["name"]
			for conn in node.get_signal_connection_list(sig_name):
				var callable: Callable = conn["callable"]
				var target_object = callable.get_object()
				var method = String(callable.get_method())
				# CONNECT_PERSIST marks a connection authored in the scene file:
				# PackedScene restores every [connection] line with it, and
				# connect_signal sets it for the same reason (see the note at its
				# own connect() call). A connection the engine makes for itself
				# while instantiating carries no such flag. That flag is the only
				# reliable way to tell "someone wrote this and could have got it
				# wrong" from "the engine wired its own internals", so a missing
				# handler is only a user mistake on a persisted connection.
				var is_persisted := (int(conn.get("flags", 0)) & CONNECT_PERSIST) != 0

				# Resolve the target path through _relative_path, which checks
				# is_ancestor_of before calling get_path_to: calling it on a
				# node outside the tree prints a Godot error to stderr, on
				# exactly the target_not_in_scene case reported just below.
				var target_rel := ""
				if target_object is Node:
					target_rel = _relative_path(scene_root, target_object)

				# Issue 1: connection target is not a node reachable from this scene
				if target_rel.is_empty():
					issues.append({
						"node": node_rel,
						"signal": sig_name,
						"target": "unknown",
						"method": method,
						"problem": "target_not_in_scene"
					})
					continue

				# Issue 2: handler method does not exist on the target node
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

				# Issue 3 (warning-level): handler does not follow _on_<node>_<signal> naming
				if not method.begins_with("_on_"):
					issues.append({
						"node": node_rel,
						"signal": sig_name,
						"target": target_rel,
						"method": method,
						"problem": "naming_convention"
					})

# Handlers on nodes within scope that begin with _on_ but have no connection
# pointing at them: signatures wired in code but never connected, or leftover
# after a disconnect. These are silent at runtime.
func _collect_orphaned_handlers(scope: Node, scene_root: Node, issues: Array) -> void:
	# index every connection target (node path) reachable in the whole
	# scene so a handler connected to a sibling outside the scope is not
	# falsely reported. Use (node_path, method) tuples as keys because Object identity
	# in dictionaries doesn't match across iterations.
	var wired_pairs := {}  # keyed by "node_path::method"
	for node in _iter_subtree(scene_root):
		for sig in node.get_signal_list():
			var sig_name = sig["name"]
			for conn in node.get_signal_connection_list(sig_name):
				var callable: Callable = conn["callable"]
				var target_object = callable.get_object()
				if target_object is Node:
					# Skip engine-internal connections (their method is not
					# user script): they do not make a user handler wired.
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

# Every node in the subtree rooted at `root`, root first, breadth-first.
# Order only affects the sequence issues are reported in.
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

# A connection is engine-internal when its method resolves to no script
# handler: engine code connects private slots (e.g. Label::_maximum_size_changed)
# that are not visible to user scripts.
#
# Two callers, and the "::" branch below matters to the second one. The
# method_missing_on_target check consults this only for persisted connections,
# whose method name always comes from a [connection] line and is therefore
# bare. Orphaned-handler detection consults it for every connection in the
# scene, runtime ones included, to keep an internal connection from marking a
# node as "wired" - that is where the prefixed form actually turns up.
func _is_engine_internal_connection(target_object: Object, method: String) -> bool:
	# A "Class::method" name (e.g. Label::_maximum_size_changed) is an engine
	# callable bound to a private C++ slot. User connections, whether made in
	# the editor, in a .tscn [connection] line, or through connect_signal,
	# always report a bare method name, so the prefix alone settles it. This is
	# the only place in the file that knows about the "::" form.
	if method.contains("::"):
		return true
	if _is_user_script_method(target_object, method):
		return false
	if target_object.has_method(method):
		return true
	return _is_engine_builtin_declared(target_object, method)

# True when method is declared by the attached script (vs inherited engine class).
func _is_user_script_method(target_object: Object, method: String) -> bool:
	var script = target_object.get_script()
	if script == null:
		return false
	for m in script.get_script_method_list():
		if String(m["name"]) == method:
			return true
	return false

# True when a method that has_method() reported false is still a real method
# of the target's engine class: ClassDB knows the whole declared surface,
# including private slots and virtuals a headless instance does not expose.
#
# Nothing else earns a pass. A "_" prefix alone does not, which was the hole
# that hid every typo in a private handler (_hanlde_press on a target that
# does not define it), and neither does the absence of a script on the target:
# a handler that exists in no script and in no engine class exists nowhere, so
# the connection is broken whoever owns the node. Runtime connections made by
# the engine are excluded by their caller instead, on CONNECT_PERSIST.
func _is_engine_builtin_declared(target_object: Object, method: String) -> bool:
	# A lambda Callable reports no method name, and an unnamed callable is not
	# a missing handler.
	if method.is_empty():
		return true
	var cls := target_object.get_class()
	return ClassDB.class_exists(cls) and ClassDB.class_has_method(cls, method, false)

# Handler method names declared by a node's attached script, via
# get_script_method_list(): that covers the script's own methods plus those of
# any GDScript it extends, and no engine-class methods. Only _on_* names are
# kept, which is all orphaned-handler detection looks at.
func _get_script_user_defined_methods(node: Node) -> Array:
	var script = node.get_script()
	if script == null:
		return []

	var methods := []
	for m in script.get_script_method_list():
		var method_name = String(m["name"])
		# Only keep _on_* methods (signal handlers) - these are always user-defined
		# and are exactly what we need for orphaned-handler detection.
		if method_name.begins_with("_on_"):
			methods.append(method_name)

	return methods

# Connect a signal from one node to a method on another node
func connect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		quit(1)
		return

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		quit(1)
		return

	if not source.has_signal(params.signal):
		log_error("Signal does not exist: " + params.signal + " on " + source.get_class())
		quit(1)
		return

	if not target.has_method(params.method):
		log_error("Method does not exist: " + params.method + " on " + target.get_class())
		quit(1)
		return

	# CONNECT_PERSIST is required for the connection to be serialized into the
	# packed scene; without it the connection is runtime-only and disappears on save.
	var err = source.connect(params.signal, Callable(target, params.method), CONNECT_PERSIST)
	if err != OK:
		log_error("Failed to connect signal: " + str(err))
		quit(1)
		return

	if save_scene_to_path(scene_root, params.scene_path):
		print("Signal '" + params.signal + "' connected from '" + params.node_path + "' to '" + params.target_node_path + "." + params.method + "'")
	else:
		log_error("Failed to save scene after connecting signal")
		quit(1)
		return

# Disconnect a signal connection between two nodes
func disconnect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)
		return

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		quit(1)
		return

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		quit(1)
		return

	if not source.is_connected(params.signal, Callable(target, params.method)):
		log_error("Signal connection does not exist")
		quit(1)
		return

	source.disconnect(params.signal, Callable(target, params.method))

	if save_scene_to_path(scene_root, params.scene_path):
		print("Signal '" + params.signal + "' disconnected from '" + params.target_node_path + "." + params.method + "'")
	else:
		log_error("Failed to save scene after disconnecting signal")
		quit(1)
		return

# ============================================
# VALIDATE OPERATION
# ============================================

# Validate a GDScript or scene file by loading it headlessly
func validate_resource(params):
	if not (params.has("script_path") or params.has("scene_path")):
		log_error("validate_resource requires script_path or scene_path")
		quit(1)
		return
	var result = _validate_single(params)
	print(JSON.stringify({"valid": result.valid, "errors": result.errors}))

# Validate a scene file against a structural schema. Schema: { type?: string, children?: Schema[], hasProperty?: string }.
# Returns { valid, missingNodes: [{ path, expected }], missingProperties: [{ path, property }], errors: string[] }.

# Unified entry point for the validate tool's checks[] array. Runs structural
# and signal-verification checks against one scene in a single Godot process,
# emitting a { valid, errors: [{ check, message, ... }] } payload compatible
# with the validate tool's output shape. Reuses the same collection helpers
# as the standalone checks: _validate_schema_node for structure,
# _collect_connection_issues / _collect_orphaned_handlers for signals.
func validate_checks(params):
	var outcome = _run_scene_checks(str(params.scene_path), params.checks if params.has("checks") else [])
	if not outcome.ok:
		log_error(outcome.error)
		quit(1)
		return
	print(JSON.stringify({"valid": outcome.errors.is_empty(), "errors": outcome.errors}))

# Runs the checks[] array against one scene and returns
# {"ok": bool, "error": String, "errors": Array}. ok=false means the scene
# itself could not be loaded (path rejected, file missing, or a dependency
# that was never imported); "error" then carries the reason and "errors" is
# empty. load_scene_instance has already written its own diagnosis to stderr,
# including the [IMPORT_NEEDED] marker the TS layer reacts to.
#
# Never quits: validate_batch runs this once per target and needs per-target
# isolation, so a bad target must not take the whole process down with it.
# Freeing the instance here (rather than at the call sites) is what keeps a
# batch of N scenes from holding N live trees at once.
func _run_scene_checks(scene_path: String, checks) -> Dictionary:
	var scene_root = load_scene_instance(scene_path)
	if not scene_root:
		return {"ok": false, "error": "Scene checks skipped: could not load scene " + scene_path, "errors": []}
	var errors := _collect_check_errors(scene_root, checks)
	scene_root.free()
	return {"ok": true, "error": "", "errors": errors}

# Runs every entry of the checks[] array against an already-instantiated scene
# and returns the collected error dictionaries. Does not free scene_root: the
# caller owns that instance. A non-Array checks value collects nothing.
#
# Every entry is hedged rather than trusted: batch sub-operations reach this
# function without passing through the Node-side check validators, so a
# malformed entry must be reported, not crash the process.
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
				# An unmatched child is a finding about the parent named in
				# path, so it reads as "no child of type X under <parent>".
				var mn_message = "Expected node of type %s at %s" % [mn_expected, mn_path]
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
	# A malformed entry is reported, not fatal: the recursion below and the
	# batch path both reach this function with values that never passed through
	# the Node-side validators. issues entries are stringified by the caller.
	if not (schema is Dictionary):
		issues.append("Invalid schema entry: expected an object, got " + type_string(typeof(schema)))
		return

	# Check type if specified
	if schema.has("type"):
		var expected_type = str(schema.type)
		if node.get_class() != expected_type:
			missing_nodes.append({
				"path": _relative_path(scene_root, node),
				"expected": expected_type
			})

	# Check hasProperty if specified
	if schema.has("has_property"):
		var prop_name = str(schema.has_property)
		if not _node_has_property_set(node, prop_name):
			missing_properties.append({
				"path": _relative_path(scene_root, node),
				"property": prop_name
			})

	# Recurse into children if children schema provided
	if schema.has("children"):
		var children_schema = schema.children
		if typeof(children_schema) == TYPE_ARRAY:
			# Track consumed children so two schema entries of the same type
			# match two distinct nodes instead of the first one twice.
			var available := node.get_children().duplicate()
			for child_schema in children_schema:
				var found = _find_child_matching(available, child_schema)
				if found:
					available.erase(found)
					_validate_schema_node(found, scene_root, child_schema, missing_nodes, missing_properties, issues)
				else:
					# The finding is about the parent: it has no child of the
					# declared type. path and expected therefore both describe
					# the same relationship, which is what the message says.
					var expected_type = str(child_schema.get("type", "?")) if child_schema is Dictionary else "?"
					missing_nodes.append({
						"path": _relative_path(scene_root, node),
						"expected": expected_type,
						"unmatched_child": true
					})

# Find the first unconsumed child that satisfies child_schema's declared
# type (any child if type is not declared). Returns null when none matches.
func _find_child_matching(available: Array, child_schema) -> Node:
	var expected_type = str(child_schema.get("type", "")) if child_schema is Dictionary else ""
	for child in available:
		if expected_type.is_empty() or child.get_class() == expected_type:
			return child
	return null

func _node_has_property_set(node: Node, prop_name: String) -> bool:
	# `in` guards against Godot printing "Invalid get index" errors to
	# stderr for properties the node type does not declare.
	if not (prop_name in node):
		return false
	var val = node.get(prop_name)
	if val == null:
		return false
	if typeof(val) == TYPE_STRING and str(val).is_empty():
		return false
	return true


# ============================================
# BATCH OPERATIONS
# ============================================

# Helper: coerce a JSON-parsed value to a GDScript type (Vector2, Vector3, Color)
func _coerce_property_value(value):
	if typeof(value) == TYPE_DICTIONARY:
		if value.has("x") and value.has("y"):
			if value.has("z"):
				return Vector3(value.x, value.y, value.z)
			else:
				return Vector2(value.x, value.y)
		elif value.has("r") and value.has("g") and value.has("b"):
			var a = value.a if value.has("a") else 1.0
			return Color(value.r, value.g, value.b, a)
	return value

# Helper: element-wise coercion for packed-array properties. Called from
# _prepare_property_value when the declared type is a Packed*Array and the
# raw JSON value is a non-empty plain Array. Each element is coerced through
# _coerce_property_value -- turning {"x": 1, "y": 2} into Vector2(1, 2),
# {"r": .., "g": .., "b": ..} into Color, etc. -- and any element that is
# not already, and cannot be coerced into, the packed element type makes
# the whole assignment fail loudly (node.set() would otherwise silently
# store the zero value for every element while reporting success).
# Element rules mirror what Godot's typed setters accept without zeroing
# (e.g. ints for float arrays, Vector2i for Vector2 arrays); a bool or a
# string on a Vector2 element, for example, is rejected up front.
# The accepted set comes from _PACKED_ARRAY_ELEMENT_TYPE plus
# _ELEMENT_TYPE_COMPAT rather than a local match, so the packed-type list
# exists in exactly one place. A declared type or element type missing from
# those tables fails CLOSED: accepting it unconditionally is what would
# reinstate the silent zero-write for a packed type nobody wrote a rule for.
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
		out.append(element)
	return {"ok": true, "value": out, "error": ""}

# Helper: find a property's full descriptor from get_property_list(), or null
# if the node has no property by that name. Callers that only need the
# Variant type should use _declared_property_type instead.
func _find_property_descriptor(node: Object, property: String):
	for p in node.get_property_list():
		if p.name == property:
			return p
	return null

# Helper: declared Variant type of a property, from the node's property list.
# Returns TYPE_NIL when the property is not found.
func _declared_property_type(node: Object, property: String) -> int:
	var descriptor = _find_property_descriptor(node, property)
	if descriptor == null:
		return TYPE_NIL
	return descriptor.type

# Declared-type compatibility table for _prepare_property_value. Keyed by the
# declared Variant type (TYPE_* from get_property_list()), valued by the set
# of raw-value Variant types accepted for that declared type. A declared type
# with no entry here falls back to the default rule: typeof(coerced) == D
# (exact match). TYPE_NIL (untyped Variant, or a property missing from the
# node's property list) is handled before this table is consulted -- it
# always accepts anything.
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

# Packed-array declared type -> the Variant type of one element. Membership in
# this table is also the gate in _prepare_property_value: a declared type absent
# from it skips element validation entirely.
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

# Element Variant type -> raw element Variant types accepted for it. Mirrors the
# scalar rows of _PROPERTY_TYPE_COMPAT above; kept as its own table so scalar
# compat widening and element widening stay independently editable, and so the
# typed-Array[T] path can share it. An element type reached from the packed path
# that is absent from this table is an internal inconsistency and is REJECTED,
# never accepted.
const _ELEMENT_TYPE_COMPAT: Dictionary = {
	TYPE_INT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_FLOAT: [TYPE_INT, TYPE_FLOAT, TYPE_BOOL],
	TYPE_STRING: [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH],
	TYPE_VECTOR2: [TYPE_VECTOR2, TYPE_VECTOR2I],
	TYPE_VECTOR3: [TYPE_VECTOR3, TYPE_VECTOR3I],
	TYPE_VECTOR4: [TYPE_VECTOR4, TYPE_VECTOR4I],
	TYPE_COLOR: [TYPE_COLOR],
}

# Helper: enforce a property's PROPERTY_HINT_RESOURCE_TYPE class filter
# against a Resource about to be assigned. Shared by the res:// load path and
# the inline-construction path so both reject a wrong-class resource
# identically. `origin` names how the resource was obtained ("Loaded" /
# "Constructed") and only shapes the error message. A property with no
# resource-type hint always passes. Returns {"ok": bool, "error": String}.
func _check_resource_hint_class(descriptor, res, property: String, origin: String) -> Dictionary:
	if descriptor == null or descriptor.get("hint") != PROPERTY_HINT_RESOURCE_TYPE or descriptor.get("hint_string", "") == "":
		return {"ok": true, "error": ""}
	for allowed_class in descriptor.hint_string.split(","):
		if ClassDB.is_parent_class(res.get_class(), allowed_class) or res.is_class(allowed_class):
			return {"ok": true, "error": ""}
	return {"ok": false, "error": "%s resource is a %s, but property '%s' expects %s" % [origin, res.get_class(), property, descriptor.hint_string]}

# Construct a Resource inline from a typed-dict spec like
# {"type": "RectangleShape2D", "size": {"x": 80, "y": 16}}. Inner properties
# are assigned through the same validated _prepare_property_value machinery
# (type-compat matrix, nested Resources, res:// loads), so the v3.2.4 error
# contract applies at every level, and the property-hint class check is the
# same one the res:// path uses.
#
# Class eligibility is settled entirely against ClassDB before instantiate()
# runs, so a rejected spec allocates nothing. That ordering is load-bearing:
# a constructed Resource is RefCounted and cannot be free()d from GDScript,
# while a non-Resource class (Node and friends) is manually managed and would
# leak for the life of the process -- neither is safe to drop after the fact.
# Returns {"ok": bool, "value": Resource|null, "error": String}.
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

	# Assign 'shader' (or any plain inner property) before slash-suffixed
	# keys: virtual properties -- most importantly ShaderMaterial's
	# shader_parameter/<uniform> keys, the primary way shader uniforms are
	# set -- only come into existence on the instance once the resource
	# they depend on is assigned. JSON preserves dict iteration order, so
	# a pre-pass extracts every plain (non-virtual) property first; without
	# it, {"shader": ..., "shader_parameter/x": ...} would hit the
	# existence gate below and fail even though set() works fine.
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

	# Recursively assign inner properties with full validation.
	for inner_prop in ordered_keys:
		# Existence gate. The `in` operator is not sufficient for virtual
		# properties: it misses shader_parameter/<uniform> keys even after
		# the shader is assigned (and only starts returning true after an
		# unrelated set() call refreshes its cache), so a slash-suffixed
		# key is also accepted when it is listed in the instance's live
		# property list -- which is where its declared type lives, so the
		# normal validation below applies unchanged. set() alone must not
		# be used as the gate: it accepts unknown names silently.
		var exists: bool = inner_prop in instance
		if not exists and "/" in String(inner_prop):
			exists = _find_property_descriptor(instance, String(inner_prop)) != null
		if not exists:
			if "/" in String(inner_prop):
				return {"ok": false, "value": null, "error": "Property '%s' does not resolve on resource of type '%s' (constructed for property '%s') -- for shader_parameter/<name>, the shader must be assigned first and <name> must be a uniform it declares" % [inner_prop, class_name_str, property]}
			return {"ok": false, "value": null, "error": "Property '%s' does not exist on resource of type '%s' (constructed for property '%s')" % [inner_prop, class_name_str, property]}
		var prepared = _prepare_property_value(instance, inner_prop, spec[inner_prop])
		if not prepared.ok:
			return {"ok": false, "value": null, "error": "Cannot set inner property '%s' on %s constructed for property '%s': %s" % [inner_prop, class_name_str, property, prepared.error]}
		instance.set(inner_prop, prepared.value)

	return {"ok": true, "value": instance, "error": ""}

# Element Variant type of a typed Array property, or TYPE_NIL when it cannot be
# determined or the array is untyped. Primary signal is the live value's own
# Array.get_typed_builtin(); the property descriptor's PROPERTY_HINT_ARRAY_TYPE
# hint_string is a fallback for the case where the current value is not a typed
# Array (e.g. a null default). Only the leading integer of hint_string is read:
# the composite forms ("24/17:Texture2D", "28:2:") therefore resolve to
# TYPE_OBJECT / TYPE_ARRAY, which are both absent from _ELEMENT_TYPE_COMPAT and
# so pass through unvalidated rather than being guessed at.
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

# Helper: element-wise coercion for a script-declared typed Array[T] property.
# Same contract as _prepare_packed_array_elements, but the expected element type
# is passed in (recovered by _typed_array_element_type) instead of derived from
# the declared container type, and the caller has already confirmed the element
# type has a rule. The result is a TYPED Array, built with the typed-Array
# constructor: node.set() on an Array[T] property does NOT convert an untyped
# Array element by element, it refuses the assignment and leaves an empty typed
# array behind while only printing an engine error, so coercing the elements is
# not by itself enough. The constructor converts each element the same way a
# typed assign would, which is why the conversion is verified by size below
# instead of by reading the property back after set().
func _prepare_typed_array_elements(property: String, node_class: String, elem_type: int, arr: Array) -> Dictionary:
	var accepted: Array = _ELEMENT_TYPE_COMPAT[elem_type]
	var out: Array = []
	for i in range(arr.size()):
		var element = _coerce_property_value(arr[i])
		if not (typeof(element) in accepted):
			return {
				"ok": false,
				"value": null,
				"error": "Cannot set property '%s' on node of type '%s': element %d of the array (%s) cannot be coerced to the element type %s" % [
					property, node_class, i, str(element), type_string(elem_type)],
			}
		out.append(element)
	# Builtin element type, so no class name and no script: Array[Node] and
	# friends never reach here, since their element types have no
	# _ELEMENT_TYPE_COMPAT row and pass through unwrapped.
	var typed: Array = Array(out, elem_type, &"", null)
	if typed.size() != out.size():
		return {
			"ok": false,
			"value": null,
			"error": "Cannot set property '%s' on node of type '%s': the array could not be converted to a typed array of %s" % [
				property, node_class, type_string(elem_type)],
		}
	return {"ok": true, "value": typed, "error": ""}

# Helper: coerce and validate a raw JSON value against a node's declared
# property type before it is assigned via node.set(). Returns
# {"ok": bool, "value": Variant, "error": String}.
#
# node.set() casts the incoming value through the property's typed setter
# with no validity return -- a type-incompatible value doesn't fail, it
# silently stores the ZERO value for the declared type (e.g. a String on an
# int property stores 0, a String on a Vector2 property stores (0, 0)).
# This function catches that class of bug up front by checking the value's
# type against the property's declared type (via get_property_list()) before
# node.set() ever runs.
#
# Three branches get special handling instead of the generic type check:
#   - Object-typed properties (Resource or Node): a plain value is rejected
#     outright, except a res:// string, which is auto-loaded (mirroring
#     _apply_load_sprite).
#   - Object-typed properties given a dict carrying a String "type" key: the
#     Resource is constructed inline via _construct_inline_resource, whose
#     inner assignments recurse back through this function.
#   - Dictionary-typed properties: coercion is skipped so a dict with an x/y
#     or r/g/b key can still be stored as a plain Dictionary instead of being
#     turned into a Vector2/Vector3/Color.
# Every other declared type is checked against _PROPERTY_TYPE_COMPAT, which
# allows the legitimate widening conversions Godot performs on store
# (float->int, String->NodePath/StringName, bool<->int/float,
# Vector2<->Vector2i, Vector3<->Vector3i, Array->Packed*Array) while
# rejecting everything else. TYPE_NIL (untyped Variant, or a property not in
# the node's property list) accepts anything. null is always passed through
# untouched -- it is the legitimate way to clear a resource.
func _prepare_property_value(node: Object, property: String, raw_value) -> Dictionary:
	var declared = _declared_property_type(node, property)
	var coerced = raw_value if declared == TYPE_DICTIONARY else _coerce_property_value(raw_value)
	if coerced == null:
		return {"ok": true, "value": coerced, "error": ""}

	# Element-wise coercion for packed-array properties. JSON sends a
	# PackedVector2Array (etc.) as a plain Array whose elements are still
	# raw dicts/strings; node.set()'s typed setter silently casts each
	# element to the zero value instead of failing. Coerce each element
	# individually via _coerce_property_value and fail loudly on any
	# element that cannot be represented.
	if _PACKED_ARRAY_ELEMENT_TYPE.has(declared) and typeof(coerced) == TYPE_ARRAY and coerced.size() > 0:
		var element_prep = _prepare_packed_array_elements(property, node.get_class(), declared, coerced)
		if not element_prep.ok:
			return {"ok": false, "value": null, "error": element_prep.error}
		coerced = element_prep.value

	# Same element pass for a script-declared typed Array[T]. Its declared type
	# is plain TYPE_ARRAY, so the element type has to be recovered from the value
	# or the descriptor. Deliberately asymmetric with the packed path above: an
	# element type with no rule here passes through unvalidated instead of being
	# rejected, because the key space is every Variant type plus every class in
	# the project, so a miss is normal rather than a bug in our own table. Godot
	# still refuses those assignments loudly instead of zero-filling them.
	if declared == TYPE_ARRAY and typeof(coerced) == TYPE_ARRAY and coerced.size() > 0:
		var elem_type := _typed_array_element_type(node, property)
		if _ELEMENT_TYPE_COMPAT.has(elem_type):
			var typed_prep = _prepare_typed_array_elements(property, node.get_class(), elem_type, coerced)
			if not typed_prep.ok:
				return {"ok": false, "value": null, "error": typed_prep.error}
			coerced = typed_prep.value

	if declared == TYPE_OBJECT and typeof(coerced) != TYPE_OBJECT:
		if typeof(coerced) == TYPE_STRING and coerced.begins_with("res://"):
			# First-time reference to an asset the scene-load probe never saw
			# (e.g. a res:// string assigned to an Object-typed property).
			# Check for the cold-import state before load() runs.
			if _classify_dep_path(coerced) == "needs_import":
				log_error("[IMPORT_NEEDED] property " + property + ": " + coerced)
				return {"ok": false, "value": null, "error": "asset not yet imported: " + coerced}
			var res = load(coerced)
			if not res:
				return {"ok": false, "value": null, "error": "Failed to load resource: " + coerced}
			if res.resource_path == "":
				return {"ok": false, "value": null, "error": "Resource was imported but has no resource_path - the import likely failed for this asset. Check stderr for the import error."}
			var hint_check = _check_resource_hint_class(_find_property_descriptor(node, property), res, property, "Loaded")
			if not hint_check.ok:
				return {"ok": false, "value": null, "error": hint_check.error}
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

	return {"ok": true, "value": coerced, "error": ""}

# Helper: collect node properties into a serializable Dictionary. When
# changed_only is true, compares each property against a default instance of
# the node's class. The defaults_cache dict is keyed by class name so the
# caller can reuse default instances across many nodes (caller is responsible
# for freeing the cache when done).
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

# Helper: validate a single target dict (script_path or scene_path)
func _validate_single(target: Dictionary) -> Dictionary:
	if target.has("script_path") and target.script_path != "":
		var path = normalize_scene_path(target.script_path)
		if path.is_empty():
			return {"valid": false, "errors": [{"message": "Path escapes the project root: " + target.script_path}], "target": target.script_path}
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.script_path}
		var resource = load(path)
		# Actual parse errors go to stderr and are parsed by TypeScript
		return {"valid": resource != null, "errors": [], "target": target.script_path}
	elif target.has("scene_path") and target.scene_path != "":
		var path = normalize_scene_path(target.scene_path)
		if path.is_empty():
			return {"valid": false, "errors": [{"message": "Path escapes the project root: " + target.scene_path}], "target": target.scene_path}
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.scene_path}
		var scene = load(path)
		return {"valid": scene != null, "errors": [], "target": target.scene_path}
	else:
		return {"valid": false, "errors": [{"message": "No valid target: provide script_path or scene_path"}], "target": ""}

# Validate multiple scripts/scenes in a single headless process. A target that
# carries a non-empty checks[] array also gets the structural / signal checks
# run against it here, in this same process, reported on that target's own
# "checkErrors" field.
#
# checkErrors is a separate field rather than an addition to "errors" because
# the TS layer overlays Godot's stderr diagnostics over "errors" whenever a
# target produced any: check errors merged into "errors" would be discarded
# for exactly those targets. Every failure mode lands on the target that
# caused it and the loop continues, so one bad target cannot cost the others
# their result.
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
	print(JSON.stringify({"results": results}))

# Execute multiple scene operations in a single headless process
# Scenes are loaded once and cached in memory; mutations accumulate until a save op
func batch_scene_operations(params: Dictionary) -> void:
	var abort_on_error = params.get("abort_on_error", false)
	var results: Array = []
	var scene_cache: Dictionary = {}

	# Pre-pass: probe every referenced scene, plus every first-time asset
	# reference (load_sprite's texture_path, and any res:// string inside a
	# set_node_properties update), for the cold-import state and for missing
	# files -- BEFORE any mutation is applied. Missing files are checked
	# first, across the whole batch: a batch that would otherwise import and
	# then refuse mid-way is worse than refusing up front. The probe re-runs
	# against the marker exit below, so the TS layer imports and re-runs the
	# whole batch cleanly; letting the main loop discover a cold scene or
	# asset lazily (after earlier ops already mutated and auto-saved other
	# scenes) would duplicate those mutations on the retry. Plain scene load
	# failures are NOT handled here — they stay lazy so per-operation error
	# reporting keeps its existing shape. Dedup keys on the normalized path,
	# not the raw string, so a scene referenced as both "a.tscn" and
	# "./a.tscn" (or the same asset referenced from two ops) is probed once.
	var seen_paths: Dictionary = {}
	var prepass_missing: Array = []
	var prepass_needs_import: Array = []
	for op in params.operations:
		var preload_path = op.get("scene_path", "")
		if preload_path != "":
			var full_path = normalize_scene_path(preload_path)
			if not full_path.is_empty() and full_path not in seen_paths and FileAccess.file_exists(full_path):
				seen_paths[full_path] = true
				var probe = _probe_scene_deps(full_path)
				prepass_missing.append_array(probe.missing)
				prepass_needs_import.append_array(probe.needs_import)

		var op_name = op.get("operation", "")
		if op_name == "load_sprite" and op.get("texture_path", "") != "":
			var asset_path = normalize_scene_path(op.texture_path)
			if not asset_path.is_empty() and asset_path not in seen_paths:
				seen_paths[asset_path] = true
				if _classify_dep_path(asset_path) == "needs_import":
					prepass_needs_import.append(asset_path)
		elif op_name == "set_node_properties" and op.has("updates") and op.updates is Array:
			for update in op.updates:
				if typeof(update) != TYPE_DICTIONARY or not update.has("value"):
					continue
				var raw_value = update.value
				if typeof(raw_value) != TYPE_STRING or not raw_value.begins_with("res://"):
					continue
				var prop_path = normalize_scene_path(raw_value)
				if prop_path.is_empty() or prop_path in seen_paths:
					continue
				seen_paths[prop_path] = true
				if _classify_dep_path(prop_path) == "needs_import":
					prepass_needs_import.append(prop_path)

	if prepass_missing.size() > 0:
		log_error("Scene references files that do not exist on disk, refusing to load so the references are not stripped on save: " + ", ".join(prepass_missing))
		quit(1)
		return
	if prepass_needs_import.size() > 0:
		log_error("[IMPORT_NEEDED] batch: " + ", ".join(prepass_needs_import))
		quit(1)
		return

	for op in params.operations:
		var op_name = op.get("operation", "")
		var scene_path = op.get("scene_path", "")
		var result = {"operation": op_name, "scenePath": scene_path}

		if scene_path != "" and scene_path not in scene_cache:
			var scene_root = load_scene_instance(scene_path)
			if scene_root:
				scene_cache[scene_path] = scene_root
			else:
				result["error"] = "Failed to load scene: " + scene_path
				results.append(result)
				if abort_on_error:
					break
				continue

		var scene_root = scene_cache.get(scene_path, null) if scene_path != "" else null

		match op_name:
			"add_node":
				if scene_root == null:
					result["error"] = "scene_path required for add_node"
				else:
					var apply_result = _apply_add_node(scene_root, op)
					if not apply_result.ok:
						result["error"] = apply_result.error
					else:
						result["success"] = true
			"load_sprite":
				if scene_root == null:
					result["error"] = "scene_path required for load_sprite"
				else:
					var apply_result = _apply_load_sprite(scene_root, op)
					if not apply_result.ok:
						result["error"] = apply_result.error
					else:
						result["success"] = true
			"set_node_properties":
				if scene_root == null:
					result["error"] = "scene_path required for set_node_properties"
				elif not op.has("updates") or (op.updates is Array and op.updates.is_empty()):
					result["error"] = "non-empty updates array required for set_node_properties"
				else:
					var apply_result = _apply_updates(scene_root, op.updates, op.get("abort_on_error", false))
					if apply_result.any_set:
						result["success"] = true
					else:
						result["error"] = "no properties were set"
					if apply_result.results.size() > 0:
						result["updates"] = apply_result.results
			"save":
				if scene_root == null:
					result["error"] = "scene_path required for save"
				else:
					var new_path = op.get("new_path", scene_path)
					if save_scene_to_path(scene_root, new_path):
						result["success"] = true
						# Only evict on normal save; save-as leaves the mutated scene in
						# cache so subsequent ops on scene_path still see accumulated mutations.
						if new_path == scene_path:
							scene_cache.erase(scene_path)
					else:
						result["error"] = "Failed to save scene: " + scene_path
			_:
				# An omitted/empty "operation" key is the common mistake —
				# name the offending item index so the caller can fix it,
				# and hint at inference when the shape identifies the op.
				var hint = ""
				if op_name == null or op_name == "":
					hint = " - operations[%d] is missing the required 'operation' key (one of: add_node, load_sprite, set_node_properties, save)." % results.size()
					# The TS layer's convertCamelToSnakeCase converts operations[]
					# items recursively (verified: nodeName → node_name), so keys
					# always arrive snake_cased here.
					if op.has("node_name") or op.has("node_type"):
						hint += " (node_name/node_type present: did you mean operation 'add_node'?)"
					elif op.has("updates"):
						hint += " (updates present: did you mean operation 'set_node_properties'?)"
					elif op.has("texture_path"):
						hint += " (texture_path present: did you mean operation 'load_sprite'?)"
				result["error"] = "Unknown batch operation: " + str(op_name) + hint

		results.append(result)
		if abort_on_error and result.has("error"):
			break

	# Auto-save any scenes that were mutated but not explicitly saved
	for scene_path in scene_cache:
		save_scene_to_path(scene_cache[scene_path], scene_path)

	print(JSON.stringify({"results": results}))
