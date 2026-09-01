/**
 * CAP-384 (CLI-sealed half) — the in-memory grant holder.
 *
 * WHY A SEPARATE PROCESS, NOT A MODULE-LEVEL VARIABLE: `capy-mcp`'s tool
 * spawner (`src/capy.ts` in the MCP repo) execs a brand-new `capy` process
 * for every tool call — `capy_run` today, and any other secret-touching
 * command tomorrow. A grant obtained by `capy device-key grant` therefore
 * cannot live in that process's own memory: it would be gone before the
 * next `capy run` invocation even starts. So the grant lives in a small,
 * separate, DETACHED process (the "grant daemon") that outlives the command
 * that spawned it, and every later `capy` invocation in the same sandbox
 * talks to it over a Unix domain socket. This is the one place this
 * program's design intentionally trades "zero extra process" for "zero
 * extra disk write" — see the CAP-384 report for the alternatives
 * considered (env-var-carried key material, a CAPY_GLOBAL_DIR_NAME-scoped
 * cache file) and why both were rejected.
 *
 * WHAT NEVER HAPPENS: K_local is never written to a file, never placed in
 * argv (visible via `ps`), and never placed in an environment variable
 * (visible via /proc/<pid>/environ on Linux). It crosses two boundaries
 * only: (1) parent → daemon, over the daemon's stdin pipe, once, at daemon
 * startup; (2) daemon → requesting process, over the Unix domain socket, on
 * every `get`. Both are process-to-process pipes, not persistent storage.
 *
 * THREAT MODEL, STATED HONESTLY: the socket is filesystem-permission-gated
 * (owning directory 0700, socket file 0600) to the same user, which is
 * EXACTLY the trust boundary `local.key` already relies on today ("any
 * process running as the user reads it" — audit-browser-direct-api.md §1.2).
 * This is not a regression from that model; it is the same model, bounded by
 * a TTL and never touching an inode. A hostile process running as a
 * DIFFERENT user cannot connect (the socket file's mode denies it); a
 * hostile process running as the SAME user could, in principle, read this
 * socket exactly as it could already read local.key on a durably-unlocked
 * machine — this file does not attempt to defend against that same-user
 * threat, because nothing on this machine can (see the audit, §2 "Resistance
 * to a same-user attacker").
 *
 * TEMPORARY-GRANT LIFETIME: `DEFAULT_GRANT_TTL_MS` (30 minutes). Deliberately chosen to
 * outlast a single WebAuthn ceremony but not a whole day: long enough that
 * one grant covers many `capy run` calls across one agentic coding session
 * without re-prompting for a touch each time (the ergonomic point of a
 * grant at all), short enough that a sandbox that is somehow still alive an
 * hour later has already lost its key material rather than keeping it
 * indefinitely. The daemon self-terminates at expiry — it does not wait for
 * a request to notice the clock ran out — so "the process is gone" and "the
 * grant is expired" are the same observable fact, not two things that can
 * drift apart. `capy pair` is a different, explicit runtime-custody action:
 * its daemon is process-bound and therefore has no wall-clock expiry. It is
 * still only process-durable — logout, daemon death, or runtime shutdown wipes
 * the in-memory key, and reboot durability requires the separate secure
 * runtime-custody provider documented in docs-internal/runtime-pairing-custody.md.
 */
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { createServer, createConnection, type Server, type Socket } from 'net';
import { chmodSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CapyError, ERROR_CODES } from '../../types/index';

export const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
/** How long a client waits for the daemon to answer one request. */
const REQUEST_TIMEOUT_MS = 5_000;
/** How long the spawning parent waits for the daemon to announce readiness. */
const STARTUP_TIMEOUT_MS = 10_000;
/**
 * How long the daemon keeps LISTENING past its own TTL before it reaps
 * itself. Without this, the internal auto-close timer and a client request
 * both race to be "the thing that notices expiry," and the timer usually
 * wins on any real clock — which would make DEVICE_KEY_GRANT_EXPIRED
 * effectively unreachable in practice (every straggling request would just
 * find the socket gone and see DEVICE_KEY_GRANT_NOT_FOUND instead, losing
 * the "you had one, it lapsed" signal). The grace window guarantees any
 * request in [ttlMs, ttlMs + grace) gets the informative, distinguishable
 * answer; only a request arriving even later ever sees "not found".
 */
