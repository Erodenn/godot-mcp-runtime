/**
 * Loss guard for headless scene saves.
 *
 * Every mutation tool edits a scene by load -> pack -> save, and a save can
 * drop content the operation never touched: a script that failed to compile
 * takes its stored exports with it, an inherited scene can be flattened, an
 * override inside an instance can vanish. The engine's own view cannot show
 * this, because the tree it would be asked about is the one that already lost
 * the content. So the guard compares TEXT: the scene file as it was before the
 * operation against the file afterwards.
 *
 * The save still happens. When the comparison finds something missing that the
 * operation did not ask to change, the caller leads its payload with warnings
 * naming it, and the pre-save file is written under
 * `.mcp/godot-runtime/scene-backups/`. A backup is written only together with
 * at least one reported loss, and backups are never pruned here. A save that
 * could not be compared at all (a binary scene, text that is not a scene) is
 * said to be unchecked instead of passing in silence; the caller says it once
 * per file, since it describes the file and not the call.
 *
 * One rule decides every comparison below: report content a user would call
 * lost, never canonicalization. A healthy save renumbers ids, reorders
 * sections, rewrites `load_steps`, adds `unique_id` (4.6) and drops values
 * equal to a default, so none of those is compared. Each rule that needed a
 * judgment carries its reason where it is applied.
 *
 * Nothing in this module throws into a handler: `beginSceneGuard` and
 * `finishSceneGuard` swallow every failure and answer with less.
 */

import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { sceneBackupPath, sceneBackupRelPath } from './artifact-paths.js';
import { BridgeManager } from './bridge-manager.js';
import { getErrorMessage } from './error-response.js';
import { logDebug } from './logger.js';
import { fileIdentityKey, resolveProjectPath } from './path-validation.js';
import { scanTscn, type TscnHeader } from './scene-parsing.js';

/** Loss items listed per scene before the rest are folded into a `+N more` entry. */
export const MAX_LOSS_ITEMS_PER_SCENE = 8;
/** Longest slice of a property value quoted in a loss item. */
const MAX_VALUE_DISPLAY_CHARS = 60;
/** How many scenes deep an inherited value is looked up before the answer is "unknown". */
const MAX_BASE_SCENE_DEPTH = 8;
/** How many inline resources deep references are compared. */
const MAX_SUB_RESOURCE_DEPTH = 4;

const TEXT_SCENE_EXTENSION = '.tscn';
const SCENE_HEADER_TAG = 'gd_scene';
const ROOT_FILE_PATH = '.';
const ROOT_TOOL_SEGMENT = 'root';
/** Prefix of a path segment that names a node by its scene-unique name (`%Name`). */
const UNIQUE_NAME_PREFIX = '%';
const UNIQUE_NAME_KEY = 'unique_name_in_owner';
const UNIQUE_NAME_SET = 'true';
const SCRIPT_KEY = 'script';
const TEXTURE_KEY = 'texture';
const SAVE_OPERATION = 'save';
const NOT_TEXT_SCENE_BEFORE =
  'the file as it was before the save is not a text scene (a binary scene, or text with no [gd_scene] header)';
const NOT_TEXT_SCENE_AFTER =
  'the saved file is not a text scene (a binary scene, or text with no [gd_scene] header)';

const EXT_REF_REGEX = /ExtResource\(\s*"([^"]*)"\s*\)/g;
const SUB_REF_REGEX = /SubResource\(\s*"([^"]*)"\s*\)/g;
const SINGLE_EXT_REF_REGEX = /^ExtResource\(\s*"([^"]*)"\s*\)$/;
const LINE_BREAK_REGEX = /\r\n?/g;
const WHITESPACE_RUN_REGEX = /\s+/g;
const QUOTED_ITEM_REGEX = /"((?:[^"\\]|\\.)*)"/g;
/** The engine's line for a script it could not compile (E11 in the plan this guard came from). */
const FAILED_SCRIPT_REGEX = /Failed to load script "([^"]+)"/g;

/** A property of one node, named the way a tool call names it. */
export interface TouchedProperty {
  /** Tool-form node path ("root/A", "Main/A", "A", "./A", "%A"). */
  nodePath: string;
  property: string;
}

/** A signal connection, with tool-form node paths. */
export interface SceneConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
}

/** What an operation asked to change, as far as a scene file is concerned. */
export interface SceneChangeIntent {
  /** Tool-form node paths ("root/A", "Main/A", "A", "./A", "%A") the operation may rewrite as a whole. */
  touchedNodes: string[];
  /** Tool-form node paths removed on purpose, with their subtrees. */
  deletedNodes: string[];
  /** Single properties the operation assigns. Everything else on those nodes is still compared. */
  touchedProperties?: TouchedProperty[];
  /** Connections removed on purpose. */
  removedConnections?: SceneConnection[];
}

export interface SceneWriteIntent extends SceneChangeIntent {
  /**
   * Scene whose text before the operation is the baseline for `target`: the
   * scene the operation loads, or for a file a save-as produced, the scene the
   * copy was made from.
   */
  source: string;
  /** File it writes. Equal to source unless save-as. */
  target: string;
  /**
   * True when the operation writes a new scene over whatever the path held
   * (create_scene). The file is watched for having been written and is never
   * compared: replacing it is the request.
   */
  replacesFile?: boolean;
}

/** What comparing one saved scene with its baseline found. */
export interface SceneComparison {
  /** One string per loss, uncapped; empty for a healthy save. */
  losses: string[];
  /** Why the pair could not be compared at all, or null when it was. */
  notChecked: string | null;
}

export interface SceneDiffOptions extends SceneChangeIntent {
  /** False for a save-as: the copy is a different file and gets no uid of its own. Default true. */
  compareSceneUid?: boolean;
  /**
   * Text of another scene of the project by its `res://` path, or null when it
   * cannot be read. Used to tell an override that became redundant from one
   * that was lost. Without it that question is answered "unknown".
   */
  readScene?: (resPath: string) => string | null;
}

interface PropValue {
  /** The value as written (a quoted string is shown with its quotes). */
  raw: string;
  /** `raw` with resource ids replaced by what they name, comparable across files. */
  norm: string;
  /** `res://` paths of the external resources the value references. */
  exts: string[];
  /** Ids of the inline resources the value references. */
  subs: string[];
}

