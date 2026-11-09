extends Control

# Read back through run_script after a click; the test never trusts a signal list alone.
var layered_presses: int = 0
var decoy_presses: int = 0
var plain_presses: int = 0


func _ready() -> void:
	(get_node("Layer/LayeredBtn") as Button).pressed.connect(_on_layered_pressed)
	(get_node("DecoyBtn") as Button).pressed.connect(_on_decoy_pressed)
	(get_node("PlainBtn") as Button).pressed.connect(_on_plain_pressed)


func _on_layered_pressed() -> void:
	layered_presses += 1


func _on_decoy_pressed() -> void:
	decoy_presses += 1


func _on_plain_pressed() -> void:
	plain_presses += 1
