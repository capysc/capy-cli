import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USER_ID = 'user_refresh_process';
const GLOBAL_DIRECTORY_NAME = '.capy-refresh-process-test';
const PROCESS_TIMEOUT_MS = 5_000;
const FILE_BACKEND_URL = pathToFileURL(resolve(import.meta.dir, '../../src/auth/session/fileBackend.ts')).href;

const CHILD_SOURCE = `
const { existsSync, writeFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const { join } = await import('node:path');
const { FileSessionStorageBackend } = await import(${JSON.stringify(FILE_BACKEND_URL)});
const USER_ID = ${JSON.stringify(USER_ID)};
const OLD = 'refresh-old';
const NEW = 'refresh-new';
const LOGIN = 'refresh-login';
const STALE = 'refresh-stale';
const action = process.env.CAPY_FENCE_ACTION ?? '';
const providerPath = process.env.CAPY_FENCE_PROVIDER_PATH ?? '';
const startPath = process.env.CAPY_FENCE_START_PATH ?? '';
const readyPath = process.env.CAPY_FENCE_READY_PATH ?? '';
const releasedPath = process.env.CAPY_FENCE_RELEASED_PATH ?? '';
const continuePath = process.env.CAPY_FENCE_CONTINUE_PATH ?? '';
const globalDirectory = join(process.env.HOME ?? '', process.env.CAPY_GLOBAL_DIR_NAME ?? '');
const sessionPath = join(globalDirectory, 'auth', 'sessions', USER_ID + '.json');
const fencePath = sessionPath + '.refresh-in-flight';
const backend = new FileSessionStorageBackend();
const session = (refreshToken) => ({
  version: 2,
  user_id: USER_ID,
  user_email: 'refresh-process@example.test',
  refresh_token: refreshToken,
  organizations: [],
  sessions: {},
});
const classify = (value) => value?.refresh_token === OLD ? 'old'
  : value?.refresh_token === NEW ? 'rotated'
    : value?.refresh_token === LOGIN ? 'login'
      : value?.refresh_token === STALE ? 'stale' : 'other';
const safeError = (cause) => {
  if (cause?.code === 'ELOCKED') return 'AUTH_REFRESH_LOCK_UNAVAILABLE';
  const message = cause instanceof Error ? cause.message : '';
  return [
    'AUTH_REFRESH_AUTHORITY_CHANGED',
    'AUTH_REFRESH_AUTHORITY_INDETERMINATE',
    'AUTH_REFRESH_AUTHORITY_MISSING',
  ].includes(message)
    ? message
    : 'PROCESS_OPERATION_REFUSED';
};
const capture = async (run) => Promise.resolve().then(run)
  .then((value) => ({ ok: true, value }))
  .catch((cause) => ({ ok: false, code: safeError(cause) }));
const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
const waitFor = async (path, deadline) => existsSync(path)
  ? true
  : Date.now() >= deadline ? false : pause(10).then(() => waitFor(path, deadline));
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rotate = async () => backend.withRefreshLock(USER_ID, async (fresh, beginRotation) => {
  if (fresh?.refresh_token !== OLD) return { status: 'adopted' };
  beginRotation();
  writeFileSync(providerPath, 'provider-called\\n', { flag: 'wx', mode: 0o600 });
  await pause(100);
  backend.save(session(NEW), USER_ID);
  return { status: 'rotated' };
});

if (action === 'seed-old') {
  backend.save(session(OLD), USER_ID);
  emit({ status: 'seeded' });
} else if (action === 'seed-rotated') {
  backend.save(session(NEW), USER_ID);
  emit({ status: 'seeded' });
} else if (action === 'same-process') {
  const outcomes = await Promise.all([rotate(), rotate()]);
  emit({
    status: 'complete',
    outcomes: outcomes.map((outcome) => outcome.status).toSorted(),
    providerCalled: existsSync(providerPath),
    fencePresent: existsSync(fencePath),
    finalAuthority: classify(backend.load(USER_ID)),
  });
} else if (action === 'contend') {
  if (!await waitFor(startPath, Date.now() + 4_000)) throw new Error('PROCESS_START_TIMEOUT');
  const outcome = await capture(rotate);
  emit(outcome.ok ? outcome.value : { status: 'refused', code: outcome.code });
} else if (action === 'adopt') {
  const outcome = await backend.withRefreshLock(USER_ID, async (fresh) => ({
    status: 'adopted',
    authority: classify(fresh),
  }));
  emit({ ...outcome, providerCalled: existsSync(providerPath), fencePresent: existsSync(fencePath) });
} else if (action === 'rotate') {
  const outcome = await rotate();
  emit({
    ...outcome,
    providerCalled: existsSync(providerPath),
    fencePresent: existsSync(fencePath),
    finalAuthority: classify(backend.load(USER_ID)),
  });
} else if (action === 'crash-after-begin') {
  await backend.withRefreshLock(USER_ID, async (_fresh, beginRotation) => {
    beginRotation();
    writeFileSync(readyPath, 'ready\\n', { flag: 'wx', mode: 0o600 });
    if (!await waitFor(continuePath, Date.now() + 30_000)) throw new Error('PROCESS_KILL_TIMEOUT');
  });
} else if (action === 'load') {
  const outcome = await capture(() => Promise.resolve(backend.load(USER_ID)));
  emit(outcome.ok
    ? { status: 'loaded', authority: classify(outcome.value) }
    : { status: 'refused', code: outcome.code });
} else if (action === 'refresh-probe') {
  const outcome = await capture(() => backend.withRefreshLock(USER_ID, async () => {
    writeFileSync(providerPath, 'provider-called\\n', { flag: 'wx', mode: 0o600 });
    return { status: 'provider-called' };
  }));
  emit(outcome.ok ? outcome.value : { status: 'refused', code: outcome.code });
} else if (action === 'clear-login') {
  backend.clear(USER_ID);
  backend.save(session(LOGIN), USER_ID);
  emit({ status: 'login-installed', finalAuthority: classify(backend.load(USER_ID)) });
} else if (action === 'stale-compare-save') {
  const oldDigest = createHash('sha256').update(OLD).digest('hex');
  const installed = backend.saveIfRefreshAuthorityMatches(session(STALE), USER_ID, oldDigest);
  emit({ status: installed ? 'installed' : 'refused', finalAuthority: classify(backend.load(USER_ID)) });
} else if (action === 'stale-callback') {
  const staleOutcome = Promise.withResolvers();
  await backend.withRefreshLock(USER_ID, async (_fresh, beginRotation) => {
    beginRotation();
    void waitFor(continuePath, Date.now() + 4_000)
      .then((continued) => continued
        ? capture(() => Promise.resolve(backend.save(session(STALE), USER_ID)))
        : ({ ok: false, code: 'PROCESS_CONTINUE_TIMEOUT' }))
      .then(staleOutcome.resolve);
    writeFileSync(readyPath, 'ready\\n', { flag: 'wx', mode: 0o600 });
    throw { code: 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH' };
  }).catch(() => undefined);
  writeFileSync(releasedPath, 'released\\n', { flag: 'wx', mode: 0o600 });
  const stale = await staleOutcome.promise;
  emit(stale.ok
    ? { status: 'overwrote' }
    : { status: 'refused', code: stale.code });
} else if (action === 'stale-generic-save') {
  const staleSnapshot = backend.load(USER_ID);
  writeFileSync(readyPath, 'ready\\n', { flag: 'wx', mode: 0o600 });
  const continued = await waitFor(continuePath, Date.now() + 4_000);
  const stale = continued && staleSnapshot
    ? await capture(() => Promise.resolve(backend.save({ ...staleSnapshot, refresh_token: STALE }, USER_ID)))
    : { ok: false, code: 'PROCESS_CONTINUE_TIMEOUT' };
  emit(stale.ok
    ? { status: 'overwrote' }
    : { status: 'refused', code: stale.code });
} else if (action === 'inspect') {
  const outcome = await capture(() => Promise.resolve(backend.load(USER_ID)));
  emit(outcome.ok
    ? { status: 'loaded', authority: classify(outcome.value), fencePresent: existsSync(fencePath) }
    : { status: 'refused', code: outcome.code, fencePresent: existsSync(fencePath) });
} else {
  emit({ status: 'unknown-action' });
  process.exit(2);
}
`;

