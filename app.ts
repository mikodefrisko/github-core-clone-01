// The server: one Store, one request-id counter, and a dispatcher over the
// four surfaces — git smart HTTP, REST v3, GraphQL v4, MCP — plus /healthz.
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>`.
// When MAKEFUN_SHOP_TOKEN is set (the trial sets it), the token must match
// it; when it is unset, any non-empty Bearer token is accepted. A missing
// token answers 401 with a JSON body. MCP tools/call enforces the same rule
// inside its handler (before any tool lookup).
//
// Every response carries X-GitHub-Request-Id (an incrementing counter, no
// crypto per request). Unknown routes answer JSON 404, never HTML. A
// malformed JSON body on a REST call answers 400; git bodies are binary and
// are never JSON-parsed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest, type RouteContext } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The challenge a 401 carries so real git clients know to send credentials. */
const AUTH_CHALLENGE = { 'WWW-Authenticate': 'Basic realm="forge", Bearer' };

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('X-GitHub-Request-Id', String(requestCounter));
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Bearer (the suite's clients) and Basic (real git: the token is the
    // password) are both accepted; the credential is the bearer token either way.
    const authorization = req.headers.authorization ?? '';
    let token = '';
    if (authorization.startsWith('Bearer ')) {
      token = authorization.slice('Bearer '.length);
    } else if (authorization.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        token = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      } catch {
        token = '';
      }
    }
    const authorized = token !== '' && (expectedToken === '' || token === expectedToken);

    void (async () => {
      // Requests without a body (GETs, and any call with no Content-Length)
      // skip the body read entirely: no listener setup, no extra tick.
      const contentLength = Number(req.headers['content-length'] ?? '0');
      let body: Buffer;
      if ((method === 'GET' || method === 'HEAD' || method === 'DELETE') && (Number.isNaN(contentLength) || contentLength === 0)) {
        body = Buffer.alloc(0);
      } else {
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
      }
      try {
        // Git smart HTTP (binary bodies, no JSON parsing). Auth enforced.
        if (path.includes('.git/')) {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' }, AUTH_CHALLENGE);
            return;
          }
          if (handleGit(req, res, store, body)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' }, AUTH_CHALLENGE);
            return;
          }
          if (path === '/api/v3') req.url = '/api/v3/';
          let parsedBody: unknown = null;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const ctx: RouteContext = {
            store,
            body: parsedBody,
            token,
            origin: `http://${req.headers.host ?? '127.0.0.1'}`,
          };
          if (handleRest(req, res, ctx)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        // GraphQL v4.
        if (path === '/api/graphql' || path === '/graphql') {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' }, AUTH_CHALLENGE);
            return;
          }
          if (handleGraphql(req, res, store, body)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        // MCP.
        if (path === '/mcp') {
          if (handleMcp(req, res, store, body, authorized)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the process down; answer 500 JSON.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
  server.keepAliveTimeout = 60_000;
  return server;
}
