/**
 * An in-memory stand-in for Vercel's REST API, for the API-mode Vercel deploy
 * tests (CAP-696). It APPLIES the calls it receives — POST creates a record,
 * PATCH edits one — so a test can assert the property that matters ("what does
 * each environment see afterwards?") instead of the shape of a request.
 *
 * It models only what Vercel documents and the deploy code relies on:
 *   - one record may serve several environments (`target`, `customEnvironmentIds`);
 *   - a Preview record may be scoped to one git branch;
 *   - a POST that collides with an existing record is refused (403), and
 *     `upsert=true` would overwrite it — recorded so a test can prove the
 *     deploy code never sends it;
 *   - sensitive records never reveal their value; encrypted ones do when
 *     `decrypt=true`;
 *   - 429 with rate-limit headers, 401/403/404 and a dropped connection on demand.
 *
 * The store inside is genuinely mutable — it stands in for Vercel's own
 * database — and is confined to this file. Tests only ever read immutable
 * snapshots from it.
 */
import type { FetchLike } from '../../src/deploy/vercelTargetApi';

export interface FakeRecord {
  id: string;
  key: string;
  value: string;
  type: 'encrypted' | 'sensitive' | 'plain';
  target: readonly string[];
  gitBranch?: string;
  customEnvironmentIds?: readonly string[];
}

export interface FakeCall {
  method: string;
  path: string;
  query: Readonly<Record<string, string>>;
  body?: Record<string, unknown>;
  authorization: string | null;
}

export interface FakeVercelOptions {
  projectId?: string;
  teamId?: string;
  token?: string;
  records?: readonly FakeRecord[];
  customEnvs?: ReadonlyArray<{ id: string; slug: string }>;
  /** New Production/Preview records come back `sensitive` (the team policy). */
  enforceSensitive?: boolean;
  /** Store a different value than the one sent — what a failed write would look like. */
  corruptWrites?: boolean;
  /** Status the project GET answers with instead of 200. */
  projectStatus?: number;
  /** Every request fails like a dropped connection. */
  dropConnection?: boolean;
  /** The first `count` write requests (POST/PATCH) answer 429 with these headers. */
  rateLimit?: { count: number; headers: Readonly<Record<string, string>> };
  /** POSTs for these keys answer 500. */
  failPostFor?: readonly string[];
}

export type StandardEnv = 'production' | 'preview' | 'development';

export interface FakeVercel {
  fetch: FetchLike;
  /** Every request received, in order (a snapshot). */
  calls(): readonly FakeCall[];
  /** Calls that could change something. */
  writeCalls(): readonly FakeCall[];
  /** Every record now stored (a snapshot, ids and all). */
  records(): readonly FakeRecord[];
  /** The value an environment actually sees for `key`. */
  seenBy(env: StandardEnv | `custom:${string}`, key: string, gitBranch?: string): string | undefined;
}

const SERVES = (rec: FakeRecord, env: string): boolean =>
  rec.target.includes(env) ||
  (env.startsWith('custom:') && (rec.customEnvironmentIds ?? []).includes(env.slice('custom:'.length)));

function envKeys(rec: FakeRecord): readonly string[] {
  return [...rec.target, ...(rec.customEnvironmentIds ?? []).map((id) => `custom:${id}`)];
}

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function asRecordJson(rec: FakeRecord, reveal: boolean): Record<string, unknown> {
  const readable = reveal && rec.type !== 'sensitive';
  return {
    id: rec.id,
    key: rec.key,
    type: rec.type,
    target: [...rec.target],
    ...(rec.gitBranch ? { gitBranch: rec.gitBranch } : {}),
    ...(rec.customEnvironmentIds ? { customEnvironmentIds: [...rec.customEnvironmentIds] } : {}),
    ...(readable ? { value: rec.value } : rec.type === 'sensitive' ? {} : { value: `ciphertext(${rec.id})` }),
    decrypted: readable && rec.type === 'encrypted',
  };
}

