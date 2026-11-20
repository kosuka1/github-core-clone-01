// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks the 2026-07-28
// revision through server/discover and the classic initialize handshake for older
// revisions, and its six tools act on the same forge store as REST and GraphQL —
// an issue created here reads back over /api/v3 with the same id.

import type { Forge, RepoRec } from './forge.ts';
import { VIEWER } from './forge.ts';
import { issueObject, mergePull, pullObject, repoObject } from './api.ts';

export interface McpResult {
  status: number;
  body: unknown; // undefined = empty body (202 for notifications)
  headers?: Record<string, string>;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'forge-session-1';

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
      body: { type: 'string', description: 'Pull request body' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, squashing by default.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
  },
];

const TOOLS_LIST_BODY = {
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
      additionalProperties: false,
    },
  })),
};

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown, headers?: Record<string, string>): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result }, headers };
}

function toolOk(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const structured = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : { result: payload };
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function splitRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : '';
  let repo = typeof args['repo'] === 'string' ? (args['repo'] as string) : '';
  const fullName = typeof args['full_name'] === 'string' ? (args['full_name'] as string) : '';
  if (repo.includes('/')) {
    const parts = repo.split('/');
    owner = parts.slice(0, -1).join('/');
    repo = parts[parts.length - 1] as string;
  } else if (repo === '' && fullName.includes('/')) {
    const parts = fullName.split('/');
    owner = parts.slice(0, -1).join('/');
    repo = parts[parts.length - 1] as string;
  }
  if (owner === '') owner = VIEWER.login;
  return { owner, repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>, base: string): Record<string, unknown> {
  const lower = name.toLowerCase();
  const def = TOOLS.find((t) => lower === t.name || lower.endsWith(`__${t.name}`) || lower.endsWith(`_${t.name}`));
  if (def === undefined) return toolErr(`Unknown tool: ${name}`);
  for (const required of def.required) {
    if (def.name !== 'get_repo' && def.name !== 'create_issue' && def.name !== 'list_issues' && def.name !== 'create_pull_request' && def.name !== 'merge_pull_request') {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return toolErr(`Missing required argument: ${required}`);
      }
    }
  }
  const findRepo = (): RepoRec | undefined => {
    const { owner, repo } = splitRepoArgs(args);
    if (owner !== VIEWER.login) return undefined;
    return forge.getRepo(owner, repo);
  };

  switch (def.name) {
    case 'create_repo': {
      const repoName = String(args['name'] ?? '');
      if (repoName === '') return toolErr('Missing required argument: name');
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return toolOk(repoObject(existing, base));
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args['description'] === 'string' ? (args['description'] as string) : null,
        isPrivate: args['private'] === true,
      });
      return toolOk(repoObject(repo, base));
    }
    case 'get_repo': {
      const repo = findRepo();
      if (repo === undefined) return toolErr('Repository not found');
      return toolOk(repoObject(repo, base));
    }
    case 'create_issue': {
      const repo = findRepo();
      if (repo === undefined) return toolErr('Repository not found');
      const title = String(args['title'] ?? '');
      if (title === '') return toolErr('Missing required argument: title');
      const issue = forge.createIssue(repo, title, typeof args['body'] === 'string' ? (args['body'] as string) : null, []);
      return toolOk(issueObject(forge, repo, issue, base));
    }
    case 'list_issues': {
      const repo = findRepo();
      if (repo === undefined) return toolErr('Repository not found');
      const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
      let items = [...repo.items.values()].filter((i) => i.kind === 'issue');
      if (state !== 'all') items = items.filter((i) => i.state === state);
      items.sort((a, b) => a.number - b.number);
      const objects = items.map((i) => issueObject(forge, repo, i, base));
      return {
        content: [{ type: 'text', text: JSON.stringify(objects) }],
        structuredContent: { issues: objects },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (repo === undefined) return toolErr('Repository not found');
      const title = String(args['title'] ?? '');
      let head = String(args['head'] ?? '');
      if (head.includes(':')) head = head.split(':').slice(1).join(':');
      const baseBranch = String(args['base'] ?? repo.defaultBranch);
      if (title === '' || head === '') return toolErr('Missing required argument: title and head are required');
      if (forge.branchTip(repo, head) === undefined) return toolErr(`Head branch not found: ${head}`);
      if (forge.branchTip(repo, baseBranch) === undefined) return toolErr(`Base branch not found: ${baseBranch}`);
      const pull = forge.createPull(repo, title, typeof args['body'] === 'string' ? (args['body'] as string) : null, head, baseBranch);
      return toolOk(pullObject(forge, repo, pull, base));
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (repo === undefined) return toolErr('Repository not found');
      const number = Number(args['pull_number'] ?? args['number'] ?? NaN);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return toolErr('Pull request not found');
      const result = mergePull(forge, repo, item, { merge_method: 'squash' });
      if (result.status !== 200) return toolErr('Pull Request is not mergeable');
      const body = result.body as { sha: string; merged: boolean; message: string };
      return toolOk({ ...pullObject(forge, repo, item, base), sha: body.sha, merged: true, message: body.message });
    }
  }
  return toolErr(`Unhandled tool: ${name}`);
}

export function handleMcp(forge: Forge, rawBody: string, base: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not JSON' } } };
  }
  const handleOne = (msg: Record<string, unknown>): McpResult => {
    const id = msg['id'];
    const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : '';
    const params = (msg['params'] !== null && typeof msg['params'] === 'object' ? msg['params'] : {}) as Record<string, unknown>;
    if (id === undefined || id === null) {
      // A notification: acknowledge with an empty 202.
      return { status: 202, body: undefined };
    }
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          protocolVersion: '2026-07-28',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forge', version: '1.0.0' },
        });
      case 'initialize': {
        const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2025-11-25';
        const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forge', version: '1.0.0' },
        }, { 'mcp-session-id': SESSION_ID });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, TOOLS_LIST_BODY);
      case 'tools/call': {
        const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
        const toolArgs = (params['arguments'] !== null && typeof params['arguments'] === 'object' ? params['arguments'] : {}) as Record<string, unknown>;
        const def = TOOLS.find((t) => toolName.toLowerCase() === t.name || toolName.toLowerCase().endsWith(`__${t.name}`));
        if (def === undefined) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        return rpcResult(id, callTool(forge, toolName, toolArgs, base));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleOne((entry ?? {}) as Record<string, unknown>)).filter((r) => r.status !== 202);
    if (results.length === 0) return { status: 202, body: undefined };
    return { status: 200, body: results.map((r) => r.body) };
  }
  return handleOne((parsed ?? {}) as Record<string, unknown>);
}
