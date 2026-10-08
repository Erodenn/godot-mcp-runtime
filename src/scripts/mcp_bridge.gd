extends Node

# KEEP IN SYNC: src/utils/bridge-protocol.ts implements the same framing on the
# Node side. Any change here MUST be mirrored there (and vice versa).
#
# Wire format: 4-byte big-endian length prefix + UTF-8 JSON payload.
# Max frame size 16 MiB; oversize frames close the offending peer.

# Spawned sessions deliver their port via the MCP_BRIDGE_PORT env var (read in
# _ready below), so the on-disk script is identical for every spawned session
# regardless of who wrote it. Attach mode has no env-var channel to a Godot
# process the user launched themselves, so BridgeManager.inject bakes the
# port into the integer literal below instead for that case. The 9900 here is
# the source-of-truth default that ships with the script so it remains
# runnable standalone (e.g. validate, manual debugging) with neither the env
# var nor a bake applied.
const PORT := 9900  # MCP_BRIDGE_PORT_BAKED
# Session token is baked into this script at inject time by BridgeManager.inject
# for attach-mode sessions (there is no env-var channel to a Godot process the
# user launched themselves). Spawned sessions deliver the token via the
# MCP_SESSION_TOKEN env var instead and leave this at its shipped default.
const SESSION_TOKEN_BAKED := ""  # MCP_BRIDGE_TOKEN_BAKED
# KEEP IN SYNC: src/utils/artifact-paths.ts `screenshotsDir()` composes this
# same directory on the Node side, and `handleTakeScreenshot` in
# src/tools/runtime-tools.ts refuses to read any screenshot outside it. This
# script cannot import TypeScript, so the path is spelled in both places and
# the two MUST move together.
const SCREENSHOT_DIR_RES_PATH := "res://.mcp/godot-runtime/screenshots"
# KEEP IN SYNC: SCREENSHOT_FRAME_RENDER_BUDGET_MS in src/tools/runtime-tools.ts
# is the twin of this constant. How long a screenshot waits for one rendered
# frame before it answers with an error. It MUST stay under the Node side's
# default screenshot command timeout, or the caller gets a generic timeout in
# place of this script's own error.
const FRAME_RENDER_BUDGET_MS := 5000
const MAX_FRAME_BYTES := 16 * 1024 * 1024
const FRAME_HEADER_BYTES := 4
# KEEP IN SYNC: ACTION_BOUNDARY_SENTINEL in src/utils/bridge-protocol.ts is the
# twin of this constant. Printed on stderr after each input action settles, as
# "<sentinel> <action index>"; the Node side splits its stderr window on these
# lines to attribute runtime errors to the action that caused them, and strips
# them from the captured log. This script cannot import TypeScript, so the
# spelling lives in both places and the two MUST move together.
const ACTION_BOUNDARY_SENTINEL := "MCP_ACTION_BOUNDARY"

# KEEP IN SYNC: MAX_WAIT_FRAMES, MAX_HOLD_MS, MAX_TEXT_LENGTH and MAX_WATCH_ENTRIES with their twins in src/tools/runtime-tools.ts.
# That side rejects an over-cap batch before it reaches the bridge; these are the independent bridge-side enforcement.
const MAX_WAIT_FRAMES := 600
const MAX_HOLD_MS := 10000
const MAX_TEXT_LENGTH := 1000
const MAX_WATCH_ENTRIES := 16
const MAX_UI_DELTA_ENTRIES := 20
# KEEP IN SYNC: MAX_INPUT_BATCH_BUDGET_MS in src/tools/runtime-tools.ts is the
# twin of this constant. Ceiling on the wall-clock waiting one batch asks for:
# every wait's ms plus every hold_ms. The per-action caps bound each wait, not
# how many there are, and a wait in milliseconds has no cap of its own, so
# without this a batch can park this peer for as long as its sender likes.
const MAX_BATCH_WAIT_MS := 600000
# Longest text reported for one Control in an input result (the focused text
# Control's value, and a changed Control's new text). A TextEdit can hold a
# whole document, and these go into every action's entry.
const MAX_UI_TEXT_CHARS := 2000
# Most actions one batch may hold. The server's time budget admits fewer (every
# action is charged a settle frame), so this only meets a bridge driven by
# hand. It is what bounds the part of an input reply that the byte budget
# below does not: the reduced entries.
const MAX_BATCH_ACTIONS := 10000
# Bytes the full entries of one input reply may add up to, a quarter of the
# frame limit. One entry is bounded (MAX_UI_DELTA_ENTRIES, MAX_UI_TEXT_CHARS,
# the sample bounds), but a batch holds thousands of them. Past this budget an
# entry is reduced to REDUCED_ENTRY_KEYS and marked `details_dropped`, so the
# reply always fits a frame: the actions of a batch have run by the time its
# reply is built, and a reply that cannot be sent would leave the caller not
# knowing that.
const MAX_INPUT_REPLY_BYTES := 4 * 1024 * 1024
# What a reduced entry keeps: whether the action ran and when. All fixed-size
# except `error`, which is cut to MAX_REDUCED_ERROR_CHARS and which at most
# one entry of a batch carries, because a failed action ends the batch.
const REDUCED_ENTRY_KEYS := ["index", "type", "ok", "frame", "elapsed_ms", "error"]
const MAX_REDUCED_ERROR_CHARS := 512

# KEEP IN SYNC: PARENT_WATCH_PORT_ENV in src/utils/bridge-protocol.ts is the
# twin of this constant. The server sets it for a game it spawned, never for an
# attached one, to the port of a listener that lives as long as the server
# process does.
const PARENT_WATCH_PORT_ENV := "MCP_PARENT_WATCH_PORT"
# How often the connection to that listener is checked. A server that was
# killed outright is noticed within two checks: the first write after its
# death is answered with a reset, and the second one fails.
const PARENT_WATCH_INTERVAL_MS := 2000

# Profiler track caps. KEEP IN SYNC: MAX_TRACK_ENTRIES and MIN_TRACK_INTERVAL_MS
# with TRACK_MAX_ENTRIES and TRACK_MIN_INTERVAL_MS in src/tools/profiler-tools.ts. A
# track samples NodePath:property values from _process on its own clock, so a
# profiler timeline can place them by engine frame number while other commands
# (a long input batch) hold this peer.
const MAX_TRACK_ENTRIES := 4
const MAX_TRACK_SAMPLES := 2000
const MIN_TRACK_INTERVAL_MS := 50
const MAX_TRACK_DURATION_MS := 180000
# What track_start falls back to when interval_ms or max_ms is left out. The
# server always sends both, so these only meet a bridge driven by hand.
const DEFAULT_TRACK_INTERVAL_MS := 250
const DEFAULT_TRACK_DURATION_MS := 60000

# Serialization bounds. _serialize_bounded walks containers recursively, and a
# Dictionary or Array can hold itself, or hold one other container many times
# over. Depth alone does not bound that walk: an array holding itself four
# times costs 4^depth steps on the game's main thread. So every caller is
# bounded three ways (depth, total container elements, string length), and a
# container met again while it is still being walked is cut where it recurs. A
# cut is written into the value as a marker string, never dropped silently.
#
# A run_script result is one value the caller asked for, so its bounds are
# generous: they exist to stop a walk that would never finish or a reply that
# could never be sent, not to trim an ordinary result.
const MAX_RESULT_DEPTH := 32
const MAX_RESULT_ELEMENTS := 50000
const MAX_RESULT_STRING_CHARS := 1048576
# A watch or track sample is taken again and again (a track up to
# MAX_TRACK_SAMPLES times per entry, from _process), so it is bounded in size
# as well: how deep it goes, how many container elements it holds in total, and
# how long any one string in it is. Scalars and vectors, the values a sample is
# meant for, are far inside all three.
const MAX_SAMPLE_DEPTH := 4
const MAX_SAMPLE_ELEMENTS := 32
const MAX_SAMPLE_STRING_CHARS := 128
# run_script's contract with the source it compiles: created with no argument,
# then execute called with the SceneTree and nothing else.
const RUN_SCRIPT_ENTRY_METHOD := "execute"
const RUN_SCRIPT_INIT_METHOD := "_init"
const RUN_SCRIPT_ENTRY_ARGUMENT_COUNT := 1
const RUN_SCRIPT_ENTRY_MISSING_ERROR := "Script must define func execute(scene_tree: SceneTree) -> Variant"
const TRUNCATED_DEPTH_MARKER := "<truncated: nested deeper than %d levels>"
const TRUNCATED_CYCLE_MARKER := "<truncated: this container contains itself>"
const TRUNCATED_ELEMENTS_MARKER := "<truncated: %d more elements>"
const TRUNCATED_ENTRIES_KEY := "<truncated>"
const TRUNCATED_ENTRIES_MARKER := "%d more entries"
const TRUNCATED_STRING_MARKER := "<truncated: %d more characters>"
# What a command is answered with when its real reply is too large to frame.
# The command has run by then, so the error carries OVERSIZE_RESPONSE_FIELD to
# tell it apart from a refusal, which means nothing was done.
# KEEP IN SYNC: OVERSIZE_RESPONSE_FIELD in src/utils/bridge-protocol.ts.
const OVERSIZE_RESPONSE_FIELD := "response_too_large"
# What a frame with no token or the wrong one is answered with. The readiness
# wait on the Node side reads it to tell another session's bridge from one
# that is still starting.
# KEEP IN SYNC: BRIDGE_UNAUTHORIZED_ERROR in src/utils/bridge-protocol.ts.
const UNAUTHORIZED_ERROR := "Unauthorized: invalid or missing session token"
# A reply that carried non-finite numbers (INF, NAN) as null says how many on
# this key, written by _send_response and stripped on the Node side, which turns
# it into a leading warning. Absent when there were none.
# KEEP IN SYNC: NON_FINITE_COUNT_FIELD in src/utils/bridge-protocol.ts.
const NON_FINITE_COUNT_FIELD := "non_finite_count"
const OVERSIZE_RESPONSE_ERROR := "The response is %d bytes, over the %d byte frame limit, and was not sent. Ask for less in one call: return a smaller value from run_script, pass a filter to get_ui_elements, or send fewer actions per batch."