interface SceneNode {
  /** File-form path: "." for the root, else the path below the root. */
  path: string;
  name: string;
  type: string | undefined;
  /** True when the node line carries `instance=`. */
  hasInstance: boolean;
  /** `res://` path the instance resolves to, when it does. */
  instancePath: string | undefined;
  /** True when the node line carries `instance_placeholder=`. */
  isPlaceholder: boolean;
  /** The scene path `instance_placeholder=` names. */
  placeholderPath: string | undefined;
  /** True when the section stores `unique_name_in_owner = true`. */
  hasUniqueName: boolean;
  groups: string[];
  props: Map<string, PropValue>;
}

interface SubResource {
  type: string;
  props: Map<string, PropValue>;
}

interface SceneModel {
  uid: string | undefined;
  rootName: string;
  nodes: Map<string, SceneNode>;
  subs: Map<string, SubResource>;
  /** File-form connection keys, see `connectionKey`. */
  connections: Map<string, SceneConnection>;
  /** File-form paths of the instances an `[editable path="..."]` line names. */
  editable: Set<string>;
  /** `res://` path -> uid, for the ext_resource lines that carry one. */
  extUids: Map<string, string>;
  /** Every `res://` path an ext_resource line names. */
  extPaths: Set<string>;
}

/** A value on one line, cut to the display length. */
function clip(text: string): string {
  const oneLine = text.replace(WHITESPACE_RUN_REGEX, ' ');
  return oneLine.length > MAX_VALUE_DISPLAY_CHARS
    ? `${oneLine.slice(0, MAX_VALUE_DISPLAY_CHARS)}...`
    : oneLine;
}

function readProps(
  header: TscnHeader,
  extById: Map<string, string>,
  subTypeById: Map<string, string>,
): Map<string, PropValue> {
  const props = new Map<string, PropValue>();
  for (const [key, value] of header.stringProps) {
    const quoted = JSON.stringify(value);
    props.set(key, { raw: quoted, norm: quoted, exts: [], subs: [] });
  }
  for (const [key, raw] of header.rawProps) {
    const exts: string[] = [];
    const subs: string[] = [];
    // Ids are renumbered by a save (`1_abc` becomes `1_x7k2p`), so a reference
    // is compared by what it names: the path of an ext_resource, the type of
    // an inline resource. A value can span lines, so line endings are folded too.
    const norm = raw
      .replace(LINE_BREAK_REGEX, '\n')
      .replace(EXT_REF_REGEX, (_match, id: string) => {
        const path = extById.get(id) ?? `?${id}`;
        exts.push(path);
        return `ExtResource(${path})`;
      })
      .replace(SUB_REF_REGEX, (_match, id: string) => {
        subs.push(id);
        return `SubResource(${subTypeById.get(id) ?? '?'})`;
      });
    props.set(key, { raw, norm, exts, subs });
  }
  return props;
}

function connectionKey(connection: SceneConnection): string {
  return [connection.signal, connection.from, connection.to, connection.method].join('\n');
}

/** The comparable shape of one text scene, or null when the text is not one. */
function buildSceneModel(text: string): SceneModel | null {
  const scan = scanTscn(text);
  const first = scan.headers[0];
  if (first === undefined || first.tag !== SCENE_HEADER_TAG) return null;

  const extById = new Map<string, string>();
  const subTypeById = new Map<string, string>();
  const model: SceneModel = {
    uid: first.attrs.get('uid'),
    rootName: '',
    nodes: new Map(),
    subs: new Map(),
    connections: new Map(),
    editable: new Set(),
    extUids: new Map(),
    extPaths: new Set(),
  };
  // Ids first: a node may reference a resource declared anywhere above it, and
  // an inline resource may reference a later one.
  for (const header of scan.headers) {
    const id = header.attrs.get('id');
    if (header.tag === 'ext_resource') {
      const path = header.attrs.get('path');
      if (path === undefined) continue;
      model.extPaths.add(path);
      if (id !== undefined) extById.set(id, path);
      const uid = header.attrs.get('uid');
      if (uid !== undefined) model.extUids.set(path, uid);
    } else if (header.tag === 'sub_resource' && id !== undefined) {
      subTypeById.set(id, header.attrs.get('type') ?? '?');
    }
  }
  for (const header of scan.headers) {
    if (header.tag === 'sub_resource') {
      const id = header.attrs.get('id');
      if (id === undefined) continue;
      model.subs.set(id, {
        type: header.attrs.get('type') ?? '?',
        props: readProps(header, extById, subTypeById),
      });
    } else if (header.tag === 'connection') {
      const connection: SceneConnection = {
        signal: header.attrs.get('signal') ?? '',
        from: header.attrs.get('from') ?? '',
        to: header.attrs.get('to') ?? '',
        method: header.attrs.get('method') ?? '',
      };
      model.connections.set(connectionKey(connection), connection);
    } else if (header.tag === 'editable') {
      const path = header.attrs.get('path');
      if (path !== undefined) model.editable.add(path);
    } else if (header.tag === 'node') {
      const name = header.attrs.get('name');
      if (name === undefined) continue;
      const parent = header.attrs.get('parent');
      let path: string;
      if (parent === undefined) {
        path = ROOT_FILE_PATH;
        model.rootName = name;
      } else {
        path = parent === ROOT_FILE_PATH ? name : `${parent}/${name}`;
      }
      const instance = header.attrs.get('instance');
      const instanceId = instance === undefined ? null : SINGLE_EXT_REF_REGEX.exec(instance);
      const props = readProps(header, extById, subTypeById);
      model.nodes.set(path, {
        path,
        name,
        type: header.attrs.get('type'),
        hasInstance: instance !== undefined,
        instancePath: instanceId ? extById.get(instanceId[1] ?? '') : undefined,
        isPlaceholder: header.attrs.has('instance_placeholder'),
        placeholderPath: header.attrs.get('instance_placeholder'),
        hasUniqueName: props.get(UNIQUE_NAME_KEY)?.raw === UNIQUE_NAME_SET,
        groups: Array.from(
          (header.attrs.get('groups') ?? '').matchAll(QUOTED_ITEM_REGEX),
          (match) => match[1] ?? '',
        ),
        props,
      });
    }
  }
  return model;
}

/**
 * A tool-form node path as the file spells it. Mirrors `find_node_by_path` in
 * godot_operations.gd and the NodePath it hands the engine: "", ".", "root"
 * and the root's own name are the root, a leading "root" or root-name segment
 * is dropped, and "." segments ("./A", "A/./B") name the node they stand on.
 * A `%Name` segment is kept as written: what it names depends on the scene,
 * see `filePathCandidates`.
 */