export function createFakeVercel(opts: FakeVercelOptions = {}): FakeVercel {
  const projectId = opts.projectId ?? 'prj_1';
  const token = opts.token ?? 'tok_fake_value';
  const store = new Map<string, FakeRecord>((opts.records ?? []).map((r) => [r.id, r]));
  const log: FakeCall[] = [];
  const state = { nextId: 1, rateLimited: 0 };

  const fetchFake: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const query = Object.fromEntries(url.searchParams.entries());
    log.push({ method, path: url.pathname, query, body, authorization: headers.Authorization ?? null });

    if (opts.dropConnection) throw new TypeError('connection dropped');
    if (headers.Authorization !== `Bearer ${token}`) return json(401, { error: { code: 'forbidden' } });
    if (opts.teamId !== undefined && query.teamId !== opts.teamId) return json(403, { error: { code: 'forbidden' } });

    const isWrite = method === 'POST' || method === 'PATCH' || method === 'DELETE';
    if (isWrite && opts.rateLimit && state.rateLimited < opts.rateLimit.count) {
      state.rateLimited += 1;
      return json(429, { error: { code: 'rate_limited' } }, opts.rateLimit.headers);
    }

    const project = url.pathname.match(/^\/v9\/projects\/([^/]+)$/);
    if (project && method === 'GET') {
      if (opts.projectStatus && opts.projectStatus !== 200) return json(opts.projectStatus, { error: { code: 'x' } });
      return decodeURIComponent(project[1]) === projectId ? json(200, { id: projectId, name: 'demo' }) : json(404, { error: { code: 'not_found' } });
    }
    const custom = url.pathname.match(/^\/v9\/projects\/([^/]+)\/custom-environments\/([^/]+)$/);
    if (custom && method === 'GET') {
      const wanted = decodeURIComponent(custom[2]);
      const found = (opts.customEnvs ?? []).find((e) => e.id === wanted || e.slug === wanted);
      return found ? json(200, { id: found.id, slug: found.slug, type: 'preview' }) : json(404, { error: { code: 'not_found' } });
    }
    if (decodeURIComponent(url.pathname.split('/')[3] ?? '') !== projectId) return json(404, { error: { code: 'not_found' } });

    const list = url.pathname.match(/^\/v10\/projects\/[^/]+\/env$/);
    if (list && method === 'GET') {
      const reveal = query.decrypt === 'true';
      return json(200, { envs: [...store.values()].map((r) => asRecordJson(r, reveal)) });
    }
    if (list && method === 'POST') return createRecord(body ?? {}, query);

    const one = url.pathname.match(/^\/v(?:9|1)\/projects\/[^/]+\/env\/([^/]+)$/);
    if (one) {
      const rec = store.get(decodeURIComponent(one[1]));
      if (!rec) return json(404, { error: { code: 'not_found' } });
      if (method === 'GET') return json(200, asRecordJson(rec, true));
      if (method === 'PATCH') return patchRecord(rec, body ?? {});
    }
    return json(405, { error: { code: 'method_unknown' } });
  };

  function createRecord(body: Record<string, unknown>, query: Readonly<Record<string, string>>): Response {
    const key = String(body.key);
    if (opts.failPostFor?.includes(key)) return json(500, { error: { code: 'internal_server_error' } });
    const target = (body.target as string[] | undefined) ?? [];
    const custom = (body.customEnvironmentIds as string[] | undefined) ?? [];
    if (target.length === 0 && custom.length === 0) return json(400, { error: { code: 'bad_request' } });
    const draft: FakeRecord = {
      id: `env_${state.nextId}`,
      key,
      value: opts.corruptWrites ? `${String(body.value)}-corrupted` : String(body.value),
      type: opts.enforceSensitive && target.some((t) => t === 'production' || t === 'preview')
        ? 'sensitive'
        : (body.type as FakeRecord['type']),
      target,
      ...(body.gitBranch ? { gitBranch: String(body.gitBranch) } : {}),
      ...(custom.length > 0 ? { customEnvironmentIds: custom } : {}),
    };
    const collides = [...store.values()].some(
      (r) =>
        r.key === key &&
        envKeys(r).some((e) => envKeys(draft).includes(e)) &&
        (!envKeys(r).includes('preview') || (r.gitBranch ?? '') === (draft.gitBranch ?? '')),
    );
    if (collides && query.upsert !== 'true') return json(403, { error: { code: 'ENV_ALREADY_EXISTS' } });
    state.nextId += 1;
    store.set(draft.id, draft);
    return json(201, { created: asRecordJson(draft, false), failed: [] });
  }

  function patchRecord(rec: FakeRecord, body: Record<string, unknown>): Response {
    const next: FakeRecord = {
      ...rec,
      ...(typeof body.value === 'string' ? { value: opts.corruptWrites ? `${body.value}-corrupted` : body.value } : {}),
      ...(Array.isArray(body.target) ? { target: body.target as string[] } : {}),
      ...(Array.isArray(body.customEnvironmentIds) ? { customEnvironmentIds: body.customEnvironmentIds as string[] } : {}),
      ...(body.gitBranch === null ? { gitBranch: undefined } : typeof body.gitBranch === 'string' ? { gitBranch: body.gitBranch } : {}),
    };
    store.set(rec.id, next);
    return json(200, asRecordJson(next, false));
  }

  return {
    fetch: fetchFake,
    calls: () => [...log],
    writeCalls: () => log.filter((c) => c.method !== 'GET'),
    records: () => [...store.values()].map((r) => ({ ...r })),
    seenBy(env, key, gitBranch) {
      const serving = [...store.values()].filter((r) => r.key === key && SERVES(r, env));
      if (env !== 'preview') return serving[0]?.value;
      const branchSpecific = serving.find((r) => gitBranch !== undefined && r.gitBranch === gitBranch);
      return (branchSpecific ?? serving.find((r) => !r.gitBranch))?.value;
    },
  };
}