# Where background mode parks the window: far enough off every monitor layout
# that no part of it is on screen.
const BACKGROUND_WINDOW_POSITION := Vector2i(-9999, -9999)

const INPUT_ACTION_TYPES := ["key", "mouse_button", "mouse_motion", "click_element", "action", "text", "wait"]

# Signals observed on a click_element target for the duration of the action.
# A Callable connected to a signal must accept at least as many arguments as the
# signal emits, so the arity is spelled out here and each one gets a lambda of
# the matching shape. text_changed is deliberately absent: it fires per
# character and carries no "this control was activated" information.
const OBSERVED_SIGNAL_ARITY := {"pressed": 0, "toggled": 1, "item_selected": 1, "text_submitted": 1}

# Per-action scalar fields that are read straight into a typed event property or
# a numeric cast at injection time (event.position, event.relative, event.unicode,
# event.shift_pressed, the action strength). GDScript raises on a wrong type
# there, mid-injection, which leaves the batch half-run and the peer waiting on a
# response that never comes until the client's own timeout. Every one of them is
# type-checked in whole-batch pre-validation instead, before anything is
# injected. Values are the type name used in the error message; the check itself
# is in _validate_action_fields.
const ACTION_FIELD_NUMBER := "number"
const ACTION_FIELD_BOOL := "boolean"
const ACTION_SCALAR_FIELD_TYPES := {
	"x": ACTION_FIELD_NUMBER,
	"y": ACTION_FIELD_NUMBER,
	"relative_x": ACTION_FIELD_NUMBER,
	"relative_y": ACTION_FIELD_NUMBER,
	"strength": ACTION_FIELD_NUMBER,
	"unicode": ACTION_FIELD_NUMBER,
	"shift": ACTION_FIELD_BOOL,
	"ctrl": ACTION_FIELD_BOOL,
	"alt": ACTION_FIELD_BOOL,
}

class PeerState:
	extends RefCounted
	var stream: StreamPeerTCP
	var buffer: PackedByteArray = PackedByteArray()
	var expected_len: int = -1   # -1 = waiting on header
	var handling: bool = false   # true while a command is awaiting a response
	var authenticated: bool = false   # true once a frame of this peer passed the token check

var tcp_server: TCPServer
var session_token: String = ""
var _peers: Array = []   # Array[PeerState]
var _shutting_down: bool = false  # One-shot: set true in shutdown(); never reset (autoload is recreated on next session)
# Monotonic id for input batches, and the batch cancellation token.
# _handle_input parks on awaits that can outlive the client waiting on it: a
# command that times out on the Node side destroys the socket, and the next
# command arrives on a brand new peer. A parked coroutine that resumed anyway
# would keep injecting into a game the client believes is idle, and would keep
# printing ACTION_BOUNDARY_SENTINEL lines into the NEXT batch's attribution
# window, where the Node side cannot tell them from that batch's own marks.
#
# WHAT CANCELLATION GUARANTEES, and what it does not. The generation is bumped
# by two events, both of them the client itself acting: the first frame of a
# connection that passes the token check (see _dispatch_command), and a new
# input batch starting. The Node client holds one socket and sends one command
# at a time (its session queue holds the next one back), and it dials only to
# send, so either event proves the batch owning an older generation has nobody
# left to report to. A connection being accepted is not such an event: anything
# on this machine can open the port, and a connect that carries no valid token
# must not be able to cancel the batch of the client that holds one. Both
# events are observed inside this process, with no dependence on when the OS
# reports the old peer gone -- StreamPeerTCP.poll() surfaces a destroyed peer
# promptly on some platforms and not at all on others until a write is
# attempted, so the peer status checked below is a best-effort extra and never
# the guarantee.
#
# The guarantee is therefore: once the client has sent a command on a new
# connection or started another batch, an abandoned batch injects nothing
# further and prints no further boundary. NOT guaranteed: a batch parked in a
# long wait while the client does nothing at all may still run to completion on
# a platform whose poll() stays CONNECTED. Its boundaries then land between
# capture windows, where beginActionErrorCapture clears them before the next
# batch reads any.
var _input_batch_generation: int = 0

# Active profiler track: the specs to sample, the sampling clock, and the
# samples taken so far. _track_active holds from track_start to track_stop;
# _track_watch empties once sampling ends (max_ms or a full buffer), so
# _process stops polling while the samples wait for track_stop.
var _track_active: bool = false
var _track_watch: Array = []
var _track_interval_ms: int = 0
var _track_next_ms: int = 0
var _track_until_ms: int = 0
var _track_samples: Array = []

# Bounds of the serialization in progress, set by _serialize_value and
# _serialize_sample before they call _serialize_bounded. Members rather than
# arguments because the element count is shared by the whole value, not by one
# container. The walk never awaits, so two serializations cannot interleave.
var _serialize_depth_limit: int = MAX_RESULT_DEPTH
var _serialize_elements_left: int = MAX_RESULT_ELEMENTS
var _serialize_string_limit: int = MAX_RESULT_STRING_CHARS
# The containers the walk is inside right now, outermost first. A container
# found on it again holds itself, directly or through others.
var _serialize_path: Array = []
# Non-finite floats the serializer has replaced with null since the last reply
# was sent. _send_response writes it and resets it. A track sample is taken
# between replies, so _poll_track keeps its own tally in _track_non_finite and
# hands it to the track_stop reply: otherwise it would land on whatever reply
# went out next.
var _non_finite_count: int = 0
var _track_non_finite: int = 0

# Parent watch: one connection to the server that spawned this game, kept only
# to notice that server going away. Null when no watch port was given (an
# attached session, a standalone run) or once the watch has been given up.
var _parent_watch: StreamPeerTCP = null
var _parent_watch_established: bool = false
var _parent_watch_next_ms: int = 0
var _parent_watch_beat: PackedByteArray = PackedByteArray()

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	# KEEP IN SYNC: MCP_SESSION_TOKEN, MCP_BRIDGE_PORT and MCP_BACKGROUND with the env the runner sets in src/utils/godot-runner.ts.
	session_token = OS.get_environment("MCP_SESSION_TOKEN")
	if session_token == "":
		session_token = SESSION_TOKEN_BAKED
	var port := PORT
	var env_port := OS.get_environment("MCP_BRIDGE_PORT")
	if env_port != "" and env_port.is_valid_int():
		var parsed_port := int(env_port)
		if parsed_port >= 1 and parsed_port <= 65535:
			port = parsed_port
	tcp_server = TCPServer.new()
	var err = tcp_server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("McpBridge: Failed to listen on port %d (error %d)" % [port, err])
	else:
		print("McpBridge: Listening on TCP port %d" % port)

	var watch_port_text := OS.get_environment(PARENT_WATCH_PORT_ENV)
	if watch_port_text != "" and watch_port_text.is_valid_int():
		var watch_port := int(watch_port_text)
		if watch_port >= 1 and watch_port <= 65535:
			_start_parent_watch(watch_port)

	if OS.get_environment("MCP_BACKGROUND") == "1":
		# Setting BORDERLESS after the window exists removes the frame but keeps
		# the outer rectangle, so the client area grows to the old outer size.
		# The viewport's final transform then stops being the identity and every
		# injected coordinate lands off target. Reading the size first and putting
		# it back afterwards keeps the transform an identity. On Windows the flag
		# change also calls ShowWindow, which would re-show a window the server
		# spawned hidden, so BORDERLESS is not set there at all.
		var size_before := DisplayServer.window_get_size()
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_NO_FOCUS, true)
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_MOUSE_PASSTHROUGH, true)
		if OS.get_name() != "Windows":
			DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, true)
			DisplayServer.window_set_size(size_before)
		DisplayServer.window_set_position(BACKGROUND_WINDOW_POSITION)
		print("McpBridge: Background mode active - window off-screen, mouse input passes through")