export function toolPathToFilePath(toolPath: string, rootName: string): string {
  const path = toolPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path === '' || path === ROOT_FILE_PATH || path === ROOT_TOOL_SEGMENT || path === rootName) {
    return ROOT_FILE_PATH;
  }
  const segments = path.split('/');
  if (segments.length > 1 && (segments[0] === ROOT_TOOL_SEGMENT || segments[0] === rootName)) {
    segments.shift();
  }
  const named = segments.filter((segment) => segment !== '' && segment !== ROOT_FILE_PATH);
  return named.length === 0 ? ROOT_FILE_PATH : named.join('/');
}

/**
 * The file-form paths a tool-form path can name in `model`. One path for every
 * spelling but `%Name`. A unique name is resolved against the model: the one
 * node called `Name` whose section stores `unique_name_in_owner = true`. When
 * the model cannot decide (no such node, or several: the flag can live in a
 * base or instanced scene), the answer depends on `guessUnresolved`. With it,
 * every node the spelling could name is returned, that is, every node whose
 * path ends with the named segments, so an intended property change is never
 * reported as a loss. Without it the answer is empty: a guess must never
 * exempt a whole subtree, which is what a deletion would make of it.
 */
function filePathCandidates(
  toolPath: string,
  model: SceneModel,
  guessUnresolved: boolean,
): string[] {
  const path = toolPathToFilePath(toolPath, model.rootName);
  const segments = path.split('/');
  let uniqueAt = -1;
  segments.forEach((segment, at) => {
    if (segment.startsWith(UNIQUE_NAME_PREFIX)) uniqueAt = at;
  });
  if (uniqueAt === -1) return [path];

  const name = segments[uniqueAt]!.slice(UNIQUE_NAME_PREFIX.length);
  const below = segments.slice(uniqueAt + 1);
  const unique = Array.from(model.nodes.values()).filter(
    (node) => node.hasUniqueName && node.name === name,
  );
  if (unique.length === 1) {
    const base = unique[0]!.path;
    if (below.length === 0) return [base];
    return [base === ROOT_FILE_PATH ? below.join('/') : `${base}/${below.join('/')}`];
  }
  if (!guessUnresolved) return [];
  const suffix = [name, ...below].join('/');
  const candidates: string[] = [];
  for (const node of model.nodes.values()) {
    if (node.path === ROOT_FILE_PATH) {
      if (below.length === 0 && node.name === name) candidates.push(node.path);
    } else if (node.path === suffix || node.path.endsWith(`/${suffix}`)) {
      candidates.push(node.path);
    }
  }
  return candidates;
}

/** A file-form path in the "root/..." form every node tool accepts. */
function displayPath(filePath: string): string {
  return filePath === ROOT_FILE_PATH ? ROOT_TOOL_SEGMENT : `${ROOT_TOOL_SEGMENT}/${filePath}`;
}

/** True when `path` is `ancestor` or below it. `ancestor` is never the root here. */
function isAtOrUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function parentOf(path: string): string | null {
  if (path === ROOT_FILE_PATH) return null;
  const slashAt = path.lastIndexOf('/');
  return slashAt === -1 ? ROOT_FILE_PATH : path.slice(0, slashAt);
}

/** `path` relative to `ancestor`, both file-form. */
function relativeTo(path: string, ancestor: string): string {
  if (path === ancestor) return ROOT_FILE_PATH;
  return ancestor === ROOT_FILE_PATH ? path : path.slice(ancestor.length + 1);
}

/** The closest node at or above `path` that is an instance of another scene. */
function nearestInstanceHolder(model: SceneModel, path: string): SceneNode | null {
  for (let at: string | null = path; at !== null; at = parentOf(at)) {
    const node = model.nodes.get(at);
    if (node?.hasInstance) return node;
  }
  return null;
}

type InheritedValue =
  | { kind: 'value'; norm: string }
  /** The scenes below do not set the key: the node gets its default there. */
  | { kind: 'not-stated' }
  /** A scene in the chain could not be read as text; `against` is its path when one is known. */
  | { kind: 'unknown'; against: string | undefined };

/** What the diff of one scene pair needs to answer "what would this node hold without the override?". */
interface BaseLookup {
  readScene: ((resPath: string) => string | null) | undefined;
  models: Map<string, SceneModel | null>;
}

function baseModel(lookup: BaseLookup, resPath: string): SceneModel | null {
  if (lookup.readScene === undefined) return null;
  if (!lookup.models.has(resPath)) {
    let model: SceneModel | null = null;
    try {
      const text = lookup.readScene(resPath);
      model = text === null ? null : buildSceneModel(text);
    } catch {
      model = null;
    }
    lookup.models.set(resPath, model);
  }
  return lookup.models.get(resPath) ?? null;
}

/**
 * The value `key` has on `path` in the scenes `model` instances or inherits,
 * that is, what the node holds once `model`'s own line for it is gone.
 */
function inheritedValue(
  lookup: BaseLookup,
  model: SceneModel,
  path: string,
  key: string,
  depth: number,
): InheritedValue {
  const holder = nearestInstanceHolder(model, path);
  if (holder === null) {
    return depth === 0 ? { kind: 'unknown', against: undefined } : { kind: 'not-stated' };
  }
  if (holder.instancePath === undefined || depth >= MAX_BASE_SCENE_DEPTH) {
    return { kind: 'unknown', against: holder.instancePath };
  }
  const base = baseModel(lookup, holder.instancePath);
  if (base === null) return { kind: 'unknown', against: holder.instancePath };
  const relPath = relativeTo(path, holder.path);
  const stated = base.nodes.get(relPath)?.props.get(key);
  if (stated !== undefined) return { kind: 'value', norm: stated.norm };
  return inheritedValue(lookup, base, relPath, key, depth + 1);
}

/** What a reference-carrying value pointed at, for a loss item. */
function describeRefs(model: SceneModel, exts: string[], subIds: string[]): string {
  const parts = [...exts];
  for (const id of subIds) parts.push(`an inline ${model.subs.get(id)?.type ?? 'resource'}`);
  return parts.join(', ');
}

/**
 * The references `before` holds that `after` no longer does, described, or
 * null when all of them are still there. External references are matched by
 * path and inline ones by resource type, since neither keeps its id.
 */
function lostRefs(
  beforeModel: SceneModel,
  before: PropValue,
  afterModel: SceneModel,
  after: PropValue | undefined,
): string | null {
  if (before.exts.length === 0 && before.subs.length === 0) return null;
  if (after === undefined) return describeRefs(beforeModel, before.exts, before.subs);
  const missingExts = before.exts.filter((path) => !after.exts.includes(path));
  const afterTypes = after.subs.map((id) => afterModel.subs.get(id)?.type ?? '?');
  const missingSubs: string[] = [];
  for (const id of before.subs) {
    const at = afterTypes.indexOf(beforeModel.subs.get(id)?.type ?? '?');
    if (at === -1) missingSubs.push(id);
    else afterTypes.splice(at, 1);
  }
  if (missingExts.length === 0 && missingSubs.length === 0) return null;
  return describeRefs(beforeModel, missingExts, missingSubs);
}

