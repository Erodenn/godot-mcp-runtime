#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false

func _init():
	var args = OS.get_cmdline_args()

	# Check for debug flag
	debug_mode = "--debug-godot" in args

	# Find the script argument and determine the positions of operation and params
	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		quit(1)

	var operation_index = script_index + 2
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		log_error("Not enough command-line arguments provided.")
		quit(1)

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

	if not params:
		log_error("Failed to parse JSON parameters: " + params_json)
		quit(1)

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
		# Batch operations
		"validate_batch":
			validate_batch(params)
		"batch_scene_operations":
			batch_scene_operations(params)
		_:
			log_error("Unknown operation: " + operation)
			quit(1)

	quit()

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

# Helper to normalize scene path
func normalize_scene_path(scene_path: String) -> String:
	if not scene_path.begins_with("res://"):
		return "res://" + scene_path
	return scene_path

# Helper to load and instantiate a scene
func load_scene_instance(scene_path: String):
	var full_path = normalize_scene_path(scene_path)
	log_debug("Loading scene from: " + full_path)

	if not FileAccess.file_exists(full_path):
		log_error("Scene file does not exist: " + full_path)
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

# Create a new scene with a specified root node type
func create_scene(params):
	printerr("Creating scene: " + params.scene_path)

	var full_scene_path = normalize_scene_path(params.scene_path)
	log_debug("Scene path: " + full_scene_path)

	var root_node_type = "Node2D"
	if params.has("root_node_type"):
		root_node_type = params.root_node_type
	log_debug("Root node type: " + root_node_type)

	var scene_root = instantiate_class(root_node_type)
	if not scene_root:
		log_error("Failed to instantiate node of type: " + root_node_type)
		quit(1)

	scene_root.name = "root"
	scene_root.owner = scene_root

	# Ensure directory exists
	var scene_dir = full_scene_path.get_base_dir()
	if scene_dir != "res://" and not scene_dir.is_empty():
		var dir = DirAccess.open("res://")
		if dir:
			var relative_dir = scene_dir.substr(6) if scene_dir.begins_with("res://") else scene_dir
			if not relative_dir.is_empty() and not dir.dir_exists(relative_dir):
				var make_error = dir.make_dir_recursive(relative_dir)
				if make_error != OK:
					log_error("Failed to create directory: " + relative_dir)
					quit(1)

	if save_scene_to_path(scene_root, full_scene_path):
		print("Scene created successfully at: " + params.scene_path)
	else:
		log_error("Failed to create scene: " + params.scene_path)
		quit(1)