func _process(_delta: float) -> void:
	if _parent_watch != null:
		_poll_parent_watch()
	if not _track_watch.is_empty():
		_poll_track()
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

	# Backwards iteration so remove_at() doesn't shift entries we haven't seen
	# yet, and avoids the O(n) cost of Array.erase() per removal.
	var i := _peers.size()
	while i > 0:
		i -= 1
		var peer = _peers[i]
		_poll_peer(peer)
		if peer.stream == null or peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_peers.remove_at(i)

# --- Parent watch ---

# Nothing tells a child process that its parent died. A server that is killed
# outright (TerminateProcess, SIGKILL, a client that force-kills it) runs no
# exit hook, so the game it spawned would keep running with nobody able to
# reach it; in background mode it is hidden and cannot be focused either. The
# operating system does close every socket of a dead process, however it died,
# so this keeps one connection open to the server and quits the game when that
# connection is lost.
func _start_parent_watch(port: int) -> void:
	var stream := StreamPeerTCP.new()
	if stream.connect_to_host("127.0.0.1", port) != OK:
		push_warning("McpBridge: could not open the parent watch connection; this game will not quit by itself if the MCP server is killed")
		return
	_parent_watch = stream
	_parent_watch_beat.resize(1)
	_parent_watch_beat[0] = 0
	_parent_watch_next_ms = Time.get_ticks_msec() + PARENT_WATCH_INTERVAL_MS

# Two signals, because neither is dependable alone on every platform: the
# stream's status after poll(), which reports a closed peer promptly on some
# systems and not at all on others while the connection is idle, and a write,
# which fails once the peer's reset has come back. The write is one byte the
# server reads and discards.
#
# Only a connection that was established and then lost quits the game. One
# that never connected is given up on with a warning: that is a watch that
# could not be set up, not a server that went away.
func _poll_parent_watch() -> void:
	var now := Time.get_ticks_msec()
	if now < _parent_watch_next_ms:
		return
	_parent_watch_next_ms = now + PARENT_WATCH_INTERVAL_MS
	_parent_watch.poll()
	var status := _parent_watch.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTING:
		return
	if status == StreamPeerTCP.STATUS_CONNECTED:
		_parent_watch_established = true
		if _parent_watch.put_data(_parent_watch_beat) == OK:
			return
	_parent_watch = null
	if not _parent_watch_established:
		push_warning("McpBridge: the parent watch connection was never established; this game will not quit by itself if the MCP server is killed")
		return
	print("McpBridge: the MCP server that started this game is gone; quitting")
	get_tree().quit()

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

	# Best-effort accident guard, not a sandbox: this stops an unauthenticated
	# local process from blasting commands at the bridge port. It does NOT stop
	# a same-user process that reads the token from our environment or from the
	# injected script on disk. Fail-open only when no token is configured at
	# all (standalone script run outside the MCP server, e.g. manual debugging).
	if session_token != "":
		var provided = payload.get("token", "")
		if typeof(provided) != TYPE_STRING or provided != session_token:
			_send_response(peer, {"error": UNAUTHORIZED_ERROR})
			return
	# The first frame of a connection that got this far is the client telling us
	# its old connection is gone: it holds one socket and dials a new one only
	# after destroying it. Any batch still parked on an earlier connection is
	# cancelled here rather than whenever the OS reports the old peer closed.
	if not peer.authenticated:
		peer.authenticated = true
		_input_batch_generation += 1

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
			await _handle_input(peer, actions, payload.get("watch", []))
		"get_ui_elements":
			_handle_get_ui_elements(peer, payload)
		"run_script":
			await _handle_run_script(peer, payload)
		"screenshot":
			await _handle_screenshot(peer, payload)
		"shutdown":
			await _handle_shutdown(peer)
		"track_start":
			_handle_track_start(peer, payload)
		"track_stop":
			_handle_track_stop(peer)
		"ping":
			_send_response(peer, {"status": "pong", "session_token": session_token, "project_path": ProjectSettings.globalize_path("res://")})
		_:
			_send_response(peer, {"error": "Unknown command: %s" % command})

# --- Screenshot ---

func _handle_screenshot(peer: PeerState, payload: Dictionary = {}) -> void:
	var frame_rendered: bool = await _ensure_frame_rendered()
	if not frame_rendered:
		_send_response(peer, {"error": "No frame was rendered within %d ms. The window is likely minimized or fully covered, so a screenshot would show a stale frame." % FRAME_RENDER_BUDGET_MS})
		return

	var viewport := get_viewport()
	if viewport == null:
		_send_response(peer, {"error": "No viewport available"})
		return

	var image := viewport.get_texture().get_image()
	if image == null:
		_send_response(peer, {"error": "Failed to capture viewport image"})
		return

	var timestamp := str(Time.get_unix_time_from_system()).replace(".", "_")
	var screenshot_dir := ProjectSettings.globalize_path(SCREENSHOT_DIR_RES_PATH)
	DirAccess.make_dir_recursive_absolute(screenshot_dir)
	var file_path := screenshot_dir.path_join("screenshot_%s.png" % timestamp)

	var save_err := image.save_png(file_path)
	if save_err != OK:
		_send_response(peer, {"error": "Failed to save screenshot (error %d)" % save_err})
		return

	var safe_path := file_path.replace("\\", "/")
	var response: Dictionary = {
		"path": safe_path,
		"width": image.get_width(),
		"height": image.get_height(),
	}

	var preview_max_width: int = int(payload.get("preview_max_width", 0))
	var preview_max_height: int = int(payload.get("preview_max_height", 0))
	if preview_max_width > 0 and preview_max_height > 0:
		var scale: float = min(
			1.0,
			min(
				float(preview_max_width) / float(image.get_width()),
				float(preview_max_height) / float(image.get_height())
			)
		)
		var preview_width: int = max(1, int(floor(float(image.get_width()) * scale)))
		var preview_height: int = max(1, int(floor(float(image.get_height()) * scale)))
		# Full image already saved to disk — resize in-place to avoid a redundant copy
		image.resize(preview_width, preview_height, Image.INTERPOLATE_LANCZOS)
		var preview_path: String = screenshot_dir.path_join("screenshot_%s_preview.png" % timestamp)
		var preview_err: Error = image.save_png(preview_path)
		if preview_err != OK:
			_send_response(peer, {"error": "Failed to save screenshot preview (error %d)" % preview_err})
			return
		response["preview_path"] = preview_path.replace("\\", "/")
		response["preview_width"] = preview_width
		response["preview_height"] = preview_height

	_send_response(peer, response)

# Waits until a freshly rendered frame is available for capture. Returns
# false when none arrived inside FRAME_RENDER_BUDGET_MS, so the caller can
# answer with an error instead of capturing a frame that may be stale.
#
# Normal path: the engine's render loop is presenting every frame, so the
# next frame_post_draw is imminent. Occluded path (macOS-only today): a
# background-mode window parked off-screen fails NSWindowOcclusionState
# visibility, DisplayServer.window_can_draw() goes false, and the engine
# main loop stops calling RenderingServer.draw() entirely, so
# frame_post_draw never fires by itself. Recover by driving one render
# manually: force_draw(false) renders every viewport into its render target
# but skips the swapchain blit that hangs while occluded. See issue #24.
#
# The wait is never an await on the signal itself: a window the engine stops
# drawing without reporting it through window_can_draw() would leave the peer
# waiting forever. It is a process_frame loop against the wall clock, which
# keeps running at time_scale 0 and while the tree is paused, where a
# SceneTreeTimer would not fire.
func _ensure_frame_rendered() -> bool:
	# GDScript lambdas capture locals by value; use an Array so the
	# mutation inside the lambda is visible out here.
	var draw_state := [false]
	var on_draw := func() -> void: draw_state[0] = true
	# Connect BEFORE force_draw(): with single-threaded rendering (the
	# default), frame_post_draw fires synchronously inside force_draw(),
	# before a wait here could start listening.
	RenderingServer.frame_post_draw.connect(on_draw, CONNECT_ONE_SHOT)
	if not DisplayServer.window_can_draw():
		RenderingServer.force_draw(false, 0.0)
	var wait_started_ms := Time.get_ticks_msec()
	while not draw_state[0] and Time.get_ticks_msec() - wait_started_ms < FRAME_RENDER_BUDGET_MS:
		await get_tree().process_frame
	if draw_state[0]:
		return true
	# Budget spent with no frame drawn. The one-shot observer never fired, so
	# it is still connected and has to be removed here.
	if RenderingServer.frame_post_draw.is_connected(on_draw):
		RenderingServer.frame_post_draw.disconnect(on_draw)
	return false

# --- Input Simulation ---

