extends Node

var udp_server: UDPServer
var port: int = 9900
var _is_processing_input: bool = false

func _ready() -> void:
	udp_server = UDPServer.new()
	var err = udp_server.listen(port)
	if err != OK:
		push_error("McpBridge: Failed to listen on port %d (error %d)" % [port, err])
	else:
		print("McpBridge: Listening on UDP port %d" % port)

func _process(_delta: float) -> void:
	udp_server.poll()
	if udp_server.is_connection_available():
		var peer: PacketPeerUDP = udp_server.take_connection()
		var packet := peer.get_packet()
		var data := packet.get_string_from_utf8().strip_edges()

		if data.begins_with("{"):
			_handle_json_command(peer, data)
		else:
			# Legacy plain-text commands
			match data:
				"screenshot":
					_handle_screenshot(peer)
				"ping":
					peer.put_packet("pong".to_utf8_buffer())
				_:
					_send_response(peer, {"error": "Unknown command: %s" % data})

func _handle_json_command(peer: PacketPeerUDP, data: String) -> void:
	var json = JSON.new()
	var err = json.parse(data)
	if err != OK:
		_send_response(peer, {"error": "Invalid JSON: %s" % json.get_error_message()})
		return

	var payload = json.data
	if typeof(payload) != TYPE_DICTIONARY:
		_send_response(peer, {"error": "Expected JSON object"})
		return

	var command = payload.get("command", "")
	match command:
		"input":
			var actions = payload.get("actions", [])
			if typeof(actions) != TYPE_ARRAY:
				_send_response(peer, {"error": "actions must be an array"})
				return
			if actions.is_empty():
				_send_response(peer, {"error": "actions array is empty"})
				return
			if _is_processing_input:
				_send_response(peer, {"error": "Input sequence already in progress"})
				return
			_handle_input(peer, actions)
		"get_ui_elements":
			_handle_get_ui_elements(peer, payload)
		"run_script":
			_handle_run_script(peer, payload)
		"screenshot":
			_handle_screenshot(peer)
		"ping":
			_send_response(peer, {"status": "pong"})
		_:
			_send_response(peer, {"error": "Unknown command: %s" % command})

# --- Screenshot ---

func _handle_screenshot(peer: PacketPeerUDP) -> void:
	await RenderingServer.frame_post_draw

	var viewport := get_viewport()
	if viewport == null:
		_send_response(peer, {"error": "No viewport available"})
		return

	var image := viewport.get_texture().get_image()
	if image == null:
		_send_response(peer, {"error": "Failed to capture viewport image"})
		return

	var timestamp := str(Time.get_unix_time_from_system()).replace(".", "_")
	var screenshot_dir := ProjectSettings.globalize_path("res://.mcp/screenshots")
	DirAccess.make_dir_recursive_absolute(screenshot_dir)
	var file_path := screenshot_dir.path_join("screenshot_%s.png" % timestamp)

	var save_err := image.save_png(file_path)
	if save_err != OK:
		_send_response(peer, {"error": "Failed to save screenshot (error %d)" % save_err})
		return

	var safe_path := file_path.replace("\\", "/")
	_send_response(peer, {"path": safe_path})

# --- Input Simulation ---

func _handle_input(peer: PacketPeerUDP, actions: Array) -> void:
	_is_processing_input = true
	var processed := 0
	var error_msg := ""

	for action in actions:
		if typeof(action) != TYPE_DICTIONARY:
			error_msg = "Action at index %d is not an object" % processed
			break

		var type = action.get("type", "")
		match type:
			"key":
				var result = _inject_key(action)
				if result != "":
					error_msg = "Action %d (key): %s" % [processed, result]
					break
			"mouse_button":
				var result = _inject_mouse_button(action)
				if result != "":
					error_msg = "Action %d (mouse_button): %s" % [processed, result]
					break
			"mouse_motion":
				_inject_mouse_motion(action)
			"action":
				var result = _inject_action(action)
				if result != "":
					error_msg = "Action %d (action): %s" % [processed, result]
					break
			"click_element":
				var result = _inject_click_element(action)
				if result != "":
					error_msg = "Action %d (click_element): %s" % [processed, result]
					break
			"wait":
				var ms = action.get("ms", 0)
				if typeof(ms) == TYPE_FLOAT or typeof(ms) == TYPE_INT:
					if ms > 0:
						await get_tree().create_timer(ms / 1000.0).timeout
				else:
					error_msg = "Action %d (wait): ms must be a number" % processed
					break
			_:
				error_msg = "Action %d: unknown type '%s'" % [processed, type]
				break

		processed += 1

	_is_processing_input = false

	if error_msg != "":
		_send_response(peer, {"error": error_msg, "actions_processed": processed})
	else:
		_send_response(peer, {"success": true, "actions_processed": processed})

