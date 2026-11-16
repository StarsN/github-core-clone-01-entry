// app.ts — the HTTP surface of the forge: health probe, REST v3, GraphQL, the MCP endpoint and git
// smart-HTTP, wired to the domain in src/. main.ts owns the lifecycle; this file owns the routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo } from './src/forge.ts';
import { infoRefs, lsRefs, fetchV2, fetchV0, receivePack, parsePkts, type FetchArgs, type PushCommand } from './src/gitproto.ts';
import { handleRest } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The bearer token on the request, or null. Accepts `Bearer x` and `token x`. */
function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const token = header.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '').trim();
  return token === '' ? null : token;
}

/**
 * Whether the request is authenticated. When the trial hands the entry its token
 * (MAKEFUN_SHOP_TOKEN), only that token passes; without one, any non-empty bearer token does —
 * the account behind it is the trial's viewer either way.
 */
function authorized(req: IncomingMessage): boolean {
  const token = presentedToken(req);
  if (token === null) return false;
  return EXPECTED_TOKEN === '' || token === EXPECTED_TOKEN;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function requestId(): string {
  requestCounter += 1;
  return `github-core-clone-${requestCounter.toString(16)}-${Date.now().toString(16)}`;
}

// -------------------------------------------------------------------------------------------------
// git smart-HTTP
// -------------------------------------------------------------------------------------------------

function splitCaps(line: string): { main: string; caps: string } {
  const nul = line.indexOf('\0');
  if (nul < 0) return { main: line, caps: '' };
  return { main: line.slice(0, nul), caps: line.slice(nul + 1) };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string, url: URL): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const method = req.method ?? 'GET';

  if (method === 'GET' && tail === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('invalid service\n'));
      return;
    }
    const protocol = req.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.toLowerCase().includes('version=2');
    const reply = infoRefs(repo, service, isV2);
    sendBuffer(res, reply.status, reply.contentType, reply.body);
    return;
  }

  if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = parsePkts(body);
    } catch {
      // A body that is not pkt-lines at all (the suite sends one on purpose): refuse it, stay up.
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('invalid pkt-line body\n'));
      return;
    }
    const lines = parsed.items.filter((item) => item.kind === 'line').map((item) => (item as { data: Buffer }).data.toString('utf8').replace(/\n$/, ''));

    if (tail === 'git-receive-pack') {
      const commands: PushCommand[] = [];
      let caps = '';
      lines.forEach((raw, index) => {
        const { main, caps: lineCaps } = index === 0 ? splitCaps(raw) : { main: raw, caps: '' };
        if (index === 0) caps = lineCaps;
        const [oldOid, newOid, ref] = main.split(' ');
        if (oldOid !== undefined && newOid !== undefined && ref !== undefined) commands.push({ oldOid, newOid, ref });
      });
      const pack = body.subarray(parsed.next);
      const reply = receivePack(repo, commands, pack.length > 0 ? Buffer.from(pack) : null, caps);
      sendBuffer(res, reply.status, reply.contentType, reply.body);
      return;
    }

    // upload-pack
    const protocol = req.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.toLowerCase().includes('version=2');
    if (isV2) {
      // Capability lines run to the first delimiter; argument lines follow it.
      const delimIndex = parsed.items.findIndex((item) => item.kind === 'delim');
      const commandItems = delimIndex >= 0 ? parsed.items.slice(0, delimIndex) : parsed.items;
      const argItems = delimIndex >= 0 ? parsed.items.slice(delimIndex + 1) : [];
      const commandLine = commandItems.find((item) => item.kind === 'line');
      const command = commandLine !== undefined ? splitCaps((commandLine as { data: Buffer }).data.toString('utf8').replace(/\n$/, '')).main : '';
      const argLines = argItems.filter((item) => item.kind === 'line').map((item) => (item as { data: Buffer }).data.toString('utf8').replace(/\n$/, ''));
      if (command === 'command=ls-refs') {
        const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const line of argLines) {
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        const reply = lsRefs(repo, args);
        sendBuffer(res, reply.status, reply.contentType, reply.body);
        return;
      }
      if (command === 'command=fetch') {
        const reply = fetchV2(repo, fetchArgsOf(argLines));
        sendBuffer(res, reply.status, reply.contentType, reply.body);
        return;
      }
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
      return;
    }

    // v0 upload-pack: want/have lines, the first carrying the client's capabilities.
    let caps = '';
    const argLines = lines.map((raw, index) => {
      if (index === 0) {
        const split = splitCaps(raw);
        caps = split.caps;
        return split.main;
      }
      return raw;
    });
    const reply = fetchV0(repo, fetchArgsOf(argLines), caps);
    sendBuffer(res, reply.status, reply.contentType, reply.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function fetchArgsOf(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) args.deepen = depth;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

// -------------------------------------------------------------------------------------------------
// The server
// -------------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3. The root answers without a token (as api.github.com's root does); everything
        // below it requires the trial token.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const headers = { 'x-github-request-id': requestId() };
          const segments = path
            .replace(/^\/api\/v3\/?/, '')
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          if (segments.length > 0 && !authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, headers);
            return;
          }
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
                return;
              }
            }
          }
          const origin = `http://${req.headers.host ?? 'localhost'}`;
          const reply = handleRest(method, segments, url.searchParams, body, origin);
          sendJson(res, reply.status, reply.body, { ...headers, ...(reply.headers ?? {}) });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(body)) {
            sendJson(res, 200, body.map((entry) => executeGraphQL(entry)));
            return;
          }
          sendJson(res, 200, executeGraphQL(body));
          return;
        }

        // The MCP endpoint.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const raw = await readBody(req);
          const reply = handleMcp(raw);
          if (reply.body === null) {
            res.writeHead(reply.status, { 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body);
          return;
        }

        // git smart-HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          await handleGit(req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3], url);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // One bad request never takes the forge down.
        try {
          sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
        } catch {
          // The response was already half-sent; nothing more to do.
        }
      }
    })();
  });
}