# Add a node to an existing scene
func add_node(params):
	printerr("Adding node to scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var parent_path = "root"
	if params.has("parent_node_path"):
		parent_path = params.parent_node_path

	var parent = find_node_by_path(scene_root, parent_path)
	if not parent:
		log_error("Parent node not found: " + parent_path)
		quit(1)

	var new_node = instantiate_class(params.node_type)
	if not new_node:
		log_error("Failed to instantiate node of type: " + params.node_type)
		quit(1)

	new_node.name = params.node_name

	if params.has("properties"):
		var properties = params.properties
		for property in properties:
			log_debug("Setting property: " + property + " = " + str(properties[property]))
			new_node.set(property, _coerce_property_value(properties[property]))

	parent.add_child(new_node)
	new_node.owner = scene_root

	if save_scene_to_path(scene_root, params.scene_path):
		print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
	else:
		log_error("Failed to save scene after adding node")
		quit(1)

# Load a sprite into a Sprite2D node
func load_sprite(params):
	printerr("Loading sprite into scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var sprite_node = find_node_by_path(scene_root, params.node_path)
	if not sprite_node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
		log_error("Node is not a sprite-compatible type: " + sprite_node.get_class())
		quit(1)

	var full_texture_path = normalize_scene_path(params.texture_path)
	var texture = load(full_texture_path)
	if not texture:
		log_error("Failed to load texture: " + full_texture_path)
		quit(1)
	if not (texture is Texture2D):
		log_error("Loaded resource is not a Texture2D: " + full_texture_path)
		quit(1)
	# A texture without a resource_path is a runtime-only object — PackedScene.pack()
	# cannot serialize it, so the assignment would silently vanish on save.
	if texture.resource_path == "":
		log_error("Texture has no resource_path — likely not imported. Open project in Godot editor once, or run 'godot --headless --editor --quit' to import assets.")
		quit(1)

	sprite_node.texture = texture

	if save_scene_to_path(scene_root, params.scene_path):
		print("Sprite loaded successfully with texture: " + params.texture_path)
	else:
		log_error("Failed to save scene after loading sprite")
		quit(1)

# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
	printerr("Exporting MeshLibrary from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

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

			if mesh_instance.mesh:
				mesh_library.set_item_preview(item_id, mesh_instance.mesh)

			item_id += 1

	if item_id > 0:
		var full_output_path = normalize_scene_path(params.output_path)

		# Ensure output directory exists
		var output_dir = full_output_path.get_base_dir()
		if output_dir != "res://":
			var dir = DirAccess.open("res://")
			if dir:
				var relative_dir = output_dir.substr(6) if output_dir.begins_with("res://") else output_dir
				if not relative_dir.is_empty() and not dir.dir_exists(relative_dir):
					dir.make_dir_recursive(relative_dir)

		var error = ResourceSaver.save(mesh_library, full_output_path)
		if error == OK:
			print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + params.output_path)
		else:
			log_error("Failed to save MeshLibrary: " + str(error))
			quit(1)
	else:
		log_error("No valid meshes found in the scene")
		quit(1)

# Save changes to a scene file
func save_scene(params):
	printerr("Saving scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var save_path = params.new_path if params.has("new_path") else params.scene_path

	if save_scene_to_path(scene_root, save_path):
		print("Scene saved successfully to: " + save_path)
	else:
		log_error("Failed to save scene")
		quit(1)

# ============================================
# NODE OPERATIONS
# ============================================

# Delete one or more nodes from a scene (saves once)
func delete_nodes(params):
	printerr("Deleting nodes from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

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

# Update one or more node properties in a single headless process (saves once)
func set_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		print(JSON.stringify({"error": "Failed to load scene: " + params.scene_path, "results": []}))
		return

	var abort_on_error = params.get("abort_on_error", false)
	var results: Array = []
	var any_set := false

	for update in params.updates:
		var result = {"nodePath": update.node_path, "property": update.property}
		var node = find_node_by_path(scene_root, update.node_path)
		if node == null:
			result["error"] = "Node not found: " + update.node_path
		else:
			node.set(update.property, _coerce_property_value(update.value))
			result["success"] = true
			any_set = true
		results.append(result)
		if abort_on_error and result.has("error"):
			break

	if any_set:
		if not save_scene_to_path(scene_root, params.scene_path):
			print(JSON.stringify({"error": "Failed to save scene after updates", "results": results}))
			return

	print(JSON.stringify({"results": results}))

# Get properties from one or more nodes in a single headless process (loads scene once)
func get_node_properties(params: Dictionary) -> void:
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		print(JSON.stringify({"error": "Failed to load scene: " + params.scene_path, "results": []}))
		return

	var results: Array = []

	for node_spec in params.nodes:
		var node_path = node_spec.get("node_path", "")
		var changed_only = node_spec.get("changed_only", false)
		var node = find_node_by_path(scene_root, node_path)
		if node == null:
			results.append({"nodePath": node_path, "error": "Node not found"})
		else:
			var props = _collect_node_properties(node, changed_only)
			results.append({"nodePath": node_path, "nodeType": node.get_class(), "properties": props})

	print(JSON.stringify({"results": results}))

# Get full hierarchical tree structure of a scene
func get_scene_tree(params):
	printerr("Getting scene tree for: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var tree_root = scene_root
	if params.has("parent_path") and params.parent_path:
		tree_root = find_node_by_path(scene_root, params.parent_path)
		if not tree_root:
			log_error("Parent node not found: " + str(params.parent_path))
			quit(1)

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

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	var full_script_path = normalize_scene_path(params.script_path)

	if not FileAccess.file_exists(full_script_path):
		log_error("Script file does not exist: " + full_script_path)
		quit(1)

	var script = load(full_script_path)
	if not script:
		log_error("Failed to load script: " + full_script_path)
		quit(1)

	node.set_script(script)

	if save_scene_to_path(scene_root, params.scene_path):
		print("Script '" + params.script_path + "' attached successfully to node '" + params.node_path + "'")
	else:
		log_error("Failed to save scene after attaching script")
		quit(1)

# ============================================
# SIGNAL AND DUPLICATE OPERATIONS
# ============================================

# Duplicate a node and its children within a scene
func duplicate_node(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root: quit(1)

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)
	if node == scene_root:
		log_error("Cannot duplicate the root node")
		quit(1)

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

	parent.add_child(duplicate)
	duplicate.owner = scene_root
	# Recursively set owner on all descendants
	for child in duplicate.get_children():
		set_owner_recursive(child, scene_root)

	if save_scene_to_path(scene_root, params.scene_path):
		print("Node duplicated successfully as '" + duplicate.name + "'")
	else:
		log_error("Failed to save scene after duplicating node")
		quit(1)

func set_owner_recursive(node: Node, owner: Node):
	node.owner = owner
	for child in node.get_children():
		set_owner_recursive(child, owner)

# List signals defined on a node and their current connections
func get_node_signals(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root: quit(1)

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	var signals = []
	for sig in node.get_signal_list():
		var sig_name = sig["name"]
		var connections = []
		for conn in node.get_signal_connection_list(sig_name):
			connections.append({
				"signal": sig_name,
				"target": str(conn["callable"].get_object().get_path()) if conn["callable"].get_object() else "unknown",
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

# Connect a signal from one node to a method on another node
func connect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root: quit(1)

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		quit(1)

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		quit(1)

	if not source.has_signal(params.signal):
		log_error("Signal does not exist: " + params.signal + " on " + source.get_class())
		quit(1)

	if not target.has_method(params.method):
		log_error("Method does not exist: " + params.method + " on " + target.get_class())
		quit(1)

	# CONNECT_PERSIST is required for the connection to be serialized into the
	# packed scene; without it the connection is runtime-only and disappears on save.
	var err = source.connect(params.signal, Callable(target, params.method), CONNECT_PERSIST)
	if err != OK:
		log_error("Failed to connect signal: " + str(err))
		quit(1)

	if save_scene_to_path(scene_root, params.scene_path):
		print("Signal '" + params.signal + "' connected from '" + params.node_path + "' to '" + params.target_node_path + "." + params.method + "'")
	else:
		log_error("Failed to save scene after connecting signal")
		quit(1)

# Disconnect a signal connection between two nodes
func disconnect_signal(params):
	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root: quit(1)

	var source = find_node_by_path(scene_root, params.node_path)
	if not source:
		log_error("Source node not found: " + params.node_path)
		quit(1)

	var target = find_node_by_path(scene_root, params.target_node_path)
	if not target:
		log_error("Target node not found: " + params.target_node_path)
		quit(1)

	if not source.is_connected(params.signal, Callable(target, params.method)):
		log_error("Signal connection does not exist")
		quit(1)

	source.disconnect(params.signal, Callable(target, params.method))

	if save_scene_to_path(scene_root, params.scene_path):
		print("Signal '" + params.signal + "' disconnected from '" + params.target_node_path + "." + params.method + "'")
	else:
		log_error("Failed to save scene after disconnecting signal")
		quit(1)

# ============================================
# VALIDATE OPERATION
# ============================================

# Validate a GDScript or scene file by loading it headlessly
func validate_resource(params):
	if not (params.has("script_path") or params.has("scene_path")):
		log_error("validate_resource requires script_path or scene_path")
		quit(1)
	var result = _validate_single(params)
	print(JSON.stringify({"valid": result.valid, "errors": result.errors}))

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

# Helper: collect node properties into a serializable Dictionary
func _collect_node_properties(node: Node, changed_only: bool) -> Dictionary:
	var default_node = null
	if changed_only:
		default_node = instantiate_class(node.get_class())

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

	if default_node:
		default_node.free()

	return properties

# Helper: validate a single target dict (script_path or scene_path)
func _validate_single(target: Dictionary) -> Dictionary:
	if target.has("script_path") and target.script_path != "":
		var path = normalize_scene_path(target.script_path)
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.script_path}
		var resource = load(path)
		# Actual parse errors go to stderr and are parsed by TypeScript
		return {"valid": resource != null, "errors": [], "target": target.script_path}
	elif target.has("scene_path") and target.scene_path != "":
		var path = normalize_scene_path(target.scene_path)
		if not FileAccess.file_exists(path):
			return {"valid": false, "errors": [{"message": "File not found: " + path}], "target": target.scene_path}
		var scene = load(path)
		return {"valid": scene != null, "errors": [], "target": target.scene_path}
	else:
		return {"valid": false, "errors": [{"message": "No valid target: provide script_path or scene_path"}], "target": ""}

# Validate multiple scripts/scenes in a single headless process
func validate_batch(params: Dictionary) -> void:
	var results: Array = []
	for target in params.targets:
		results.append(_validate_single(target))
	print(JSON.stringify({"results": results}))

# Helper: add a node to a scene root without saving (returns error string or "")
func _batch_add_node(scene_root: Node, op: Dictionary) -> String:
	var parent_path = "root"
	if op.has("parent_node_path"):
		parent_path = op.parent_node_path
	var parent = find_node_by_path(scene_root, parent_path)
	if not parent:
		return "Parent node not found: " + parent_path
	if not op.has("node_type") or op.node_type == "":
		return "node_type is required for add_node"
	if not op.has("node_name") or op.node_name == "":
		return "node_name is required for add_node"
	var new_node = instantiate_class(op.node_type)
	if not new_node:
		return "Failed to instantiate node of type: " + op.node_type
	new_node.name = op.node_name
	if op.has("properties"):
		for property in op.properties:
			new_node.set(property, _coerce_property_value(op.properties[property]))
	parent.add_child(new_node)
	new_node.owner = scene_root
	return ""

# Helper: set a sprite texture without saving (returns error string or "")
func _batch_load_sprite(scene_root: Node, op: Dictionary) -> String:
	if not op.has("node_path") or op.node_path == "":
		return "node_path is required for load_sprite"
	if not op.has("texture_path") or op.texture_path == "":
		return "texture_path is required for load_sprite"
	var sprite_node = find_node_by_path(scene_root, op.node_path)
	if not sprite_node:
		return "Node not found: " + op.node_path
	if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
		return "Node is not sprite-compatible: " + sprite_node.get_class()
	var texture = load(normalize_scene_path(op.texture_path))
	if not texture:
		return "Failed to load texture: " + op.texture_path
	if not (texture is Texture2D):
		return "Loaded resource is not a Texture2D: " + op.texture_path
	if texture.resource_path == "":
		return "Texture has no resource_path — likely not imported. Open project in Godot editor once, or run 'godot --headless --editor --quit' to import assets."
	sprite_node.texture = texture
	return ""

# Execute multiple scene operations in a single headless process
# Scenes are loaded once and cached in memory; mutations accumulate until a save op
func batch_scene_operations(params: Dictionary) -> void:
	var abort_on_error = params.get("abort_on_error", false)
	var results: Array = []
	var scene_cache: Dictionary = {}

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
					var err = _batch_add_node(scene_root, op)
					if err != "":
						result["error"] = err
					else:
						result["success"] = true
			"load_sprite":
				if scene_root == null:
					result["error"] = "scene_path required for load_sprite"
				else:
					var err = _batch_load_sprite(scene_root, op)
					if err != "":
						result["error"] = err
					else:
						result["success"] = true
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
				result["error"] = "Unknown batch operation: " + op_name

		results.append(result)
		if abort_on_error and result.has("error"):
			break

	# Auto-save any scenes that were mutated but not explicitly saved
	for scene_path in scene_cache:
		save_scene_to_path(scene_cache[scene_path], scene_path)

	print(JSON.stringify({"results": results}))
