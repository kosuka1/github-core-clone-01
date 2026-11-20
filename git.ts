// The git layer of the forge: a content-addressed object store, packfile read/write,
// pkt-line framing, and the smart-HTTP endpoints (info/refs, git-upload-pack speaking
// protocol v2 with a v0 fallback, git-receive-pack v0). Standard library only.
//
// Objects live in one store shared by every repository, exactly like a real git object
// database: repositories differ only in their refs. Everything is in memory, which keeps
// the timed workloads fast; nothing here touches the disk or the clock for object bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO = '0000000000000000000000000000000000000000';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

// ------------------------------------------------------------------ object store

export class ObjectStore {
  private map = new Map<string, { type: ObjType; data: Buffer }>();

  put(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.map.has(sha)) this.map.set(sha, { type, data });
    return sha;
  }

  has(sha: string): boolean {
    return this.map.has(sha);
  }

  get(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.map.get(sha);
  }

  typeOf(sha: string): ObjType | undefined {
    return this.map.get(sha)?.type;
  }
}

// ------------------------------------------------------------------ commits and trees

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000" for a subtree
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  // Git orders tree entries by name, with directories sorting as if they ended in "/".
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function buildCommitData(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.authorLine}`);
  lines.push(`committer ${info.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Follow tag objects down to the object they ultimately name. */
export function peelToCommit(store: ObjectStore, sha: string): string {
  let cur = sha;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.get(cur);
    if (obj === undefined) return cur;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return cur;
  }
  return cur;
}

/** The commit a ref ultimately points at, or undefined when it cannot be resolved. */
export function resolveCommit(store: ObjectStore, sha: string): CommitInfo | undefined {
  const target = peelToCommit(store, sha);
  const obj = store.get(target);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data);
}

// ------------------------------------------------------------------ tree walking

/** Every object reachable from a commit: the commit, its trees and blobs (not ancestors). */
export function commitClosure(store: ObjectStore, commitSha: string, into: Set<string>): void {
  const commit = resolveCommit(store, commitSha);
  if (commit === undefined) return;
  into.add(peelToCommit(store, commitSha));
  const walk = (treeSha: string): void => {
    if (into.has(treeSha)) return;
    const obj = store.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    into.add(treeSha);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.sha);
      else into.add(e.sha);
    }
  };
  walk(commit.tree);
}

/** All ancestors of a commit, itself included, following first and later parents alike. */
export function ancestorsOf(store: ObjectStore, commitSha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [peelToCommit(store, commitSha)];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    const obj = store.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, maybeAncestor: string, ofCommit: string): boolean {
  if (maybeAncestor === ofCommit) return true;
  return ancestorsOf(store, ofCommit).has(maybeAncestor);
}

/** Flatten a tree into path -> blob entry, recursively. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', into = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return into;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.sha, path, into);
    else into.set(path, e);
  }
  return into;
}

/** Read the blob at a path inside a commit's tree, or undefined. */
export function blobAtPath(store: ObjectStore, treeSha: string, segments: string[]): { sha: string; mode: string } | undefined {
  let cur = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = store.get(cur);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry.mode === '40000' ? undefined : { sha: entry.sha, mode: entry.mode };
    if (entry.mode !== '40000') return undefined;
    cur = entry.sha;
  }
  return undefined;
}

/**
 * Return a new tree sha with `segments` set to the given blob (or removed when blobSha
 * is null), creating intermediate trees as needed. An emptied subtree is pruned, as git
 * does not track empty directories.
 */
export function updateTree(store: ObjectStore, treeSha: string | undefined, segments: string[], blobSha: string | null, mode = '100644'): string {
  const entries: TreeEntry[] = treeSha === undefined ? [] : parseTree((store.get(treeSha) as { data: Buffer }).data);
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode, name: head, sha: blobSha };
    } else {
      entries.push({ mode, name: head, sha: blobSha });
    }
  } else {
    const subSha = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.sha : undefined;
    const newSub = updateTree(store, subSha, rest, blobSha, mode);
    const subObj = store.get(newSub);
    const subEmpty = subObj !== undefined && parseTree(subObj.data).length === 0;
    if (subEmpty) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, sha: newSub };
    } else {
      entries.push({ mode: '40000', name: head, sha: newSub });
    }
  }
  return store.put('tree', serializeTree(entries));
}

