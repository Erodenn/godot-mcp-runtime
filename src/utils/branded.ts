/** Nominal types for strings carrying validation invariants: the `__brand` phantom field blocks assigning arbitrary strings, and the only casts live in the `arg-parsing.ts` parsers. */

export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };

export type ProjectPath = Brand<string, 'ProjectPath'>;
export type ScenePath = Brand<string, 'ScenePath'>;
export type NodePath = Brand<string, 'NodePath'>;
