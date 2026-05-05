// Debug mode from environment
const DEBUG_MODE = process.env.DEBUG === 'true';

export function logDebug(message: string): void {
  if (DEBUG_MODE) {
    console.error(`[DEBUG] ${message}`);
  }
}

export function logError(message: string): void {
  console.error(`[SERVER] ${message}`);
}