// ------------------------------------------------------------------ packfiles

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const packCache = new Map<string, Buffer>();

/** Build a pack holding the given objects whole (no deltas), in the order given. */
export function buildPack(store: ObjectStore, shas: string[]): Buffer {
  // Objects are immutable, so a pack for a given object list never changes; the
  // clone workload asks for the same pack fifty times in a row.
  const cacheKey = shas.join(' ');
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'utf8');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  parts.push(head);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (packCache.size > 64) packCache.clear();
  packCache.set(cacheKey, pack);
  return pack;
}

/** Inflate one deflate stream starting at `offset`; returns data and the offset just past it. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const rest = buf.subarray(offset);
  // inflateSync ignores trailing bytes, and a truncated stream throws: the consumed
  // length is the smallest prefix that inflates, found by binary search.
  let lo = 1;
  let hi = rest.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      zlibInflate(rest.subarray(0, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('corrupt deflate stream in pack');
  return { data: zlibInflate(rest.subarray(0, found)), next: offset + found };
}

function zlibInflate(buf: Buffer): Buffer {
  return inflateSync(buf);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i] as number;
      i += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readSize();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i] as number; i += 1; }
      if (op & 0x02) { offset |= (delta[i] as number) << 8; i += 1; }
      if (op & 0x04) { offset |= (delta[i] as number) << 16; i += 1; }
      if (op & 0x08) { offset |= (delta[i] as number) << 24; i += 1; }
      if (op & 0x10) { size = delta[i] as number; i += 1; }
      if (op & 0x20) { size |= (delta[i] as number) << 8; i += 1; }
      if (op & 0x40) { size |= (delta[i] as number) << 16; i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}


/**
 * Parse a whole packfile into the store. Delta bases always appear earlier in the
 * pack (or are already in the store for ref-deltas), so objects resolve in one pass.
 * Returns the number of objects read.
 */
export function absorbPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('utf8') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const indexByHeader = new Map<number, string>();
  for (let n = 0; n < count; n += 1) {
    const headerAt = offset;
    const firstByte = pack[offset] as number;
    const typeNum = (firstByte >> 4) & 0x07;
    let i = offset + 1;
    let byte = firstByte;
    while (byte & 0x80) {
      byte = pack[i] as number;
      i += 1;
    }
    if (typeNum === 6) {
      // ofs-delta: the base is identified by the offset of its own header.
      let back = pack[i] as number;
      i += 1;
      let backValue = back & 0x7f;
      while (back & 0x80) {
        back = pack[i] as number;
        i += 1;
        backValue = ((backValue + 1) << 7) | (back & 0x7f);
      }
      const baseSha = indexByHeader.get(headerAt - backValue);
      if (baseSha === undefined) throw new Error('ofs-delta base is not in this pack');
      const base = store.get(baseSha);
      if (base === undefined) throw new Error('ofs-delta base missing from store');
      const { data, next } = inflateAt(pack, i);
      offset = next;
      const sha = store.put(base.type, applyDelta(base.data, data));
      indexByHeader.set(headerAt, sha);
      continue;
    }
    if (typeNum === 7) {
      const baseSha = pack.subarray(i, i + 20).toString('hex');
      i += 20;
      const base = store.get(baseSha);
      if (base === undefined) throw new Error('ref-delta base missing from store');
      const { data, next } = inflateAt(pack, i);
      offset = next;
      const sha = store.put(base.type, applyDelta(base.data, data));
      indexByHeader.set(headerAt, sha);
      continue;
    }
    const type = NUM_TYPE[typeNum] as ObjType;
    const { data, next } = inflateAt(pack, i);
    offset = next;
    const sha = store.put(type, data);
    indexByHeader.set(headerAt, sha);
  }
  return count;
}

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a buffer of pkt-lines into packets; throws on a malformed length. */
export function parsePkts(buf: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const lenText = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('pkt-line overruns the buffer');
    packets.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, next: i };
}