const DEFAULT_REAP_GRACE_MS = 2 * 60 * 1000;

/** Backwards-compatible explicit socket override. `capy pair` now persists a
 *  metadata-only pointer under the active Capy home, so subsequent processes
 *  do not need this variable; manual `device-key grant` and orchestrators may
 *  still use it. Its presence remains an ephemerality signal. */
export const GRANT_SOCKET_ENV_VAR = 'CAPY_DEVICE_KEY_GRANT_SOCKET';

/** Internal-only subcommand name; not documented in --help. */
export const GRANT_DAEMON_SUBCOMMAND = '__device-key-grant-daemon';

export interface GrantedKeyMaterialWire {
  userId: string;
  credentialId: string;
  /** base64, 32 bytes. Crosses process boundaries exactly twice — see file header. */
  kLocalB64: string;
  /** null means process-bound runtime custody; finite values are temporary grants. */
  ttlMs: number | null;
}

export interface GrantDaemonHandle {
  socketPath: string;
  expiresAt: number;
  pid: number;
}

// --- Daemon-side: the long-lived server ------------------------------------

interface HeldGrant {
  userId: string;
  credentialId: string;
  kLocal: Buffer;
  expiresAt: number;
}

type DaemonRequest = { op: 'get'; userId?: string } | { op: 'ping' } | { op: 'shutdown' };

function respond(socket: Socket, body: Record<string, unknown>): void {
  try {
    socket.end(JSON.stringify(body) + '\n');
  } catch {
    // Client already gone — nothing to do.
  }
}

/**
 * Build (but do not yet accept traffic on) the daemon's server + socket
 * path. Split from `startGrantDaemonProcess` so the server logic — the part
 * that actually decides what to answer — is unit-testable in-process, in
 * the SAME test file, without forking a real subprocess. The only thing
 * that genuinely requires a second OS process is outliving the command that
 * created the grant (see file header); the protocol itself does not.
 */
export function createGrantDaemonServer(
  material: { userId: string; credentialId: string; kLocal: Buffer },
  ttlMs: number | null,
  opts: { reapGraceMs?: number } = {},
): { server: Server; socketPath: string; socketDir: string; expiresAt: number; close: () => void } {
  const reapGraceMs = opts.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
  const socketDir = mkdtempSync(join(tmpdir(), 'capy-grant-'));
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, `${randomBytes(8).toString('hex')}.sock`);

  const held: HeldGrant = {
    userId: material.userId,
    credentialId: material.credentialId,
    kLocal: Buffer.from(material.kLocal),
    // `0` is the persisted wire sentinel for process-bound custody. It keeps
    // the v1 metadata shape backwards-compatible without inventing a fake
    // far-future expiry date.
    expiresAt: ttlMs === null ? 0 : Date.now() + ttlMs,
  };

  const lifecycle = new AbortController();
  const wipe = (): void => void held.kLocal.fill(0);

  const server = createServer((socket) => {
    void readOneLine(socket).then((line) => {
      const req = (() => {
        try {
          return JSON.parse(line) as DaemonRequest;
        } catch {
          return null;
        }
      })();
      if (!req) {
        respond(socket, { ok: false, code: 'INVALID_REQUEST' });
        return;
      }

      if (req.op === 'ping') {
        respond(socket, { ok: true });
        return;
      }
      if (req.op === 'shutdown') {
        respond(socket, { ok: true });
        close();
        return;
      }
      if (req.op !== 'get') {
        respond(socket, { ok: false, code: 'INVALID_REQUEST' });
        return;
      }
      const expired = held.expiresAt !== 0 && Date.now() >= held.expiresAt;
      if (lifecycle.signal.aborted || expired) {
        respond(socket, { ok: false, code: ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED });
        close(); // The grant is dead the moment it's noticed dead — don't linger.
        return;
      }
      if (req.userId && req.userId !== held.userId) {
        // Not this account's grant — same fail-closed posture as every other
        // identity check in this program (coded, not a leak of who it IS for).
        respond(socket, { ok: false, code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND });
        return;
      }
      respond(socket, {
        ok: true,
        userId: held.userId,
        credentialId: held.credentialId,
        kLocal: held.kLocal.toString('base64'),
        expiresAt: held.expiresAt,
      });
    }).catch(() => respond(socket, { ok: false, code: 'INVALID_REQUEST' }));
    socket.on('error', () => {
      // A client that disconnects mid-write is not this server's problem.
    });
  });

  const expiryTimer = ttlMs === null ? null : setTimeout(close, ttlMs + reapGraceMs);
  // Never keeps the daemon's own event loop alive by itself in tests that
  // hold a reference without calling close(); production callers always run
  // this to completion via runGrantDaemonForever.
  expiryTimer?.unref?.();

  function close(): void {
    lifecycle.abort();
    wipe();
    if (expiryTimer) clearTimeout(expiryTimer);
    try {
      server.close();
    } catch {
      // Already closed.
    }
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — a leftover empty tmp dir is not a secret.
    }
  }

  return { server, socketPath, socketDir, expiresAt: held.expiresAt, close };
}