type ChildEvidence = Readonly<{
  status: string;
  code?: string;
  authority?: string;
  finalAuthority?: string;
  outcomes?: readonly string[];
  providerCalled?: boolean;
  fencePresent?: boolean;
}>;

type Captured<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; cause: unknown }>;
const capture = async <T>(run: () => Promise<T>): Promise<Captured<T>> => Promise.resolve().then(run)
  .then((value) => ({ ok: true, value }) as const)
  .catch((cause: unknown) => ({ ok: false, cause }) as const);

const fixturePaths = (home: string) => {
  const root = join(home, 'coordination');
  return {
    root,
    provider: join(root, 'provider-called'),
    start: join(root, 'start'),
    ready: join(root, 'ready'),
    released: join(root, 'released'),
    continued: join(root, 'continue'),
    session: join(home, GLOBAL_DIRECTORY_NAME, 'auth', 'sessions', `${USER_ID}.json`),
  } as const;
};

const childEnvironment = (
  home: string,
  action: string,
  paths: ReturnType<typeof fixturePaths>,
): Readonly<Record<string, string>> => ({
  HOME: home,
  PATH: process.env.PATH ?? '',
  TMPDIR: tmpdir(),
  CAPY_GLOBAL_DIR_NAME: GLOBAL_DIRECTORY_NAME,
  CAPY_FENCE_ACTION: action,
  CAPY_FENCE_PROVIDER_PATH: paths.provider,
  CAPY_FENCE_START_PATH: paths.start,
  CAPY_FENCE_READY_PATH: paths.ready,
  CAPY_FENCE_RELEASED_PATH: paths.released,
  CAPY_FENCE_CONTINUE_PATH: paths.continued,
});

