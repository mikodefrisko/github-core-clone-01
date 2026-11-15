// Git smart HTTP: info/refs (v0 + v2 advertisements), protocol v2 ls-refs and
// fetch, and v0 receive-pack. The client (the suite's git-client.ts) is the
// spec; the contract notes live in the kit's analysis/git-contract.md.
//
// Upload-pack speaks protocol v2 when the client asks for it (Git-Protocol:
// version=2) and v0 otherwise; receive-pack is v0-only, always. Packs the
// server sends carry plain objects only, framed as sideband band-1 packets.
// Ref updates enforce fast-forward: a non-fast-forward update is refused
// per-ref with the literal reason `non-fast-forward` while the pack still
// unpacks ok.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { ZERO_OID } from './store.ts';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  sidebandPackets,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
} from './gitobj.ts';
import type { GitObject } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_REQ = 'application/x-git-upload-pack-request';
const RECEIVE_REQ = 'application/x-git-receive-pack-request';

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
}

function badRequest(res: ServerResponse, message: string): void {
  send(res, 400, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`, 'utf8'));
}

/** Parse /<owner>/<repo>.git/<rest> from a path; null when it is not a git path. */
function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== '') return null;
  const owner = parts[1] as string;
  const repoGit = parts[2] as string;
  if (!repoGit.endsWith('.git')) return null;
  const repo = repoGit.slice(0, -4);
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) return null;
  return { owner, repo, rest: parts.slice(3).join('/') };
}

/** The v0 capability list for upload-pack (first line, after NUL). */
function uploadCapsV0(): string {
  return 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
}

/** The v0 capability list for receive-pack (first line, after NUL). */
function receiveCapsV0(): string {
  return 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
}

function refLinesV0(repo: Repo, caps: string): Buffer[] {
  const chunks: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (refs.length === 0) {
    chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return chunks;
  }
  let first = true;
  for (const [name, oid] of refs) {
    const suffix = first ? `\0${caps}` : '';
    chunks.push(encodePktLine(`${oid} ${name}${suffix}\n`));
    first = false;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag' && name.startsWith('refs/tags/')) {
      const peeled = parseTag(obj.data).object;
      chunks.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return chunks;
}

function infoRefsUpload(repo: Repo, wantsV2: boolean): Buffer {
  const chunks: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  if (wantsV2) {
    chunks.push(encodePktLine('version 2\n'));
    chunks.push(encodePktLine('fetch=shallow\n'));
    chunks.push(encodePktLine('ls-refs=unborn\n'));
    chunks.push(encodePktLine(`agent=${AGENT}\n`));
    chunks.push(encodePktLine('object-format=sha1\n'));
    chunks.push(PKT_FLUSH);
  } else {
    chunks.push(...refLinesV0(repo, uploadCapsV0()));
    chunks.push(PKT_FLUSH);
  }
  return Buffer.concat(chunks);
}

function infoRefsReceive(repo: Repo): Buffer {
  const chunks: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  chunks.push(...refLinesV0(repo, receiveCapsV0()));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const headOid = repo.refs.get(repo.headTarget);
  const push = (line: string): void => {
    lines.push(encodePktLine(line));
  };
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (include('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${repo.headTarget}`;
      push(`${line}\n`);
    } else if (args.unborn) {
      let line = `unborn HEAD`;
      if (args.symrefs) line += ` symref-target:${repo.headTarget}`;
      push(`${line}\n`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    if (!include(name)) continue;
    let line = `${oid} ${name}`;
    if (args.symrefs && name === repo.headTarget) {
      // HEAD's target is reported on the HEAD line, not here.
    }
    const obj = repo.objects.get(oid);
    if (args.peel && obj !== undefined && obj.type === 'tag' && name.startsWith('refs/tags/')) {
      line += ` peeled:${parseTag(obj.data).object}`;
    }
    push(`${line}\n`);
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  deepen: number | null;
  thinPack: boolean;
}

function parseFetchArgs(lines: readonly { payload: Buffer }[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], deepen: null, thinPack: false };
  const seenWant = new Set<string>();
  for (const { payload } of lines) {
    const text = payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const oid = text.slice(5).trim();
      if (!seenWant.has(oid)) {
        seenWant.add(oid);
        args.wants.push(oid);
      }
    } else if (text.startsWith('have ')) {
      args.haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      args.shallowBoundaries.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.deepen = Math.trunc(n);
    } else if (text === 'thin-pack') {
      args.thinPack = true;
    }
  }
  return args;
}

