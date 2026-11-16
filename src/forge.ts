// forge.ts — the forge's whole domain: a git object store (SHA-1, content-addressed, shared by every
// repository), repositories with refs, issues, pull requests, labels and comments, and the tree/commit
// machinery the REST, GraphQL, MCP and git-protocol surfaces all share. In-memory only: one process,
// one trial. No dependencies beyond node:crypto.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Every git object this forge has ever stored, by hex sha1. */
export const objects = new Map<string, GitObject>();

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// -------------------------------------------------------------------------------------------------
// Commits and trees
// -------------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

const commitCache = new Map<string, CommitInfo | null>();

export function parseCommit(oid: string): CommitInfo | null {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = objects.get(oid);
  let info: CommitInfo | null = null;
  if (obj !== undefined && obj.type === 'commit') {
    const text = obj.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let authorName = '';
    let authorEmail = '';
    let timestamp = 0;
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        const match = /^(.*)<([^>]*)>\s+(\d+)\s/.exec(line.slice(7));
        if (match !== null) {
          authorName = match[1].trim();
          authorEmail = match[2];
          timestamp = Number(match[3]);
        }
      }
    }
    info = { tree, parents, message, authorName, authorEmail, timestamp };
  }
  commitCache.set(oid, info);
  return info;
}

export interface TreeEntry {
  mode: string; // octal as stored: '40000' for trees, '100644' / '100755' / '120000' for blobs
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, with directories sorting as if their name ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(entries: TreeEntry[]): string {
  return storeObject('tree', buildTreeData(entries));
}

/** Follow tag objects to the commit they ultimately name; null when the chain ends elsewhere. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

/** Every commit reachable from `tip` (inclusive), newest first (breadth-first, parents in order). */
export function commitChain(tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const info = parseCommit(oid);
    if (info === null) continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of info.parents) queue.push(parent);
  }
  return order;
}

export function ancestorSet(tip: string): Set<string> {
  return new Set(commitChain(tip));
}

/** Is `ancestor` reachable from `descendant` (or equal to it)? */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const info = parseCommit(oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A common ancestor of two commits (nearest to `b` first), or null when the histories are disjoint. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const info = parseCommit(oid);
    if (info === null) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  return null;
}

/** Flatten a tree into path -> blob entry, recursively. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Look up one path in a tree; returns the entry (file or dir) or null. */
export function treeLookup(treeOid: string, path: string): { oid: string; mode: string } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (mode 100644), or removed when `blobOid` is null.
 * Starts from `treeOid` (or the empty tree when null). Empty subtrees are pruned, as git does.
 */
export function treeWithPath(treeOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((part) => part !== '');
  const apply = (currentOid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = currentOid === null ? [] : parseTree(objects.get(currentOid)?.data ?? Buffer.alloc(0));
    const name = parts[depth];
    const existing = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (existing >= 0) entries.splice(existing, 1);
      } else if (existing >= 0) {
        entries[existing] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = existing >= 0 && entries[existing].mode === '40000' ? entries[existing].oid : null;
      const newChild = apply(childOid, depth + 1);
      if (existing >= 0) entries.splice(existing, 1);
      if (newChild !== null) entries.push({ mode: '40000', name, oid: newChild });
    }
    if (entries.length === 0) return null;
    return storeTree(entries);
  };
  return apply(treeOid, 0) ?? storeTree([]);
}

/** Build a tree oid from a flat path -> blob map (used by merges). */
export function treeFromFlat(files: Map<string, { oid: string; mode: string }>): string {
  let root: string | null = null;
  const paths = [...files.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  for (const path of paths) {
    root = setPathPlain(root, path.split('/'), files.get(path)!);
  }
  return root ?? storeTree([]);
}

function setPathPlain(treeOid: string | null, parts: string[], file: { oid: string; mode: string }): string {
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const name = parts[0];
  const existing = entries.findIndex((entry) => entry.name === name);
  const childOid = existing >= 0 && entries[existing].mode === '40000' ? entries[existing].oid : null;
  if (existing >= 0) entries.splice(existing, 1);
  if (parts.length === 1) entries.push({ mode: file.mode, name, oid: file.oid });
  else entries.push({ mode: '40000', name, oid: setPathPlain(childOid, parts.slice(1), file) });
  return storeTree(entries);
}

/** Create a commit object with the forge's own identity (contents-API and merge commits). */
export function createCommit(treeOid: string, parents: string[], message: string): string {
  const now = Math.floor(Date.now() / 1000);
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${now} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

// -------------------------------------------------------------------------------------------------
// Repositories, issues, pull requests
// -------------------------------------------------------------------------------------------------

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  refs: Map<string, string>; // full refname -> oid
  nextNumber: number; // one counter shared by issues and pull requests, as on GitHub
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>; // by issue/PR number
  createdAt: string;
}

const DEFAULT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['bug', 'd73a4a'],
  ['documentation', '0075ca'],
  ['duplicate', 'cfd3d7'],
  ['enhancement', 'a2eeef'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
  ['invalid', 'e4e669'],
  ['question', 'd876e3'],
  ['wontfix', 'ffffff'],
];

export const repos = new Map<string, Repo>(); // by name; every repository belongs to the viewer
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    description,
    isPrivate,
    refs: new Map(),
    nextNumber: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(DEFAULT_LABELS.map(([labelName, color]) => [labelName, { name: labelName, color }])),
    comments: new Map(),
    createdAt: nowIso(),
  };
  nextRepoId += 1;
  repos.set(name, repo);
  return repo;
}

