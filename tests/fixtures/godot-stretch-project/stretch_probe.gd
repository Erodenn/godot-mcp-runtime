extends Control

# Read back through run_script after a click; the test never trusts a signal list alone.
var press_count: int = 0
var ghost_press_count: int = 0


func _ready() -> void:
	(get_node("ClickBtn") as Button).pressed.connect(_on_click_pressed)
	(get_node("GhostBtn") as Button).pressed.connect(_on_ghost_pressed)


func _on_click_pressed() -> void:
	press_count += 1


func _on_ghost_pressed() -> void:
	ghost_press_count += 1
