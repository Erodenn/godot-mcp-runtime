extends Control

const GROW_HEIGHT := 120.0

# Press counts the tests read through run_script: a click that reaches the wrong control must show here.
var target_presses := 0
var occluder_presses := 0
var row_one_presses := 0
var row_two_presses := 0
var blocker_presses := 0


func _ready() -> void:
	(get_node("Target") as Button).pressed.connect(func() -> void: target_presses += 1)
	(get_node("Occluder") as Button).pressed.connect(func() -> void: occluder_presses += 1)
	(get_node("Rows/RowOne") as Button).pressed.connect(_on_row_one_pressed)
	(get_node("Rows/RowTwo") as Button).pressed.connect(func() -> void: row_two_presses += 1)
	(get_node("Blocker") as Button).pressed.connect(func() -> void: blocker_presses += 1)


# Grows the first row so the container moves the second one down, and reveals a blocker where the second row was.
func _on_row_one_pressed() -> void:
	row_one_presses += 1
	var row_one := get_node("Rows/RowOne") as Button
	row_one.custom_minimum_size.y = GROW_HEIGHT
	(get_node("Blocker") as Button).visible = true
