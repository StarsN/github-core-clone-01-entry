// gitproto.ts — git smart-HTTP: pkt-lines, pack reading/writing, and the upload-pack / receive-pack
// handlers. Protocol v2 for fetch when the client asks (Git-Protocol: version=2), v0 otherwise;
// receive-pack is v0 with report-status, as the suite's client speaks it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  objects,
  storeObject,
  getObject,
  parseCommit,
  peelToCommit,
  isAncestor,
  type GitObjectType,
  type Repo,
} from './forge.ts';

export const AGENT = 'github-core-clone/1.0.0';

// -------------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem =
  | { kind: 'line'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines from the front of `buf`; returns the items and how many bytes they consumed. */
export function parsePkts(buf: Buffer, offset = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('pkt-line overruns the body');
    items.push({ kind: 'line', data: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { items, next: pos };
}

/** A sideband pkt-line: one band byte plus payload. */
export function sidebandPkt(band: number, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

/** Frame pack bytes as band-1 sideband pkt-lines. */
export function framePack(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    frames.push(sidebandPkt(1, pack.subarray(pos, Math.min(pack.length, pos + CHUNK))));
  }
  return frames;
}

// -------------------------------------------------------------------------------------------------
// Pack files
// -------------------------------------------------------------------------------------------------

const TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one zlib stream starting at `pos`; returns the data and the offset just past the stream. */
export function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  const rest = buf.subarray(pos);
  const data = inflateSync(rest); // throws when truncated; trailing bytes past the stream are ignored
  // The exact stream length is the smallest prefix that still inflates to the same bytes.
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, next: pos + lo };
}

/** Apply a git delta (`base` + delta program) and return the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Read every object out of a pack (plain and delta forms) and store them. Returns the object count. */
export function unpackPack(pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack file');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  interface Pending {
    type: GitObjectType;
    data: Buffer;
  }
  const pending = new Map<number, Pending>(); // by pack offset, for ofs-delta resolution
  const byOid = new Map<string, Pending>();
  for (let index = 0; index < count; index += 1) {
    const objectOffset = pos;
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint names the base object in this pack.
      byte = pack[pos];
      pos += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = pending.get(objectOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      const { data, next } = inflateAt(pack, pos);
      pos = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const resolved: Pending = { type: base.type, data: applyDelta(base.data, data) };
      pending.set(objectOffset, resolved);
      byOid.set(storeObject(resolved.type, resolved.data), resolved);
    } else if (typeCode === 7) {
      // REF_DELTA: a base oid names the base object (in this pack or already in the store).
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, next } = inflateAt(pack, pos);
      pos = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const base = byOid.get(baseOid) ?? getObject(baseOid);
      if (base === undefined) throw new Error('ref-delta base is unknown');
      const resolved: Pending = { type: base.type, data: applyDelta(base.data, data) };
      pending.set(objectOffset, resolved);
      byOid.set(storeObject(resolved.type, resolved.data), resolved);
    } else {
      const type = TYPE_NAMES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateAt(pack, pos);
      pos = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const entry: Pending = { type, data };
      pending.set(objectOffset, entry);
      byOid.set(storeObject(type, data), entry);
    }
  }
  return count;
}

/** Build a pack holding exactly `oids` (plain objects, no deltas). */
export function buildPack(oids: string[]): Buffer {
  const present = oids.filter((oid) => getObject(oid) !== undefined);
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(present.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of present) {
    const obj = getObject(oid)!;
    // Object header: type in bits 4-6 of the first byte, size in the low 4 bits then 7 bits per
    // following byte, MSB set while more size bytes follow.
    const encoded: number[] = [];
    let remaining = obj.data.length;
    let firstByte = (TYPE_CODES[obj.type] << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) firstByte |= 0x80;
    encoded.push(firstByte);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      encoded.push(byte);
    }
    parts.push(Buffer.from(encoded));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------------
// Fetch planning: which objects a fetch must carry
// -------------------------------------------------------------------------------------------------

export interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
  common: string | null;
}