func _handle_input(peer: PeerState, actions: Array, watch: Variant = []) -> void:
	# Pre-validation first: a batch that fails here injects nothing at all, so a
	# malformed action at index 5 cannot leave the game in a half-driven state.
	var validation := _validate_input_batch(actions, watch)
	if validation != "":
		_send_response(peer, {"error": validation})
		return

	_input_batch_generation += 1
	var generation := _input_batch_generation
	var watch_list: Array = watch
	var batch_start_frame := Engine.get_process_frames()
	var batch_start_ms := Time.get_ticks_msec()
	var results: Array = []
	# Dictionary used as an ordered set of inputs this batch pressed and did not
	# release. Keys are reported verbatim in still_held.
	var held := {}
	var stopped := false
	var reply_bytes := 0

	for i in actions.size():
		var entry: Dictionary = await _run_action(i, actions[i], watch_list, batch_start_frame, batch_start_ms, held)
		# Cancellation point. _run_action awaits at least one frame, and a wait
		# action can park here for seconds, which is long enough for the client to
		# give up and for a later batch to start. Checked BEFORE the sentinel
		# print below: a mark emitted now would land in whatever attribution
		# window is open, which is no longer this batch's.
		if _input_batch_abandoned(peer, generation):
			stopped = true
			break
		# Once the full entries have used the reply's byte budget, this entry
		# and every later one is reported reduced.
		if reply_bytes <= MAX_INPUT_REPLY_BYTES:
			reply_bytes += JSON.stringify(entry).to_utf8_buffer().size()
		if reply_bytes > MAX_INPUT_REPLY_BYTES:
			entry = _reduce_entry(entry)
		results.append(entry)
		# The single sentinel site. It runs for every reported entry on every
		# path, success or failure, and always after that action's settle frame,
		# so a handler's error lines precede it on stderr and the Node side can
		# attribute them. printerr, never print: stdout and stderr are separate
		# pipes with no relative ordering.
		printerr("%s %d" % [ACTION_BOUNDARY_SENTINEL, i])
		if not entry.get("ok", false):
			stopped = true
			break

	# A runtime failure or a cancellation ends the batch: later actions depend on
	# earlier ones, and continuing would inject into unknown state.
	if stopped:
		for j in range(results.size(), actions.size()):
			var skipped_type := ""
			var skipped_action = actions[j]
			if typeof(skipped_action) == TYPE_DICTIONARY:
				skipped_type = str(skipped_action.get("type", ""))
			results.append({"index": j, "type": skipped_type, "skipped": true})

	var response := {"success": not stopped, "results": results}
	if not held.is_empty():
		response["still_held"] = held.keys()
	# Reached on the cancelled path too, on purpose: _send_response skips the
	# write when the peer is gone and clears peer.handling either way, which is
	# what keeps the "every path reaches _send_response" invariant true without a
	# finally block GDScript does not have.
	_send_response(peer, response)

# An entry cut down to REDUCED_ENTRY_KEYS, with the marker that says so.
func _reduce_entry(entry: Dictionary) -> Dictionary:
	var reduced := {"details_dropped": true}
	for key in REDUCED_ENTRY_KEYS:
		if entry.has(key):
			reduced[key] = entry[key]
	if reduced.has("error"):
		reduced["error"] = _cut_text(str(reduced["error"]), MAX_REDUCED_ERROR_CHARS)
	return reduced

# True when the batch that started at `generation` has nobody left to report to.
# Two independent signals, in order of trustworthiness:
#   1. The generation moved on: the client sent a command on a new connection
#      or started another batch.
#      This is the guarantee (see _input_batch_generation) and it is observed
#      here, not inferred from the socket.
#   2. The peer is no longer connected. Best-effort only: whether a destroyed
#      peer shows up as disconnected, and how soon, is the platform's business.
# Reads state only, so it is cheap enough to run between every action. The peer's
# status is already refreshed by _poll_peer every frame, and a batch only resumes
# on a frame boundary, so no extra poll() is needed here.
func _input_batch_abandoned(peer: PeerState, generation: int) -> bool:
	if generation != _input_batch_generation:
		return true
	if peer == null or peer.stream == null:
		return true
	return peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED

# Whole-batch validation. Returns "" when the batch may run, else a single flat
# message naming the offending action index or watch entry. Watch and
# click_element targets are NOT resolved here: an earlier action may legitimately
# be what creates them.
func _validate_input_batch(actions: Array, watch: Variant) -> String:
	if typeof(watch) != TYPE_ARRAY:
		return "watch must be an array of NodePath:property strings"
	var watch_list: Array = watch
	if watch_list.size() > MAX_WATCH_ENTRIES:
		return "watch accepts at most %d entries (got %d)" % [MAX_WATCH_ENTRIES, watch_list.size()]
	for i in watch_list.size():
		var spec = watch_list[i]
		if typeof(spec) != TYPE_STRING:
			return "watch[%d]: must be a string of the form NodePath:property" % i
		if _split_watch_spec(spec).is_empty():
			return "watch[%d]: expected NodePath:property (got '%s')" % [i, str(spec)]

	if actions.size() > MAX_BATCH_ACTIONS:
		return "the batch holds %d actions, over the %d one call may hold; split it across calls" % [actions.size(), MAX_BATCH_ACTIONS]

	var total_wait_ms := 0.0
	for i in actions.size():
		var action = actions[i]
		if typeof(action) != TYPE_DICTIONARY:
			return "action %d: must be an object" % i
		var dict: Dictionary = action
		var type = dict.get("type", "")
		if typeof(type) != TYPE_STRING or not INPUT_ACTION_TYPES.has(type):
			return "action %d: unknown type '%s'" % [i, str(type)]
		var field_error := _validate_action_fields(i, type, dict)
		if field_error != "":
			return field_error
		# Both were type-checked just above: ms is a number on a wait, hold_ms a
		# number on the types that take one.
		if type == "wait" and dict.has("ms"):
			total_wait_ms += float(dict.get("ms"))
		elif dict.has("hold_ms"):
			total_wait_ms += float(dict.get("hold_ms"))
	if total_wait_ms > float(MAX_BATCH_WAIT_MS):
		return "the batch waits %.0f ms in total, over the %d ms ceiling for one call; split it across calls" % [total_wait_ms, MAX_BATCH_WAIT_MS]
	return ""

func _validate_action_fields(index: int, type: String, action: Dictionary) -> String:
	if action.has("pressed") and typeof(action.get("pressed")) != TYPE_BOOL:
		return "action %d (%s): pressed must be a boolean" % [index, type]
	if action.has("hold_ms"):
		if type != "key" and type != "action" and type != "mouse_button":
			return "action %d (%s): hold_ms applies to key, action and mouse_button only" % [index, type]
		if action.has("pressed"):
			return "action %d (%s): hold_ms cannot be combined with pressed" % [index, type]
		if not _is_number(action.get("hold_ms")):
			return "action %d (%s): hold_ms must be a number" % [index, type]
		var hold_ms := float(action.get("hold_ms"))
		if hold_ms < 0.0 or hold_ms > float(MAX_HOLD_MS):
			return "action %d (%s): hold_ms must be between 0 and %d" % [index, type, MAX_HOLD_MS]

	# Type-only: a field is checked wherever it appears, not restricted to the
	# action types that read it. Rejecting a harmlessly-ignored extra field would
	# be a new refusal, while a wrong type is a raise waiting to happen.
	for field in ACTION_SCALAR_FIELD_TYPES:
		if not action.has(field):
			continue
		var expected: String = ACTION_SCALAR_FIELD_TYPES[field]
		var value = action.get(field)
		var field_ok := _is_number(value) if expected == ACTION_FIELD_NUMBER else typeof(value) == TYPE_BOOL
		if not field_ok:
			return "action %d (%s): %s must be a %s" % [index, type, field, expected]

	match type:
		"key":
			var key_name = action.get("key", "")
			if typeof(key_name) != TYPE_STRING or key_name == "":
				return "action %d (key): key name is required" % index
			if OS.find_keycode_from_string(key_name) == KEY_NONE:
				return "action %d (key): unrecognized key name: '%s'" % [index, key_name]
		"mouse_button", "click_element":
			var button_name = action.get("button", "left")
			if typeof(button_name) != TYPE_STRING:
				return "action %d (%s): button must be a string" % [index, type]
			var resolved := _resolve_button_name(button_name)
			if resolved[1] != "":
				return "action %d (%s): %s" % [index, type, resolved[1]]
			# Typed here, not at injection: assigning a non-bool to
			# InputEventMouseButton.double_click raises, and for click_element
			# that raise lands between the observer connects and their
			# disconnect, where GDScript has no finally to unwind them.
			if action.has("double_click") and typeof(action.get("double_click")) != TYPE_BOOL:
				return "action %d (%s): double_click must be a boolean" % [index, type]
			if type == "click_element":
				var element = action.get("element", "")
				if typeof(element) != TYPE_STRING or element == "":
					return "action %d (click_element): element identifier is required" % index
		"action":
			var action_name = action.get("action", "")
			if typeof(action_name) != TYPE_STRING or action_name == "":
				return "action %d (action): action name is required" % index
			if not InputMap.has_action(action_name):
				return "action %d (action): unknown input action: '%s'" % [index, action_name]
		"text":
			var text_value = action.get("text", "")
			if typeof(text_value) != TYPE_STRING or text_value == "":
				return "action %d (text): text is required" % index
			if (text_value as String).length() > MAX_TEXT_LENGTH:
				return "action %d (text): text exceeds %d characters" % [index, MAX_TEXT_LENGTH]
		"wait":
			var has_ms := action.has("ms")
			var has_frames := action.has("frames")
			if has_ms == has_frames:
				return "action %d (wait): set exactly one of ms or frames" % index
			if has_ms:
				if not _is_number(action.get("ms")):
					return "action %d (wait): ms must be a number" % index
				if float(action.get("ms")) < 0.0:
					return "action %d (wait): ms must not be negative" % index
			else:
				if not _is_number(action.get("frames")):
					return "action %d (wait): frames must be a number" % index
				var frames := int(action.get("frames"))
				if frames < 0 or frames > MAX_WAIT_FRAMES:
					return "action %d (wait): frames must be between 0 and %d" % [index, MAX_WAIT_FRAMES]
	return ""

