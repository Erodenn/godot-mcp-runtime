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
 * `.mcp/godot-runtime/scene-backups/`. Backups are never pruned here.
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
import { resolveProjectPath } from './path-validation.js';
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
const SCRIPT_KEY = 'script';
const TEXTURE_KEY = 'texture';

const EXT_REF_REGEX = /ExtResource\(\s*"([^"]*)"\s*\)/g;
const SUB_REF_REGEX = /SubResource\(\s*"([^"]*)"\s*\)/g;
const SINGLE_EXT_REF_REGEX = /^ExtResource\(\s*"([^"]*)"\s*\)$/;
const SINGLE_SUB_REF_REGEX = /^SubResource\(\s*"[^"]*"\s*\)$/;
const QUOTED_ITEM_REGEX = /"((?:[^"\\]|\\.)*)"/g;
/** The engine's line for a script it could not compile (E11 in the plan this guard came from). */
const FAILED_SCRIPT_REGEX = /Failed to load script "([^"]+)"/g;

/** A property of one node, named the way a tool call names it. */
export interface TouchedProperty {
  /** Tool-form node path ("root/A", "Main/A", "A"). */
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
  /** Tool-form node paths ("root/A", "Main/A", "A") the operation may rewrite as a whole. */
  touchedNodes: string[];
  /** Tool-form node paths removed on purpose, with their subtrees. */
  deletedNodes: string[];
  /** Single properties the operation assigns. Everything else on those nodes is still compared. */
  touchedProperties?: TouchedProperty[];
  /** Connections removed on purpose. */
  removedConnections?: SceneConnection[];
}

export interface SceneWriteIntent extends SceneChangeIntent {
  /** Scene the operation loads, project-relative. */
  source: string;
  /** File it writes. Equal to source unless save-as. */
  target: string;
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
  type: string | undefined;
  /** True when the node line carries `instance=`. */
  hasInstance: boolean;
  /** `res://` path the instance resolves to, when it does. */
  instancePath: string | undefined;
  /** True when the node line carries `instance_placeholder=`. */
  isPlaceholder: boolean;
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
  /** `res://` path -> uid, for the ext_resource lines that carry one. */
  extUids: Map<string, string>;
  /** Every `res://` path an ext_resource line names. */
  extPaths: Set<string>;
}

function clip(text: string): string {
  return text.length > MAX_VALUE_DISPLAY_CHARS
    ? `${text.slice(0, MAX_VALUE_DISPLAY_CHARS)}...`
    : text;
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
    // an inline resource.
    const norm = raw
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
      model.nodes.set(path, {
        path,
        type: header.attrs.get('type'),
        hasInstance: instance !== undefined,
        instancePath: instanceId ? extById.get(instanceId[1] ?? '') : undefined,
        isPlaceholder: header.attrs.has('instance_placeholder'),
        groups: Array.from(
          (header.attrs.get('groups') ?? '').matchAll(QUOTED_ITEM_REGEX),
          (match) => match[1] ?? '',
        ),
        props: readProps(header, extById, subTypeById),
      });
    }
  }
  return model;
}

/**
 * A tool-form node path as the file spells it. Mirrors `find_node_by_path` in
 * godot_operations.gd: "", ".", "root" and the root's own name are the root,
 * and a leading "root" or root-name segment is dropped.
 */
export function toolPathToFilePath(toolPath: string, rootName: string): string {
  let path = toolPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path === '' || path === ROOT_FILE_PATH || path === ROOT_TOOL_SEGMENT || path === rootName) {
    return ROOT_FILE_PATH;
  }
  const slashAt = path.indexOf('/');
  if (slashAt !== -1) {
    const firstSegment = path.slice(0, slashAt);
    if (firstSegment === ROOT_TOOL_SEGMENT || firstSegment === rootName) {
      path = path.slice(slashAt + 1);
    }
  }
  return path === '' ? ROOT_FILE_PATH : path;
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
  /** A scene in the chain could not be read as text. */
  | { kind: 'unknown' };

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
  if (holder === null) return depth === 0 ? { kind: 'unknown' } : { kind: 'not-stated' };
  if (holder.instancePath === undefined || depth >= MAX_BASE_SCENE_DEPTH)
    return { kind: 'unknown' };
  const base = baseModel(lookup, holder.instancePath);
  if (base === null) return { kind: 'unknown' };
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
  items: string[];
}

