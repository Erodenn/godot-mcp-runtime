extends Node

# KEEP IN SYNC: src/utils/bridge-protocol.ts implements the same framing on the
# Node side. Any change here MUST be mirrored there (and vice versa).
#
# Wire format: 4-byte big-endian length prefix + UTF-8 JSON payload.
# Max frame size 16 MiB; oversize frames close the offending peer.

const DEFAULT_BRIDGE_PORT := 9900
const MAX_FRAME_BYTES := 16 * 1024 * 1024
const FRAME_HEADER_BYTES := 4

class PeerState:
	extends RefCounted
	var stream: StreamPeerTCP
	var buffer: PackedByteArray = PackedByteArray()
	var expected_len: int = -1   # -1 = waiting on header
	var handling: bool = false   # true while a command is awaiting a response

var tcp_server: TCPServer
var port: int = DEFAULT_BRIDGE_PORT
var session_token: String = ""
var _peers: Array = []   # Array[PeerState]

func _resolve_port() -> int:
	var raw := OS.get_environment("MCP_BRIDGE_PORT")
	if raw == "":
		return DEFAULT_BRIDGE_PORT
	if not raw.is_valid_int():
		return DEFAULT_BRIDGE_PORT
	var parsed := int(raw)
	if parsed <= 0 or parsed > 65535:
		return DEFAULT_BRIDGE_PORT
	return parsed

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	session_token = OS.get_environment("MCP_SESSION_TOKEN")
	port = _resolve_port()
	tcp_server = TCPServer.new()
	var err = tcp_server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("McpBridge: Failed to listen on port %d (error %d)" % [port, err])
	else:
		print("McpBridge: Listening on TCP port %d" % port)

	if OS.get_environment("MCP_BACKGROUND") == "1":
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_NO_FOCUS, true)
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_MOUSE_PASSTHROUGH, true)
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, true)
		DisplayServer.window_set_position(Vector2i(-9999, -9999))
		print("McpBridge: Background mode active - window hidden, physical input blocked")

func _process(_delta: float) -> void:
	if tcp_server == null or not tcp_server.is_listening():
		return

	while tcp_server.is_connection_available():
		var stream := tcp_server.take_connection()
		if stream == null:
			break
		stream.set_no_delay(true)
		var peer := PeerState.new()
		peer.stream = stream
		_peers.append(peer)

	var dead: Array = []
	for peer in _peers:
		_poll_peer(peer)
		if peer.stream == null or peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			dead.append(peer)

	if not dead.is_empty():
		for peer in dead:
			_peers.erase(peer)

func _poll_peer(peer: PeerState) -> void:
	peer.stream.poll()
	var status := peer.stream.get_status()
	if status != StreamPeerTCP.STATUS_CONNECTED:
		return

	var available := peer.stream.get_available_bytes()
	if available > 0:
		var chunk: Array = peer.stream.get_partial_data(available)
		# get_partial_data returns [error, PackedByteArray]
		if chunk[0] == OK:
			peer.buffer.append_array(chunk[1])

	while true:
		if peer.expected_len < 0:
			if peer.buffer.size() < FRAME_HEADER_BYTES:
				return
			# Read u32 BE header.
			var header := peer.buffer.slice(0, FRAME_HEADER_BYTES)
			var b0 := int(header[0])
			var b1 := int(header[1])
			var b2 := int(header[2])
			var b3 := int(header[3])
			peer.expected_len = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
			peer.buffer = peer.buffer.slice(FRAME_HEADER_BYTES)
			if peer.expected_len > MAX_FRAME_BYTES:
				push_error("McpBridge: Frame header exceeds limit (%d), closing peer" % peer.expected_len)
				peer.stream.disconnect_from_host()
				peer.stream = null
				return

		if peer.handling:
			return
		if peer.buffer.size() < peer.expected_len:
			return

		var frame_bytes := peer.buffer.slice(0, peer.expected_len)
		peer.buffer = peer.buffer.slice(peer.expected_len)
		peer.expected_len = -1

		var data := frame_bytes.get_string_from_utf8().strip_edges()
		peer.handling = true
		_dispatch_command(peer, data)
		# _dispatch_command awaits internally on async branches (input, run_script,
		# screenshot, shutdown), so control returns here at the first inner await.
		# `peer.handling` is the gate that blocks re-entry; it is cleared by
		# `_send_response` once the handler completes.

