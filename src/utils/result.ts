/**
 * Unified Result shape used across the handler/parser/dispatch boundary.
 *
 * Replaces the two divergent conventions that grew up before this:
 *  - `'isError' in v` discriminator on validators in `error-response.ts`.
 *  - Local `ParseResult<T>` in `runtime-tools.ts` (`parseBridgeJson`).
 *
 * Both collapse into `{ ok: true; value: T } | { ok: false; error: E }` so
 * handlers, parsers, and the dispatch edge can compose without re-implementing
 * the discriminator in each module.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;
