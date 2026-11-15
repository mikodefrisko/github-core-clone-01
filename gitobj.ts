// Git object model, packfile codec and pkt-line framing — the whole of git the
// forge speaks, implemented on node:crypto and node:zlib only (there is no git
// binary in the trial). Packs the server writes carry plain objects only (no
// deltas: the suite's pack-deltas check only requires deltas to resolve *when
// the server sends them*); packs the server reads may carry OFS/REF deltas,
// which resolve here.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash as createHashCrypto } from 'node:crypto';
import type { GitObject, ObjType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Decode base64 tolerantly: strip whitespace and repair missing padding. */
export function decodeBase64Loose(input: string): Buffer {
  const cleaned = input.replace(/\s/g, '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** SHA-1 of a loose object: sha1("<type> <size>\0" + data). */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHashCrypto('sha1').update(header).update(data).digest('hex');
}

export function putObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/** Git tree-entry sort: a directory compares as if its name ended in '/'. */
export function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? `${name}/` : name;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.mode, a.name);
    const kb = treeSortKey(b.mode, b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.author}\n`;
  out += `committer ${info.committer}\n`;
  out += `\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The reachability closure of roots: commit -> tree + parents, tree -> entries (not gitlinks), tag -> target. */
export function collectReachable(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or they are equal). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packVarint(first: number, size: number): Buffer {
  const bytes: number[] = [];
  let value = size;
  bytes.push((first << 4) | (value & 0x0f));
  value >>>= 4;
  while (value > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(value & 0x7f);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

/** A pack v2 of plain objects, checksummed. No deltas. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const deflated = deflateSync(obj.data);
    chunks.push(packVarint(PACK_TYPE_CODES[obj.type], obj.data.length));
    chunks.push(deflated);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHashCrypto('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readPackVarint(buf: Buffer, at: number): { type: number; size: number; next: number } {
  let byte = buf[at] as number;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = at + 1;
  while (byte & 0x80) {
    byte = buf[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if (pos > buf.length) throw new Error('pack varint is truncated');
  }
  return { type, size, next: pos };
}

function readOfsVarint(buf: Buffer, at: number): { value: number; next: number } {
  let byte = buf[at] as number;
  let value = byte & 0x7f;
  let pos = at + 1;
  while (byte & 0x80) {
    byte = buf[pos] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    pos += 1;
    if (pos > buf.length) throw new Error('ofs-delta varint is truncated');
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= (delta[at] as number) << (8 * i);
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= (delta[at] as number) << (8 * i);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      if (at + op > delta.length) throw new Error('delta insert runs past the end');
      out.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0x00');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Inflate the zlib stream starting at `at`. `inflateSync` ignores trailing
 * bytes, and with `{info: true}` the engine's `bytesWritten` is exactly the
 * number of input bytes the stream consumed — the stream's own length.
 */
function inflateAt(buf: Buffer, at: number, expectedSize: number): { data: Buffer; used: number } {
  const result = inflateSync(buf.subarray(at), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (result.buffer.length !== expectedSize) throw new Error('pack object size mismatch');
  return { data: result.buffer, used: result.engine.bytesWritten };
}

export interface ParsedPack {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
}

/** Verify the trailer, then parse every entry (plain objects and OFS/REF deltas). */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header is not PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expect = createHashCrypto('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!expect.equals(buf.subarray(trailerStart))) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: ObjType }>();
  let at = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = at;
    const { type, size, next } = readPackVarint(buf, at);
    at = next;
    let objType: ObjType;
    let data: Buffer;
    if (type === 6) {
      const { value, next: afterOfs } = readOfsVarint(buf, at);
      const baseOffset = entryOffset - value;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is missing');
      const baseObj = objects.get(base.oid);
      if (baseObj === undefined) throw new Error('ofs-delta base object is missing');
      at = afterOfs;
      const inflated = inflateAt(buf, at, size);
      data = applyDelta(baseObj.data, inflated.data);
      objType = base.type;
      at += inflated.used;
    } else if (type === 7) {
      const baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateAt(buf, at, size);
      const baseObj = objects.get(baseOid);
      if (baseObj === undefined) throw new Error('ref-delta base object is missing');
      data = applyDelta(baseObj.data, inflated.data);
      objType = baseObj.type;
      at += inflated.used;
    } else {
      objType = PACK_TYPES[type] as ObjType;
      if (objType === undefined) throw new Error(`pack object type ${type}`);
      const inflated = inflateAt(buf, at, size);
      data = inflated.data;
      at += inflated.used;
    }
    const oid = objectId(objType, data);
    objects.set(oid, { type: objType, data });
    byOffset.set(entryOffset, { oid, type: objType });
  }
  if (at !== trailerStart) throw new Error('pack has trailing bytes');
  return { version, declaredCount, objects };
}

// ---------------------------------------------------------------- pkt-line

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a pkt-line stream; throws on a malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) throw new Error(`bad pkt-line length ${head}`);
    if (at + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(at + 4, at + len)) });
    at += len;
  }
  return out;
}

export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Frame bytes as sideband band-1 pkt-lines (payload <= 65515 per packet). */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < data.length; at += CHUNK) {
    const piece = data.subarray(at, Math.min(data.length, at + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (data.length === 0) out.push(encodePktLine(Buffer.from([1])));
  return out;
}
