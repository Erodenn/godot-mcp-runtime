extends Control

const CONTENT_SCALE_FACTOR: float = 0.7

# Read back through run_script after a click; a press on a neighbour shows up as a count on the wrong button.
var left_presses: int = 0
var middle_presses: int = 0
var right_presses: int = 0


func _ready() -> void:
	get_window().content_scale_factor = CONTENT_SCALE_FACTOR
	(get_node("LeftBtn") as Button).pressed.connect(_on_left_pressed)
	(get_node("MiddleBtn") as Button).pressed.connect(_on_middle_pressed)
	(get_node("RightBtn") as Button).pressed.connect(_on_right_pressed)


func _on_left_pressed() -> void:
	left_presses += 1


func _on_middle_pressed() -> void:
	middle_presses += 1


func _on_right_pressed() -> void:
	right_presses += 1