/** Frame pack bytes as sideband band-1 pkt-lines, for upload-pack and receive-pack. */
export function sidebandFrame(pack: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  if (progress !== undefined && progress !== '') {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CHUNK)])));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

export interface FetchPlan {
  objects: string[]; // object shas to pack, in a stable order
  shallow: string[]; // commit shas on the shallow boundary to report
  unshallow: string[]; // previously shallow commits this fetch deepens past
}

/**
 * Choose the objects a fetch answers with: everything reachable from the wants,
 * minus everything the client already holds, honouring a shallow depth measured in
 * commits from each want tip. A commit the client marks shallow is a boundary: the
 * client holds the commit and its tree, but none of its ancestors.
 */
export function planFetch(store: ObjectStore, wants: string[], haves: string[], deepen: number | undefined, shallowMarks: string[]): FetchPlan {
  const shallowSet = new Set(shallowMarks.map((m) => peelToCommit(store, m)));
  const haveObjects = new Set<string>();
  {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const have of haves) if (store.has(have)) queue.push(peelToCommit(store, have));
    for (const mark of shallowSet) if (store.has(mark) && !queue.includes(mark)) queue.push(mark);
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      commitClosure(store, cur, haveObjects);
      if (shallowSet.has(cur)) continue; // the boundary: ancestors are not held
      const commit = resolveCommit(store, cur);
      if (commit !== undefined) queue.push(...commit.parents);
    }
  }

  const include = new Set<string>();
  const shallow: string[] = [];
  const seenCommitDepth = new Map<string, number>();

  const includeTreeOf = (commitSha: string): void => {
    const commit = resolveCommit(store, commitSha);
    if (commit === undefined) return;
    const closure = new Set<string>();
    commitClosure(store, commitSha, closure);
    for (const sha of closure) {
      if (!haveObjects.has(sha)) include.add(sha);
    }
  };

  // Breadth-first over commits so depth is the shortest distance from any want.
  const queue: Array<{ sha: string; depth: number }> = [];
  for (const want of wants) {
    const tip = peelToCommit(store, want);
    if (store.typeOf(tip) === 'commit') queue.push({ sha: tip, depth: 1 });
    else if (store.has(want)) {
      // A tree or blob want (used by fixture fetches): send its closure directly.
      const closure = new Set<string>();
      if (store.typeOf(want) === 'tree') {
        const walk = (t: string): void => {
          if (closure.has(t)) return;
          closure.add(t);
          const obj = store.get(t);
          if (obj === undefined) return;
          for (const e of parseTree(obj.data)) {
            if (e.mode === '40000') walk(e.sha);
            else closure.add(e.sha);
          }
        };
        walk(want);
      } else closure.add(want);
      for (const sha of closure) if (!haveObjects.has(sha)) include.add(sha);
    }
  }
  while (queue.length > 0) {
    const { sha, depth } = queue.shift() as { sha: string; depth: number };
    const prev = seenCommitDepth.get(sha);
    if (prev !== undefined && prev <= depth) continue;
    seenCommitDepth.set(sha, depth);
    // A commit the client already has still gets traversed: a deepen request needs
    // the ancestors beyond the client's shallow boundary, which sit behind it.
    if (!haveObjects.has(sha)) includeTreeOf(sha);
    const commit = resolveCommit(store, sha);
    if (commit === undefined) continue;
    if (deepen !== undefined && depth >= deepen) {
      if (commit.parents.length > 0 && !haveObjects.has(sha)) shallow.push(sha);
      continue;
    }
    for (const parent of commit.parents) queue.push({ sha: parent, depth: depth + 1 });
  }
  // Non-commit wants that are tags: include the tag object itself.
  for (const want of wants) {
    if (store.typeOf(want) === 'tag' && !haveObjects.has(want)) include.add(want);
  }
  const unshallow: string[] = [];
  if (deepen !== undefined) {
    for (const mark of shallowSet) {
      const depth = seenCommitDepth.get(mark);
      if (depth !== undefined && depth < deepen) unshallow.push(mark);
    }
  }
  return { objects: [...include], shallow, unshallow };
}

