// mcp.ts — the Model Context Protocol endpoint (POST /mcp), legacy handshake era: `initialize` +
// `notifications/initialized`, stateless, JSON-RPC 2.0 over plain JSON bodies. `server/discover` is
// answered method-not-found, which the suite accepts as the pre-discover era. The tools are the
// github-mcp-server names, backed by the same domain objects as REST.

import {
  repos,
  createRepo,
  findRepo,
  branchTip,
  createIssue,
  createPull,
  mergePull,
  type Repo,
} from './forge.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpReply {
  status: number;
  body: unknown | null; // null = empty body (notifications)
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, status: number, code: number, message: string): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(args: Record<string, unknown>): Repo | null {
  if (typeof args.owner !== 'string' || typeof args.repo !== 'string') return null;
  return findRepo(args.owner, args.repo);
}

function callTool(name: string, rawArgs: unknown): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return { error: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(repoName)) return { result: toolError(`Repository ${repoName} already exists`) };
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { result: toolOk(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      return { result: toolOk(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const issue = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { result: toolOk(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return { result: toolOk(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'get_issue': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { result: toolError('Issue not found') };
      return { result: toolOk(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const head = String(args.head);
      const base = String(args.base);
      if (branchTip(repo, head) === null) return { result: toolError(`Head branch ${head} does not exist`) };
      if (branchTip(repo, base) === null) return { result: toolError(`Base branch ${base} does not exist`) };
      const pull = createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return { result: toolOk(pullJson(repo, pull)) };
    }
    case 'list_pull_requests': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      return { result: toolOk(pulls.map((pull) => pullJson(repo, pull))) };
    }
    case 'merge_pull_request': {
      const repo = needRepo(args);
      if (repo === null) return { result: toolError('Repository not found') };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: toolError('Pull request not found') };
      if (pull.merged) return { result: toolError('Pull request has already been merged') };
      const outcome = mergePull(repo, pull, 'squash');
      if (!outcome.ok) return { result: toolError('Pull request is not mergeable') };
      return { result: toolOk(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Handle one POST /mcp body. Authentication is the caller's job (401 before this runs). */
export function handleMcp(rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, 400, -32700, 'Parse error');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, 400, -32600, 'Invalid Request');
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const hasId = 'id' in request;
  const id = request.id ?? null;
  if (!hasId) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return { status: 202, body: null };
  }
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcError(id, 200, -32601, 'Method not found: server/discover');
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const outcome = callTool(toolName, params.arguments);
      if (outcome.error !== undefined) return rpcError(id, 200, outcome.error.code, outcome.error.message);
      return rpcResult(id, outcome.result);
    }
    default:
      return rpcError(id, 200, -32601, `Method not found: ${method}`);
  }
}