func _is_number(value: Variant) -> bool:
	return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT

# Runs one action and reports what it did. Ordering matters throughout: the UI
# snapshot is taken before injection, observers are connected before injection,
# and every read happens after the settle frame, because
# Input.parse_input_event is buffered and no handler has run in the frame of
# injection.
func _run_action(index: int, action: Variant, watch: Array, batch_start_frame: int, batch_start_ms: int, held: Dictionary) -> Dictionary:
	var dict: Dictionary = action
	var type := str(dict.get("type", ""))
	var entry := {"index": index, "type": type}

	var before := _snapshot_ui()
	var pre_focus := _focus_path()
	var pre_scene := _current_scene_path()

	# Runtime pre-checks. The disabled check is its own check and is never
	# inferred from the hovered control: Godot reports a disabled Button as
	# hovered while its pressed signal never fires.
	var target: Control = null
	if type == "click_element":
		var identifier := str(dict.get("element", ""))
		target = _find_control_by_identifier(identifier)
		if target == null:
			entry["error"] = "could not find UI element: %s" % identifier
		elif not target.is_visible_in_tree():
			entry["error"] = "UI element '%s' is not visible" % identifier
		elif target is BaseButton and (target as BaseButton).disabled:
			entry["error"] = "UI element '%s' is disabled" % identifier
	elif type == "text":
		if _focus_owner() == null:
			entry["error"] = "no Control holds focus; focus a LineEdit or TextEdit first"

	# No observer is connected yet, so this early exit leaks nothing.
	if entry.has("error"):
		if not watch.is_empty():
			entry["watch"] = _sample_watch(watch)
		return _finish_entry(entry, batch_start_frame, batch_start_ms)

	# Observers, connected only on a click_element target and only for signals
	# the target actually declares. Lambdas capture by value, so the sink is an
	# Array whose mutation is visible out here (same pattern as
	# _ensure_frame_rendered). The connected pairs are kept so the disconnect
	# below undoes exactly what was done.
	var observed: Array = []
	var connections := {}
	if target != null:
		for signal_name in OBSERVED_SIGNAL_ARITY:
			if not target.has_signal(signal_name):
				continue
			var observer := _make_signal_observer(signal_name, int(OBSERVED_SIGNAL_ARITY[signal_name]), observed)
			if observer.is_null():
				continue
			target.connect(signal_name, observer)
			connections[signal_name] = observer

	# From here to the disconnect below there is exactly one straight-line path
	# with no return: GDScript has no finally, so an early exit would leak a
	# connection onto a node that outlives this call.
	match type:
		"key":
			if dict.has("pressed"):
				var key_pressed: bool = dict.get("pressed")
				_inject_key(dict, key_pressed)
				_update_held(held, "key:%s" % str(dict.get("key", "")), key_pressed)
			else:
				_inject_key(dict, true)
				await _tap_hold(dict, true)
				_inject_key(dict, false)
		"mouse_button":
			if dict.has("pressed"):
				var button_pressed: bool = dict.get("pressed")
				_inject_mouse_button(dict, button_pressed)
				_update_held(held, "mouse_button:%s" % str(dict.get("button", "left")), button_pressed)
			else:
				_inject_mouse_button(dict, true)
				await _tap_hold(dict, false)
				_inject_mouse_button(dict, false)
		"mouse_motion":
			_inject_mouse_motion(dict)
		"click_element":
			# Zero gap by design, and hold_ms is rejected for this type, so no
			# frame elapses between the two events and no handler can have run.
			# The validity guard is belt and braces for a freed target.
			_inject_click_element(dict, target, true)
			if is_instance_valid(target):
				_inject_click_element(dict, target, false)
		"action":
			if dict.has("pressed"):
				var action_pressed: bool = dict.get("pressed")
				_inject_action(dict, action_pressed)
				_update_held(held, "action:%s" % str(dict.get("action", "")), action_pressed)
			else:
				_inject_action(dict, true)
				await _tap_hold(dict, true)
				_inject_action(dict, false)
		"text":
			_inject_text(str(dict.get("text", "")))
		"wait":
			if dict.has("frames"):
				var frames := int(dict.get("frames"))
				for _n in frames:
					await get_tree().process_frame
			else:
				await _wait_wall_clock_ms(float(dict.get("ms")))

	# One settle frame so the buffered events flush and their handlers run before
	# anything is read. Unconditional for every injecting type, never skipped
	# because the next action happens to be a wait: action i's result must not
	# depend on action i+1. A wait injects nothing, so it adds no settle frame
	# and its frame count is exactly the frames it waited.
	if type != "wait":
		await get_tree().process_frame

	# Read, then disconnect. Every post-read on the target is validity-guarded:
	# a handler is allowed to free the node it was fired from.
	var fired: Array = observed.duplicate()
	if not fired.is_empty():
		entry["signals"] = fired
	for signal_name in connections:
		var observer: Callable = connections[signal_name]
		if is_instance_valid(target) and target.is_connected(signal_name, observer):
			target.disconnect(signal_name, observer)

	if type == "click_element" or type == "mouse_button":
		var hit = _hit_control()
		if hit != null:
			var hit_control: Control = hit
			entry["hit"] = str(hit_control.get_path())
			# Occlusion answers "did something else take this click". Skipped
			# entirely when no hovered control is available (older engine), and
			# never used to infer the disabled case.
			if type == "click_element" and is_instance_valid(target):
				if not (target == hit_control or target.is_ancestor_of(hit_control)):
					entry["error"] = "occluded by %s" % str(hit_control.get_path())

	if type == "key" or type == "text":
		var focus_now := _focus_path()
		if focus_now != "":
			entry["focus"] = focus_now

	if type == "action":
		entry["pressed"] = Input.is_action_pressed(str(dict.get("action", "")))

	if type == "mouse_motion":
		var viewport := get_viewport()
		if viewport != null:
			entry["position"] = _serialize_value(viewport.get_mouse_position())

	if type == "text":
		var focus_node := _focus_owner()
		if focus_node is LineEdit:
			entry["value"] = _cut_text((focus_node as LineEdit).text, MAX_UI_TEXT_CHARS)
		elif focus_node is TextEdit:
			entry["value"] = _cut_text((focus_node as TextEdit).text, MAX_UI_TEXT_CHARS)

	var changes := _diff_ui(before, _snapshot_ui(), pre_focus, pre_scene)
	if not changes.is_empty():
		entry["changes"] = changes
	if not watch.is_empty():
		entry["watch"] = _sample_watch(watch)

	return _finish_entry(entry, batch_start_frame, batch_start_ms)

func _finish_entry(entry: Dictionary, batch_start_frame: int, batch_start_ms: int) -> Dictionary:
	entry["frame"] = Engine.get_process_frames() - batch_start_frame
	entry["elapsed_ms"] = Time.get_ticks_msec() - batch_start_ms
	entry["ok"] = not entry.has("error")
	return entry

# One lambda shape per signal arity: a Callable with fewer parameters than the
# signal emits errors at emit time, so a single zero-arg observer would break on
# toggled / item_selected / text_submitted.
func _make_signal_observer(signal_name: String, arity: int, sink: Array) -> Callable:
	match arity:
		0:
			return func() -> void: sink.append(signal_name)
		1:
			return func(_arg: Variant) -> void: sink.append(signal_name)
		_:
			return Callable()

func _update_held(held: Dictionary, key: String, pressed: bool) -> void:
	if pressed:
		held[key] = true
	else:
		held.erase(key)

# Tap hold. hold_ms wins when supplied and holds for at least that many
# wall-clock milliseconds. Otherwise key and action taps wait until
# one process frame AND one physics frame have both elapsed, because a render
# frame at high fps can contain zero physics ticks and code polling
# is_action_pressed in _physics_process would never see the press. Mouse taps
# keep a zero gap, which is what a real click looks like.
func _tap_hold(action: Dictionary, frame_gap: bool) -> void:
	if action.has("hold_ms"):
		await _wait_wall_clock_ms(float(action.get("hold_ms")))
		return
	if frame_gap:
		await get_tree().process_frame
		await get_tree().physics_frame

