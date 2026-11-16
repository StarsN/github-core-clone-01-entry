// rest.ts — the REST v3 surface: repositories, contents, branches, commits, labels, issues, comments
// and pull requests, serialized the way GitHub serializes them (and the way the suite reads them).

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  DEFAULT_BRANCH,
  repos,
  createRepo,
  findRepo,
  branchTip,
  createIssue,
  createPull,
  addComment,
  parseCommit,
  commitChain,
  storeObject,
  treeLookup,
  treeWithPath,
  parseTree,
  getObject,
  createCommit,
  pullFiles,
  mergePull,
  type Repo,
  type Issue,
  type PullRequest,
  type Comment,
} from './forge.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message } });

export function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  void repo;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: branchTip(repo, pull.headRef) ?? '',
      label: `${VIEWER_LOGIN}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: branchTip(repo, pull.baseRef) ?? '',
      label: `${VIEWER_LOGIN}:${pull.baseRef}`,
    },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt };
}

function commitJson(oid: string): Record<string, unknown> {
  const info = parseCommit(oid);
  const date = info !== null && info.timestamp > 0 ? new Date(info.timestamp * 1000).toISOString() : new Date(0).toISOString();
  return {
    sha: oid,
    commit: {
      // The API reports the message without its trailing newline(s), as GitHub does.
      message: (info?.message ?? '').replace(/\n+$/, ''),
      tree: { sha: info?.tree ?? '' },
      author: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date },
      committer: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date },
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams, makeUrl: (page: number) => string): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(query);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    headers.link = `<${makeUrl(page + 1)}>; rel="next", <${makeUrl(Math.ceil(items.length / perPage))}>; rel="last"`;
  }
  return { slice, headers };
}

// -------------------------------------------------------------------------------------------------
// The router. `segments` is the path after /api/v3, split and decoded; `origin` builds Link URLs.
// -------------------------------------------------------------------------------------------------

export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestReply {
  const bodyObj: Record<string, unknown> = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  if (segments.length === 0) {
    return { status: 200, body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0-github-core-clone' } };
  }
  if (segments[0] === 'rate_limit' && segments.length === 1 && method === 'GET') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const bucket = { limit: 5000, remaining: 5000, reset, used: 0 };
    return { status: 200, body: { rate: bucket, resources: { core: bucket, graphql: bucket, search: { limit: 30, remaining: 30, reset, used: 0 } } } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: viewerJson() };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const name = str(bodyObj.name);
      if (name === '') return unprocessable('Repository creation failed: name is required');
      if (repos.has(name)) return unprocessable('Repository creation failed: name already exists on this account');
      const repo = createRepo(name, str(bodyObj.description), bodyObj.private === true);
      return { status: 201, body: repoJson(repo) };
    }
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      const { slice, headers } = paginate(all, query, (page) => `${origin}/api/v3/user/repos?page=${page}&per_page=${pagination(query).perPage}`);
      return { status: 200, body: slice, headers };
    }
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const repo = findRepo(segments[1], segments[2]);
  if (repo === null) return notFound();
  const rest = segments.slice(3);
  const repoPath = `/repos/${segments[1]}/${segments[2]}`;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
      if (typeof bodyObj.private === 'boolean') repo.isPrivate = bodyObj.private;
      if (typeof bodyObj.name === 'string' && bodyObj.name !== '' && bodyObj.name !== repo.name) {
        if (repos.has(bodyObj.name)) return unprocessable('Repository creation failed: name already exists on this account');
        repos.delete(repo.name);
        repo.name = bodyObj.name;
        repos.set(repo.name, repo);
      }
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      return { status: 204, body: null };
    }
    return notFound();
  }

  // ---- contents -------------------------------------------------------------------------------
  if (rest[0] === 'contents') {
    return handleContents(repo, method, rest.slice(1).join('/'), query, bodyObj);
  }

  // ---- branches and commits -------------------------------------------------------------------
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
    return { status: 200, body: branches };
  }
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const tip = branchTip(repo, rest[1]);
    if (tip === null) return notFound();
    return { status: 200, body: { name: rest[1], commit: { sha: tip }, protected: false } };
  }
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const branch = query.get('sha') ?? DEFAULT_BRANCH;
    const tip = branchTip(repo, branch) ?? (getObject(branch)?.type === 'commit' ? branch : null);
    if (tip === null) return { status: 200, body: [] };
    const { perPage } = pagination(query);
    const { page } = pagination(query);
    const chain = commitChain(tip).slice((page - 1) * perPage, page * perPage);
    return { status: 200, body: chain.map(commitJson) };
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    if (getObject(rest[1])?.type !== 'commit') return notFound();
    return { status: 200, body: commitJson(rest[1]) };
  }

  // ---- git refs -------------------------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'GET') {
    const all = [...repo.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } }));
    return { status: 200, body: all };
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const ref = str(bodyObj.ref);
    const sha = str(bodyObj.sha);
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return unprocessable('Validation Failed: invalid ref');
    if (getObject(sha)?.type !== 'commit') return unprocessable('Validation Failed: invalid sha');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } } };
  }

  // ---- labels -----------------------------------------------------------------------------------
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()] };
    if (method === 'POST') {
      const name = str(bodyObj.name);
      if (name === '') return unprocessable('Validation Failed: name is required');
      // Creating a label that already exists (a fresh repository ships GitHub's default set)
      // answers the label, as the suite creates its labels explicitly in every repository.
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        if (str(bodyObj.color) !== '') existing.color = str(bodyObj.color);
        return { status: 201, body: existing };
      }
      const label = { name, color: str(bodyObj.color) || 'ededed' };
      repo.labels.set(name, label);
      return { status: 201, body: label };
    }
  }

  // ---- issues and comments ----------------------------------------------------------------------
  if (rest[0] === 'issues') {
    return handleIssues(repo, method, rest.slice(1), query, bodyObj, repoPath, origin);
  }

  // ---- pull requests ------------------------------------------------------------------------------
  if (rest[0] === 'pulls') {
    return handlePulls(repo, method, rest.slice(1), query, bodyObj, repoPath, origin);
  }

  return notFound();
}

// -------------------------------------------------------------------------------------------------
// Contents
// -------------------------------------------------------------------------------------------------

function handleContents(repo: Repo, method: string, path: string, query: URLSearchParams, bodyObj: Record<string, unknown>): RestReply {
  const refName = query.get('ref') ?? (typeof bodyObj.branch === 'string' ? bodyObj.branch : DEFAULT_BRANCH);
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const tip = branchTip(repo, refName);
    if (tip === null) return notFound();
    const info = parseCommit(tip);
    if (info === null) return notFound();
    if (cleanPath === '') {
      const entries = parseTree(getObject(info.tree)?.data ?? Buffer.alloc(0)).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      }));
      return { status: 200, body: entries };
    }
    const found = treeLookup(info.tree, cleanPath);
    if (found === null) return notFound();
    const name = cleanPath.split('/').pop()!;
    if (found.mode === '40000') {
      const entries = parseTree(getObject(found.oid)?.data ?? Buffer.alloc(0)).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${cleanPath}/${entry.name}`,
        sha: entry.oid,
      }));
      return { status: 200, body: entries };
    }
    const blob = getObject(found.oid);
    if (blob === undefined) return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        name,
        path: cleanPath,
        sha: found.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }

  if (method === 'PUT') {
    if (cleanPath === '') return unprocessable('Validation Failed: path is required');
    const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
    const content = typeof bodyObj.content === 'string' ? Buffer.from(bodyObj.content.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
    const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : DEFAULT_BRANCH;
    let tip = branchTip(repo, branch);
    if (tip === null && branch !== DEFAULT_BRANCH) tip = branchTip(repo, DEFAULT_BRANCH);
    const tipInfo = tip !== null ? parseCommit(tip) : null;
    const existing = tipInfo !== null ? treeLookup(tipInfo.tree, cleanPath) : null;
    const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
    if (existing !== null && existing.mode !== '40000') {
      if (givenSha !== undefined && givenSha !== existing.oid) {
        return { status: 409, body: { message: 'Conflict: the file has changed since the given sha' } };
      }
    } else if (existing === null && givenSha !== undefined) {
      return notFound();
    }
    const blobOid = storeObject('blob', content);
    const newTree = treeWithPath(tipInfo?.tree ?? null, cleanPath, blobOid);
    const commitOid = createCommit(newTree, tip !== null ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return {
      status: existing !== null ? 200 : 201,
      body: {
        content: { name: cleanPath.split('/').pop()!, path: cleanPath, sha: blobOid, size: content.length, encoding: 'base64' },
        commit: { sha: commitOid },
      },
    };
  }

  if (method === 'DELETE') {
    const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';
    const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : DEFAULT_BRANCH;
    const tip = branchTip(repo, branch);
    if (tip === null) return notFound();
    const tipInfo = parseCommit(tip);
    if (tipInfo === null) return notFound();
    const existing = treeLookup(tipInfo.tree, cleanPath);
    if (existing === null || existing.mode === '40000') return notFound();
    const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      return { status: 409, body: { message: 'Conflict: the file has changed since the given sha' } };
    }
    const newTree = treeWithPath(tipInfo.tree, cleanPath, null);
    const commitOid = createCommit(newTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { status: 200, body: { content: null, commit: { sha: commitOid } } };
  }

  return notFound();
}

// -------------------------------------------------------------------------------------------------
// Issues
// -------------------------------------------------------------------------------------------------

function labelNamesOf(repo: Repo, raw: unknown): { labels: string[] } | { error: RestReply } {
  if (raw === undefined) return { labels: [] };
  const names: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') names.push(entry);
      else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
    }
  }
  for (const name of names) {
    if (!repo.labels.has(name)) return { error: unprocessable(`Validation Failed: label "${name}" does not exist`) };
  }
  return { labels: names };
}

