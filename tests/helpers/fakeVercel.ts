/**
 * A scripted fake of the Vercel REST API for the `capy connect vercel` tests.
 *
 * It answers ONLY the five read endpoints the connector uses and THROWS on
 * any non-GET request or unknown path, so a stray write (or a call to a route
 * the docs do not list) fails the test at the call site rather than being
 * merely recorded. Every value in here is a fake sentinel.
 */
import type { VercelFetchLike } from '../../src/deploy/vercelApi';

export interface RawEnv {
  id: string;
  key: string;
  type: string;
  target?: string | string[];
  gitBranch?: string;
  customEnvironmentIds?: string[];
  configurationId?: string | null;
  /** What the LIST returns as `value` (plain: the real value; encrypted: opaque ciphertext). */
  listValue?: string;
}

export interface FakeVercelData {
  teams?: ReadonlyArray<{ id: string; slug: string; name?: string }>;
  /** Projects per scope: a team id, or `personal`. */
  projects: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
  envs: Readonly<Record<string, ReadonlyArray<RawEnv>>>;
  custom?: Readonly<Record<string, ReadonlyArray<{ id: string; slug: string }>>>;
  /** Per-id decrypted values, keyed by env record id. A missing key = Vercel returned no `value`. */
  values?: Readonly<Record<string, string>>;
  /** Env record ids whose per-id answer says `decrypted: false` (Vercel would not decrypt the value, e.g. a role that cannot read production values). */
  undecrypted?: readonly string[];
  /** Project list page size, to exercise pagination. */
  pageSize?: number;
  /** Set `pagination.next` on the env list, to exercise the truncation warning. */
  envListNext?: number;
}

export interface FakeCall {
  method: string;
  url: string;
  authorization?: string;
}

/**
 * Wrap a fake in `bun:test`'s `mock()` and read the calls back with this: the
 * recording lives inside the test library's own mock object, so the tests
 * never push into an array of their own.
 */
export function callsOf(fetchMock: { mock: { calls: ReadonlyArray<readonly unknown[]> } }): readonly FakeCall[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: (init as { method: string }).method,
    url: url as string,
    authorization: (init as { headers: Record<string, string> }).headers.Authorization,
  }));
}

const json = (body: unknown, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

export function fakeVercelFetch(data: FakeVercelData): VercelFetchLike {
  return (async (url: string, init: { method: string; headers: Record<string, string> }) => {
    if (init.method !== 'GET') throw new Error(`fakeVercel: unexpected non-GET ${init.method} ${url}`);
    const u = new URL(url);
    const teamId = u.searchParams.get('teamId') ?? undefined;
    const path = u.pathname;

    if (path === '/v2/teams') {
      return json({ teams: data.teams ?? [], pagination: { count: (data.teams ?? []).length, next: null, prev: null } });
    }
    if (path === '/v10/projects') {
      const all = data.projects[teamId ?? 'personal'] ?? [];
      const size = data.pageSize ?? all.length;
      const start = Number(u.searchParams.get('from') ?? '0');
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? start + size : null;
      return json({ projects: page, pagination: { count: page.length, next, prev: null } });
    }
    const projectRoute = /^\/v9\/projects\/([^/]+)$/.exec(path);
    if (projectRoute) {
      const idOrName = decodeURIComponent(projectRoute[1]);
      const hit = (data.projects[teamId ?? 'personal'] ?? []).find((p) => p.id === idOrName || p.name === idOrName);
      return hit ? json(hit) : json({ error: { code: 'not_found', message: 'nope' } }, 404);
    }
    const customRoute = /^\/v9\/projects\/([^/]+)\/custom-environments$/.exec(path);
    if (customRoute) {
      return json({ accountLimit: { total: 3 }, environments: data.custom?.[decodeURIComponent(customRoute[1])] ?? [] });
    }
    const envListRoute = /^\/v10\/projects\/([^/]+)\/env$/.exec(path);
    if (envListRoute) {
      const records = data.envs[decodeURIComponent(envListRoute[1])] ?? [];
      return json({
        envs: records.map(({ listValue, ...rec }) => ({
          ...rec,
          ...(rec.target === undefined ? {} : { target: rec.target }),
          ...(listValue === undefined ? {} : { value: listValue }),
          decrypted: false,
        })),
        ...(data.envListNext === undefined ? {} : { pagination: { count: records.length, next: data.envListNext, prev: null } }),
      });
    }
    const envValueRoute = /^\/v1\/projects\/([^/]+)\/env\/([^/]+)$/.exec(path);
    if (envValueRoute) {
      const projectId = decodeURIComponent(envValueRoute[1]);
      const envId = decodeURIComponent(envValueRoute[2]);
      const rec = (data.envs[projectId] ?? []).find((e) => e.id === envId);
      if (!rec) return json({ error: { code: 'not_found', message: 'nope' } }, 404);
      const value = data.values?.[envId];
      const { listValue: _omit, ...meta } = rec;
      return json({ ...meta, decrypted: !(data.undecrypted ?? []).includes(envId), ...(value === undefined ? {} : { value }) });
    }
    throw new Error(`fakeVercel: unexpected path ${path}`);
  }) as VercelFetchLike;
}

/** A project row as Vercel returns it (only the fields the connector reads). */
export const project = (
  id: string,
  name: string,
  over: { rootDirectory?: string | null; link?: Record<string, unknown> | null } = {},
): Record<string, unknown> => ({
  id,
  name,
  rootDirectory: over.rootDirectory === undefined ? null : over.rootDirectory,
  ...(over.link === null ? {} : { link: over.link ?? { type: 'github', org: 'acme', repo: 'widgets', productionBranch: 'main' } }),
});