# Real-time pause of at least `requested_ms` wall-clock milliseconds, used by both
# the wait action's ms form and hold_ms tap holds.
#
# A SceneTreeTimer is deliberately NOT used here. It counts down accumulated
# process delta, which is not wall clock: frame-delta smoothing and clamping let
# the accumulated total run ahead of Time.get_ticks_msec(), so the timer can fire
# while less than the requested time has actually passed (observed: a 200 ms wait
# reporting 194 ms). A timer is also scaled by Engine.time_scale, so at a time
# scale of zero it never fires at all.
#
# Awaiting process_frame and comparing wall clock fixes both. process_frame is
# emitted every main-loop iteration regardless of SceneTree.paused and regardless
# of time_scale, and the comparison is against a monotonic clock nothing in the
# game can slow, so the loop always terminates. Overshoot is at most one frame,
# which the Node-side computed timeout already covers: computeInputTimeoutMs
# charges every action a pessimistic settle frame, and a wait action spends none.
func _wait_wall_clock_ms(requested_ms: float) -> void:
	# Ceil, not truncate: elapsed_ms is whole milliseconds, so a fractional
	# request has to clear the next whole millisecond to still read as >= itself.
	var required_ms := int(ceil(requested_ms))
	if required_ms <= 0:
		return
	var start_ms := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start_ms < required_ms:
		await get_tree().process_frame

func _inject_key(action: Dictionary, pressed: bool) -> void:
	var key_name := str(action.get("key", ""))
	var keycode := OS.find_keycode_from_string(key_name)
	var event := InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.pressed = pressed
	event.echo = false
	event.shift_pressed = action.get("shift", false)
	event.ctrl_pressed = action.get("ctrl", false)
	event.alt_pressed = action.get("alt", false)
	# Text-entry Controls (LineEdit, TextEdit) consume `event.unicode`, not just
	# the keycode - without it, typing into a focused LineEdit produces nothing.
	# Auto-derive for ASCII letters and digits; fall back to caller-supplied
	# `unicode` for symbols and non-ASCII.
	if action.has("unicode"):
		event.unicode = int(action.get("unicode"))
	elif keycode >= KEY_A and keycode <= KEY_Z:
		event.unicode = int(keycode) if event.shift_pressed else int(keycode) + 32
	elif keycode >= KEY_0 and keycode <= KEY_9:
		event.unicode = int(keycode)
	Input.parse_input_event(event)

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

func _inject_mouse_button(action: Dictionary, pressed: bool) -> void:
	var button_result := _resolve_button_name(str(action.get("button", "left")))
	var button_index: MouseButton = button_result[0]
	var pos := Vector2(action.get("x", 0), action.get("y", 0))
	var event := InputEventMouseButton.new()
	event.button_index = button_index
	event.pressed = pressed
	event.position = pos
	event.global_position = pos
	event.double_click = action.get("double_click", false)
	Input.parse_input_event(event)

func _inject_mouse_motion(action: Dictionary) -> void:
	var event = InputEventMouseMotion.new()
	event.position = Vector2(action.get("x", 0), action.get("y", 0))
	event.global_position = event.position
	event.relative = Vector2(action.get("relative_x", 0), action.get("relative_y", 0))
	Input.parse_input_event(event)

func _inject_action(action: Dictionary, pressed: bool) -> void:
	var action_name := str(action.get("action", ""))
	if pressed:
		Input.action_press(action_name, float(action.get("strength", 1.0)))
	else:
		Input.action_release(action_name)

func _inject_click_element(action: Dictionary, target: Control, pressed: bool) -> void:
	var button_result := _resolve_button_name(str(action.get("button", "left")))
	var button_index: MouseButton = button_result[0]
	var center := target.get_global_rect().get_center()
	var event := InputEventMouseButton.new()
	event.button_index = button_index
	event.pressed = pressed
	event.position = center
	event.global_position = center
	event.double_click = action.get("double_click", false)
	Input.parse_input_event(event)

# One press+release pair per character with `unicode` set, queued in a single
# pass with no interleaved frames: parse_input_event preserves submission order
# and the focused LineEdit / TextEdit consumes the pairs in that order when the
# queue flushes.
func _inject_text(text: String) -> void:
	for i in text.length():
		var character := text.substr(i, 1)
		var code := text.unicode_at(i)
		# A real keystroke carries a keycode alongside the unicode; derive one
		# where the character has an obvious key and leave it unset otherwise
		# (a space or a symbol still types, since text entry reads unicode).
		var keycode := OS.find_keycode_from_string(character.to_upper())
		var press := InputEventKey.new()
		press.keycode = keycode
		press.physical_keycode = keycode
		press.unicode = code
		press.pressed = true
		press.echo = false
		Input.parse_input_event(press)
		var release := InputEventKey.new()
		release.keycode = keycode
		release.physical_keycode = keycode
		release.unicode = code
		release.pressed = false
		release.echo = false
		Input.parse_input_event(release)

# --- Input Observation ---

# path -> {text, disabled} over the same visible-only walk get_ui_elements uses,
# so the UI delta and the element listing can never disagree about what is
# visible. Deliberately not a second tree walk.
func _snapshot_ui() -> Dictionary:
	var elements: Array[Dictionary] = []
	_collect_control_nodes(get_tree().root, elements, true, "")
	var snapshot := {}
	for element in elements:
		snapshot[element["path"]] = {
			"text": element.get("text", ""),
			"disabled": element.get("disabled", false),
		}
	return snapshot

func _diff_ui(before: Dictionary, after: Dictionary, pre_focus: String, pre_scene: String) -> Dictionary:
	var appeared: Array = []
	var disappeared: Array = []
	var changed: Array = []

	for path in after:
		if not before.has(path):
			appeared.append(path)
			continue
		var was: Dictionary = before[path]
		var now: Dictionary = after[path]
		var delta := {"path": path}
		if was.get("text", "") != now.get("text", ""):
			delta["text"] = _cut_text(str(now.get("text", "")), MAX_UI_TEXT_CHARS)
		if was.get("disabled", false) != now.get("disabled", false):
			delta["disabled"] = now.get("disabled", false)
		if delta.size() > 1:
			changed.append(delta)

	for path in before:
		if not after.has(path):
			disappeared.append(path)

	var changes := {}
	var dropped := 0
	dropped += _put_capped(changes, "appeared", _collapse_subtrees(appeared))
	dropped += _put_capped(changes, "disappeared", _collapse_subtrees(disappeared))
	dropped += _put_capped(changes, "changed", changed)

	var scene_now := _current_scene_path()
	if scene_now != pre_scene:
		changes["scene"] = scene_now
	var focus_now := _focus_path()
	if focus_now != pre_focus:
		changes["focus"] = focus_now
	if dropped > 0:
		changes["truncated"] = dropped
	return changes

# Writes `values` under `key` capped at MAX_UI_DELTA_ENTRIES and returns how many
# entries were dropped, which the caller sums into `truncated`.
func _put_capped(changes: Dictionary, key: String, values: Array) -> int:
	if values.is_empty():
		return 0
	if values.size() <= MAX_UI_DELTA_ENTRIES:
		changes[key] = values
		return 0
	changes[key] = values.slice(0, MAX_UI_DELTA_ENTRIES)
	return values.size() - MAX_UI_DELTA_ENTRIES

# Drops any path that has an ancestor in the same list, so an overlay opening
# reports one path instead of every Control under it. Quadratic, but bounded by
# the number of visible Controls that changed in a single action.
func _collapse_subtrees(paths: Array) -> Array:
	var kept: Array = []
	for path in paths:
		var path_text := str(path)
		var has_ancestor := false
		for other in paths:
			var other_text := str(other)
			if other_text != path_text and path_text.begins_with(other_text + "/"):
				has_ancestor = true
				break
		if not has_ancestor:
			kept.append(path_text)
	return kept

# Splits a watch spec on its first ":" into [node path, property path]. Returns
# an empty Array when either part is missing, which is what pre-validation keys
# on. The property part keeps any further ":" so subnames such as "position:x"
# reach get_indexed intact.
func _split_watch_spec(spec: Variant) -> Array:
	if typeof(spec) != TYPE_STRING:
		return []
	var text: String = spec
	var separator := text.find(":")
	if separator <= 0 or separator >= text.length() - 1:
		return []
	return [text.substr(0, separator), text.substr(separator + 1)]

# Watch samples are read-only and never fail a batch: an unresolvable node or
# property reports null for that key.
func _sample_watch(watch: Array) -> Dictionary:
	var samples := {}
	for spec in watch:
		var key := str(spec)
		samples[key] = _sample_one_watch(spec)
	return samples

