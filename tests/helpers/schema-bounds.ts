import type { ToolDefinition } from '../../src/mcp.types.js';

export interface NumericSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

export interface BoundedInput {
  /** `tool.property`, with `[]` for array items: `simulate_input.actions[].hold_ms`. */
  id: string;
  tool: string;
  schema: NumericSchema;
}

const EXCLUSIVE_INSIDE_STEP = 0.001;
const NUMBER_OUTSIDE_STEP = 0.5;
const INTEGER_OUTSIDE_STEP = 1;
const FRACTION = 0.5;

function hasBound(schema: NumericSchema): boolean {
  return (
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.exclusiveMinimum !== undefined
  );
}

function walk(node: unknown, trail: string, tool: string, out: BoundedInput[]): void {
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === 'object' && properties !== null) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const id = `${trail}.${name}`;
      const schema = child as NumericSchema;
      if ((schema.type === 'number' || schema.type === 'integer') && hasBound(schema)) {
        out.push({ id, tool, schema });
      }
      walk(child, id, tool, out);
    }
  }
  const items = record.items;
  if (typeof items === 'object' && items !== null) walk(items, `${trail}[]`, tool, out);
}

/** Every number or integer input that declares a minimum, maximum or exclusiveMinimum, at any depth. */
export function collectBoundedInputs(definitions: readonly ToolDefinition[]): BoundedInput[] {
  const out: BoundedInput[] = [];
  for (const definition of definitions) {
    walk(definition.inputSchema, definition.name, definition.name, out);
  }
  return out;
}

export interface BoundProbes {
  /** Values the schema range admits, at each edge. */
  inside: number[];
  /** Values just past each edge. */
  outside: number[];
  /** A value inside the range that is not a whole number; set only for an `integer` input. */
  fraction: number | null;
}

export function probesFor(schema: NumericSchema): BoundProbes {
  const outsideStep = schema.type === 'integer' ? INTEGER_OUTSIDE_STEP : NUMBER_OUTSIDE_STEP;
  const insideStep = schema.type === 'integer' ? INTEGER_OUTSIDE_STEP : EXCLUSIVE_INSIDE_STEP;
  const inside: number[] = [];
  const outside: number[] = [];
  let lowestInside: number | null = null;
  if (schema.minimum !== undefined) {
    inside.push(schema.minimum);
    outside.push(schema.minimum - outsideStep);
    lowestInside = schema.minimum;
  }
  if (schema.exclusiveMinimum !== undefined) {
    const first = schema.exclusiveMinimum + insideStep;
    inside.push(first);
    outside.push(schema.exclusiveMinimum);
    lowestInside = first;
  }
  if (schema.maximum !== undefined) {
    inside.push(schema.maximum);
    outside.push(schema.maximum + outsideStep);
  }
  return {
    inside,
    outside,
    fraction: schema.type === 'integer' && lowestInside !== null ? lowestInside + FRACTION : null,
  };
}
