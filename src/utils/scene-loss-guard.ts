/** Loss guard for headless scene saves: compares scene text before and after, because the engine's own tree has already lost the content.
 * Reports content a user would call lost, never canonicalization; nothing here throws into a handler. */

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
/** The engine's line for a script it could not compile. */
const FAILED_SCRIPT_REGEX = /Failed to load script "([^"]+)"/g;

export interface TouchedProperty {
  nodePath: string;
  property: string;
}

export interface SceneConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
}

export interface SceneChangeIntent {
  /** Tool-form node paths ("root/A", "Main/A", "A", "./A", "%A") the operation may rewrite as a whole. */
  touchedNodes: string[];
  deletedNodes: string[];
  /** Single properties the operation assigns. Everything else on those nodes is still compared. */
  touchedProperties?: TouchedProperty[];
  removedConnections?: SceneConnection[];
}

export interface SceneWriteIntent extends SceneChangeIntent {
  /** Scene whose pre-operation text is the baseline for `target`; for a save-as copy, the scene the copy was made from. */
  source: string;
  target: string;
  /** The operation writes a new scene over whatever the path held (create_scene): never compared, since replacing it is the request. */
  replacesFile?: boolean;
}

export interface SceneComparison {
  losses: string[];
  /** Why the pair could not be compared at all, or null when it was. */
  notChecked: string | null;
}

export interface SceneDiffOptions extends SceneChangeIntent {
  /** False for a save-as: the copy is a different file and gets no uid of its own. Default true. */
  compareSceneUid?: boolean;
  /** Text of another project scene by `res://` path, or null; tells a redundant override from a lost one, and without it that is answered 'unknown'. */
  readScene?: (resPath: string) => string | null;
}

interface PropValue {
  raw: string;
  /** `raw` with resource ids replaced by what they name, comparable across files. */
  norm: string;
  exts: string[];
  subs: string[];
}

interface SceneNode {
  /** File-form path: "." for the root, else the path below the root. */
  path: string;
  name: string;
  type: string | undefined;
  hasInstance: boolean;
  instancePath: string | undefined;
  isPlaceholder: boolean;
  placeholderPath: string | undefined;
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
  connections: Map<string, SceneConnection>;
  editable: Set<string>;
  extUids: Map<string, string>;
  extPaths: Set<string>;
}

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
    // A save renumbers ids (`1_abc` becomes `1_x7k2p`), so a reference is compared by what it names (ext_resource path, inline resource type); line endings are folded as a value can span lines.
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

/** A tool-form node path as the file spells it; mirrors `find_node_by_path` in godot_operations.gd ("", ".", "root" and the root's name are the root; "./" segments are no-ops). A `%Name` segment is kept as written (see `filePathCandidates`). */
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

/** The file-form paths a tool-form path can name; only `%Name` is ambiguous (the unique-name flag can live in a base or instanced scene).
 * Unresolved, `guessUnresolved` returns every node it could name so a change is never reported as a loss; without it none, since a guess must not exempt a whole deleted subtree. */
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

function relativeTo(path: string, ancestor: string): string {
  if (path === ancestor) return ROOT_FILE_PATH;
  return ancestor === ROOT_FILE_PATH ? path : path.slice(ancestor.length + 1);
}

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
  | { kind: 'unknown'; against: string | undefined };

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

function describeRefs(model: SceneModel, exts: string[], subIds: string[]): string {
  const parts = [...exts];
  for (const id of subIds) parts.push(`an inline ${model.subs.get(id)?.type ?? 'resource'}`);
  return parts.join(', ');
}

/** True when two external references are the same resource: the same path, or the same uid on their own side. The engine resolves by uid and writes the current path on save, so a stale path under an unchanged uid is canonicalization. */
function sameExternalRef(
  beforeModel: SceneModel,
  beforePath: string | undefined,
  afterModel: SceneModel,
  afterPath: string | undefined,
): boolean {
  if (beforePath === afterPath) return true;
  if (beforePath === undefined || afterPath === undefined) return false;
  const beforeUid = beforeModel.extUids.get(beforePath);
  return beforeUid !== undefined && beforeUid === afterModel.extUids.get(afterPath);
}