const startChild = (home: string, action: string, paths: ReturnType<typeof fixturePaths>) => Bun.spawn({
  cmd: [process.execPath, '--no-env-file', '-e', CHILD_SOURCE],
  env: childEnvironment(home, action, paths),
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
});

const waitForExit = async (child: ReturnType<typeof startChild>): Promise<number> => {
  const timeout = Promise.withResolvers<number>();
  const timer = setTimeout(() => timeout.reject(new Error('PROCESS_TEST_CHILD_TIMEOUT')), PROCESS_TIMEOUT_MS);
  const outcome = await capture(() => Promise.race([child.exited, timeout.promise]))
    .finally(() => clearTimeout(timer));
  if (outcome.ok) return outcome.value;
  child.kill(9);
  const killTimeout = Promise.withResolvers<number>();
  const killTimer = setTimeout(
    () => killTimeout.reject(new Error('PROCESS_TEST_CHILD_KILL_TIMEOUT')),
    PROCESS_TIMEOUT_MS,
  );
  const killed = await capture(() => Promise.race([child.exited, killTimeout.promise]))
    .finally(() => clearTimeout(killTimer));
  if (!killed.ok) throw killed.cause;
  throw outcome.cause;
};

const finishChild = async (child: ReturnType<typeof startChild>): Promise<ChildEvidence> => {
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await waitForExit(child);
  const [output, errorOutput] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0 || errorOutput.length !== 0) throw new Error('PROCESS_TEST_CHILD_FAILED');
  const parsed = (() => {
    try { return JSON.parse(output.trim()) as unknown; } catch { return null; }
  })();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PROCESS_TEST_CHILD_EVIDENCE_INVALID');
  }
  return parsed as ChildEvidence;
};

const stopChild = async (child: ReturnType<typeof startChild>): Promise<void> => {
  if (child.exitCode === null) child.kill(9);
  await waitForExit(child);
};

const withChild = async <T>(
  child: ReturnType<typeof startChild>,
  run: (owned: ReturnType<typeof startChild>) => Promise<T>,
): Promise<T> => {
  const outcome = await capture(() => run(child));
  const stopped = await capture(() => stopChild(child));
  if (!outcome.ok) throw outcome.cause;
  if (!stopped.ok) throw stopped.cause;
  return outcome.value;
};

const runChild = (
  home: string,
  action: string,
  paths: ReturnType<typeof fixturePaths>,
): Promise<ChildEvidence> => finishChild(startChild(home, action, paths));

const waitForFile = async (path: string, deadline = Date.now() + PROCESS_TIMEOUT_MS): Promise<void> => {
  if (existsSync(path)) return;
  if (Date.now() >= deadline) throw new Error('PROCESS_TEST_RENDEZVOUS_TIMEOUT');
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  return waitForFile(path, deadline);
};

