extends Node

@export var stock: Dictionary[String, int] = {}
@export var by_id: Dictionary[int, float] = {}
@export var cell: Vector2i = Vector2i.ZERO
@export var bytes: PackedByteArray = PackedByteArray()
@export var ids32: PackedInt32Array = PackedInt32Array()