function handleIssues(repo: Repo, method: string, rest: string[], query: URLSearchParams, bodyObj: Record<string, unknown>, repoPath: string, origin: string): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = labelNamesOf(repo, bodyObj.labels);
      if ('error' in parsed) return parsed.error;
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      if (title === '') return unprocessable('Validation Failed: title is required');
      const issue = createIssue(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', parsed.labels);
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, headers } = paginate(issues, query, (page) => `${origin}/api/v3${repoPath}/issues?page=${page}&per_page=${pagination(query).perPage}`);
      return { status: 200, body: slice.map((issue) => issueJson(repo, issue)), headers };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue !== undefined) return { status: 200, body: issueJson(repo, issue) };
      if (pull !== undefined) {
        return { status: 200, body: { ...pullJson(repo, pull), pull_request: { url: '' } } };
      }
      return notFound();
    }
    if (method === 'PATCH') {
      const target = issue ?? pull;
      if (target === undefined) return notFound();
      if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) {
        target.state = bodyObj.state;
        target.updatedAt = new Date().toISOString();
      }
      if (issue !== undefined) {
        if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
        if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
        if (bodyObj.labels !== undefined) {
          const parsed = labelNamesOf(repo, bodyObj.labels);
          if ('error' in parsed) return parsed.error;
          issue.labels = parsed.labels;
        }
        return { status: 200, body: issueJson(repo, issue) };
      }
      return { status: 200, body: pullJson(repo, pull!) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined && pull === undefined) return notFound();
    if (method === 'POST') {
      const text = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const comment = addComment(repo, number, text);
      return { status: 201, body: commentJson(comment) };
    }
    if (method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map(commentJson);
      return { status: 200, body: comments };
    }
  }
  return notFound();
}