# INVARIANT: every code path through this function and its handlers must
# eventually reach `_send_response`. `peer.handling` is set to true by the
# caller (`_poll_peer`) before dispatch and cleared inside `_send_response`.
# A handler that exits without calling `_send_response` will deadlock the
# peer — the next frame will never be polled. When adding a new branch,
# ensure the early-exit calls `_send_response` with an error payload.
func _dispatch_command(peer: PeerState, data: String) -> void:
	if not data.begins_with("{"):
		_send_response(peer, {"error": "Non-JSON frame (expected a JSON command object)"})
		return

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
			await _handle_input(peer, actions)
		"get_ui_elements":
			_handle_get_ui_elements(peer, payload)
		"run_script":
			await _handle_run_script(peer, payload)
		"screenshot":
			await _handle_screenshot(peer)
		"shutdown":
			await _handle_shutdown(peer)
		"ping":
			_send_response(peer, {"status": "pong", "session_token": session_token, "project_path": ProjectSettings.globalize_path("res://")})
		_:
			_send_response(peer, {"error": "Unknown command: %s" % command})

# --- Screenshot ---

func _handle_screenshot(peer: PeerState) -> void:
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

func _handle_input(peer: PeerState, actions: Array) -> void:
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

	# Allow queued input events to dispatch and any signal handlers
	# (and their runtime errors) to fire before we reply, so the
	# Node-side stderr scan in sendCommandWithErrors sees them.
	await get_tree().process_frame
	await get_tree().process_frame

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

func _resolve_button_name(button_name: String) -> Array:
	match button_name:
		"left":
			return [MOUSE_BUTTON_LEFT, ""]
		"right":
			return [MOUSE_BUTTON_RIGHT, ""]
		"middle":
			return [MOUSE_BUTTON_MIDDLE, ""]
		_:
			return [MOUSE_BUTTON_NONE, "unknown button: '%s' (use 'left', 'right', or 'middle')" % button_name]

func _inject_mouse_button(action: Dictionary) -> String:
	var button_result := _resolve_button_name(action.get("button", "left"))
	if button_result[1] != "":
		return button_result[1]
	var button_index: MouseButton = button_result[0]

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

	var button_result := _resolve_button_name(action.get("button", "left"))
	if button_result[1] != "":
		return button_result[1]
	var button_index: MouseButton = button_result[0]
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

func _handle_get_ui_elements(peer: PeerState, payload: Dictionary) -> void:
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
		var abs_node := root.get_node_or_null(NodePath(identifier))
		if abs_node is Control:
			return abs_node as Control
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

func _handle_run_script(peer: PeerState, payload: Dictionary) -> void:
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

	# Execute (await in case the user's script uses async/await internally)
	var result = await instance.execute(get_tree())

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

# --- Shutdown ---

func _handle_shutdown(peer: PeerState) -> void:
	_send_response(peer, {"status": "shutting_down"})
	# Let the response flush before we tear the listener down. A new command
	# arriving in this 2-frame window would dispatch against a peer that's
	# about to close; the response write fails gracefully and the Node side
	# sees BridgeDisconnectedError. MCP serializes calls so this is theoretical.
	await get_tree().process_frame
	await get_tree().process_frame
	_close_all_peers()
	if tcp_server != null:
		tcp_server.stop()
	# Detach from the tree so subsequent _process ticks don't run.
	queue_free()

# --- Utility ---

func _send_response(peer: PeerState, data: Dictionary) -> void:
	var resp := JSON.stringify(data)
	var body := resp.to_utf8_buffer()
	if body.size() > MAX_FRAME_BYTES:
		push_error("McpBridge: Response exceeds %d bytes; dropping" % MAX_FRAME_BYTES)
		peer.handling = false
		return
	if peer.stream != null and peer.stream.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		var header := PackedByteArray()
		header.resize(FRAME_HEADER_BYTES)
		var size := body.size()
		header[0] = (size >> 24) & 0xFF
		header[1] = (size >> 16) & 0xFF
		header[2] = (size >> 8) & 0xFF
		header[3] = size & 0xFF
		peer.stream.put_data(header)
		peer.stream.put_data(body)
	peer.handling = false

func _close_all_peers() -> void:
	for peer in _peers:
		if peer.stream != null:
			peer.stream.disconnect_from_host()
			peer.stream = null
	_peers.clear()

func _exit_tree() -> void:
	_close_all_peers()
	if tcp_server != null:
		tcp_server.stop()
		tcp_server = null
		print("McpBridge: Stopped")
