/**
 * Shared PNG fixtures for the cold-import integration tests
 * (reactive-import.test.ts, batch-import-prepass.test.ts).
 */

/** 1x1 transparent PNG. */
export function minimalPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Garbage bytes with a .png extension -- import fails but writes an .import sidecar. */
export function invalidPng(): Buffer {
  return Buffer.from('this is not a png at all');
}