interface DiffContext {
  before: SceneModel;
  after: SceneModel;
  failedScripts: ReadonlySet<string>;
}

/**
 * Compare one inline resource with its counterpart; returns the losses.
 *
 * Sub-resources: an inline resource has no stable identity (its id is
 * regenerated), so it is reached only through the property that references it
 * and compared by type. Inside it references are always compared. Plain keys
 * are compared only when the resource's script did not load, for the same
 * reason as on a node: a value equal to the resource's default is legitimately
 * not written back, while a script that failed takes every value it declares.
 */
function compareInlineResource(
  context: DiffContext,
  label: string,
  beforeId: string,
  afterId: string,
  depth: number,
): string[] {
  const items: string[] = [];
  if (depth >= MAX_SUB_RESOURCE_DEPTH) return items;
  const before = context.before.subs.get(beforeId);
  const after = context.after.subs.get(afterId);
  if (before === undefined || after === undefined) return items;
  const scriptPath = before.props.get(SCRIPT_KEY)?.exts[0];
  let scriptInTrouble = scriptPath !== undefined && context.failedScripts.has(scriptPath);
  const missingPlainKeys: string[] = [];
  for (const [key, value] of before.props) {
    const afterValue = after.props.get(key);
    if (value.exts.length === 0 && value.subs.length === 0) {
      if (afterValue === undefined) missingPlainKeys.push(key);
      continue;
    }
    const lost = lostRefs(context.before, value, context.after, afterValue);
    if (lost !== null) {
      if (key === SCRIPT_KEY) scriptInTrouble = true;
      items.push(`${label} lost ${key} (was ${lost})`);
    } else if (afterValue !== undefined) {
      items.push(...compareInlineRefs(context, `${label}.${key}`, value, afterValue, depth + 1));
    }
  }
  if (scriptInTrouble && missingPlainKeys.length > 0) {
    items.push(
      `${label} lost stored values of ${scriptPath ?? 'its script'}: ${missingPlainKeys.join(', ')}`,
    );
  }
  return items;
}

/**
 * Compare the inline resources `before` references with the ones `after`
 * does, for a value that kept every reference. A value can hold several (a
 * dictionary of animations), and neither ids nor order identify them, so each
 * one is paired with the remaining resource of its type that it lost the least
 * against. A healthy save pairs every one with nothing lost.
 */
function compareInlineRefs(
  context: DiffContext,
  label: string,
  before: PropValue,
  after: PropValue,
  depth: number,
): string[] {
  const items: string[] = [];
  const remaining = [...after.subs];
  for (const beforeId of before.subs) {
    const type = context.before.subs.get(beforeId)?.type;
    if (type === undefined) continue;
    let best: { at: number; items: string[] } | null = null;
    for (let at = 0; at < remaining.length; at++) {
      if (context.after.subs.get(remaining[at]!)?.type !== type) continue;
      const found = compareInlineResource(context, label, beforeId, remaining[at]!, depth);
      if (best === null || found.length < best.items.length) best = { at, items: found };
      if (found.length === 0) break;
    }
    if (best === null) continue;
    remaining.splice(best.at, 1);
    items.push(...best.items);
  }
  return items;
}

/** "1 stored override ... is" or "N stored overrides ... are". */
function uncheckedOverridesItem(count: number, holderLabel: string, against: string): string {
  const subject = count === 1 ? '1 stored override' : `${count} stored overrides`;
  const verb = count === 1 ? 'is' : 'are';
  return `${subject} under ${holderLabel} ${verb} gone and could not be checked against ${against}`;
}

/**
 * Compare a scene's text before and after a save. `losses` holds what the file
 * lost that `intent` did not ask to change. `failedScripts` holds the `res://`
 * paths of scripts the engine reported it could not load during the save.
 * When either text is not a text scene nothing can be compared, and
 * `notChecked` says which side and why.
 */
