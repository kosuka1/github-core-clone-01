// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4
// and MCP from a single in-memory store. Every reply carries an X-GitHub-Request-Id
// header; every surface except /healthz requires the trial's bearer <redacted>

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './forge.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleRest } from './api.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(8, '0').toUpperCase() + ':FORGE';
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    'cache-control': 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, req, res).catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const base = `http://${req.headers.host ?? 'localhost'}`;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  // ---------------------------------------------------------- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    // GET and HEAD carry no body the handlers read; waiting for the request
    // stream to end would cost an event-loop turn on every single read.
    const mayHaveBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = mayHaveBody ? await readBody(req) : Buffer.alloc(0);
    let parsed: Record<string, unknown> | undefined;
    if (body.length > 0 && mayHaveBody) {
      try {
        const value = JSON.parse(body.toString('utf8')) as unknown;
        parsed = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
    const result = handleRest(forge, { method, segments, query: url.searchParams, body: parsed, base });
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // ---------------------------------------------------------- GraphQL v4
  if (path === '/api/graphql') {
    if (method === 'GET') {
      const payload = {
        query: url.searchParams.get('query') ?? '',
        variables: url.searchParams.get('variables') ?? undefined,
        operationName: url.searchParams.get('operationName') ?? undefined,
      };
      const result = handleGraphQL(forge, JSON.stringify(payload));
      sendJson(res, result.status, result.body);
      return;
    }
    const body = await readBody(req);
    const result = handleGraphQL(forge, body.toString('utf8'));
    sendJson(res, result.status, result.body);
    return;
  }

  // ---------------------------------------------------------- MCP
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this endpoint takes POST' } });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(forge, body.toString('utf8'), base);
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // ---------------------------------------------------------- git smart HTTP
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const sub = gitMatch[3] ?? '';
    const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
    if (repo === undefined) {
      sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n', 'utf8'));
      return;
    }
    if (method === 'GET' && sub === '/info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('Unknown service\n', 'utf8'));
        return;
      }
      const protocol = req.headers['git-protocol'] ?? '';
      const result = infoRefs(forge, repo, service, protocol.includes('version=2'));
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && sub === '/git-upload-pack') {
      const body = await readBody(req);
      const result = uploadPack(forge, repo, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && sub === '/git-receive-pack') {
      const body = await readBody(req);
      const result = receivePack(forge, repo, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found\n', 'utf8'));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
