extends Node2D

@export var speed: float = 1.0
@export var note: String = ""

func bonus() -> int:
	return GameState.score