// ------------------------------------------------------------------ smart HTTP

import type { Forge, RepoRec } from './forge.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta multi_ack_detailed no-done agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function refLines(store: ObjectStore, repo: RepoRec, caps: string | null): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  let first = true;
  const emit = (text: string): void => {
    if (first && caps !== null) {
      lines.push(pktLine(`${text}\0${caps}`));
    } else {
      lines.push(pktLine(text));
    }
    first = false;
  };
  if (headSha !== undefined) emit(`${headSha} HEAD`);
  for (const [ref, sha] of sortedRefs(repo)) {
    emit(`${sha} ${ref}`);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'tag') {
      lines.push(pktLine(`${peelToCommit(store, sha)} ${ref}^{}`));
    }
  }
  if (first) {
    // No refs at all: git advertises a zero HEAD under a pseudo-ref.
    lines.push(pktLine(`${ZERO} capabilities^{}\0${caps ?? ''}`));
  }
  return lines;
}

/** GET info/refs for either service. */
export function infoRefs(forge: Forge, repo: RepoRec, service: string, protocolV2: boolean): GitResponse {
  const store = forge.store;
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = [
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(lines) };
  }
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS_V0;
  const parts = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...refLines(store, repo, caps), PKT_FLUSH];
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

interface PktReader {
  lines: string[];
  rest: Buffer;
}

/** Read pkt-lines until the first flush; returns the data lines and the bytes after. */
function readUntilFlush(buf: Buffer): PktReader {
  const { packets, next } = parsePktsUntilFlush(buf);
  return { lines: packets, rest: buf.subarray(next) };
}

function parsePktsUntilFlush(buf: Buffer): { packets: string[]; next: number } {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line');
    if (len === 0) return { packets: lines, next: i + 4 };
    if (len === 1 || len === 2) {
      i += 4;
      continue;
    }
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { packets: lines, next: i };
}

/** Split a v2 request into command, capabilities and argument lines. */
function splitV2Request(buf: Buffer): { command: string; args: string[] } {
  const all: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line');
    if (len === 0) break;
    if (len === 1 || len === 2) {
      i += 4;
      continue;
    }
    all.push(buf.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, ''));
    i += len;
  }
  const commandLine = all.find((l) => l.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length).trim();
  const args = all.filter((l) => l !== commandLine && !l.startsWith('agent=') && !l.startsWith('object-format='));
  return { command, args };
}