const withFixture = async (run: (
  home: string,
  paths: ReturnType<typeof fixturePaths>,
) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'capy-refresh-fence-process-'));
  const paths = fixturePaths(home);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try {
    await run(home, paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

describe('refresh fence process coordination', () => {
  it('serializes same-process contenders so only one burns the old authority', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    expect(await runChild(home, 'same-process', paths)).toEqual({
      status: 'complete',
      outcomes: ['adopted', 'rotated'],
      providerCalled: true,
      fencePresent: false,
      finalAuthority: 'rotated',
    });
  }), 20_000);

  it('serializes two processes so only one burns the old authority', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    const first = startChild(home, 'contend', paths);
    const outcomes = await withChild(first, async (ownedFirst) => {
      const second = startChild(home, 'contend', paths);
      return withChild(second, async (ownedSecond) => {
        await writeFile(paths.start, 'start\n', { mode: 0o600 });
        return Promise.all([finishChild(ownedFirst), finishChild(ownedSecond)]);
      });
    });
    expect(outcomes.map(({ status }) => status).toSorted()).toEqual(['adopted', 'rotated']);
    expect(existsSync(paths.provider)).toBeTrue();
    expect(await runChild(home, 'inspect', paths)).toEqual({
      status: 'loaded', authority: 'rotated', fencePresent: false,
    });
  }), 20_000);

  it('creates no fence for pure adoption and clears a rotation fence only after save readback', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-rotated', paths)).toEqual({ status: 'seeded' });
    expect(await runChild(home, 'adopt', paths)).toEqual({
      status: 'adopted', authority: 'rotated', providerCalled: false, fencePresent: false,
    });
  }).then(() => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    expect(await runChild(home, 'rotate', paths)).toEqual({
      status: 'rotated', providerCalled: true, fencePresent: false, finalAuthority: 'rotated',
    });
  })), 20_000);

  it('keeps a killed owner fenced and refuses the next load and refresh before provider work', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    const owner = startChild(home, 'crash-after-begin', paths);
    await withChild(owner, async (owned) => {
      await waitForFile(paths.ready);
      expect(owned.exitCode).toBeNull();
      owned.kill(9);
      expect(await waitForExit(owned)).not.toBe(0);
      expect(owned.signalCode).toBe('SIGKILL');
    });
    expect(existsSync(`${paths.session}.refresh-in-flight`)).toBeTrue();
    const immediate = await runChild(home, 'load', paths);
    expect(immediate.status).toBe('refused');
    expect(['AUTH_REFRESH_AUTHORITY_INDETERMINATE', 'AUTH_REFRESH_LOCK_UNAVAILABLE']).toContain(immediate.code);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_500));
    expect(await runChild(home, 'load', paths)).toEqual({
      status: 'refused', code: 'AUTH_REFRESH_AUTHORITY_INDETERMINATE',
    });
    expect(await runChild(home, 'refresh-probe', paths)).toEqual({
      status: 'refused', code: 'AUTH_REFRESH_AUTHORITY_INDETERMINATE',
    });
    expect(existsSync(paths.provider)).toBeFalse();
  }), 20_000);

  it('refuses a stale hosted compare-save after explicit clear and new login', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    expect(await runChild(home, 'clear-login', paths)).toEqual({
      status: 'login-installed', finalAuthority: 'login',
    });
    expect(await runChild(home, 'stale-compare-save', paths)).toEqual({
      status: 'refused', finalAuthority: 'login',
    });
  }), 20_000);

  it('refuses a stale fenced callback after explicit clear and new login', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    const staleWriter = startChild(home, 'stale-callback', paths);
    await withChild(staleWriter, async (owned) => {
      await Promise.all([waitForFile(paths.ready), waitForFile(paths.released)]);
      expect(await runChild(home, 'clear-login', paths)).toEqual({
        status: 'login-installed', finalAuthority: 'login',
      });
      await writeFile(paths.continued, 'continue\n', { mode: 0o600 });
      expect(await finishChild(owned)).toEqual({
        status: 'refused', code: 'AUTH_REFRESH_AUTHORITY_INDETERMINATE',
      });
    });
    expect(await runChild(home, 'inspect', paths)).toEqual({
      status: 'loaded', authority: 'login', fencePresent: false,
    });
  }), 20_000);

  it('refuses a generic stale snapshot writer after explicit clear and new login', () => withFixture(async (home, paths) => {
    expect(await runChild(home, 'seed-old', paths)).toEqual({ status: 'seeded' });
    const staleWriter = startChild(home, 'stale-generic-save', paths);
    await withChild(staleWriter, async (owned) => {
      await waitForFile(paths.ready);
      expect(await runChild(home, 'clear-login', paths)).toEqual({
        status: 'login-installed', finalAuthority: 'login',
      });
      await writeFile(paths.continued, 'continue\n', { mode: 0o600 });
      expect(await finishChild(owned)).toEqual({
        status: 'refused', code: 'AUTH_REFRESH_AUTHORITY_CHANGED',
      });
    });
    expect(await runChild(home, 'inspect', paths)).toEqual({
      status: 'loaded', authority: 'login', fencePresent: false,
    });
  }), 20_000);
});