func _sample_one_watch(spec: Variant) -> Variant:
	var parts := _split_watch_spec(spec)
	if parts.is_empty():
		return null
	var node := get_tree().root.get_node_or_null(NodePath(str(parts[0])))
	if node == null:
		return null
	return _serialize_sample(node.get_indexed(NodePath(str(parts[1]))))

# --- Profiler track ---

# Samples the given NodePath:property specs every interval_ms until track_stop
# or max_ms, replacing any track already running. Each sample carries the engine
# process frame, the same counter the profiler's frames are numbered by, so the
# Node side can place it on a capture's timeline exactly. Sampling runs from
# _process, so it keeps going while an input batch holds the peer.
func _handle_track_start(peer: PeerState, payload: Dictionary) -> void:
	var watch = payload.get("watch", [])
	if typeof(watch) != TYPE_ARRAY or (watch as Array).is_empty():
		_send_response(peer, {"error": "watch must be a non-empty array of NodePath:property strings"})
		return
	var watch_list: Array = watch
	if watch_list.size() > MAX_TRACK_ENTRIES:
		_send_response(peer, {"error": "track accepts at most %d entries (got %d)" % [MAX_TRACK_ENTRIES, watch_list.size()]})
		return
	for i in watch_list.size():
		if _split_watch_spec(watch_list[i]).is_empty():
			_send_response(peer, {"error": "track[%d]: expected NodePath:property (got '%s')" % [i, str(watch_list[i])]})
			return
	var interval = payload.get("interval_ms", DEFAULT_TRACK_INTERVAL_MS)
	var duration = payload.get("max_ms", DEFAULT_TRACK_DURATION_MS)
	if not _is_number(interval) or not _is_number(duration):
		_send_response(peer, {"error": "interval_ms and max_ms must be numbers"})
		return
	var now := Time.get_ticks_msec()
	_track_active = true
	_track_watch = watch_list.duplicate()
	_track_interval_ms = maxi(int(interval), MIN_TRACK_INTERVAL_MS)
	_track_next_ms = now
	_track_until_ms = now + clampi(int(duration), MIN_TRACK_INTERVAL_MS, MAX_TRACK_DURATION_MS)
	_track_samples = []
	_track_non_finite = 0
	_send_response(peer, {"status": "tracking"})

# Hands the samples over once. A second track_stop, or one after another call
# replaced the track, is an error rather than an empty list, so a capture
# whose track was lost says so instead of looking like nothing was sampled.
func _handle_track_stop(peer: PeerState) -> void:
	if not _track_active:
		_send_response(peer, {"error": "No track is running: it was stopped or replaced by another profiler call before this capture collected it"})
		return
	var samples := _track_samples
	_track_active = false
	_track_watch = []
	_track_samples = []
	_non_finite_count += _track_non_finite
	_track_non_finite = 0
	_send_response(peer, {"samples": samples})

# Past max_ms, or once the buffer is full, the samples are kept for track_stop
# and nothing new is taken: a track nobody stops cannot grow without bound.
func _poll_track() -> void:
	var now := Time.get_ticks_msec()
	if now >= _track_until_ms or _track_samples.size() >= MAX_TRACK_SAMPLES:
		_track_watch = []
		return
	if now < _track_next_ms:
		return
	_track_next_ms = now + _track_interval_ms
	var tally_before := _non_finite_count
	var values := _sample_watch(_track_watch)
	_track_non_finite += _non_finite_count - tally_before
	_non_finite_count = tally_before
	_track_samples.append({"frame": Engine.get_process_frames(), "values": values})

# The Control under the mouse after the settle frame. Reached through call() so
# this script still parses on 4.x builds that predate the method; has_method
# gates whether it runs at all, and callers omit `hit` when this returns null.
func _hit_control() -> Variant:
	var viewport := get_viewport()
	if viewport == null or not viewport.has_method("gui_get_hovered_control"):
		return null
	var hovered = viewport.call("gui_get_hovered_control")
	# is_instance_valid as well as a null test: the hovered control can itself be
	# a node an input handler freed during this action, and a freed Object does
	# not compare equal to null. Reading get_path() off one would take the whole
	# coroutine down, so the field is omitted instead.
	if hovered == null or not is_instance_valid(hovered):
		return null
	return hovered

func _focus_owner() -> Control:
	var viewport := get_viewport()
	if viewport == null:
		return null
	return viewport.gui_get_focus_owner()

func _focus_path() -> String:
	var focus_node := _focus_owner()
	if focus_node == null:
		return ""
	return str(focus_node.get_path())

func _current_scene_path() -> String:
	var scene := get_tree().current_scene
	if scene == null:
		return ""
	return str(scene.get_path())

# --- UI Element Discovery ---

func _handle_get_ui_elements(peer: PeerState, payload: Dictionary) -> void:
	var visible_only: bool = payload.get("visible_only", true)
	var type_filter: String = payload.get("type_filter", "")
	# is_class() below matches native class names only, so a name that is not
	# a Control class can never match. Answering that with an empty list would
	# read as "this scene has no such controls".
	if type_filter != "":
		if not ClassDB.class_exists(type_filter):
			_send_response(peer, {"error": "Unknown class for filter: '%s'. filter matches native Godot class names such as Button or Label; a script class_name is not matched." % type_filter})
			return
		# A class Control inherits from (CanvasItem, Node, Object) is true of every
		# Control, so it lists them all. Only a class on another branch can match
		# nothing.
		var names_a_control: bool = (
			type_filter == "Control"
			or ClassDB.is_parent_class(type_filter, "Control")
			or ClassDB.is_parent_class("Control", type_filter)
		)
		if not names_a_control:
			_send_response(peer, {"error": "filter '%s' is not a Control class" % type_filter})
			return
	var root := get_tree().root
	var elements: Array[Dictionary] = []
	_collect_control_nodes(root, elements, visible_only, type_filter)
	_send_response(peer, {"elements": elements})

# A rect number as JSON can carry it. Not _finite_or_null: this walk also runs for
# every input action's UI snapshot, where a count would land on a reply with no rect in it.
func _rect_number(number: float) -> Variant:
	return number if is_finite(number) else null

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
				"x": _rect_number(rect.position.x),
				"y": _rect_number(rect.position.y),
				"width": _rect_number(rect.size.x),
				"height": _rect_number(rect.size.y),
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

	# Everything that would make new() or the execute call raise is refused
	# here, from the compiled script's own method list. A raise in this handler
	# sends no response, and the client then waits out its whole timeout.
	var signature_problem := _run_script_signature_problem(script)
	if signature_problem != "":
		_send_response(peer, {"error": signature_problem})
		return

	# Instantiate and validate
	var instance = script.new()
	if instance == null:
		_send_response(peer, {"error": "Failed to instantiate script"})
		return

	if not instance.has_method(RUN_SCRIPT_ENTRY_METHOD):
		if instance is RefCounted:
			instance = null  # Let RefCounted free itself
		else:
			instance.free()
		_send_response(peer, {"error": RUN_SCRIPT_ENTRY_MISSING_ERROR})
		return

	# Execute (await in case the user's script uses async/await internally)
	# The argument list here is what RUN_SCRIPT_ENTRY_ARGUMENT_COUNT states.
	var result = await instance.execute(get_tree())

	# Clean up
	if instance is RefCounted:
		instance = null
	else:
		instance.free()

	# Serialize and respond
	var serialized = _serialize_value(result)
	_send_response(peer, {"success": true, "result": serialized})

# The first entry named `method_name` in a script's method list, or {} when it
# declares none. The list runs from the script itself to its base scripts, so
# the first match is the one a call reaches.
func _script_method_info(script: Script, method_name: String) -> Dictionary:
	var methods: Array = script.get_script_method_list()
	for method in methods:
		if typeof(method) == TYPE_DICTIONARY and str(method.get("name", "")) == method_name:
			return method
	return {}

# How many arguments a call to `method` has to pass: those with no default.
# Default values are listed by editor builds only, so any other build answers 0
# rather than count an optional argument as a required one.
func _required_argument_count(method: Dictionary) -> int:
	if not OS.has_feature("editor"):
		return 0
	var declared = method.get("args", [])
	var defaults = method.get("default_args", [])
	if typeof(declared) != TYPE_ARRAY or typeof(defaults) != TYPE_ARRAY:
		return 0
	return maxi(declared.size() - defaults.size(), 0)

