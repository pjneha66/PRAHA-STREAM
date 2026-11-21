// Xtream / M3U group trees for the Live TV browser.
//
// VyseTV keeps portal channels in categories and playlist channels in
// `group-title` values; provider names frequently contain a nested path
// ("US / Sports / Soccer"). These are pure builders — no I/O, no React — so a
// later phase can feed the result straight into virtualised group chips.

export interface GroupTreeNode<T> {
  /** Stable identity: lower-cased path joined with `\u0000`. */
  id: string;
  name: string;
  /** Path segments from the root, excluding this node's own name. */
  path: string[];
  children: GroupTreeNode<T>[];
  /** Items directly in this group (never includes descendants). */
  items: T[];
  /** Items in this subtree, including descendants. */
  count: number;
}

export interface GroupTreeOptions {
  /** Separators understood in a group name, longest first by preference. */
  separators?: readonly string[];
  /** Name used when a channel has no group. */
  uncategorised?: string;
  /** Sort sibling nodes and items by name (default true). */
  sort?: boolean;
}

const DEFAULT_SEPARATORS = [' / ', ' | ', ' > ', ' :: ', ' // ', ' - '] as const;

/** Split a provider group label into nested path segments, trimming each one. */
export function splitGroupPath(
  label: string | undefined | null,
  separators: readonly string[] = DEFAULT_SEPARATORS,
): string[] {
  if (!label || !label.trim()) return [];
  let rest = label.trim();
  const parts: string[] = [];
  // Find the earliest separator at each level so mixed formats work.
  for (;;) {
    let bestIndex = -1;
    let bestLength = 0;
    for (const sep of separators) {
      const idx = rest.indexOf(sep);
      if (idx >= 0 && (bestIndex < 0 || idx < bestIndex || (idx === bestIndex && sep.length > bestLength))) {
        bestIndex = idx;
        bestLength = sep.length;
      }
    }
    if (bestIndex < 0) break;
    parts.push(rest.slice(0, bestIndex).trim());
    rest = rest.slice(bestIndex + bestLength).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function makeNode<T>(name: string, path: string[]): GroupTreeNode<T> {
  return {
    id: [...path, name].map((part) => part.toLowerCase()).join('\u0000'),
    name,
    path: [...path],
    children: [],
    items: [],
    count: 0,
  };
}

function finish<T>(node: GroupTreeNode<T>, sort: boolean, nameOf?: (item: T) => string): GroupTreeNode<T> {
  if (sort) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    if (nameOf) node.items = [...node.items].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }
  let count = node.items.length;
  for (const child of node.children) count += finish(child, sort, nameOf).count;
  node.count = count;
  return node;
}

/**
 * Build a generic group tree. `pathOf` returns the nested path for one item.
 * The returned root holds ungrouped items directly and every group as a child.
 */
export function buildGroupTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string | readonly string[] | undefined | null,
  options: GroupTreeOptions = {},
): GroupTreeNode<T> {
  const separators = options.separators ?? DEFAULT_SEPARATORS;
  const fallback = options.uncategorised ?? 'Uncategorised';
  const sort = options.sort !== false;
  const root = makeNode<T>('All', []);
  const byId = new Map<string, GroupTreeNode<T>>([[root.id, root]]);

  for (const item of items || []) {
    const raw = pathOf(item);
    const segments = Array.isArray(raw)
      ? raw.map((part) => String(part).trim()).filter(Boolean)
      : splitGroupPath(typeof raw === 'string' ? raw : undefined, separators);
    const path = segments.length ? segments : [fallback];
    let parent = root;
    const seen: string[] = [];
    for (const segment of path) {
      const id = [...seen, segment].map((part) => part.toLowerCase()).join('\u0000');
      let node = byId.get(id);
      if (!node) {
        node = makeNode<T>(segment, [...seen]);
        byId.set(id, node);
        parent.children.push(node);
      }
      parent = node;
      seen.push(segment);
    }
    parent.items.push(item);
  }

  return finish(root, sort);
}