func _inject_key(action: Dictionary) -> String:
	var key_name = action.get("key", "")
	if key_name == "":
		return "key name is required"

	var keycode = OS.find_keycode_from_string(key_name)
	if keycode == KEY_NONE:
		return "unrecognized key name: '%s'" % key_name

	var event = InputEventKey.new()
	event.keycode = keycode
	event.pressed = action.get("pressed", true)
	event.echo = false
	event.shift_pressed = action.get("shift", false)
	event.ctrl_pressed = action.get("ctrl", false)
	event.alt_pressed = action.get("alt", false)
	Input.parse_input_event(event)
	return ""

func _inject_mouse_button(action: Dictionary) -> String:
	var button_name = action.get("button", "left")
	var button_index: MouseButton
	match button_name:
		"left":
			button_index = MOUSE_BUTTON_LEFT
		"right":
			button_index = MOUSE_BUTTON_RIGHT
		"middle":
			button_index = MOUSE_BUTTON_MIDDLE
		_:
			return "unknown button: '%s' (use 'left', 'right', or 'middle')" % button_name

	var pos = Vector2(action.get("x", 0), action.get("y", 0))
	var double_click = action.get("double_click", false)

	# If pressed is explicitly set, only do that one event
	if action.has("pressed"):
		var event = InputEventMouseButton.new()
		event.button_index = button_index
		event.pressed = action.get("pressed")
		event.position = pos
		event.global_position = pos
		event.double_click = double_click
		Input.parse_input_event(event)
	else:
		# Auto press + release (click)
		var press = InputEventMouseButton.new()
		press.button_index = button_index
		press.pressed = true
		press.position = pos
		press.global_position = pos
		press.double_click = double_click
		Input.parse_input_event(press)

		var release = InputEventMouseButton.new()
		release.button_index = button_index
		release.pressed = false
		release.position = pos
		release.global_position = pos
		Input.parse_input_event(release)

	return ""

func _inject_mouse_motion(action: Dictionary) -> void:
	var event = InputEventMouseMotion.new()
	event.position = Vector2(action.get("x", 0), action.get("y", 0))
	event.global_position = event.position
	event.relative = Vector2(action.get("relative_x", 0), action.get("relative_y", 0))
	Input.parse_input_event(event)

func _inject_action(action: Dictionary) -> String:
	var action_name = action.get("action", "")
	if action_name == "":
		return "action name is required"

	var pressed = action.get("pressed", true)
	var strength = action.get("strength", 1.0)

	if pressed:
		Input.action_press(action_name, strength)
	else:
		Input.action_release(action_name)
	return ""

func _inject_click_element(action: Dictionary) -> String:
	var identifier: String = action.get("element", "")
	if identifier == "":
		return "element identifier is required"

	var target := _find_control_by_identifier(identifier)
	if target == null:
		return "Could not find UI element: %s" % identifier

	if not target.is_visible_in_tree():
		return "UI element '%s' is not visible" % identifier

	var button_name: String = action.get("button", "left")
	var button_index: MouseButton
	match button_name:
		"left":
			button_index = MOUSE_BUTTON_LEFT
		"right":
			button_index = MOUSE_BUTTON_RIGHT
		"middle":
			button_index = MOUSE_BUTTON_MIDDLE
		_:
			return "unknown button: '%s' (use 'left', 'right', or 'middle')" % button_name

	var double_click: bool = action.get("double_click", false)
	var rect := target.get_global_rect()
	var center := rect.get_center()

	var press := InputEventMouseButton.new()
	press.button_index = button_index
	press.pressed = true
	press.position = center
	press.global_position = center
	press.double_click = double_click
	Input.parse_input_event(press)

	var release := InputEventMouseButton.new()
	release.button_index = button_index
	release.pressed = false
	release.position = center
	release.global_position = center
	Input.parse_input_event(release)

	return ""

# --- UI Element Discovery ---

func _handle_get_ui_elements(peer: PacketPeerUDP, payload: Dictionary) -> void:
	var visible_only: bool = payload.get("visible_only", true)
	var type_filter: String = payload.get("type_filter", "")
	var root := get_tree().root
	var elements: Array[Dictionary] = []
	_collect_control_nodes(root, elements, visible_only, type_filter)
	_send_response(peer, {"elements": elements})

