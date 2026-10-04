/**
 * A throwaway Capy world for driving the BUILT cli through its real argument
 * parser: an isolated HOME (profile, session, wrapped master key and K_local on
 * disk), a project directory (keep.lock + branch), and a local mock service.
 * Nothing here can reach a real server: the prod entrypoint is pointed at the
 * mock by a profile in the throwaway HOME, the mechanism BYOC operators use.
 *
 * The mock service implements only what the piped write path calls:
 *   POST /orgs/:org/co-decrypt   identity (the on-disk blob is already the inner layer)
 *   POST /orgs/:org/wrap         identity
 *   POST /secrets/:project       answers like the real one, or 500 once `failPushes()` was called
 *
 * Every request it receives is appended to a log file (and the push-failure
 * switch is a flag file) rather than held in a mutable variable, so tests can
 * assert the service only ever saw ciphertext.
 *
 * Needs `bun run build` first, like the other tests that spawn `dist/`.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { text } from 'node:stream/consumers';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveProjectKey, encryptMasterKey, masterKeyAAD } from '../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../src/crypto/localKeyRoot';
import { FileManager } from '../../src/files/fileManager';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { KeepFile } from '../../src/types/index';

export const PROD_CLI = join(__dirname, '../../dist/index.js');
export const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

export const ORG_ID = 'org_test_piped';
const WORKOS_ORG_ID = 'org_workos_test_piped';
export const PROJECT_ID = 'proj_test_piped';
const USER_ID = 'user_test_piped';
export const BRANCH = 'production';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly elapsedMs: number;
}

export interface Harness {
  readonly home: string;
  readonly project: string;
  readonly projectKey: string;
  /** Every request the mock service has received so far. */
  requests(): readonly RecordedRequest[];
  /** Number of `POST /secrets/:project` calls so far (a push). */
  pushCount(): number;
  /** From now on, `POST /secrets/:project` answers 500. */
  failPushes(): void;
  /** Makes the mock answer `GET /orgs/:org/secrets` (the `capy secrets` index) with this body. */
  setSecretsIndex(body: unknown): void;
  /** Makes the mock answer `GET /orgs/:org/repos` with this body. */
  setOrgRepos(body: unknown): void;
  /** Makes the mock answer `GET /secrets/:project?branch=<branch>` with this body. */
  setBranchData(project: string, branch: string, body: unknown): void;
  /** How `PUT /orgs/:org/projects/:project/repos` answers: `ok`, `mismatch` (other repos known), `500`, or `hang` (never). Default `ok`. */
  setRepoPutMode(mode: 'ok' | 'mismatch' | '500' | 'hang'): void;
  /** The `PUT .../repos` requests the mock has received (parsed bodies). */
  repoPuts(): readonly unknown[];
  /** Directory for extra files (a fake `gh`, its log). */
  readonly root: string;
  /** Run the built cli. `stdin: undefined` closes stdin immediately (like `</dev/null`). */
  run(args: readonly string[], stdin?: Buffer | string, cli?: string, env?: Readonly<Record<string, string>>): Promise<CliResult>;
  /** Decrypts what `.env` currently holds for `name`, or undefined. */
  envValue(name: string): string | undefined;
  /** The raw text of keep.lock as the cli left it. */
  keepLockText(): string;
  /** Every file under the throwaway HOME and project directory, as [path, bytes]. */
  allFiles(): readonly (readonly [string, Buffer])[];
  dispose(): Promise<void>;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function fakeJwt(workosOrgId: string): string {
  return `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify({ org_id: workosOrgId }))}.sig`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function seedHome(home: string, serviceUrl: string): string {
  const masterKey = randomBytes(32);
  const kLocal = randomBytes(32);
  const capyDir = join(home, '.capy');

  // The profile that retargets the prod entrypoint at the mock service.
  writeJson(join(capyDir, 'config.json'), { default: 'test', profiles: { test: { url: serviceUrl } } });

  writeJson(join(capyDir, 'auth', 'sessions', `${USER_ID}.json`), {
    version: 2,
    user_id: USER_ID,
    user_email: 'piped@example.test',
    refresh_token: 'refresh-token-unused',
    organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: 'Piped Test Org' }],
    sessions: { [ORG_ID]: { access_token: fakeJwt(WORKOS_ORG_ID), expires_at: Date.now() + 24 * 3600 * 1000 } },
  });

  // key.enc holds the INNER layer directly: the mock's co-decrypt is the identity.
  const userDir = join(capyDir, 'orgs', ORG_ID, 'users', USER_ID);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'local.key'), kLocal.toString('base64'), { mode: 0o600 });
  writeJson(join(userDir, 'key.enc'), {
    version: '2.0',
    org_id: ORG_ID,
    encrypted_master_key: encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER_ID, ORG_ID)),
    wrapping_method: 'local_root',
    created_at: new Date().toISOString(),
  });

  return deriveProjectKey(masterKey, PROJECT_ID, ORG_ID);
}

function seedProject(project: string): void {
  const keep: KeepFile = {
    version: '3.0',
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    project_name: 'piped-test',
    variables: {},
  };
  writeJson(join(project, 'keep.lock'), keep);
  mkdirSync(join(project, '.capy'), { recursive: true });
  writeFileSync(join(project, '.capy', 'branch'), BRANCH);
}

function walkFiles(dir: string): readonly (readonly [string, Buffer])[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walkFiles(full) : [[full, readFileSync(full)] as const];
  });
}