function lsRefsAnswer(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  const store = forge.store;
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const out: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      out.push(pktLine(`${headSha} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (wantUnborn) {
      out.push(pktLine(`${ZERO} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''} unborn\n`));
    }
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    const obj = store.get(sha);
    if (wantPeel && obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(store, sha)}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function fetchAnswer(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  const store = forge.store;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowMarks: string[] = [];
  const wantRefs: string[] = [];
  let deepen: number | undefined;
  let done = false;
  let waitForDone = false;
  for (const raw of args) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowMarks.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('want-ref ')) wantRefs.push(line.slice(9).trim());
    else if (line === 'done') done = true;
    else if (line === 'wait-for-done') waitForDone = true;
  }
  const sections: Buffer[][] = [];
  const acks: string[] = [];
  for (const have of haves) {
    if (store.has(have) && store.typeOf(have) === 'commit') acks.push(`ACK ${have}\n`);
  }
  if (waitForDone && !done) {
    const lines = [pktLine('acknowledgments\n')];
    if (acks.length === 0) lines.push(pktLine('NAK\n'));
    else for (const a of acks) lines.push(pktLine(a));
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  if (haves.length > 0) {
    const lines = [pktLine('acknowledgments\n')];
    if (acks.length === 0) lines.push(pktLine('NAK\n'));
    else for (const a of acks) lines.push(pktLine(a));
    sections.push(lines);
  }
  const resolvedWants = [...wants];
  const wantedRefLines: string[] = [];
  for (const ref of wantRefs) {
    const sha = repo.refs.get(ref);
    if (sha !== undefined) {
      resolvedWants.push(sha);
      wantedRefLines.push(`${sha} ${ref}\n`);
    }
  }
  const plan = planFetch(store, resolvedWants, haves, deepen, shallowMarks);
  if (deepen !== undefined || shallowMarks.length > 0) {
    const lines = [pktLine('shallow-info\n')];
    for (const sha of plan.shallow) lines.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) lines.push(pktLine(`unshallow ${sha}\n`));
    sections.push(lines);
  }
  if (wantedRefLines.length > 0) {
    const lines = [pktLine('wanted-refs\n')];
    for (const l of wantedRefLines) lines.push(pktLine(l));
    sections.push(lines);
  }
  const pack = buildPack(store, plan.objects);
  const packSection = [pktLine('packfile\n'), sidebandFrame(pack)];
  sections.push(packSection);
  const out: Buffer[] = [];
  sections.forEach((section, idx) => {
    if (idx > 0) out.push(PKT_DELIM);
    out.push(...section);
  });
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function uploadPackV0(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const store = forge.store;
  const { lines } = readUntilFlush(body);
  const wants: string[] = [];
  let sideband = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const sha = rest.split(' ')[0] as string;
      wants.push(sha);
      if (rest.includes('side-band-64k')) sideband = true;
    }
  }
  // "have" lines and the final "done" follow in a second pkt block; parse the rest too.
  const plan = planFetch(store, wants, [], undefined, []);
  const pack = buildPack(store, plan.objects);
  const nak = pktLine('NAK\n');
  if (sideband) return Buffer.concat([nak, sidebandFrame(pack), PKT_FLUSH]);
  return Buffer.concat([nak, pack]);
}

/** POST git-upload-pack. */
export function uploadPack(forge: Forge, repo: RepoRec, body: Buffer): GitResponse {
  const firstFour = body.subarray(0, 4).toString('ascii');
  void firstFour;
  const { command, args } = splitV2Request(body);
  let payload: Buffer;
  if (command === 'ls-refs') payload = lsRefsAnswer(forge, repo, args);
  else if (command === 'fetch') payload = fetchAnswer(forge, repo, args);
  else payload = uploadPackV0(forge, repo, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: payload };
}

/** POST git-receive-pack. */
export function receivePack(forge: Forge, repo: RepoRec, body: Buffer): GitResponse {
  const store = forge.store;
  const { lines, rest } = readUntilFlush(body);
  let sideband = false;
  let reportStatus = false;
  interface Cmd { oldSha: string; newSha: string; ref: string }
  const commands: Cmd[] = [];
  for (const raw of lines) {
    let line = raw;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      if (caps.includes('report-status')) reportStatus = true;
      line = line.slice(0, nul);
    }
    const parts = line.trim().split(' ');
    if (parts.length === 3) commands.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts[2] as string });
  }
  let unpackOk = true;
  let unpackError = '';
  if (rest.length > 0) {
    try {
      absorbPack(store, rest);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: `unpack failed: ${unpackError}` });
  } else {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newSha === ZERO) {
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!store.has(cmd.newSha)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current !== undefined && cmd.oldSha !== ZERO && current !== cmd.oldSha) {
        results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (current !== undefined && !cmd.ref.startsWith('refs/tags/')) {
        const oldCommit = peelToCommit(store, current);
        const newCommit = peelToCommit(store, cmd.newSha);
        if (store.typeOf(oldCommit) === 'commit' && store.typeOf(newCommit) === 'commit' && !isAncestor(store, oldCommit, newCommit)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(cmd.ref, cmd.newSha);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }
  if (!reportStatus) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack error: ${unpackError}\n`)];
  for (const r of results) {
    reportLines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const report = Buffer.concat(reportLines);
  if (sideband) {
    // The band-1 stream is itself a pkt-line stream and needs its own flush inside
    // the band before the outer flush closes the sideband.
    const inner = Buffer.concat([report, PKT_FLUSH]);
    const framed = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat([report, PKT_FLUSH]) };
}