/** Minimal shape shared by Xtream categories and M3U group headers. */
export interface GroupCategory {
  id: string;
  name: string;
}

export interface XtreamLikeStream {
  streamId: string;
  name: string;
  categoryId?: string;
}

/**
 * Xtream portal tree: category → (nested label) → streams. Categories absent
 * from the category list land in "Other"; empty categories are kept so the UI
 * can show them with a zero count.
 */
export function buildXtreamGroupTree(
  categories: readonly GroupCategory[],
  streams: readonly XtreamLikeStream[],
  options: GroupTreeOptions = {},
): GroupTreeNode<XtreamLikeStream> {
  const root = buildGroupTree<XtreamLikeStream>(
    streams,
    (stream) => {
      const category = (categories || []).find((cat) => cat.id === stream.categoryId);
      return category?.name || 'Other';
    },
    options,
  );
  const byId = new Map(root.children.map((node) => [node.id, node]));
  for (const category of categories || []) {
    const path = splitGroupPath(category.name, options.separators ?? DEFAULT_SEPARATORS);
    const segments = path.length ? path : ['Other'];
    let parent = root;
    const seen: string[] = [];
    for (const segment of segments) {
      const id = [...seen, segment].map((part) => part.toLowerCase()).join('\u0000');
      let node = byId.get(id);
      if (!node) {
        node = makeNode<XtreamLikeStream>(segment, [...seen]);
        byId.set(id, node);
        parent.children.push(node);
      }
      parent = node;
      seen.push(segment);
    }
  }
  return finish(root, options.sort !== false, (stream) => stream.name);
}

export interface M3uLikeChannel {
  name: string;
  url: string;
  group?: string;
}

export interface M3uLikePlaylist {
  name: string;
  channels: readonly M3uLikeChannel[];
}

/** M3U tree: one node per playlist, then nested `group-title` segments. */
export function buildM3uGroupTree(
  playlists: readonly M3uLikePlaylist[],
  options: GroupTreeOptions = {},
): GroupTreeNode<M3uLikeChannel> {
  const root = makeNode<M3uLikeChannel>('All', []);
  const sort = options.sort !== false;
  const fallback = options.uncategorised ?? 'Uncategorised';
  const separators = options.separators ?? DEFAULT_SEPARATORS;
  for (const playlist of playlists || []) {
    const name = playlist?.name?.trim() || 'Playlist';
    const playlistNode = makeNode<M3uLikeChannel>(name, []);
    root.children.push(playlistNode);
    for (const channel of playlist.channels || []) {
      const segments = splitGroupPath(channel.group, separators);
      let parent = playlistNode;
      const seen: string[] = [];
      for (const segment of segments.length ? segments : [fallback]) {
        const id = [...seen, segment].map((part) => part.toLowerCase()).join('\u0000');
        let node = parent.children.find((child) => child.id === id);
        if (!node) {
          node = makeNode<M3uLikeChannel>(segment, [...seen]);
          parent.children.push(node);
        }
        parent = node;
        seen.push(segment);
      }
      parent.items.push(channel);
    }
    finish(playlistNode, sort, (channel) => channel.name);
  }
  return finish(root, sort);
}

/** Depth-first list of every non-root node, useful for flat chip lists. */
export function flattenGroups<T>(node: GroupTreeNode<T>): GroupTreeNode<T>[] {
  const out: GroupTreeNode<T>[] = [];
  const walk = (current: GroupTreeNode<T>) => {
    for (const child of current.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Find a node by its path segments (relative to the given root). */
export function findGroup<T>(root: GroupTreeNode<T>, path: readonly string[]): GroupTreeNode<T> | null {
  let current = root;
  for (const segment of path) {
    const next = current.children.find((child) => child.name.toLowerCase() === segment.toLowerCase());
    if (!next) return null;
    current = next;
  }
  return current;
}