func _collect_control_nodes(node: Node, elements: Array[Dictionary], visible_only: bool, type_filter: String = "") -> void:
	if node is Control:
		var ctrl := node as Control
		if visible_only and not ctrl.is_visible_in_tree():
			return
		if type_filter != "" and not ctrl.is_class(type_filter):
			# Still recurse into children even if this node doesn't match
			for child in node.get_children():
				_collect_control_nodes(child, elements, visible_only, type_filter)
			return
		var rect := ctrl.get_global_rect()
		var element := {
			"name": String(ctrl.name),
			"type": ctrl.get_class(),
			"path": str(ctrl.get_path()),
			"rect": {
				"x": rect.position.x,
				"y": rect.position.y,
				"width": rect.size.x,
				"height": rect.size.y,
			},
			"visible": ctrl.is_visible_in_tree(),
		}
		# Extract text content for common Control types
		if ctrl is Button:
			element["text"] = (ctrl as Button).text
		elif ctrl is Label:
			element["text"] = (ctrl as Label).text
		elif ctrl is LineEdit:
			element["text"] = (ctrl as LineEdit).text
			element["placeholder"] = (ctrl as LineEdit).placeholder_text
		elif ctrl is TextEdit:
			element["text"] = (ctrl as TextEdit).text
		elif ctrl is RichTextLabel:
			element["text"] = (ctrl as RichTextLabel).text
		# Disabled state for buttons
		if ctrl is BaseButton:
			element["disabled"] = (ctrl as BaseButton).disabled
		# Tooltip
		if ctrl.tooltip_text != "":
			element["tooltip"] = ctrl.tooltip_text
		elements.append(element)
	for child in node.get_children():
		_collect_control_nodes(child, elements, visible_only, type_filter)

func _find_control_by_identifier(identifier: String) -> Control:
	var root := get_tree().root
	# Try as node path first
	if identifier.begins_with("/"):
		var node := root.get_node_or_null(NodePath(identifier))
		if node is Control:
			return node as Control
	# Try as relative path from root
	var node := root.get_node_or_null(NodePath(identifier))
	if node is Control:
		return node as Control
	# BFS: match by node name
	var queue: Array[Node] = []
	queue.append(root)
	while not queue.is_empty():
		var current: Node = queue.pop_front()
		if current is Control:
			if String(current.name) == identifier:
				return current as Control
		for child in current.get_children():
			queue.append(child)
	return null

# --- Script Execution ---

func _handle_run_script(peer: PacketPeerUDP, payload: Dictionary) -> void:
	var source: String = payload.get("source", "")
	if source.strip_edges() == "":
		_send_response(peer, {"error": "No script source provided"})
		return

	# Compile the script at runtime
	var script := GDScript.new()
	script.source_code = source
	var err := script.reload()
	if err != OK:
		_send_response(peer, {"error": "Script compilation failed (error %d). Check syntax." % err})
		return

	# Instantiate and validate
	var instance = script.new()
	if instance == null:
		_send_response(peer, {"error": "Failed to instantiate script"})
		return

	if not instance.has_method("execute"):
		if instance is RefCounted:
			instance = null  # Let RefCounted free itself
		else:
			instance.free()
		_send_response(peer, {"error": "Script must define func execute(scene_tree: SceneTree) -> Variant"})
		return

	# Execute
	var result = null
	var exec_error := ""
	result = instance.execute(get_tree())

	# Clean up
	if instance is RefCounted:
		instance = null
	else:
		instance.free()

	# Serialize and respond
	var serialized = _serialize_value(result)
	_send_response(peer, {"success": true, "result": serialized})

func _serialize_value(value: Variant) -> Variant:
	if value == null:
		return null

	match typeof(value):
		TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_VECTOR2:
			var v: Vector2 = value
			return {"x": v.x, "y": v.y}
		TYPE_VECTOR2I:
			var v: Vector2i = value
			return {"x": v.x, "y": v.y}
		TYPE_VECTOR3:
			var v: Vector3 = value
			return {"x": v.x, "y": v.y, "z": v.z}
		TYPE_VECTOR3I:
			var v: Vector3i = value
			return {"x": v.x, "y": v.y, "z": v.z}
		TYPE_COLOR:
			var c: Color = value
			return {"r": c.r, "g": c.g, "b": c.b, "a": c.a}
		TYPE_DICTIONARY:
			var d: Dictionary = value
			var result := {}
			for key in d:
				result[str(key)] = _serialize_value(d[key])
			return result
		TYPE_ARRAY:
			var a: Array = value
			var result := []
			for item in a:
				result.append(_serialize_value(item))
			return result
		TYPE_OBJECT:
			if value is Node:
				var node: Node = value
				return {"class": node.get_class(), "name": String(node.name), "path": str(node.get_path())}
			elif value is Resource:
				var res: Resource = value
				return {"class": res.get_class(), "path": res.resource_path}
			else:
				return str(value)
		_:
			return str(value)

# --- Utility ---

func _send_response(peer: PacketPeerUDP, data: Dictionary) -> void:
	var resp := JSON.stringify(data)
	peer.put_packet(resp.to_utf8_buffer())

func _exit_tree() -> void:
	if udp_server != null:
		udp_server.stop()
		print("McpBridge: Stopped")