interface MockService {
  readonly server: Server;
  readonly url: string;
}

async function startMockService(requestLog: string, failFlag: string, root: string): Promise<MockService> {
  const server = createServer(async (req, res) => {
    const body = await text(req);
    const path = req.url ?? '';
    appendFileSync(requestLog, `${JSON.stringify({ method: req.method ?? '', path, body })}\n`);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const fixture = (name: string): unknown | undefined =>
      existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), 'utf8')) : undefined;
    if (req.method === 'GET' && /^\/orgs\/[^/]+\/secrets$/.test(path)) {
      const body = fixture('secrets-index.json');
      return body === undefined ? send(404, { error: 'no index fixture' }) : send(200, body);
    }
    if (req.method === 'GET' && /^\/orgs\/[^/]+\/repos$/.test(path)) {
      const body = fixture('org-repos.json');
      return body === undefined ? send(404, { error: 'no repos fixture' }) : send(200, body);
    }
    if (req.method === 'PUT' && /^\/orgs\/[^/]+\/projects\/[^/]+\/repos$/.test(path)) {
      const mode = existsSync(join(root, 'repo-put-mode')) ? readFileSync(join(root, 'repo-put-mode'), 'utf8') : 'ok';
      if (mode === 'hang') return undefined; // never answers; the harness closes the connection on dispose
      if (mode === '500') return send(500, { code: 'SERVICE_ERROR', error: 'mock repo failure' });
      const put = JSON.parse(body) as { host: string; owner: string; name: string; path: string };
      return send(200, {
        ok: true,
        link: { ...put, project_id: 'p', github_repo_id: null, first_seen_at: '', last_seen_at: '' },
        known_repos: mode === 'mismatch' ? [{ host: 'github.com', owner: 'someone-else', name: 'copied-from', path: '.' }] : [],
      });
    }
    if (req.method === 'GET' && /^\/secrets\/[^/?]+\?/.test(path)) {
      const [project, query] = path.slice('/secrets/'.length).split('?');
      const branch = new URLSearchParams(query).get('branch') ?? '';
      const data = fixture(`branch-${project}-${branch}.json`);
      return data === undefined ? send(404, { error: 'no branch fixture' }) : send(200, data);
    }
    if (path.endsWith('/co-decrypt')) return send(200, { plaintext: (JSON.parse(body) as { ciphertext: string }).ciphertext });
    if (path.endsWith('/wrap')) return send(200, { ciphertext: (JSON.parse(body) as { plaintext: string }).plaintext });
    if (path.startsWith('/secrets/') && req.method === 'POST') {
      if (existsSync(failFlag)) return send(500, { error: 'mock push failure' });
      const parsed = JSON.parse(body) as { keep_file: string; branch: string };
      const keep = JSON.parse(parsed.keep_file) as KeepFile;
      return send(200, { keep_hash: SyncEngine.computeKeepHash(keep, parsed.branch) });
    }
    return send(404, { error: 'unexpected request' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

export async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'capy-piped-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const requestLog = join(root, 'requests.jsonl');
  const failFlag = join(root, 'fail-pushes');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(requestLog, '');

  const mock = await startMockService(requestLog, failFlag, root);
  const projectKey = seedHome(home, mock.url);
  seedProject(project);

  const requests = (): readonly RecordedRequest[] =>
    readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecordedRequest);

  const run: Harness['run'] = async (args, stdin, cli = PROD_CLI, extraEnv = {}) => {
    const started = Date.now();
    const child = spawn('node', [cli, ...args], {
      cwd: project,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CAPY_WEB_NO_OPEN: '1',
        CAPY_NO_AUTOCOMMIT: '1',
        ...extraEnv,
      },
    });
    // A writer that stops reading mid-pipe (the cap) closes the pipe: EPIPE is expected, not a failure.
    child.stdin.on('error', () => undefined);
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
    const [stdout, stderr, [code]] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    return { stdout, stderr, code: code as number | null, elapsedMs: Date.now() - started };
  };

  return {
    home,
    project,
    projectKey,
    requests,
    pushCount: () => requests().filter((r) => r.method === 'POST' && r.path.startsWith('/secrets/')).length,
    failPushes: () => writeFileSync(failFlag, '1'),
    setSecretsIndex: (body) => writeFileSync(join(root, 'secrets-index.json'), JSON.stringify(body)),
    setOrgRepos: (body) => writeFileSync(join(root, 'org-repos.json'), JSON.stringify(body)),
    setBranchData: (projectId, branch, body) => writeFileSync(join(root, `branch-${projectId}-${branch}.json`), JSON.stringify(body)),
    setRepoPutMode: (mode) => writeFileSync(join(root, 'repo-put-mode'), mode),
    repoPuts: () =>
      requests()
        .filter((r) => r.method === 'PUT' && /\/projects\/[^/]+\/repos$/.test(r.path))
        .map((r) => JSON.parse(r.body) as unknown),
    root,
    run,
    envValue: (name) => {
      const files = new FileManager(project);
      const raw = files.readEnvFile()[name];
      return raw === undefined ? undefined : files.decryptValue(raw, projectKey);
    },
    keepLockText: () => readFileSync(join(project, 'keep.lock'), 'utf8'),
    allFiles: () => [...walkFiles(home), ...walkFiles(project)],
    dispose: async () => {
      mock.server.closeAllConnections();
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** sha256 of a string, for asserting "this file did not change" without printing contents. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
