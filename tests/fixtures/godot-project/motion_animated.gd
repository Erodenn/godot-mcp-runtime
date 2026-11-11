extends Node2D

# Fixture for the render_movie motion tests: the Mover rect travels right by a
# fixed step every process frame, so any two frames of a movie run differ.

const STEP_PX := 24.0


func _process(_delta: float) -> void:
	var mover := get_node_or_null("Mover") as ColorRect
	if mover != null:
		mover.position.x += STEP_PX