/** The references `before` holds that `after` no longer does, or null. External ones match by uid when both sides carry one, else by path; inline ones by type, since neither keeps its id. */
function lostRefs(
  beforeModel: SceneModel,
  before: PropValue,
  afterModel: SceneModel,
  after: PropValue | undefined,
): string | null {
  if (before.exts.length === 0 && before.subs.length === 0) return null;
  if (after === undefined) return describeRefs(beforeModel, before.exts, before.subs);
  const missingExts = before.exts.filter(
    (path) =>
      !after.exts.some((afterPath) => sameExternalRef(beforeModel, path, afterModel, afterPath)),
  );
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

/** Compares one inline resource with its counterpart; reached only through the property that references it and compared by type, since its id is regenerated.
 * Plain keys are compared only when its script did not load: a default-equal value is legitimately not written back, a failed script takes every value. */
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

/** Compares the inline resources a value references before and after; neither ids nor order identify them, so each is paired with the remaining resource of its type it lost least against. */
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

function uncheckedOverridesItem(count: number, holderLabel: string, against: string): string {
  const subject = count === 1 ? '1 stored override' : `${count} stored overrides`;
  const verb = count === 1 ? 'is' : 'are';
  return `${subject} under ${holderLabel} ${verb} gone and could not be checked against ${against}`;
}

/** Compares a scene's text before and after a save; `losses` holds what `intent` did not ask to change, `failedScripts` the scripts the engine could not load. If either text is not a text scene, `notChecked` says which side and why. */
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
  // A deletion exempts its whole subtree, so it counts only where the path is known: an unresolvable `%Name` exempts nothing and the node is reported gone.
  // The root cannot be deleted, so a root entry exempts nothing.
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
  // Plain overrides gone while the scene they override could not be read: counted, never guessed at.
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

  // Subtrees already reported gone: the override lines under a lost instance vanish with it, and listing each would bury the cause.
  // Never the root: a scene that stopped being inherited still holds its nodes.
  const goneRoots: string[] = [];
  const isUnderGone = (path: string): boolean =>
    goneRoots.some((root) => path !== root && isAtOrUnder(path, root));

  for (const node of beforeModel.nodes.values()) {
    if (isDeleted(node.path) || wholeNodes.has(node.path) || isUnderGone(node.path)) continue;
    const label = `"${displayPath(node.path)}"`;
    const nodeTouchedKeys = touchedKeys.get(node.path);
    const afterNode = afterModel.nodes.get(node.path);
    // A node line with a type, instance or placeholder creates a node; one with none (`[node name="Arm" parent="Unit" index="0"]`) only overrides a node another scene creates.
    const createsNode = node.type !== undefined || node.hasInstance || node.isPlaceholder;
    // Properties on an override line or an instance root override another scene's values; that scene says whether a missing key was lost or merely redundant.
    const holdsOverrides = node.type === undefined || node.hasInstance;

    const inheritedSame = (key: string, value: PropValue): boolean | 'unknown' => {
      const inherited = inheritedValue(lookup, beforeModel, node.path, key, 0);
      if (inherited.kind !== 'unknown') {
        return inherited.kind === 'value' && inherited.norm === value.norm;
      }
      return 'unknown';
    };
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
      // A vanished override line is a loss only if it changed the node: earlier versions pinned every inherited value into such lines, so each key is checked against the scene it overrides (same value: redundant).
      // Unreadable scene: references are reported, plain values counted (see `unchecked`), as a plain value cannot be told from a default. A line the operation assigned to is exempt.
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
      (!afterNode.hasInstance ||
        !sameExternalRef(context.before, node.instancePath, context.after, afterNode.instancePath))
    ) {
      const was = node.instancePath ?? 'another scene';
      items.push(
        node.path === ROOT_FILE_PATH
          ? `The scene is no longer inherited from ${was}`
          : `${label} no longer instances ${was}`,
      );
      if (node.path !== ROOT_FILE_PATH) goneRoots.push(node.path);
    }
    // A placeholder that became a node or full instance loads a scene the author had deferred; one naming another scene is another node.
    if (
      node.isPlaceholder &&
      (!afterNode.isPlaceholder || afterNode.placeholderPath !== node.placeholderPath)
    ) {
      items.push(
        `${label} is no longer a placeholder for ${node.placeholderPath ?? 'another scene'}`,
      );
    }
    // Type is compared only when both lines state one: earlier versions wrote a redundant `type=` beside `instance=` that a healthy save removes.
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
      // Plain keys on a self-creating node: a default-equal value is legitimately not written back and the text cannot tell it from a loss,
      // except when the node's script did not load (it drops every value it declares).
      items.push(
        `${label} lost stored values of ${scriptPath ?? 'its script'}: ${missingPlainKeys.join(', ')}`,
      );
    } else if (holdsOverrides && nodeTouchedKeys === undefined) {
      // Assigning one property can clear another (rotation_degrees to 0 removes `rotation`), so a node the operation assigned to is left out of this rule.
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

  // Editable instances: an instance's children overrides load only while its `[editable]` line is there; the line going with the instance itself is already covered.
  for (const path of beforeModel.editable) {
    if (afterModel.editable.has(path) || isDeleted(path)) continue;
    if (goneRoots.some((root) => isAtOrUnder(path, root))) continue;
    items.push(
      `"${displayPath(path)}" is no longer marked editable: without its [editable] line the overrides of its children are not loaded`,
    );
  }

  // Connections are identified by signal, source, target and method; a missing line is a loss unless the operation removed it or deleted one of its ends.
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

/** What a `set_node_properties` updates array asks to change: assigning `script` replaces what the node stores, so the node is touched whole; any other update touches the one property. Reads both key spellings. */
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

/** What a finished `set_node_properties` or `delete_nodes` run says about its node paths: where each led (`resolvedNodePath`, which a `%Name` path does not show) and whether its entry succeeded; null if `results` is not an array. */
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

/** `intents` restated from the operation's report: each resolved path is replaced by the node it led to (so `%Name` need not be guessed), and a deletion not reported as a success is dropped, since nothing was deleted. */
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

export function inPlaceSceneWrite(
  scenePath: string,
  intent: Partial<Omit<SceneWriteIntent, 'source' | 'target'>> = {},
): SceneWriteIntent[] {
  return [{ source: scenePath, target: scenePath, touchedNodes: [], deletedNodes: [], ...intent }];
}

export function loadSpriteTouch(nodePath: string): TouchedProperty {
  return { nodePath, property: TEXTURE_KEY };
}

interface SceneFileRef {
  /** The same for every spelling of one file (`fileIdentityKey`); `Main.tscn` is `main.tscn` only where the file system is case-insensitive. */
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

/** The scene files a `batch_scene_operations` call may write, one intent per file whichever way items spell it. A `save` with `newPath` makes the target a copy of the source as changed so far (baseline and intent copied; later operations add to the copy).
 * With `results`, a failed save-as moves no baseline and `set_node_properties` paths become the nodes `updates` reports; without it every save-as is assumed to succeed. */
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
  sourceKey: string;
  targetKey: string;
  replacesFile: boolean;
}

export interface SceneGuard {
  projectPath: string;
  runId: string;
  files: Map<string, GuardedFile>;
  writes: Map<string, GuardedWrite>;
}

export interface UncheckedSave {
  fileKey: string;
  warning: string;
}

export interface SceneGuardOutcome {
  warnings: string[];
  /** Scenes written but not comparable, kept apart from `warnings` because it is a fact about the file (a binary scene) true on every save: the caller decides how often to say it. */
  unchecked: UncheckedSave[];
  wroteScene: boolean;
}

function isTextScenePath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(TEXT_SCENE_EXTENSION);
}

/** Fold `intents` into `guard.writes`. With `readFiles`, an unmet scene is read now (only right before the operation runs); without it such an intent is left out, as its pre-operation text is gone. */
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

/** Reads the scenes an operation is about to write, before it runs. Never throws: an unresolvable scene is not guarded, an unreadable one has no text to compare. */
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

/** Replaces what the guard takes the operation to have asked for once its own report says more than the request; scenes read before the run stay. Never throws. */
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

/** Compares every guarded scene with disk. A scene that lost content gets one lead line, the capped items and a pre-save backup under `.mcp/godot-runtime/scene-backups/<run id>/` (never pruned here);
 * one written but not comparable gets an `unchecked` entry and no backup. Never throws. */
export function finishSceneGuard(guard: SceneGuard, stderr: string): SceneGuardOutcome {
  const outcome: SceneGuardOutcome = { warnings: [], unchecked: [], wroteScene: false };
  try {
    const failedScripts = failedScriptsIn(stderr);
    // Another project scene for the redundant-override question: its text before the operation if this operation also wrote it, since the compared file was authored against that.
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
