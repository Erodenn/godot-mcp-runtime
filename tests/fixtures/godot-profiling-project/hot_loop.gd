extends Node2D

# Deliberately expensive per frame so `burn` dominates any profiler capture.
func _process(_delta: float) -> void:
	burn(20000)


func burn(iterations: int) -> float:
	var total := 0.0
	for i in iterations:
		total += sqrt(float(i))
	return total