export function compareSceneText(
  before: string,
  after: string,
  intent: SceneDiffOptions,
  failedScripts: ReadonlySet<string>,
): SceneComparison {
  const beforeModel = buildSceneModel(before);
  if (beforeModel === null) return { losses: [], notChecked: NOT_TEXT_SCENE_BEFORE };
  const afterModel = buildSceneModel(after);
  if (afterModel === null) return { losses: [], notChecked: NOT_TEXT_SCENE_AFTER };

  const context: DiffContext = { before: beforeModel, after: afterModel, failedScripts };
  const items: string[] = [];
  const lookup: BaseLookup = { readScene: intent.readScene, models: new Map() };
  const toFile = (toolPath: string): string[] => filePathCandidates(toolPath, beforeModel, true);
  // A deletion exempts its whole subtree, so it counts only where the path is
  // known: a `%Name` this file cannot resolve exempts nothing, and the node it
  // named is then reported as gone. The operation's own report names the node
  // (`resolvedNodePath`, see `resolveIntentPaths`), so that is the rare case.
  // The root cannot be deleted (the tool refuses), so a root entry exempts nothing.
  const deleted = intent.deletedNodes
    .flatMap((toolPath) => filePathCandidates(toolPath, beforeModel, false))
    .filter((path) => path !== ROOT_FILE_PATH);
  const wholeNodes = new Set(intent.touchedNodes.flatMap(toFile));
  const touchedKeys = new Map<string, Set<string>>();
  for (const touched of intent.touchedProperties ?? []) {
    for (const path of toFile(touched.nodePath)) {
      const keys = touchedKeys.get(path) ?? new Set<string>();
      keys.add(touched.property);
      touchedKeys.set(path, keys);
    }
  }
  const isDeleted = (path: string): boolean =>
    deleted.some((ancestor) => isAtOrUnder(path, ancestor));
  // Plain overrides that are gone while the scene they override could not be
  // read: by instance and unreadable scene, counted and never guessed at.
  const unchecked = new Map<string, { holder: string; against: string; count: number }>();

  if (
    (intent.compareSceneUid ?? true) &&
    beforeModel.uid !== undefined &&
    afterModel.uid !== beforeModel.uid
  ) {
    items.push(
      afterModel.uid === undefined
        ? `The scene lost its uid ${beforeModel.uid}`
        : `The scene uid changed from ${beforeModel.uid} to ${afterModel.uid}`,
    );
  }

  // Subtrees already reported as gone. The override lines under a lost
  // instance vanish with it, and listing each would bury the one cause. The
  // root is never one of them: a scene that stopped being inherited still
  // holds its nodes, written out, and they are compared as usual.
  const goneRoots: string[] = [];
  const isUnderGone = (path: string): boolean =>
    goneRoots.some((root) => path !== root && isAtOrUnder(path, root));

  for (const node of beforeModel.nodes.values()) {
    if (isDeleted(node.path) || wholeNodes.has(node.path) || isUnderGone(node.path)) continue;
    const label = `"${displayPath(node.path)}"`;
    const nodeTouchedKeys = touchedKeys.get(node.path);
    const afterNode = afterModel.nodes.get(node.path);
    // A node line with a type, an instance or a placeholder creates a node. A
    // line with none of them (`[node name="Arm" parent="Unit" index="0"]`)
    // only overrides a node another scene creates.
    const createsNode = node.type !== undefined || node.hasInstance || node.isPlaceholder;
    // Properties on an override line, and on the line of an instance root, are
    // overrides of another scene's values. For those the other scene can say
    // whether a missing key was lost or had merely become redundant.
    const holdsOverrides = node.type === undefined || node.hasInstance;

    const inheritedSame = (key: string, value: PropValue): boolean | 'unknown' => {
      const inherited = inheritedValue(lookup, beforeModel, node.path, key, 0);
      if (inherited.kind !== 'unknown') {
        return inherited.kind === 'value' && inherited.norm === value.norm;
      }
      return 'unknown';
    };
    // A plain override that is gone while the scene below could not be read.
    const countUnchecked = (key: string): void => {
      const inherited = inheritedValue(lookup, beforeModel, node.path, key, 0);
      const holder = nearestInstanceHolder(beforeModel, node.path)?.path ?? node.path;
      const against =
        (inherited.kind === 'unknown' ? inherited.against : undefined) ?? 'the scene it comes from';
      const tallyKey = `${holder}\n${against}`;
      const tally = unchecked.get(tallyKey) ?? { holder, against, count: 0 };
      tally.count++;
      unchecked.set(tallyKey, tally);
    };

    if (afterNode === undefined) {
      if (createsNode) {
        items.push(`Node ${label} is no longer in the file`);
        goneRoots.push(node.path);
        continue;
      }
      // Override lines under instances: a line that disappears is a loss only
      // if it changed the node. Scenes saved by earlier versions of this
      // server pinned every inherited value into such lines, and a healthy
      // save now drops them, so each key is checked against the scene it
      // overrides: the same value there means the line was redundant. When
      // that scene cannot be read, references are reported and plain values
      // are counted (see `unchecked`), because a plain value cannot be told
      // from a default.
      // A line the operation assigned to is exempt the same way a surviving
      // one is: setting an override back to the inherited value removes the
      // line, and that is the request.
      const lostOverrides: string[] = [];
      for (const [key, value] of node.props) {
        if (nodeTouchedKeys?.has(key)) continue;
        const isRef = value.exts.length > 0 || value.subs.length > 0;
        if (!isRef && nodeTouchedKeys !== undefined) continue;
        const same = inheritedSame(key, value);
        if (same === true) continue;
        if (same === 'unknown' && !isRef) {
          countUnchecked(key);
          continue;
        }
        lostOverrides.push(`${key} (was ${clip(value.raw)})`);
      }
      if (lostOverrides.length > 0) {
        items.push(`${label} lost its override of ${lostOverrides.join(', ')}`);
      }
      if (node.groups.length > 0) {
        items.push(`${label} is no longer in the group(s) ${node.groups.join(', ')}`);
      }
      continue;
    }

    if (
      node.hasInstance &&
      (!afterNode.hasInstance || afterNode.instancePath !== node.instancePath)
    ) {
      const was = node.instancePath ?? 'another scene';
      items.push(
        node.path === ROOT_FILE_PATH
          ? `The scene is no longer inherited from ${was}`
          : `${label} no longer instances ${was}`,
      );
      if (node.path !== ROOT_FILE_PATH) goneRoots.push(node.path);
    }
    // A placeholder that became a node or a full instance loads a scene the
    // author had deferred, and one that names another scene is another node.
    if (
      node.isPlaceholder &&
      (!afterNode.isPlaceholder || afterNode.placeholderPath !== node.placeholderPath)
    ) {
      items.push(
        `${label} is no longer a placeholder for ${node.placeholderPath ?? 'another scene'}`,
      );
    }
    // Type: compared only when both lines state one. Scenes saved by earlier
    // versions of this server carry a redundant `type=` beside `instance=`,
    // which a healthy save removes.
    if (node.type !== undefined && afterNode.type !== undefined && node.type !== afterNode.type) {
      items.push(`${label} changed type from ${node.type} to ${afterNode.type}`);
    }
    // Groups are written on the node line and nothing canonicalizes them away.
    const lostGroups = node.groups.filter((group) => !afterNode.groups.includes(group));
    if (lostGroups.length > 0) {
      items.push(`${label} is no longer in the group(s) ${lostGroups.join(', ')}`);
    }

    let scriptPath: string | undefined;
    let scriptInTrouble = false;
    const missingPlainKeys: string[] = [];
    for (const [key, value] of node.props) {
      const afterValue = afterNode.props.get(key);
      const isRef = value.exts.length > 0 || value.subs.length > 0;
      if (key === SCRIPT_KEY && isRef) {
        scriptPath = value.exts[0];
        if (scriptPath !== undefined && failedScripts.has(scriptPath)) scriptInTrouble = true;
      }
      if (nodeTouchedKeys?.has(key)) continue;
      if (!isRef) {
        if (afterValue === undefined) missingPlainKeys.push(key);
        continue;
      }
      const lost = lostRefs(beforeModel, value, afterModel, afterValue);
      if (lost === null) {
        if (afterValue !== undefined) {
          items.push(...compareInlineRefs(context, `${label} ${key}`, value, afterValue, 0));
        }
        continue;
      }
      // A reference pinned into an override line is redundant when the scene
      // below references the same thing.
      if (afterValue === undefined && holdsOverrides && inheritedSame(key, value) === true)
        continue;
      if (key === SCRIPT_KEY) {
        scriptInTrouble = true;
        items.push(`${label} lost its script ${lost}`);
      } else {
        items.push(`${label} lost ${key} (was ${lost})`);
      }
    }

    if (missingPlainKeys.length === 0) continue;
    if (scriptInTrouble) {
      // Plain keys on a node that creates itself: a value equal to the class
      // or script default is legitimately not written back, and the text
      // cannot tell that from a loss. The exception is a node whose script did
      // not load: the save then drops every value the script declares.
      items.push(
        `${label} lost stored values of ${scriptPath ?? 'its script'}: ${missingPlainKeys.join(', ')}`,
      );
    } else if (holdsOverrides && nodeTouchedKeys === undefined) {
      // Assigning one property can clear another on the same node (setting
      // rotation_degrees to 0 removes `rotation`), so a node the operation
      // assigned to is left out of this rule.
      const lostOverrides: string[] = [];
      for (const key of missingPlainKeys) {
        const same = inheritedSame(key, node.props.get(key)!);
        if (same === false) lostOverrides.push(key);
        else if (same === 'unknown') countUnchecked(key);
      }
      if (lostOverrides.length > 0) {
        items.push(
          `${label} lost its override of ${lostOverrides
            .map((key) => `${key} (was ${clip(node.props.get(key)!.raw)})`)
            .join(', ')}`,
        );
      }
    }
  }

  for (const { holder, against, count } of unchecked.values()) {
    items.push(uncheckedOverridesItem(count, `"${displayPath(holder)}"`, against));
  }

  // Editable instances: the overrides of an instance's children load only
  // while its `[editable]` line is there. The line going with the instance
  // itself is already covered by what was said about the instance.
  for (const path of beforeModel.editable) {
    if (afterModel.editable.has(path) || isDeleted(path)) continue;
    if (goneRoots.some((root) => isAtOrUnder(path, root))) continue;
    items.push(
      `"${displayPath(path)}" is no longer marked editable: without its [editable] line the overrides of its children are not loaded`,
    );
  }

  // Connections: identified by signal, source, target and method. A healthy
  // save keeps every one of them, so a missing line is a loss unless the
  // operation removed it or deleted one of its ends.
  const removed = new Set(
    (intent.removedConnections ?? []).flatMap((connection) =>
      toFile(connection.from).flatMap((from) =>
        toFile(connection.to).map((to) => connectionKey({ ...connection, from, to })),
      ),
    ),
  );
  for (const [key, connection] of beforeModel.connections) {
    if (afterModel.connections.has(key) || removed.has(key)) continue;
    const ends = [connection.from, connection.to];
    if (ends.some((end) => isDeleted(end) || goneRoots.some((root) => isAtOrUnder(end, root)))) {
      continue;
    }
    items.push(
      `The connection of signal ${connection.signal} from "${displayPath(connection.from)}" to ${connection.method} on "${displayPath(connection.to)}" is no longer in the file`,
    );
  }

  for (const [path, uid] of beforeModel.extUids) {
    if (afterModel.extPaths.has(path) && !afterModel.extUids.has(path)) {
      items.push(`The reference to ${path} lost its uid ${uid}`);
    }
  }
  return { losses: items, notChecked: null };
}