# Why a compiled run_script source cannot be instantiated with no argument and
# then called as execute(scene_tree), or "" when it can. Reads only the method
# list, so nothing of the script runs.
func _run_script_signature_problem(script: GDScript) -> String:
	if not script.can_instantiate():
		return "Script cannot be instantiated (an abstract class?). %s" % RUN_SCRIPT_ENTRY_MISSING_ERROR

	var initializer := _script_method_info(script, RUN_SCRIPT_INIT_METHOD)
	if not initializer.is_empty() and _required_argument_count(initializer) > 0:
		return "Script's _init takes %d required argument(s); run_script creates the script with none. Remove the parameters or give them defaults." % _required_argument_count(initializer)

	var entry := _script_method_info(script, RUN_SCRIPT_ENTRY_METHOD)
	if entry.is_empty():
		# Not declared by the script or its base scripts. has_method on the
		# instance answers for a native method of that name.
		return ""
	var declared = entry.get("args", null)
	if typeof(declared) != TYPE_ARRAY:
		return ""
	var required := _required_argument_count(entry)
	if declared.size() < RUN_SCRIPT_ENTRY_ARGUMENT_COUNT or required > RUN_SCRIPT_ENTRY_ARGUMENT_COUNT:
		return "execute is called with exactly one argument, the SceneTree, and this script's execute declares %d parameter(s), %d of them required. %s" % [declared.size(), required, RUN_SCRIPT_ENTRY_MISSING_ERROR]

	var parameter = declared[0]
	if typeof(parameter) == TYPE_DICTIONARY:
		var parameter_type: int = int(parameter.get("type", TYPE_NIL))
		var parameter_class := str(parameter.get("class_name", ""))
		var accepts_scene_tree := true
		if parameter_type == TYPE_OBJECT:
			# A class ClassDB does not know is a script class, which a game's
			# own SceneTree subclass can be: left to the call.
			if parameter_class != "" and ClassDB.class_exists(parameter_class):
				accepts_scene_tree = ClassDB.is_parent_class("SceneTree", parameter_class)
		elif parameter_type != TYPE_NIL:
			accepts_scene_tree = false
		if not accepts_scene_tree:
			var shown_type := parameter_class if parameter_class != "" else type_string(parameter_type)
			return "execute's parameter is typed %s, which cannot hold the SceneTree it is called with. %s" % [shown_type, RUN_SCRIPT_ENTRY_MISSING_ERROR]
	return ""

# A value the caller asked for once (a run_script result, a mouse position):
# bounded in depth, total container elements and string length, generously.
# See MAX_RESULT_DEPTH.
func _serialize_value(value: Variant) -> Variant:
	_serialize_depth_limit = MAX_RESULT_DEPTH
	_serialize_elements_left = MAX_RESULT_ELEMENTS
	_serialize_string_limit = MAX_RESULT_STRING_CHARS
	_serialize_path.clear()
	return _serialize_bounded(value, 0)

# A watch or track sample: the same three bounds, tightly. See MAX_SAMPLE_DEPTH.
func _serialize_sample(value: Variant) -> Variant:
	_serialize_depth_limit = MAX_SAMPLE_DEPTH
	_serialize_elements_left = MAX_SAMPLE_ELEMENTS
	_serialize_string_limit = MAX_SAMPLE_STRING_CHARS
	_serialize_path.clear()
	return _serialize_bounded(value, 0)

# JSON has no INF or NAN. A float that is neither finite goes out as null and is
# counted, so the reply can say so (see NON_FINITE_COUNT_FIELD).
func _finite_or_null(number: float) -> Variant:
	if is_finite(number):
		return number
	_non_finite_count += 1
	return null

# Cuts text to `limit` characters, with the number of characters cut.
func _cut_text(text: String, limit: int) -> String:
	if text.length() <= limit:
		return text
	return text.substr(0, limit) + TRUNCATED_STRING_MARKER % (text.length() - limit)

# Cuts text to the string limit of the serialization in progress.
func _bound_text(text: String) -> String:
	return _cut_text(text, _serialize_string_limit)

# True when one more container element may be serialized, and counts it.
func _take_serialize_element() -> bool:
	if _serialize_elements_left <= 0:
		return false
	_serialize_elements_left -= 1
	return true

# True when `container` is one the walk is already inside. Compared by
# identity: == on two containers compares their contents, which for a container
# that holds itself is the very recursion this exists to stop.
func _on_serialize_path(container: Variant) -> bool:
	for ancestor in _serialize_path:
		if is_same(ancestor, container):
			return true
	return false

# `depth` is how many containers enclose `value`. Call through _serialize_value
# or _serialize_sample, which set the bounds this reads.
func _serialize_bounded(value: Variant, depth: int) -> Variant:
	if value == null:
		return null

	match typeof(value):
		TYPE_BOOL, TYPE_INT:
			return value
		TYPE_FLOAT:
			return _finite_or_null(value)
		TYPE_STRING:
			var text: String = value
			return _bound_text(text)
		TYPE_VECTOR2:
			var v: Vector2 = value
			return {"x": _finite_or_null(v.x), "y": _finite_or_null(v.y)}
		TYPE_VECTOR2I:
			var v: Vector2i = value
			return {"x": v.x, "y": v.y}
		TYPE_VECTOR3:
			var v: Vector3 = value
			return {"x": _finite_or_null(v.x), "y": _finite_or_null(v.y), "z": _finite_or_null(v.z)}
		TYPE_VECTOR3I:
			var v: Vector3i = value
			return {"x": v.x, "y": v.y, "z": v.z}
		TYPE_COLOR:
			var c: Color = value
			return {"r": _finite_or_null(c.r), "g": _finite_or_null(c.g), "b": _finite_or_null(c.b), "a": _finite_or_null(c.a)}
		TYPE_DICTIONARY:
			if depth >= _serialize_depth_limit:
				return TRUNCATED_DEPTH_MARKER % _serialize_depth_limit
			var d: Dictionary = value
			if _on_serialize_path(d):
				return TRUNCATED_CYCLE_MARKER
			_serialize_path.append(d)
			var result := {}
			var taken := 0
			for key in d:
				if not _take_serialize_element():
					result[TRUNCATED_ENTRIES_KEY] = TRUNCATED_ENTRIES_MARKER % (d.size() - taken)
					break
				result[_bound_text(str(key))] = _serialize_bounded(d[key], depth + 1)
				taken += 1
			_serialize_path.pop_back()
			return result
		TYPE_ARRAY:
			if depth >= _serialize_depth_limit:
				return TRUNCATED_DEPTH_MARKER % _serialize_depth_limit
			var a: Array = value
			if _on_serialize_path(a):
				return TRUNCATED_CYCLE_MARKER
			_serialize_path.append(a)
			var result := []
			for i in a.size():
				if not _take_serialize_element():
					result.append(TRUNCATED_ELEMENTS_MARKER % (a.size() - i))
					break
				result.append(_serialize_bounded(a[i], depth + 1))
			_serialize_path.pop_back()
			return result
		TYPE_OBJECT:
			# A freed Object is not null, and `is` raises on one. A profiler track
			# samples from _process, where that would raise on every tick. The
			# text is what str() gives a freed Object.
			if not is_instance_valid(value):
				return "<Freed Object>"
			if value is Node:
				var node: Node = value
				# get_path() on a node outside the tree prints an engine error
				# and returns the empty path, so that case gives "" without
				# the call: a tracked property would log it on every sample.
				var node_path := str(node.get_path()) if node.is_inside_tree() else ""
				return {"class": node.get_class(), "name": String(node.name), "path": node_path}
			elif value is Resource:
				var res: Resource = value
				return {"class": res.get_class(), "path": res.resource_path}
			else:
				return _bound_text(str(value))
		_:
			# Everything else goes out as text, the packed arrays included, so
			# the string limit is what bounds a sampled PackedByteArray.
			return _bound_text(str(value))

# --- Shutdown ---

func _handle_shutdown(peer: PeerState) -> void:
	_shutting_down = true
	_send_response(peer, {"status": "shutting_down"})
	# Let the response flush before we tear the listener down. A new command
	# arriving in this 2-frame window would dispatch against a peer that's
	# about to close; the response write fails gracefully and the Node side
	# sees BridgeDisconnectedError. The Node side sends one command at a time and
	# sends nothing after a shutdown, so this is theoretical.
	await get_tree().process_frame
	await get_tree().process_frame
	_close_all_peers()
	if tcp_server != null:
		tcp_server.stop()
	# Detach from the tree so subsequent _process ticks don't run.
	queue_free()

# --- Utility ---

func _send_response(peer: PeerState, data: Dictionary) -> void:
	if _non_finite_count > 0:
		data[NON_FINITE_COUNT_FIELD] = _non_finite_count
	_non_finite_count = 0
	var resp := JSON.stringify(data)
	var body := resp.to_utf8_buffer()
	if body.size() > MAX_FRAME_BYTES:
		# The caller is waiting on a reply. Sending none would leave it to wait
		# out its whole timeout and conclude the game had stopped, so it gets a
		# small error naming the size instead.
		push_error("McpBridge: Response of %d bytes exceeds %d; sending an error in its place" % [body.size(), MAX_FRAME_BYTES])
		body = JSON.stringify({"error": OVERSIZE_RESPONSE_ERROR % [body.size(), MAX_FRAME_BYTES], OVERSIZE_RESPONSE_FIELD: true}).to_utf8_buffer()
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
	if not _shutting_down:
		push_warning("McpBridge: removed from tree without shutdown - bridge connection will be lost")
	_close_all_peers()
	if tcp_server != null:
		tcp_server.stop()
		tcp_server = null
		print("McpBridge: Stopped")