/**
 * Bring the socket up and listen, mode-restricting it to the owning user
 * (0600) the moment it exists. Resolves once accepting connections. Exported
 * so tests exercise the EXACT same "bring the socket up" path production
 * uses, rather than a hand-rolled copy that could silently drift (e.g. one
 * that forgets the chmod).
 */
export function listenGrantDaemonServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
}

/**
 * The hidden daemon command's body (`capy __device-key-grant-daemon`):
 * reads exactly one line of JSON off stdin (the material — see file header
 * for why stdin, never argv/env), starts the server, announces
 * `{socketPath, expiresAt}` on stdout (never the key), and then blocks until
 * finite TTL expiry or a `shutdown` request closes it. Process-bound runtime
 * custody has no finite TTL. This function's promise
 * resolves only when the daemon should exit — production `index.ts` wiring
 * calls it and lets the process end naturally afterward.
 */
export async function runGrantDaemonForever(stdin: NodeJS.ReadableStream, ttlOverrideMs?: number): Promise<void> {
  const line = await readOneLine(stdin);
  const wire = (() => {
    try {
      return JSON.parse(line) as GrantedKeyMaterialWire;
    } catch {
      throw new CapyError('Malformed grant daemon input.', ERROR_CODES.INVALID_FORMAT);
    }
  })();
  const kLocal = Buffer.from(wire.kLocalB64, 'base64');
  const ttlMs = ttlOverrideMs !== undefined
    ? ttlOverrideMs
    : wire.ttlMs === undefined
      ? DEFAULT_GRANT_TTL_MS
      : wire.ttlMs;

  const { server, socketPath, expiresAt, close } = createGrantDaemonServer(
    { userId: wire.userId, credentialId: wire.credentialId, kLocal },
    ttlMs,
  );
  await listenGrantDaemonServer(server, socketPath);
  process.stdout.write(JSON.stringify({ socketPath, expiresAt }) + '\n');

  await new Promise<void>((resolve) => {
    server.on('close', resolve);
    // Finite temporary grants get a belt-and-suspenders expiry guard. A
    // process-bound runtime pair deliberately waits for shutdown or process
    // death instead.
    if (ttlMs !== null) setTimeout(() => close(), ttlMs + 5_000).unref?.();
  });
}

function readOneLine(stream: NodeJS.ReadableStream): Promise<string> {
  const readFrom = (buffer: string): Promise<string> => new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      cleanup();
      const next = buffer + chunk.toString();
      const newline = next.indexOf('\n');
      if (newline !== -1) return resolve(next.slice(0, newline));
      void readFrom(next).then(resolve, reject);
    };
    const onEnd = (): void => {
      cleanup();
      if (buffer.length > 0) resolve(buffer);
      else reject(new Error('grant daemon: stdin closed with no material'));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
  return readFrom('');
}

// --- Parent-side: spawn the daemon ------------------------------------------

/**
 * Launch the grant daemon as a detached child process re-executing this same
 * CLI binary with the hidden subcommand, hand it the material over stdin
 * (never argv, never env — see file header), and wait for its readiness
 * announcement. The child is `unref()`d so the parent (`capy device-key
 * grant`) can exit immediately; the daemon keeps running on its own.
 * `persistRuntimePairing` stores only the returned socket metadata, never
 * K_local, for the `capy pair` runtime-scoped path.
 */
