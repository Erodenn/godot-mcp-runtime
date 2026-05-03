import { readFileSync, writeFileSync } from 'fs';

/**
 * Parsing and editing primitives for the `[autoload]` section of project.godot.
 *
 * Used by:
 *  - tools/autoload-tools.ts — list/add/remove/update_autoload handlers
 *  - utils/bridge-manager.ts — McpBridge inject/cleanup/repair
 *
 * Pure functions: each takes the absolute path to project.godot and returns
 * either parsed data or a boolean indicating whether the file was mutated.
 */

export interface AutoloadEntry {
  name: string;
  path: string;
  singleton: boolean;
}

/**
 * Matches an empty `[autoload]` section (the header followed by only blank
 * lines, up to the next section header or end-of-file). Used by cleanup paths
 * to drop the section after the last entry is removed.
 */
export const EMPTY_AUTOLOAD_SECTION_REGEX = /\[autoload\]\s*(?=\n\[|\n*$)/g;

export function normalizeAutoloadPath(p: string): string {
  return p.startsWith('res://') ? p : `res://${p}`;
}

export function parseAutoloads(projectFilePath: string): AutoloadEntry[] {
  const content = readFileSync(projectFilePath, 'utf8');
  const autoloads: AutoloadEntry[] = [];
  let inAutoloadSection = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inAutoloadSection = trimmed === '[autoload]';
      continue;
    }
    if (!inAutoloadSection || trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#'))
      continue;
    const match = trimmed.match(/^(\w+)="(\*?)([^"]*)"$/);
    if (match) {
      autoloads.push({ name: match[1], singleton: match[2] === '*', path: match[3] });
    }
  }
  return autoloads;
}

export function addAutoloadEntry(
  projectFilePath: string,
  name: string,
  path: string,
  singleton: boolean,
): void {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  const entry = `${name}="${singleton ? '*' : ''}${normalizeAutoloadPath(path)}"`;

  const sectionIdx = lines.findIndex((l) => l.trim() === '[autoload]');
  if (sectionIdx === -1) {
    writeFileSync(projectFilePath, content.trimEnd() + '\n\n[autoload]\n' + entry + '\n', 'utf8');
    return;
  }

  let insertIdx = sectionIdx + 1;
  while (insertIdx < lines.length && !lines[insertIdx].trim().startsWith('[')) {
    insertIdx++;
  }
  lines.splice(insertIdx, 0, entry);
  writeFileSync(projectFilePath, lines.join('\n'), 'utf8');
}

/**
 * Remove the named autoload entry. Also drops the `[autoload]` section header
 * if the removed entry was the last one in it. Returns true when the file was
 * mutated.
 */
export function removeAutoloadEntry(projectFilePath: string, name: string): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  let inAutoloadSection = false;
  let removed = false;

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inAutoloadSection = trimmed === '[autoload]';
      return true;
    }
    if (inAutoloadSection) {
      const match = trimmed.match(/^(\w+)=/);
      if (match && match[1] === name) {
        removed = true;
        return false;
      }
    }
    return true;
  });

  if (!removed) return false;

  let newContent = filtered.join('\n');
  newContent = newContent.replace(EMPTY_AUTOLOAD_SECTION_REGEX, '');
  newContent = newContent.trimEnd() + '\n';
  writeFileSync(projectFilePath, newContent, 'utf8');
  return true;
}

export function updateAutoloadEntry(
  projectFilePath: string,
  name: string,
  newPath?: string,
  singleton?: boolean,
): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const lines = content.split('\n');
  let inAutoloadSection = false;
  let updated = false;

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inAutoloadSection = trimmed === '[autoload]';
      return line;
    }
    if (inAutoloadSection) {
      const match = trimmed.match(/^(\w+)="(\*?)([^"]*)"$/);
      if (match && match[1] === name) {
        const effectiveSingleton = singleton !== undefined ? singleton : match[2] === '*';
        const effectivePath = newPath !== undefined ? normalizeAutoloadPath(newPath) : match[3];
        updated = true;
        return `${name}="${effectiveSingleton ? '*' : ''}${effectivePath}"`;
      }
    }
    return line;
  });

  if (updated) writeFileSync(projectFilePath, newLines.join('\n'), 'utf8');
  return updated;
}