/**
 * Compare the references inside one inline resource with its counterpart.
 *
 * Sub-resources: an inline resource has no stable identity (its id is
 * regenerated), so it is reached only through the property that references it
 * and compared by type. Inside it only references are compared, for the same
 * reason plain keys on a healthy node are not: a value equal to the resource's
 * default is legitimately not written back.
 */
function compareInlineResource(
  context: DiffContext,
  label: string,
  beforeId: string,
  afterId: string,
  depth: number,
): void {
  if (depth >= MAX_SUB_RESOURCE_DEPTH) return;
  const before = context.before.subs.get(beforeId);
  const after = context.after.subs.get(afterId);
  if (before === undefined || after === undefined) return;
  for (const [key, value] of before.props) {
    const afterValue = after.props.get(key);
    const lost = lostRefs(context.before, value, context.after, afterValue);
    if (lost !== null) {
      context.items.push(`${label} lost ${key} (was ${lost})`);
    } else if (
      afterValue !== undefined &&
      isSingleInlineRef(value) &&
      isSingleInlineRef(afterValue)
    ) {
      compareInlineResource(
        context,
        `${label}.${key}`,
        value.subs[0]!,
        afterValue.subs[0]!,
        depth + 1,
      );
    }
  }
}

function isSingleInlineRef(value: PropValue): boolean {
  return value.subs.length === 1 && SINGLE_SUB_REF_REGEX.test(value.raw);
}

/**
 * What the file lost between `before` and `after` that `intent` did not ask to
 * change. One string per loss, uncapped; an empty array for a healthy save.
 * `failedScripts` holds the `res://` paths of scripts the engine reported it
 * could not load during the operation.
 */