export function spawnGrantDaemon(
  material: { userId: string; credentialId: string; kLocal: Buffer },
  opts: { ttlMs?: number | null; execPath?: string; scriptPath?: string; persistRuntimePairing?: boolean } = {},
): Promise<GrantDaemonHandle> {
  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1];
  const ttlMs = opts.ttlMs === undefined ? DEFAULT_GRANT_TTL_MS : opts.ttlMs;

  const launch = new Promise<GrantDaemonHandle>((resolve, reject) => {
    const child = spawn(execPath, [scriptPath, GRANT_DAEMON_SUBCOMMAND], {
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });

    const announcement = child.stdout
      ? readOneLine(child.stdout).then((line) => {
        const announced = JSON.parse(line) as { socketPath: string; expiresAt: number };
        return { socketPath: announced.socketPath, expiresAt: announced.expiresAt, pid: child.pid! };
      })
      : Promise.reject(new CapyError('Grant daemon stdout was unavailable.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND));
    const processFailure = new Promise<never>((_resolve, rejectFailure) => {
      child.once('error', rejectFailure);
      child.once('exit', (code) => rejectFailure(
        new CapyError(
          `Grant daemon exited before announcing readiness (code ${code}).`,
          ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
        ),
      ));
    });
    const startup = Promise.race([announcement, processFailure]);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CapyError('Grant daemon did not start in time.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND));
    }, STARTUP_TIMEOUT_MS);

    startup.then(
      (handle) => {
        clearTimeout(timer);
        child.unref();
        child.stdout?.destroy();
        resolve(handle);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    child.stdin?.write(
      JSON.stringify({
        userId: material.userId,
        credentialId: material.credentialId,
        kLocalB64: material.kLocal.toString('base64'),
        ttlMs,
      } satisfies GrantedKeyMaterialWire) + '\n',
    );
    child.stdin?.end();
  });

  if (!opts.persistRuntimePairing) return launch;
  return launch.then(async (handle) => {
    const { registerRuntimePairing } = await import('../pairing/runtimePairing');
    await registerRuntimePairing(material.userId, material.credentialId, handle);
    return handle;
  });
}

// --- Client: talk to an already-running daemon ------------------------------

export interface FetchedGrant {
  userId: string;
  credentialId: string;
  kLocal: Buffer;
  expiresAt: number;
}

/**
 * Fetch the held K_local from a running grant daemon. Maps every failure
 * mode to a coded CapyError — a missing socket (daemon never started, or
 * already exited) and an expired grant are DISTINGUISHABLE outcomes so the
 * caller can tell "you never granted" from "you did, and it lapsed — run
 * `capy device-key grant` again."
 */
export function fetchGrantedKLocal(socketPath: string, userId: string): Promise<FetchedGrant> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new CapyError('Timed out talking to the device-key grant.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND),
      );
    }, REQUEST_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ op: 'get', userId }) + '\n');
    });
    void readOneLine(socket).then((line) => {
      clearTimeout(timer);
      const parsed = (() => {
        try {
          return JSON.parse(line.trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (!parsed) {
        reject(new CapyError('The device-key grant answered with a malformed response.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND));
        return;
      }
      if (parsed.ok === true) {
        resolve({
          userId: String(parsed.userId),
          credentialId: String(parsed.credentialId),
          kLocal: Buffer.from(String(parsed.kLocal), 'base64'),
          expiresAt: Number(parsed.expiresAt),
        });
        return;
      }
      const code = parsed.code === ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED
        ? ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED
        : ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND;
      reject(
        new CapyError(
          code === ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED
            ? 'Your device-key grant for this chat has expired. Ask to re-grant a device key.'
            : 'No device-key grant is active for this chat.',
          code,
        ),
      );
    }).catch(() => {
      clearTimeout(timer);
      reject(new CapyError('No device-key grant is active for this chat.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND));
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT (no socket file) / ECONNREFUSED (stale socket, daemon gone) —
      // both mean "no grant available", never a hard crash for the caller.
      reject(
        new CapyError('No device-key grant is active for this chat.', ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND, {
          cause: err.code,
        }),
      );
    });
  });
}

/** Best-effort liveness probe — used by `am I ephemeral with an active grant`
 *  callers that want to decide without risking an exception. */
export async function isGrantActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, REQUEST_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(JSON.stringify({ op: 'ping' }) + '\n');
    });
    void readOneLine(socket).then((line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line.trim()).ok === true);
      } catch {
        resolve(false);
      }
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