// -------------------------------------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------------------------------------

function handlePulls(repo: Repo, method: string, rest: string[], query: URLSearchParams, bodyObj: Record<string, unknown>, repoPath: string, origin: string): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
      const base = typeof bodyObj.base === 'string' ? bodyObj.base : DEFAULT_BRANCH;
      if (title === '' || head === '') return unprocessable('Validation Failed: title and head are required');
      if (branchTip(repo, head) === null) return unprocessable(`Validation Failed: head branch "${head}" does not exist`);
      if (branchTip(repo, base) === null) return unprocessable(`Validation Failed: base branch "${base}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return unprocessable(`Validation Failed: a pull request for ${head} into ${base} already exists`);
        }
      }
      const pull = createPull(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', head, base);
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { slice, headers } = paginate(pulls, query, (page) => `${origin}/api/v3${repoPath}/pulls?page=${page}&per_page=${pagination(query).perPage}`);
      return { status: 200, body: slice.map((pull) => pullJson(repo, pull)), headers };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) {
        pull.state = bodyObj.state;
        pull.updatedAt = new Date().toISOString();
      }
      if (typeof bodyObj.title === 'string') pull.title = bodyObj.title;
      if (typeof bodyObj.body === 'string') pull.body = bodyObj.body;
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const { slice, headers } = paginate(pullFiles(repo, pull), query, (page) => `${origin}/api/v3${repoPath}/pulls/${number}/files?page=${page}&per_page=${pagination(query).perPage}`);
    return { status: 200, body: slice, headers };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return { status: 405, body: { message: 'Pull Request has already been merged' } };
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const methodName = typeof bodyObj.merge_method === 'string' ? bodyObj.merge_method : 'merge';
    const outcome = mergePull(repo, pull, methodName);
    if (!outcome.ok) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    return { status: 200, body: { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
