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
		"get_uid":
			get_uid(params)
		"resave_resources":
			resave_resources(params)
		# New node operations
		"delete_node":
			delete_node(params)
		"update_node_property":
			update_node_property(params)
		"get_node_properties":
			get_node_properties(params)
		"list_nodes":
			list_nodes(params)
		"get_scene_tree":
			get_scene_tree(params)
		"attach_script":
			attach_script(params)
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

# Helper to find a node by path
func find_node_by_path(scene_root: Node, node_path: String) -> Node:
	if node_path == "root" or node_path.is_empty():
		return scene_root

	var path = node_path
	if path.begins_with("root/"):
		path = path.substr(5)

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
			new_node.set(property, properties[property])

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

# Find files with a specific extension recursively
func find_files(path, extension):
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension))
			elif file_name.ends_with(extension):
				files.append(path + file_name)

			file_name = dir.get_next()

	return files

# Get UID for a specific file
func get_uid(params):
	if not params.has("file_path"):
		log_error("File path is required")
		quit(1)

	var file_path = normalize_scene_path(params.file_path)
	printerr("Getting UID for file: " + file_path)

	if not FileAccess.file_exists(file_path):
		log_error("File does not exist: " + file_path)
		quit(1)

	var uid_path = file_path + ".uid"
	var f = FileAccess.open(uid_path, FileAccess.READ)

	if f:
		var uid_content = f.get_as_text()
		f.close()

		var result = {
			"file": file_path,
			"uid": uid_content.strip_edges(),
			"exists": true
		}
		print(JSON.stringify(result))
	else:
		var result = {
			"file": file_path,
			"exists": false,
			"message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
		}
		print(JSON.stringify(result))

# Resave all resources to update UID references
func resave_resources(params):
	printerr("Resaving all resources to update UID references...")

	var project_path = "res://"
	if params.has("project_path"):
		project_path = params.project_path
		if not project_path.begins_with("res://"):
			project_path = "res://" + project_path
		if not project_path.ends_with("/"):
			project_path += "/"

	var scenes = find_files(project_path, ".tscn")
	var success_count = 0
	var error_count = 0

	for scene_path in scenes:
		var scene = load(scene_path)
		if scene:
			var error = ResourceSaver.save(scene, scene_path)
			if error == OK:
				success_count += 1
			else:
				error_count += 1
				log_error("Failed to save: " + scene_path)
		else:
			error_count += 1
			log_error("Failed to load: " + scene_path)

	var scripts = find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
	var generated_uids = 0

	for script_path in scripts:
		var uid_path = script_path + ".uid"
		var f = FileAccess.open(uid_path, FileAccess.READ)
		if not f:
			var res = load(script_path)
			if res:
				var error = ResourceSaver.save(res, script_path)
				if error == OK:
					generated_uids += 1

	print("Resave operation complete. Scenes: " + str(success_count) + " saved, " + str(error_count) + " errors. UIDs generated: " + str(generated_uids))

# ============================================
# NEW NODE OPERATIONS
# ============================================

# Delete a node from a scene
func delete_node(params):
	printerr("Deleting node from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	if node == scene_root:
		log_error("Cannot delete the root node")
		quit(1)

	var parent = node.get_parent()
	parent.remove_child(node)
	node.queue_free()

	if save_scene_to_path(scene_root, params.scene_path):
		print("Node '" + params.node_path + "' deleted successfully")
	else:
		log_error("Failed to save scene after deleting node")
		quit(1)

# Update a single property on a node
func update_node_property(params):
	printerr("Updating node property in scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	var property_name = params.property
	var property_value = params.value

	log_debug("Setting property '" + property_name + "' to: " + str(property_value))

	# Handle special value types
	if typeof(property_value) == TYPE_DICTIONARY:
		# Check if it's a Vector2, Vector3, Color, etc.
		if property_value.has("x") and property_value.has("y"):
			if property_value.has("z"):
				property_value = Vector3(property_value.x, property_value.y, property_value.z)
			else:
				property_value = Vector2(property_value.x, property_value.y)
		elif property_value.has("r") and property_value.has("g") and property_value.has("b"):
			var a = property_value.a if property_value.has("a") else 1.0
			property_value = Color(property_value.r, property_value.g, property_value.b, a)

	node.set(property_name, property_value)

	if save_scene_to_path(scene_root, params.scene_path):
		print("Property '" + property_name + "' updated successfully on node '" + params.node_path + "'")
	else:
		log_error("Failed to save scene after updating property")
		quit(1)

# Get all properties of a specific node
func get_node_properties(params):
	printerr("Getting node properties from scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var node = find_node_by_path(scene_root, params.node_path)
	if not node:
		log_error("Node not found: " + params.node_path)
		quit(1)

	var changed_only = params.has("changed_only") and params.changed_only

	var default_node = null
	if changed_only:
		default_node = instantiate_class(node.get_class())

	var properties = {}
	var property_list = node.get_property_list()

	for prop in property_list:
		var prop_name = prop["name"]
		var prop_usage = prop["usage"]

		# Only include properties that are stored/visible
		if prop_usage & PROPERTY_USAGE_STORAGE or prop_usage & PROPERTY_USAGE_EDITOR:
			var value = node.get(prop_name)

			# Skip properties matching defaults if changed_only
			if default_node and default_node.get(prop_name) == value:
				continue

			# Convert special types to serializable format
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

	var result = {
		"nodePath": params.node_path,
		"nodeType": node.get_class(),
		"properties": properties
	}

	print(JSON.stringify(result))

# List all child nodes under a parent
func list_nodes(params):
	printerr("Listing nodes in scene: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var parent_path = "root"
	if params.has("parent_path"):
		parent_path = params.parent_path

	var parent = find_node_by_path(scene_root, parent_path)
	if not parent:
		log_error("Parent node not found: " + parent_path)
		quit(1)

	var children = []
	for child in parent.get_children():
		children.append({
			"name": child.name,
			"type": child.get_class(),
			"childCount": child.get_child_count()
		})

	var result = {
		"parentPath": parent_path,
		"parentType": parent.get_class(),
		"children": children
	}

	print(JSON.stringify(result))

# Get full hierarchical tree structure of a scene
func get_scene_tree(params):
	printerr("Getting scene tree for: " + params.scene_path)

	var scene_root = load_scene_instance(params.scene_path)
	if not scene_root:
		quit(1)

	var max_depth = -1
	if params.has("max_depth"):
		max_depth = int(params.max_depth)

	var tree = build_tree_recursive(scene_root, "", 0, max_depth)
	print(JSON.stringify(tree))

func build_tree_recursive(node: Node, path: String, depth: int = 0, max_depth: int = -1) -> Dictionary:
	var node_path = path + "/" + node.name if not path.is_empty() else node.name

	var children = []
	if max_depth < 0 or depth < max_depth:
		for child in node.get_children():
			children.append(build_tree_recursive(child, node_path, depth + 1, max_depth))

	var script_path = ""
	if node.get_script():
		var script = node.get_script()
		if script.resource_path:
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