/** The `losses` of `compareSceneText`: an empty array when nothing could be compared. */
export function diffSceneText(
  before: string,
  after: string,
  intent: SceneDiffOptions,
  failedScripts: ReadonlySet<string>,
): string[] {
  return compareSceneText(before, after, intent, failedScripts).losses;
}

/** `items`, with everything past the cap folded into one `+N more` entry. */
export function capLossItems(items: string[]): string[] {
  if (items.length <= MAX_LOSS_ITEMS_PER_SCENE) return items;
  return [
    ...items.slice(0, MAX_LOSS_ITEMS_PER_SCENE),
    `+${items.length - MAX_LOSS_ITEMS_PER_SCENE} more`,
  ];
}

/** The scripts the engine said it could not load, by `res://` path. */
export function failedScriptsIn(stderr: string): Set<string> {
  return new Set(Array.from(stderr.matchAll(FAILED_SCRIPT_REGEX), (match) => match[1] ?? ''));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, camel: string, snake: string): string | null {
  const value = record[camel] ?? record[snake];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * What a `set_node_properties` updates array asks to change. Assigning
 * `script` replaces what the node stores, so that node is touched as a whole;
 * any other update touches the one property it names. Reads both key
 * spellings and skips items that are not well formed.
 */
export function updateTouches(updates: unknown): {
  touchedNodes: string[];
  touchedProperties: TouchedProperty[];
} {
  const touchedNodes: string[] = [];
  const touchedProperties: TouchedProperty[] = [];
  for (const raw of Array.isArray(updates) ? updates : []) {
    const update = asRecord(raw);
    if (update === null) continue;
    const nodePath = stringField(update, 'nodePath', 'node_path');
    const property = typeof update.property === 'string' ? update.property : null;
    if (nodePath === null || property === null) continue;
    if (property === SCRIPT_KEY) touchedNodes.push(nodePath);
    else touchedProperties.push({ nodePath, property });
  }
  return { touchedNodes, touchedProperties };
}

/**
 * What a finished `set_node_properties` or `delete_nodes` run says about the
 * node paths it was given: where each one led (`resolvedNodePath`, the
 * `root/...` path of the node, which a `%Name` path does not show) and whether
 * its entry succeeded. Null when `results` is not a results array.
 */
function readResolvedPaths(
  results: unknown,
): { resolved: Map<string, string>; succeeded: Map<string, boolean> } | null {
  if (!Array.isArray(results)) return null;
  const resolved = new Map<string, string>();
  const succeeded = new Map<string, boolean>();
  for (const raw of results as unknown[]) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const nodePath = stringField(entry, 'nodePath', 'node_path');
    if (nodePath === null) continue;
    const resolvedPath = stringField(entry, 'resolvedNodePath', 'resolved_node_path');
    if (resolvedPath !== null) resolved.set(nodePath, resolvedPath);
    succeeded.set(nodePath, (succeeded.get(nodePath) ?? false) || entry.success === true);
  }
  return { resolved, succeeded };
}

/**
 * `intents` restated from the operation's own report. Every node path the
 * report resolved is replaced by the path of the node it led to, so a `%Name`
 * path no longer has to be guessed at. A deletion the report does not call a
 * success is dropped: nothing was deleted for it, so nothing is exempt.
 * A payload with no `results` array leaves the intents as they are.
 */
export function resolveIntentPaths(
  intents: SceneWriteIntent[],
  payload: Record<string, unknown>,
): SceneWriteIntent[] {
  const report = readResolvedPaths(payload.results);
  if (report === null) return intents;
  const { resolved, succeeded } = report;
  const place = (nodePath: string): string => resolved.get(nodePath) ?? nodePath;
  return intents.map((intent) => ({
    ...intent,
    touchedNodes: intent.touchedNodes.map(place),
    deletedNodes: intent.deletedNodes
      .filter((nodePath) => succeeded.get(nodePath) !== false)
      .map(place),
    touchedProperties: (intent.touchedProperties ?? []).map((touched) => ({
      ...touched,
      nodePath: place(touched.nodePath),
    })),
  }));
}

