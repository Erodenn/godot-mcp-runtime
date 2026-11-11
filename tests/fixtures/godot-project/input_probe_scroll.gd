extends Control

# Press counts by button name, read through run_script: a click that reaches the wrong button, or none, must show here.
var presses: Dictionary = {}


func _ready() -> void:
	for node: Node in find_children("*", "Button", true, false):
		(node as Button).pressed.connect(_on_pressed.bind(String(node.name)))


func _on_pressed(button_name: String) -> void:
	presses[button_name] = int(presses.get(button_name, 0)) + 1