/** Commits within `depth` generations of `roots` (depth 1 = roots only) and their boundary. */
function shallowClosure(
  objects: Map<string, GitObject>,
  roots: readonly string[],
  depth: number,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = roots.map((oid) => ({ oid, gen: 0 }));
  const seenGen = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const prev = seenGen.get(oid);
    if (prev !== undefined && prev <= gen) continue;
    seenGen.set(oid, gen);
    if (gen >= depth) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    included.add(oid);
    const parents = parseCommit(obj.data).parents;
    if (gen + 1 >= depth) {
      if (parents.length > 0) boundary.add(oid);
    } else {
      for (const parent of parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return { included, boundary };
}

/** Tree + blob closure of a set of commits. */
function treeClosure(objects: Map<string, GitObject>, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    const stack = [tree];
    while (stack.length > 0) {
      const entry = stack.pop() as string;
      if (out.has(entry)) continue;
      const entryObj = objects.get(entry);
      if (entryObj === undefined) continue;
      out.add(entry);
      if (entryObj.type === 'tree') {
        for (const child of parseTree(entryObj.data)) {
          if (child.mode !== '160000') stack.push(child.oid);
        }
      }
    }
  }
  return out;
}

interface FetchPlan {
  /** Objects to send, in a stable order (commits first is fine). */
  objects: GitObject[];
  /** New shallow boundaries to report. */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const objects = repo.objects;
  const wantSet = new Set(args.wants.filter((oid) => oid !== ZERO_OID));
  if (wantSet.size === 0) return { objects: [], shallow: [], unshallow: [] };
  if (args.deepen !== null) {
    const { included, boundary } = shallowClosure(objects, [...wantSet], args.deepen);
    const trees = treeClosure(objects, included);
    // What the client already holds: each old boundary commit + its tree closure.
    const held = new Set<string>();
    for (const boundaryOid of args.shallowBoundaries) {
      held.add(boundaryOid);
      for (const oid of treeClosure(objects, [boundaryOid])) held.add(oid);
    }
    const send = new Set<string>();
    for (const oid of included) if (!held.has(oid)) send.add(oid);
    for (const oid of trees) if (!held.has(oid)) send.add(oid);
    const unshallow: string[] = [];
    for (const old of args.shallowBoundaries) {
      if (included.has(old) && !boundary.has(old)) unshallow.push(old);
    }
    const ordered = orderObjects(objects, send);
    return { objects: ordered, shallow: [...boundary], unshallow };
  }
  const wanted = collectReachable(objects, wantSet);
  const held = args.haves.length > 0 ? collectReachable(objects, args.haves.filter((oid) => oid !== ZERO_OID)) : new Set<string>();
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);
  return { objects: orderObjects(objects, send), shallow: [], unshallow: [] };
}