/** The `sceneWrites` of an operation that writes one scene at the path it names. */
export function inPlaceSceneWrite(
  scenePath: string,
  intent: Partial<Omit<SceneWriteIntent, 'source' | 'target'>> = {},
): SceneWriteIntent[] {
  return [{ source: scenePath, target: scenePath, touchedNodes: [], deletedNodes: [], ...intent }];
}

/** The one property `load_sprite` assigns. */
export function loadSpriteTouch(nodePath: string): TouchedProperty {
  return { nodePath, property: TEXTURE_KEY };
}

/** One scene file of a project, by identity rather than by spelling. */
interface SceneFileRef {
  /**
   * The same for every spelling of one file (`fileIdentityKey`): `main.tscn`,
   * `./main.tscn` and `res://main.tscn` are one file everywhere, and
   * `Main.tscn` is that file too only where the platform's file system says
   * so. On a case-sensitive one it is another file with its own entry.
   */
  key: string;
  relPath: string;
  absPath: string;
}

/** The file a scene path names inside the project, or null when it does not resolve there. */
function sceneFileRef(projectPath: string, scenePath: string): SceneFileRef | null {
  const resolved = resolveProjectPath(projectPath, scenePath, 'write');
  if (resolved === null) return null;
  return {
    key: fileIdentityKey(resolved.absPath),
    relPath: resolved.relPath,
    absPath: resolved.absPath,
  };
}

type FullSceneWriteIntent = Required<Omit<SceneWriteIntent, 'replacesFile'>>;

function emptyIntent(source: string, target: string): FullSceneWriteIntent {
  return {
    source,
    target,
    touchedNodes: [],
    deletedNodes: [],
    touchedProperties: [],
    removedConnections: [],
  };
}

/**
 * The scene files a `batch_scene_operations` call may write, with what it asks
 * to change in each: one intent per file, whichever way the items spell it.
 *
 * A file's intent follows the file's content. An operation on a scene adds to
 * that scene's intent. A `save` item with a `newPath` makes the target a copy
 * of the source as the batch has changed it so far, so the target's baseline
 * becomes the source's baseline and its intent a copy of the source's; the
 * save-as wins over whatever the batch did to the target before, and later
 * operations on the target add to the copy's intent, not to the source's.
 *
 * `results` is the `results` array of the finished batch, when there is one.
 * With it, a save-as that did not succeed moves no baseline, since the target
 * was not replaced, and the node paths of a `set_node_properties` item are
 * replaced by the nodes its `updates` report says they led to. Without it every
 * save-as is taken to have succeeded and the paths stand as requested.
 */
export function batchSceneWrites(
  operations: unknown[],
  projectPath: string,
  results?: unknown,
): SceneWriteIntent[] {
  const byFile = new Map<string, FullSceneWriteIntent>();
  const outcomes = Array.isArray(results) ? (results as unknown[]) : null;
  operations.forEach((raw, index) => {
    const item = asRecord(raw);
    if (item === null) return;
    const scene = stringField(item, 'scenePath', 'scene_path');
    if (scene === null) return;
    const file = sceneFileRef(projectPath, scene);
    if (file === null) return;
    let intent = byFile.get(file.key);
    if (intent === undefined) {
      intent = emptyIntent(scene, scene);
      byFile.set(file.key, intent);
    }
    if (item.operation === 'set_node_properties') {
      const touches = updateTouches(item.updates);
      const report = readResolvedPaths(asRecord(outcomes?.[index])?.updates);
      const place = (nodePath: string): string => report?.resolved.get(nodePath) ?? nodePath;
      intent.touchedNodes.push(...touches.touchedNodes.map(place));
      intent.touchedProperties.push(
        ...touches.touchedProperties.map((touched) => ({
          ...touched,
          nodePath: place(touched.nodePath),
        })),
      );
    } else if (item.operation === 'load_sprite') {
      const nodePath = stringField(item, 'nodePath', 'node_path');
      if (nodePath !== null) intent.touchedProperties.push(loadSpriteTouch(nodePath));
    } else if (item.operation === SAVE_OPERATION) {
      const newPath = stringField(item, 'newPath', 'new_path');
      const target = newPath === null ? null : sceneFileRef(projectPath, newPath);
      if (newPath === null || target === null || target.key === file.key) return;
      if (outcomes !== null && asRecord(outcomes[index])?.success !== true) return;
      byFile.set(target.key, {
        source: intent.source,
        target: newPath,
        touchedNodes: [...intent.touchedNodes],
        deletedNodes: [...intent.deletedNodes],
        touchedProperties: [...intent.touchedProperties],
        removedConnections: [...intent.removedConnections],
      });
    }
  });
  return [...byFile.values()];
}

interface GuardedFile extends SceneFileRef {
  /** The file's bytes before the operation, or null when it did not exist or could not be read. */
  before: Buffer | null;
}

interface GuardedWrite extends Required<SceneChangeIntent> {
  /** `SceneFileRef.key` of the baseline scene and of the file written. */
  sourceKey: string;
  targetKey: string;
  replacesFile: boolean;
}

export interface SceneGuard {
  projectPath: string;
  runId: string;
  /** By `SceneFileRef.key`. */
  files: Map<string, GuardedFile>;
  /** By source and target key. */
  writes: Map<string, GuardedWrite>;
}

/** A scene that was written and could not be compared. */
export interface UncheckedSave {
  /** `SceneFileRef.key` of the file: the same for every spelling of its path. */
  fileKey: string;
  warning: string;
}

/** What `finishSceneGuard` found. */
export interface SceneGuardOutcome {
  /** Warnings to lead the payload with: what each compared scene lost. */
  warnings: string[];
  /**
   * The scenes that were written and could not be compared, one per file.
   * Kept apart from `warnings` because this is a fact about the file (it is a
   * binary scene), true on every save of it: the caller decides how often to
   * say it.
   */
  unchecked: UncheckedSave[];
  /** True when at least one guarded file is new or holds other bytes than before the operation. */
  wroteScene: boolean;
}

function isTextScenePath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(TEXT_SCENE_EXTENSION);
}

/**
 * Fold `intents` into `guard.writes`. With `readFiles`, a scene the guard has
 * not met is read now, which is only right before the operation runs; without
 * it an intent naming such a scene is left out, because its text before the
 * operation is no longer there to read.
 */