/** All tree/blob oids reachable from a commit's tree. */
function treeClosure(treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const obj = getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  out.add(treeOid);
  const text = obj.data;
  let pos = 0;
  while (pos < text.length) {
    const space = text.indexOf(0x20, pos);
    const mode = text.toString('utf8', pos, space);
    const nul = text.indexOf(0x00, space + 1);
    const oid = text.toString('hex', nul + 1, nul + 21);
    if (mode === '40000') treeClosure(oid, out);
    else out.add(oid);
    pos = nul + 21;
  }
}

export function planFetch(wants: string[], haves: string[], clientShallow: string[], deepen: number | null): FetchPlan {
  // What the client already holds: the ancestors of every have — but a shallow client's boundary
  // commits are held WITHOUT their parents, so the walk stops below every commit the client
  // declared shallow. (A deepen request names its boundary commit as a have; treating that have
  // as full history would starve the very commits the deepen asks for.)
  const shallowSet0 = new Set(clientShallow);
  const haveCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const commit = peelToCommit(have);
      if (commit !== null && !haveCommits.has(commit)) {
        haveCommits.add(commit);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (shallowSet0.has(oid)) continue; // boundary: held, but its parents are not
      const info = parseCommit(oid);
      if (info === null) continue;
      for (const parent of info.parents) {
        if (!haveCommits.has(parent) && getObject(parent)?.type === 'commit') {
          haveCommits.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  const haveObjects = new Set<string>(haveCommits);
  for (const commit of haveCommits) {
    const info = parseCommit(commit);
    if (info !== null) treeClosure(info.tree, haveObjects);
  }
  const common = haves.find((have) => getObject(have)?.type === 'commit') ?? null;

  // Breadth-first walk from the wants, with distances, never crossing into held history.
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const extraObjects: string[] = []; // tag objects named directly by a want
  for (const want of wants) {
    const obj = getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      extraObjects.push(want);
      const commit = peelToCommit(want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 0);
        queue.push({ oid: commit, dist: 0 });
      }
    } else if (obj.type === 'commit' && !distance.has(want)) {
      distance.set(want, 0);
      queue.push({ oid: want, dist: 0 });
    }
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    // With a deepen limit, commits at the limit can never be sent, so their parents are not walked:
    // a depth-1 clone of a long history then costs O(1) commits, not O(history).
    if (deepen !== null && dist + 1 >= deepen) continue;
    const info = parseCommit(oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (haveCommits.has(parent) || distance.has(parent)) continue;
      if (getObject(parent)?.type !== 'commit') continue;
      distance.set(parent, dist + 1);
      queue.push({ oid: parent, dist: dist + 1 });
    }
  }

  const limit = deepen === null ? Number.POSITIVE_INFINITY : deepen;
  const sentCommits = [...distance.entries()].filter(([, dist]) => dist < limit).map(([oid]) => oid);
  const sentSet = new Set(sentCommits);
  const boundary: string[] = [];
  for (const oid of sentCommits) {
    const info = parseCommit(oid);
    if (info === null) continue;
    const isBoundary = info.parents.some((parent) => !sentSet.has(parent) && !haveCommits.has(parent));
    if (isBoundary) boundary.push(oid);
  }
  const shallowSet = new Set(clientShallow);
  const unshallow = clientShallow.filter((oid) => sentSet.has(oid) && !boundary.includes(oid));

  const sentObjects = new Set<string>();
  const treesAndBlobs = new Set<string>();
  for (const oid of extraObjects) if (!haveObjects.has(oid)) sentObjects.add(oid);
  for (const oid of sentCommits) {
    if (!haveObjects.has(oid)) sentObjects.add(oid);
    const info = parseCommit(oid);
    if (info !== null) treeClosure(info.tree, treesAndBlobs);
  }
  for (const oid of treesAndBlobs) if (!haveObjects.has(oid)) sentObjects.add(oid);
  // Commits first (walk order), then the rest: any order is legal, this one reads well in a log.
  const ordered = [...sentCommits.filter((oid) => sentObjects.has(oid)), ...[...sentObjects].filter((oid) => !sentSet.has(oid))];
  return { oids: ordered, shallow: boundary, unshallow, common };
}

// -------------------------------------------------------------------------------------------------
// HTTP handlers
// -------------------------------------------------------------------------------------------------

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function refLines(repo: Repo): Array<{ oid: string; name: string }> {
  const lines: Array<{ oid: string; name: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) lines.push({ oid: repo.refs.get(name)!, name });
  return lines;
}

export function infoRefs(repo: Repo, service: string, isV2: boolean): GitReply {
  if (service === 'git-upload-pack' && isV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `side-band-64k thin-pack shallow ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const refs = refLines(repo);
  const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    lines.push(`${headOid} HEAD`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}`);
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefs(repo: Repo, args: LsRefsArgs): GitReply {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get('refs/heads/main');
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`${ZERO_OID} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''} unborn\n`));
    }
  }
  for (const ref of refLines(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelToCommit(ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

/**
 * Built packs, keyed by the exact fetch shape. Objects are content-addressed and immutable, so a
 * pack built for a want/have/deepen triple stays correct forever; fifty concurrent clones of the
 * same tip build it once. Bounded, oldest-first eviction.
 */
const packCache = new Map<string, { plan: FetchPlan; pack: Buffer }>();

function cachedFetch(args: FetchArgs): { plan: FetchPlan; pack: Buffer } {
  const key = [
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.deepen === null ? '' : String(args.deepen),
  ].join('|');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(args.wants, args.haves, args.shallow, args.deepen);
  const entry = { plan, pack: buildPack(plan.oids) };
  if (packCache.size >= 256) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, entry);
  return entry;
}

function section(name: string, lines: string[]): Buffer[] {
  return [pktLine(`${name}\n`), ...lines.map((line) => pktLine(`${line}\n`)), PKT_DELIM];
}

export function fetchV2(repo: Repo, args: FetchArgs): GitReply {
  void repo;
  if (!args.done) {
    // A negotiation round: acknowledge what we hold, and say whether we are ready to build a pack.
    const acks = args.haves.filter((have) => getObject(have)?.type === 'commit').map((have) => `ACK ${have}`);
    const lines = acks.length > 0 ? [...acks, 'ready'] : ['NAK'];
    const parts: Buffer[] = [...section('acknowledgments', lines), PKT_FLUSH];
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  const { plan, pack } = cachedFetch(args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(...section('acknowledgments', [plan.common !== null ? `ACK ${plan.common}` : 'NAK']));
  }
  if (args.deepen !== null || args.shallow.length > 0) {
    const lines = [...plan.shallow.map((oid) => `shallow ${oid}`), ...plan.unshallow.map((oid) => `unshallow ${oid}`)];
    parts.push(...section('shallow-info', lines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...framePack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function fetchV0(repo: Repo, args: FetchArgs, requestCaps: string): GitReply {
  void repo;
  const { plan, pack } = cachedFetch(args);
  const parts: Buffer[] = [];
  if (args.deepen !== null || args.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
  if (requestCaps.includes('side-band-64k')) {
    parts.push(...framePack(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, commands: PushCommand[], pack: Buffer | null, requestCaps: string): GitReply {
  let unpackLine = 'unpack ok';
  if (pack !== null && pack.length > 0) {
    try {
      unpackPack(pack);
    } catch (err) {
      unpackLine = `unpack index-pack failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const results: string[] = [unpackLine];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      results.push(`ng ${ref} invalid ref`);
      continue;
    }
    if (unpackLine !== 'unpack ok') {
      results.push(`ng ${ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (newOid === ZERO_OID) {
      repo.refs.delete(ref);
      results.push(`ok ${ref}`);
      continue;
    }
    const target = getObject(newOid);
    if (target === undefined) {
      results.push(`ng ${ref} invalid object`);
      continue;
    }
    if (ref.startsWith('refs/heads/') && target.type !== 'commit') {
      results.push(`ng ${ref} invalid object`);
      continue;
    }
    if (current !== ZERO_OID && current !== oldOid && oldOid !== ZERO_OID) {
      results.push(`ng ${ref} stale info`);
      continue;
    }
    if (current !== ZERO_OID) {
      const newCommit = peelToCommit(newOid);
      if (newCommit === null || !isAncestor(current, newCommit)) {
        results.push(`ng ${ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(ref, newOid);
    results.push(`ok ${ref}`);
  }
  const useSideband = requestCaps.includes('side-band-64k');
  const parts: Buffer[] = results.map((line) => (useSideband ? sidebandPkt(1, Buffer.from(`${line}\n`, 'utf8')) : pktLine(`${line}\n`)));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