export function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(name) ?? null;
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextNumber,
    id: nextIssueId,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.nextNumber += 1;
  nextIssueId += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
  const pull: PullRequest = {
    number: repo.nextNumber,
    id: nextIssueId,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.nextNumber += 1;
  nextIssueId += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function addComment(repo: Repo, number: number, body: string): Comment {
  const comment: Comment = { id: nextCommentId, body, createdAt: nowIso() };
  nextCommentId += 1;
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return comment;
}

// -------------------------------------------------------------------------------------------------
// Merging and diffing
// -------------------------------------------------------------------------------------------------

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

function linesOf(oid: string | undefined): string[] {
  if (oid === undefined) return [];
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts via LCS (files in this forge are small; a cap keeps pathological cases sane). */
export function diffCounts(oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) return { additions: newLines.length, deletions: oldLines.length };
  const width = newLines.length + 1;
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The changed files of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(baseTip, headTip) ?? baseTip;
  const baseInfo = parseCommit(base);
  const headInfo = parseCommit(headTip);
  if (baseInfo === null || headInfo === null) return [];
  const baseFiles = flattenTree(baseInfo.tree);
  const headFiles = flattenTree(headInfo.tree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const { additions, deletions } = diffCounts(before?.oid, after?.oid);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  conflict?: boolean;
}

/**
 * Three-way merge of a pull request's head into its base, per file. `method` 'merge' keeps both
 * parents; anything else (squash, and rebase treated as squash) produces a single-parent commit.
 * On success the base ref moves and the pull request is marked merged.
 */
export function mergePull(repo: Repo, pull: PullRequest, method: string): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, conflict: true };
  const base = mergeBase(baseTip, headTip);
  if (base === null) return { ok: false, conflict: true };
  const baseInfo = parseCommit(base);
  const oursInfo = parseCommit(baseTip);
  const theirsInfo = parseCommit(headTip);
  if (baseInfo === null || oursInfo === null || theirsInfo === null) return { ok: false, conflict: true };
  const baseFiles = flattenTree(baseInfo.tree);
  const ourFiles = flattenTree(oursInfo.tree);
  const theirFiles = flattenTree(theirsInfo.tree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inOurs = ourFiles.get(path);
    const inTheirs = theirFiles.get(path);
    if (inOurs?.oid === inTheirs?.oid) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else if (inBase?.oid === inOurs?.oid) {
      if (inTheirs !== undefined) merged.set(path, inTheirs);
    } else if (inBase?.oid === inTheirs?.oid) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else {
      return { ok: false, conflict: true };
    }
  }
  const treeOid = treeFromFlat(merged);
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` : `${pull.title} (#${pull.number})`;
  const sha = createCommit(treeOid, parents, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return { ok: true, sha };
}

/** Would merging this pull request conflict? (GraphQL's `mergeable`.) */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const probe: PullRequest = { ...pull };
  const refsBefore = new Map(repo.refs);
  const outcome = mergePull(repo, probe, 'squash');
  repo.refs = refsBefore;
  if (outcome.ok) return 'MERGEABLE';
  return outcome.conflict === true ? 'CONFLICTING' : 'UNKNOWN';
}

// -------------------------------------------------------------------------------------------------
// Global ids (GraphQL): opaque, stable, reversible only inside this process.
// -------------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(['v1', kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 3 || segments[0] !== 'v1') return null;
    return { kind: segments[1], parts: segments.slice(2) };
  } catch {
    return null;
  }
}