function recordWrites(guard: SceneGuard, intents: SceneWriteIntent[], readFiles: boolean): void {
  for (const intent of intents) {
    const source = sceneFileRef(guard.projectPath, intent.source);
    const target = sceneFileRef(guard.projectPath, intent.target);
    if (source === null || target === null) continue;
    if (!readFiles && !(guard.files.has(source.key) && guard.files.has(target.key))) continue;
    for (const scene of [source, target]) {
      if (guard.files.has(scene.key)) continue;
      let before: Buffer | null = null;
      try {
        before = readFileSync(scene.absPath);
      } catch {
        before = null;
      }
      guard.files.set(scene.key, { ...scene, before });
    }
    const key = `${source.key}\n${target.key}`;
    const write = guard.writes.get(key) ?? {
      sourceKey: source.key,
      targetKey: target.key,
      touchedNodes: [],
      deletedNodes: [],
      touchedProperties: [],
      removedConnections: [],
      replacesFile: false,
    };
    write.replacesFile ||= intent.replacesFile === true;
    write.touchedNodes.push(...intent.touchedNodes);
    write.deletedNodes.push(...intent.deletedNodes);
    write.touchedProperties.push(...(intent.touchedProperties ?? []));
    write.removedConnections.push(...(intent.removedConnections ?? []));
    guard.writes.set(key, write);
  }
}

/**
 * Read the scenes an operation is about to write, before it runs. Writes
 * nothing and never throws: a scene that does not resolve inside the project
 * is simply not guarded, and one that cannot be read has no text to compare.
 */
export function beginSceneGuard(projectPath: string, intents: SceneWriteIntent[]): SceneGuard {
  const guard: SceneGuard = {
    projectPath,
    runId: `${Date.now()}-${randomUUID()}`,
    files: new Map(),
    writes: new Map(),
  };
  try {
    recordWrites(guard, intents, true);
  } catch (error: unknown) {
    logDebug(`Scene loss guard could not read the scenes before the operation: ${error}`);
  }
  return guard;
}

/**
 * Replace what the guard takes the operation to have asked for, once the
 * operation has run and its own report says more than the request did. The
 * scenes read before the run stay as they are. Never throws.
 */
export function restateSceneGuard(guard: SceneGuard, intents: SceneWriteIntent[]): void {
  const previous = guard.writes;
  try {
    guard.writes = new Map();
    recordWrites(guard, intents, false);
  } catch (error: unknown) {
    guard.writes = previous;
    logDebug(`Scene loss guard kept the request's intent: ${error}`);
  }
}

/**
 * Compare every guarded scene with what is on disk now. Returns the warnings
 * to lead the payload with and whether any guarded file was written.
 *
 * Per scene that lost content: one lead line, then the capped items, and the
 * pre-save file under `.mcp/godot-runtime/scene-backups/<run id>/`. Per scene
 * that was written and could not be compared: one `unchecked` entry saying so,
 * and no backup. A scene the operation left byte-identical adds nothing. Never
 * throws.
 */
export function finishSceneGuard(guard: SceneGuard, stderr: string): SceneGuardOutcome {
  const outcome: SceneGuardOutcome = { warnings: [], unchecked: [], wroteScene: false };
  try {
    const failedScripts = failedScriptsIn(stderr);
    // Another scene of the project, for the redundant-override question: the
    // text it had before the operation when this operation also wrote it,
    // because that is the scene the compared file was authored against.
    const readScene = (resPath: string): string | null => {
      const scene = sceneFileRef(guard.projectPath, resPath);
      if (scene === null || !isTextScenePath(scene.relPath)) return null;
      const guarded = guard.files.get(scene.key);
      if (guarded !== undefined && guarded.before !== null) return guarded.before.toString('utf8');
      try {
        return readFileSync(scene.absPath, 'utf8');
      } catch {
        return null;
      }
    };
    /** Backup location of each target already written in this call, or the reason it failed. */
    const backups = new Map<string, string>();

    for (const write of guard.writes.values()) {
      const target = guard.files.get(write.targetKey);
      const source = guard.files.get(write.sourceKey);
      if (target === undefined || source === undefined) continue;
      let after: Buffer;
      try {
        after = readFileSync(target.absPath);
      } catch {
        continue;
      }
      // The same bytes as before the operation: this file was not written.
      if (target.before !== null && after.equals(target.before)) continue;
      outcome.wroteScene = true;
      // A file the operation set out to replace has nothing to be held to,
      // and neither has a new file with no scene behind it.
      const base = source.before;
      if (write.replacesFile || base === null || after.equals(base)) continue;
      const isSaveAs = write.sourceKey !== write.targetKey;
      const comparison = compareSceneText(
        base.toString('utf8'),
        after.toString('utf8'),
        { ...write, compareSceneUid: !isSaveAs, readScene },
        failedScripts,
      );
      if (comparison.notChecked !== null) {
        if (!outcome.unchecked.some((entry) => entry.fileKey === target.key)) {
          outcome.unchecked.push({
            fileKey: target.key,
            warning: `Saved ${target.relPath}, but the save was not checked for lost content: ${comparison.notChecked}.`,
          });
        }
        continue;
      }
      if (comparison.losses.length === 0) continue;

      let backupNote: string;
      if (target.before === null) {
        backupNote = isSaveAs
          ? `There was no file at that path before the save, so nothing was backed up; ${source.relPath} was not modified.`
          : 'There is no copy of the file as it was before the save.';
      } else {
        let location = backups.get(write.targetKey);
        if (location === undefined) {
          location = writeBackup(guard, target.relPath, target.before);
          backups.set(write.targetKey, location);
        }
        backupNote = `The file as it was before the save: ${location}.`;
      }
      outcome.warnings.push(
        `Saved ${target.relPath}, but the file lost content this operation did not ask to change. ${backupNote}`,
        ...capLossItems(comparison.losses),
      );
    }
  } catch (error: unknown) {
    logDebug(`Scene loss guard could not compare the saved scenes: ${error}`);
  }
  return outcome;
}

/** Write one pre-save file. Returns where it is, or a note saying why it is not there. */
function writeBackup(guard: SceneGuard, sceneRelPath: string, content: Buffer): string {
  const location = sceneBackupRelPath(guard.runId, sceneRelPath);
  try {
    BridgeManager.ensureArtifactRoot(guard.projectPath);
    const backupPath = sceneBackupPath(guard.projectPath, guard.runId, sceneRelPath);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, content);
    return location;
  } catch (error: unknown) {
    return `${location} (backup could not be written: ${getErrorMessage(error)})`;
  }
}
