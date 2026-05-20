import { normalize } from 'path';

/**
 * Normalize a path for cross-platform comparison.
 * Folds Windows backslashes to forward slashes and strips trailing slashes,
 * so Node's `path.normalize` output matches Godot's `globalize_path("res://")`.
 */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Extract JSON from Godot output by finding the first { or [ and matching to the end.
 * This strips debug logs, version banners, and other noise.
 */
export function extractJson(output: string): string {
  // Find the first occurrence of { or [
  const jsonStartBrace = output.indexOf('{');
  const jsonStartBracket = output.indexOf('[');

  let jsonStart = -1;
  if (jsonStartBrace === -1 && jsonStartBracket === -1) {
    return output; // No JSON found, return as-is
  } else if (jsonStartBrace === -1) {
    jsonStart = jsonStartBracket;
  } else if (jsonStartBracket === -1) {
    jsonStart = jsonStartBrace;
  } else {
    jsonStart = Math.min(jsonStartBrace, jsonStartBracket);
  }

  // Extract from JSON start to end
  const jsonPart = output.substring(jsonStart);

  // Try to parse to validate, if it fails return original
  try {
    JSON.parse(jsonPart.trim());
    return jsonPart.trim();
  } catch {
    // If the extracted part isn't valid JSON, try to find the last } or ]
    const lastBrace = jsonPart.lastIndexOf('}');
    const lastBracket = jsonPart.lastIndexOf(']');
    const lastEnd = Math.max(lastBrace, lastBracket);

    if (lastEnd > 0) {
      const extracted = jsonPart.substring(0, lastEnd + 1);
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        return output; // Return original if still can't parse
      }
    }
    return output;
  }
}

/**
 * Strip Godot banner and debug lines from output, keeping only meaningful content.
 */
export function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) return false;
    // Skip Godot version banner
    if (trimmed.startsWith('Godot Engine v')) return false;
    // Skip debug lines
    if (trimmed.startsWith('[DEBUG]')) return false;
    // Skip info lines that are just status updates
    if (trimmed.startsWith('[INFO] Operation:')) return false;
    if (trimmed.startsWith('[INFO] Executing operation:')) return false;
    return true;
  });
  return cleanedLines.join('\n');
}

export function cleanStdout(stdout: string): string {
  if (stdout.includes('{') || stdout.includes('[')) {
    return extractJson(stdout);
  }
  return cleanOutput(stdout);
}
