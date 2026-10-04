extends Node2D

@export var speed: float = 1.0

func _ready():
	print(NotDeclaredAnywhere.value)
