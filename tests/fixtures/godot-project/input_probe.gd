extends Node

# Fixture for the simulate_input integration tests. Every handler here exists
# to produce exactly one observable effect a test can assert on. Keep it
# minimal: it has to be readable by someone debugging a failing assertion.

const MOVE_STEP := 8.0


func _ready() -> void:
	(get_node("PanelBtn") as Button).pressed.connect(_on_panel_pressed)
	(get_node("ErrorBtn") as Button).pressed.connect(_on_error_pressed)
	(get_node("FreeMe/FreeSelfBtn") as Button).pressed.connect(_on_free_self_pressed)


# Polled in both loops: a key tap holds for one process frame and one physics
# frame, and either loop alone could be the one that runs during the hold.
func _process(_delta: float) -> void:
	_poll_move()


func _physics_process(_delta: float) -> void:
	_poll_move()


func _poll_move() -> void:
	if not Input.is_action_pressed("probe_move"):
		return
	var mover := get_node_or_null("Mover") as Node2D
	if mover != null:
		mover.position.x += MOVE_STEP


func _on_panel_pressed() -> void:
	var panel := get_node_or_null("HiddenPanel") as Control
	if panel != null:
		panel.visible = true


# A genuine runtime script error, not push_error: only SCRIPT ERROR lines are
# captured as per-action errors.
func _on_error_pressed() -> void:
	var empty: Array = []
	var idx := 5
	print(empty[idx])


func _on_free_self_pressed() -> void:
	var box := get_node_or_null("FreeMe")
	if box != null:
		box.queue_free()