function orderObjects(objects: Map<string, GitObject>, oids: Set<string>): GitObject[] {
  // Commits, trees, blobs, tags — a stable order the client accepts in any order.
  const byType: Record<string, GitObject[]> = { commit: [], tree: [], blob: [], tag: [] };
  for (const oid of oids) {
    const obj = objects.get(oid);
    if (obj !== undefined) byType[obj.type]?.push(obj);
  }
  return [...byType.commit, ...byType.tree, ...byType.blob, ...byType.tag];
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const chunks: Buffer[] = [];
  // Real git only expects an acknowledgments section when the client sent
  // `have` lines (a negotiation happened). A fresh fetch with no haves is
  // answered with the packfile section directly; sending `acknowledgments`
  // there makes real git die with "expected 'packfile'". The suite's client
  // accepts either form.
  if (args.haves.length > 0) {
    chunks.push(encodePktLine('acknowledgments\n'));
    chunks.push(encodePktLine('NAK\n'));
    chunks.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
    chunks.push(PKT_DELIM);
  }
  // No wanted-refs section: it is optional in protocol v2 (the client
  // already knows ref -> oid from ls-refs), and real git rejects a
  // wanted-refs line for a ref it did not ask for — which happens on a
  // shallow clone whenever a tag points at the same tip as the branch.
  // The suite's client accepts the section's absence.
  chunks.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects);
  chunks.push(...sidebandPackets(pack));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const chunks: Buffer[] = [];
  chunks.push(encodePktLine('NAK\n'));
  for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  chunks.push(...sidebandPackets(pack));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: readonly { payload: Buffer }[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const { payload } of lines) {
    const text = payload.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  return commands;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  // Commands run to the first flush; the rest is the raw pack.
  let at = 0;
  const commandLines: { payload: Buffer }[] = [];
  let packStart = body.length;
  try {
    while (at < body.length) {
      if (at + 4 > body.length) break;
      const head = body.subarray(at, at + 4).toString('ascii');
      if (head === '0000') {
        packStart = at + 4;
        break;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || len > 65520 || at + len > body.length) {
        packStart = body.length;
        break;
      }
      commandLines.push({ payload: Buffer.from(body.subarray(at + 4, at + len)) });
      at += len;
    }
  } catch {
    packStart = body.length;
  }
  const commands = parsePushCommands(commandLines);
  const packBytes = body.subarray(packStart);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack error\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} missing object\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        report.push(`ng ${command.ref} no such ref\n`);
        continue;
      }
      if (command.oldOid !== current) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  }
  // The report stream inside band 1 is itself a pkt-line stream: it must be
  // terminated by a flush packet inside band 1 (real git's inner packet
  // reader waits for it and otherwise reports "the remote end hung up").
  // The suite's client filters data packets only, so the inner flush is
  // invisible to it.
  const reportBytes = Buffer.concat([...report.map((line) => encodePktLine(line)), PKT_FLUSH]);
  const chunks = sidebandPackets(reportBytes);
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- entry point

/** Handle a git smart-HTTP request. Returns true when the path was a git path. */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
): boolean {
  let path = '/';
  let service = '';
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    path = url.pathname;
    service = url.searchParams.get('service') ?? '';
  } catch {
    return false;
  }
  const parsed = parseGitPath(path);
  if (parsed === null) return false;
  const method = req.method ?? 'GET';
  const { owner, repo: repoName, rest } = parsed;

  if (method === 'GET' && rest === 'info/refs') {
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      notFound(res);
      return true;
    }
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      send(res, 200, UPLOAD_AD, infoRefsUpload(repo, wantsV2));
      return true;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, RECEIVE_AD, infoRefsReceive(repo));
      return true;
    }
    badRequest(res, 'unknown service');
    return true;
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      notFound(res);
      return true;
    }
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      badRequest(res, 'malformed pkt-line stream');
      return true;
    }
    const dataLines = packets.filter((packet) => packet.kind === 'data');
    if (dataLines.length === 0) {
      badRequest(res, 'empty upload-pack request');
      return true;
    }
    const first = (dataLines[0] as { payload: Buffer }).payload.toString('utf8');
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (first.startsWith('command=ls-refs')) {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      let seenDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (packet.kind !== 'data' || !seenDelim) continue;
        const text = packet.payload.toString('utf8').trim();
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text === 'unborn') args.unborn = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      send(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, args));
      return true;
    }
    if (first.startsWith('command=fetch')) {
      const argLines: { payload: Buffer }[] = [];
      let seenDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (packet.kind === 'data' && seenDelim) argLines.push(packet);
      }
      const args = parseFetchArgs(argLines);
      void wantsV2;
      send(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, args));
      return true;
    }
    if (first.startsWith('want ')) {
      // v0 fetch: wants in section 1, haves + done in section 2 (split on flush).
      const argLines: { payload: Buffer }[] = [];
      for (const packet of packets) {
        if (packet.kind === 'data') argLines.push(packet);
      }
      const args = parseFetchArgs(argLines);
      send(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, args));
      return true;
    }
    badRequest(res, 'unknown upload-pack command');
    return true;
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      notFound(res);
      return true;
    }
    const contentType = req.headers['content-type'] ?? '';
    if (!String(contentType).includes('application/x-git-receive-pack-request') && body.length > 0) {
      // The suite always sends the right type; tolerate anything else by trying to parse.
    }
    send(res, 200, 'application/x-git-receive-pack-result', receivePack(repo, body));
    return true;
  }

  return false;
}