export function diffSceneText(
  before: string,
  after: string,
  intent: SceneDiffOptions,
  failedScripts: ReadonlySet<string>,
): string[] {
  const beforeModel = buildSceneModel(before);
  const afterModel = buildSceneModel(after);
  // A file that is not a text scene on either side is not this guard's to
  // judge: there is nothing to compare it with.
  if (beforeModel === null || afterModel === null) return [];

  const context: DiffContext = { before: beforeModel, after: afterModel, items: [] };
  const { items } = context;
  const lookup: BaseLookup = { readScene: intent.readScene, models: new Map() };
  const toFile = (toolPath: string): string => toolPathToFilePath(toolPath, beforeModel.rootName);
  // The root cannot be deleted (the tool refuses), so a root entry exempts nothing.
  const deleted = intent.deletedNodes.map(toFile).filter((path) => path !== ROOT_FILE_PATH);
  const wholeNodes = new Set(intent.touchedNodes.map(toFile));
  const touchedKeys = new Map<string, Set<string>>();
  for (const touched of intent.touchedProperties ?? []) {
    const path = toFile(touched.nodePath);
    const keys = touchedKeys.get(path) ?? new Set<string>();
    keys.add(touched.property);
    touchedKeys.set(path, keys);
  }
  const isDeleted = (path: string): boolean =>
    deleted.some((ancestor) => isAtOrUnder(path, ancestor));

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
      if (inherited.kind === 'unknown') return 'unknown';
      return inherited.kind === 'value' && inherited.norm === value.norm;
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
      // that scene cannot be read, only references are reported, because a
      // plain value cannot be told from a default.
      // A line the operation assigned to is exempt the same way a surviving
      // one is: setting an override back to the inherited value removes the
      // line, and that is the request.
      const lostOverrides: string[] = [];
      for (const [key, value] of node.props) {
        if (nodeTouchedKeys?.has(key)) continue;
        const isRef = value.exts.length > 0 || value.subs.length > 0;
        if (!isRef && nodeTouchedKeys !== undefined) continue;
        const same = inheritedSame(key, value);
        if (same === true || (same === 'unknown' && !isRef)) continue;
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
        if (afterValue !== undefined && isSingleInlineRef(value) && isSingleInlineRef(afterValue)) {
          compareInlineResource(context, `${label} ${key}`, value.subs[0]!, afterValue.subs[0]!, 0);
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
      const lostOverrides = missingPlainKeys.filter(
        (key) => inheritedSame(key, node.props.get(key)!) === false,
      );
      if (lostOverrides.length > 0) {
        items.push(
          `${label} lost its override of ${lostOverrides
            .map((key) => `${key} (was ${clip(node.props.get(key)!.raw)})`)
            .join(', ')}`,
        );
      }
    }
  }

  // Connections: identified by signal, source, target and method. A healthy
  // save keeps every one of them, so a missing line is a loss unless the
  // operation removed it or deleted one of its ends.
  const removed = new Set(
    (intent.removedConnections ?? []).map((connection) =>
      connectionKey({ ...connection, from: toFile(connection.from), to: toFile(connection.to) }),
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
  return items;
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

/** The `sceneWrites` of an operation that loads one scene and saves it back in place. */
export function inPlaceSceneWrite(
  scenePath: string,
  intent: Partial<SceneChangeIntent> = {},
): SceneWriteIntent[] {
  return [{ source: scenePath, target: scenePath, touchedNodes: [], deletedNodes: [], ...intent }];
}

/** The one property `load_sprite` assigns. */
export function loadSpriteTouch(nodePath: string): TouchedProperty {
  return { nodePath, property: TEXTURE_KEY };
}

/**
 * The scene files a `batch_scene_operations` call may write, with what it asks
 * to change in each. One intent per distinct scene spelling (the guard folds
 * spellings of one file together), plus one per `save` item with a `newPath`,
 * carrying what had been touched on its source up to that point.
 */
export function batchSceneWrites(operations: unknown[]): SceneWriteIntent[] {
  const byScene = new Map<string, SceneWriteIntent>();
  const saveAs: SceneWriteIntent[] = [];
  for (const raw of operations) {
    const item = asRecord(raw);
    if (item === null) continue;
    const scene = stringField(item, 'scenePath', 'scene_path');
    if (scene === null) continue;
    let intent = byScene.get(scene);
    if (intent === undefined) {
      intent = {
        source: scene,
        target: scene,
        touchedNodes: [],
        deletedNodes: [],
        touchedProperties: [],
      };
      byScene.set(scene, intent);
    }
    const touchedProperties = intent.touchedProperties ?? [];
    if (item.operation === 'set_node_properties') {
      const touches = updateTouches(item.updates);
      intent.touchedNodes.push(...touches.touchedNodes);
      touchedProperties.push(...touches.touchedProperties);
    } else if (item.operation === 'load_sprite') {
      const nodePath = stringField(item, 'nodePath', 'node_path');
      if (nodePath !== null) touchedProperties.push(loadSpriteTouch(nodePath));
    } else if (item.operation === 'save') {
      const newPath = stringField(item, 'newPath', 'new_path');
      if (newPath !== null) {
        saveAs.push({
          source: scene,
          target: newPath,
          touchedNodes: [...intent.touchedNodes],
          deletedNodes: [],
          touchedProperties: [...touchedProperties],
        });
      }
    }
  }
  return [...byScene.values(), ...saveAs];
}

interface GuardedFile {
  absPath: string;
  /** The file's bytes before the operation, or null when it did not exist or could not be read. */
  before: Buffer | null;
}

interface GuardedWrite extends SceneWriteIntent {
  touchedProperties: TouchedProperty[];
  removedConnections: SceneConnection[];
}

export interface SceneGuard {
  projectPath: string;
  runId: string;
  /** By project-relative path. */
  files: Map<string, GuardedFile>;
  /** By source and target project-relative path. */
  writes: Map<string, GuardedWrite>;
}

function isTextScenePath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(TEXT_SCENE_EXTENSION);
}

/**
 * Read the scenes an operation is about to write, before it runs. Writes
 * nothing and never throws: a scene that does not resolve inside the project,
 * is not a `.tscn`, or cannot be read is simply not guarded.
 */
export function beginSceneGuard(projectPath: string, intents: SceneWriteIntent[]): SceneGuard {
  const guard: SceneGuard = {
    projectPath,
    runId: `${Date.now()}-${randomUUID()}`,
    files: new Map(),
    writes: new Map(),
  };
  try {
    for (const intent of intents) {
      const source = resolveProjectPath(projectPath, intent.source);
      const target = resolveProjectPath(projectPath, intent.target);
      if (source === null || target === null) continue;
      if (!isTextScenePath(source.relPath) || !isTextScenePath(target.relPath)) continue;
      for (const scene of [source, target]) {
        if (guard.files.has(scene.relPath)) continue;
        let before: Buffer | null = null;
        try {
          before = readFileSync(scene.absPath);
        } catch {
          before = null;
        }
        guard.files.set(scene.relPath, { absPath: scene.absPath, before });
      }
      const key = `${source.relPath}\n${target.relPath}`;
      const write = guard.writes.get(key) ?? {
        source: source.relPath,
        target: target.relPath,
        touchedNodes: [],
        deletedNodes: [],
        touchedProperties: [],
        removedConnections: [],
      };
      write.touchedNodes.push(...intent.touchedNodes);
      write.deletedNodes.push(...intent.deletedNodes);
      write.touchedProperties.push(...(intent.touchedProperties ?? []));
      write.removedConnections.push(...(intent.removedConnections ?? []));
      guard.writes.set(key, write);
    }
  } catch (error: unknown) {
    logDebug(`Scene loss guard could not read the scenes before the operation: ${error}`);
  }
  return guard;
}

/**
 * Compare every guarded scene with what is on disk now. Returns the warnings
 * to lead the payload with (per scene: one lead line, then the capped items),
 * and writes the pre-save file of each scene that lost content under
 * `.mcp/godot-runtime/scene-backups/<run id>/`. Never throws.
 */
export function finishSceneGuard(guard: SceneGuard, stderr: string): string[] {
  const warnings: string[] = [];
  try {
    const failedScripts = failedScriptsIn(stderr);
    // Another scene of the project, for the redundant-override question: the
    // text it had before the operation when this operation also wrote it,
    // because that is the scene the compared file was authored against.
    const readScene = (resPath: string): string | null => {
      const resolved = resolveProjectPath(guard.projectPath, resPath);
      if (resolved === null || !isTextScenePath(resolved.relPath)) return null;
      const guarded = guard.files.get(resolved.relPath);
      if (guarded !== undefined && guarded.before !== null) return guarded.before.toString('utf8');
      try {
        return readFileSync(resolved.absPath, 'utf8');
      } catch {
        return null;
      }
    };
    /** Backup location of each target already written in this call, or the reason it failed. */
    const backups = new Map<string, string>();

    for (const write of guard.writes.values()) {
      const target = guard.files.get(write.target);
      const base = guard.files.get(write.source)?.before ?? null;
      if (target === undefined || base === null) continue;
      let after: Buffer;
      try {
        after = readFileSync(target.absPath);
      } catch {
        continue;
      }
      if (after.equals(base)) continue;
      const items = diffSceneText(
        base.toString('utf8'),
        after.toString('utf8'),
        { ...write, compareSceneUid: write.source === write.target, readScene },
        failedScripts,
      );
      if (items.length === 0) continue;

      let backupNote: string;
      if (target.before === null) {
        backupNote =
          write.source === write.target
            ? 'There is no copy of the file as it was before the save.'
            : `There was no file at that path before the save, so nothing was backed up; ${write.source} was not modified.`;
      } else {
        let location = backups.get(write.target);
        if (location === undefined) {
          location = writeBackup(guard, write.target, target.before);
          backups.set(write.target, location);
        }
        backupNote = `The file as it was before the save: ${location}.`;
      }
      warnings.push(
        `Saved ${write.target}, but the file lost content this operation did not ask to change. ${backupNote}`,
        ...capLossItems(items),
      );
    }
  } catch (error: unknown) {
    logDebug(`Scene loss guard could not compare the saved scenes: ${error}`);
  }
  return warnings;
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
