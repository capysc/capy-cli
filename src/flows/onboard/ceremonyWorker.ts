/**
 * The DETACHED sandbox-session ceremony worker (CAP-451 follow-up: the
 * broker-ceremony deadlock fix).
 *
 * `runSandboxCeremony` (`./sandboxCeremony.ts`) is correct but was run
 * IN-PROCESS by the driver, which meant `capy onboard --broker-ceremony
 * --json` did not print anything — including the URL and `user_code` a
 * human needs to finish the ceremony — until the poll settled, up to
 * `CEREMONY_DEADLINE_MS` (15 minutes) later. A caller that awaits that
 * process (the MCP's `capy_onboard` tool) hangs for the same span, and an
 * MCP HOST that cannot render an elicitation has no way to ever show the
 * human the link at all: the tool call just hangs until the host aborts it,
 * with an empty chat. `capy_whoami`'s auth gate has the identical shape.
 *
 * The fix: NOTHING waits on a human inside a tool call, or inside this
 * process's own `--broker-ceremony` invocation. `prepareCeremonyScreen` —
 * called by `driver.ts` in place of the old inline `runSandboxCeremony` call
 * — mints the request fragment, builds the URL exactly as before, but
 * instead of polling itself it SPAWNS A DETACHED CHILD PROCESS (this same
 * CLI binary, re-invoked as `onboard --ceremony-worker`) and returns
 * immediately with the `screen` step so the ordinary `surfaceScreen` /
 * `--json` envelope path (`onboardCommand.ts`) prints the URL and
 * `user_code` within the same tick — no different, from the caller's
 * perspective, than any other screen step.
 *
 * The worker is that same `runSandboxCeremony` — UNCHANGED, reused verbatim
 * (only handed a `presetPrfSalt` so it runs its ceremony against the EXACT
 * salt already embedded in the URL the human was shown, additive on
 * `SandboxCeremonyOptions`) — running in the background, polling the
 * connection up to its existing 15-minute deadline, and on settling (either
 * way) writing a small, secret-free marker file under this directory's
 * `.capy/` so the NEXT `capy onboard` invocation against the same directory
 * can tell "still waiting" from "declined/expired/failed" from "answered"
 * without re-polling or re-spawning.
 *
 * Everything that crosses the worker's stdin (private key, flow secret, PRF
 * salt) is exactly what `runSandboxCeremony` already held in memory in the
 * old in-process design — nothing NEW is handed to a child process that the
 * parent did not already hold. It never rides argv (visible in `ps`), never
 * a file, and never an environment variable (inherited by children,
 * sometimes logged by supervisors).
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ConnectionKeypair,
  exportConnectionPrivateKeyB64,
  importConnectionKeypair,
} from '../../service/brokerEnvelope';
import { getGlobalCapyDir } from '../../config/globalConfig';
import { debug } from '../../ui/debug';
import { generatePrfSalt } from '../../auth/deviceKey/crypto';
import { FLOW_CONTRACT_VERSION, FlowStep } from '../validate';
import {
  buildCeremonyUrl,
  CEREMONY_CODES,
  CEREMONY_DEADLINE_MS,
  runSandboxCeremony,
} from './sandboxCeremony';

// ---------------------------------------------------------------------------
// 1. The marker file — secret-free, keyed by connection id
// ---------------------------------------------------------------------------

export type CeremonyMarkerState = 'pending' | 'done' | 'failed';

export interface CeremonyMarker {
  state: CeremonyMarkerState;
  /** The exact URL (with the CLI's `#r=` fragment) already shown to the human. Not a secret. */
  url: string;
  /** RFC-8628 anti-phishing code — not a secret, meant to be shown. */
  userCode?: string;
  connectionId: string;
  createdAt: number;
  /**
   * The target dir this ceremony's flow instance is running against — not a
   * secret, kept for the same reason the marker itself already carries
   * `connectionId`: a human (or a future debugging pass) reading a marker in
   * the global store, where the marker's OWN location no longer says which
   * project it belongs to, needs it recorded on the marker itself.
   */
  targetDir?: string;
  /** Set only when state is 'done' and the ceremony resolved an org. Not a secret. */
  orgId?: string;
  /**
   * Set only when state is 'done' and the ceremony CREATED a project (the
   * `default` project the create_org mint provisions). Not a secret. Rides
   * to `driver.ts`'s step report as `result.project_id` so the service pins
   * the project the mint already made — see `FirstRunOutcome.projectId`.
   */
  projectId?: string;
  /** Set only when state is 'failed'. A code, never prose. */
  code?: string;
}

/** A marker older than this is treated as abandoned (worker died without writing an outcome). */
export const CEREMONY_MARKER_STALE_MS = CEREMONY_DEADLINE_MS + 60_000;

/**
 * Markers live under the GLOBAL capy dir (`~/.capy/ceremonies/`), never under
 * the target project directory. `prepareCeremonyScreen` used to `mkdir`
 * `<targetDir>/.capy/` itself to hold this file — creating that directory is
 * the FLOW's job (the `write_capy_dir` local_action, run later once the flow
 * actually decides this directory is a Capy project), not a side effect of a
 * ceremony that has not settled anything yet. Keyed by `connectionId` alone
 * (globally unique — minted per flow instance by the service), so the
 * `targetDir` param below is kept only for signature compatibility with
 * every existing caller/test; the marker's own `targetDir` field (written by
 * `prepareCeremonyScreen`) is the one source of truth for which project it
 * belongs to.
 */
export function ceremonyMarkerPath(_targetDir: string, connectionId: string): string {
  return join(getGlobalCapyDir(), 'ceremonies', `${connectionId}.json`);
}

function isCeremonyMarker(v: unknown): v is CeremonyMarker {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    (m.state === 'pending' || m.state === 'done' || m.state === 'failed') &&
    typeof m.url === 'string' &&
    typeof m.connectionId === 'string' &&
    typeof m.createdAt === 'number'
  );
}

/** Best-effort: a marker that fails to parse is treated as absent, never thrown. */
export function readCeremonyMarker(targetDir: string, connectionId: string): CeremonyMarker | null {
  const path = ceremonyMarkerPath(targetDir, connectionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isCeremonyMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCeremonyMarker(targetDir: string, marker: CeremonyMarker): void {
  const path = ceremonyMarkerPath(targetDir, marker.connectionId);
  // The GLOBAL `~/.capy/ceremonies/` dir, never `<targetDir>/.capy/` — see
  // `ceremonyMarkerPath`'s own doc for why the flow, not this worker, owns
  // creating a project's `.capy/` directory.
  const dir = join(getGlobalCapyDir(), 'ceremonies');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(marker), 'utf8');
}

/** Best-effort cleanup once a marker has been consumed by the driver. */
export function deleteCeremonyMarker(targetDir: string, connectionId: string): void {
  try {
    rmSync(ceremonyMarkerPath(targetDir, connectionId), { force: true });
  } catch {
    // Nothing this driver can do about an un-removable marker; the next
    // ceremony uses a different connection id, so a leftover file is inert.
  }
}

// ---------------------------------------------------------------------------
// 2. The worker's stdin payload — never argv, never a file, never an env var
// ---------------------------------------------------------------------------

export interface CeremonyWorkerPayload {
  v: 1;
  privateKeyB64: string;
  publicKeyB64: string;
  connectionId: string;
  userCode?: string;
  /** The base step URL (no `#r=` fragment) — the worker rebuilds the identical fragment from `prfSaltB64`. */
  baseUrl: string;
  flowSecret: string;
  prfSaltB64: string;
  targetDir: string;
  serviceUrl: string;
  devMode: boolean;
  machineName?: string;
  /**
   * The REAL ids of the flow and its sandbox_session step, so the worker can
   * report the settled outcome to the service itself (see the settle-report
   * block in runCeremonyWorker — the marker alone is unreachable in organic
   * sequencing). Optional for payload back-compat: absent, the worker skips
   * the report and the marker path stands alone, exactly as before.
   */
  flowId?: string;
  stepId?: string;
  /**
   * CAP-542: the `sandbox_session` step's own `mint_org_id` param, when the
   * service sent one (jumping straight to the mint rail for an
   * already-known org). Threaded through so the worker's own
   * `buildCeremonyUrl` call (inside `runSandboxCeremony`) reconstructs the
   * IDENTICAL fragment `prepareCeremonyScreen` already showed the human —
   * see `runCeremonyWorker`'s synthetic `step` below. Absent for every
   * ceremony this binary built before CAP-542.
   */
  mintOrgId?: string;
}

function isWorkerPayload(v: unknown): v is CeremonyWorkerPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.privateKeyB64 === 'string' &&
    typeof p.publicKeyB64 === 'string' &&
    typeof p.connectionId === 'string' &&
    typeof p.baseUrl === 'string' &&
    typeof p.flowSecret === 'string' &&
    typeof p.prfSaltB64 === 'string' &&
    typeof p.targetDir === 'string' &&
    typeof p.serviceUrl === 'string' &&
    typeof p.devMode === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// 3. Parent side: ensure a worker is running, never block on it
// ---------------------------------------------------------------------------

export interface PrepareCeremonyScreenOptions {
  step: FlowStep;
  keypair: ConnectionKeypair;
  flowSecret: string;
  serviceUrl: string;
  devMode: boolean;
  machineName?: string;
  targetDir: string;
  /** Injectable for tests — defaults to `child_process.spawn` against this binary's own entry. */
  spawnImpl?: typeof spawn;
  /** Injectable for tests — defaults to resolving this binary's own re-invocation. */
  resolveCommand?: () => { command: string; args: string[] };
}

export type PrepareCeremonyScreenResult =
  | { kind: 'screen'; step: FlowStep }
  | { kind: 'settled'; outcome: 'ok'; orgId?: string; projectId?: string }
  | { kind: 'settled'; outcome: 'failed'; code: string };

/**
 * How this binary re-invokes itself as a ceremony worker. A `pkg`-packaged
 * binary IS the interpreter (`process.execPath` alone runs it — no script
 * path to prepend); a `bun`/`node` dev invocation needs its own entry script
 * as the first argument, exactly as the shell originally invoked it.
 */
function defaultResolveCommand(): { command: string; args: string[] } {
  const isPackaged = Boolean((process as unknown as { pkg?: unknown }).pkg);
  const base = isPackaged ? [] : [process.argv[1]];
  return { command: process.execPath, args: [...base, 'onboard', '--ceremony-worker'] };
}

/**
 * Spawn the detached worker and return immediately — never awaited by the
 * caller. `detached: true` + `unref()` lets this process (and its whole
 * process group, when the host kills it) exit without taking the worker
 * down with it; `stdio: ['pipe', 'ignore', 'ignore']` is the one channel the
 * payload rides (closed immediately after the write) with no output anyone
 * reads.
 */
export function spawnCeremonyWorker(
  payload: CeremonyWorkerPayload,
  opts: { spawnImpl?: typeof spawn; resolveCommand?: () => { command: string; args: string[] } } = {},
): ChildProcess {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const { command, args } = (opts.resolveCommand ?? defaultResolveCommand)();
  // Diagnostic aid: CAPY_CEREMONY_LOG (a file path) routes the DETACHED
  // worker's otherwise-discarded stderr to a file, so `debug()` breadcrumbs
  // (CAPY_VERBOSE=1) survive the parent's exit. Dev/E2E only — unset, the
  // original ['pipe','ignore','ignore'] wiring is byte-identical.
  const stderrTarget = ((): 'ignore' | number => {
    const logPath = process.env.CAPY_CEREMONY_LOG;
    if (!logPath) return 'ignore';
    try {
      return openSync(logPath, 'a');
    } catch {
      return 'ignore';
    }
  })();
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: ['pipe', 'ignore', stderrTarget],
  });
  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
  child.unref();
  return child;
}

/**
 * Called by `driver.ts` in place of the old inline `runSandboxCeremony`
 * call. Never polls, never awaits the worker — resolves as soon as a worker
 * is confirmed spawned (first encounter) or the existing marker has been
 * read (every later encounter of the same connection). S1-resume-ceremony
 * semantics: re-asking the same pending ceremony returns the SAME url and
 * `user_code`, never mints a second connection or spawns a second worker.
 */
export async function prepareCeremonyScreen(
  opts: PrepareCeremonyScreenOptions,
): Promise<PrepareCeremonyScreenResult> {
  const connectionId = opts.step.params.connection_id as string;
  const userCode =
    typeof opts.step.params.user_code === 'string' ? (opts.step.params.user_code as string) : undefined;
  // CAP-542: read straight off the validated step — see `CeremonyWorkerPayload.mintOrgId`'s doc for why this also has to ride the worker payload.
  const mintOrgId =
    typeof opts.step.params.mint_org_id === 'string' ? (opts.step.params.mint_org_id as string) : undefined;

  const existing = readCeremonyMarker(opts.targetDir, connectionId);
  if (existing) {
    const stale = existing.state === 'pending' && Date.now() - existing.createdAt > CEREMONY_MARKER_STALE_MS;
    if (existing.state === 'pending' && !stale) {
      // Same connection, same URL, no second worker.
      return { kind: 'screen', step: { ...opts.step, url: existing.url } };
    }
    // A settled marker ('done'/'failed') or a stale abandoned 'pending' one
    // is consumed here — the next line starts fresh if it re-encounters this
    // same connection id, which the service will not do once it has moved
    // the instance on.
    deleteCeremonyMarker(opts.targetDir, connectionId);
    if (existing.state === 'done') {
      return {
        kind: 'settled',
        outcome: 'ok',
        ...(existing.orgId ? { orgId: existing.orgId } : {}),
        ...(existing.projectId ? { projectId: existing.projectId } : {}),
      };
    }
    if (existing.state === 'failed') {
      return { kind: 'settled', outcome: 'failed', code: existing.code ?? CEREMONY_CODES.SERVICE_ERROR };
    }
    // Stale pending: fall through and mint a fresh worker below.
  }

  const prfSalt = generatePrfSalt();
  const url = buildCeremonyUrl(opts.step, opts.machineName, prfSalt);

  writeCeremonyMarker(opts.targetDir, {
    state: 'pending',
    url,
    userCode,
    connectionId,
    createdAt: Date.now(),
    targetDir: opts.targetDir,
  });

  // `spawnCeremonyWorker` can fail two ways: a SYNCHRONOUS throw out of
  // `spawnImpl` itself (some platforms/Node versions surface a bad command
  // this way; the injectable `spawnImpl` a test uses to reproduce ENOENT
  // deterministically also throws synchronously), or an ASYNC 'error' event
  // on the returned child (the more common real-world ENOENT/EACCES shape).
  // Before this fix, the synchronous case propagated straight out of this
  // function AFTER the 'pending' marker above had already been written —
  // crashing the caller (`driver.ts`) with a stack trace instead of the
  // `--json` envelope it is contractually never allowed to skip, and leaving
  // a marker on disk with no worker ever running to settle it.
  let child: ReturnType<typeof spawnCeremonyWorker>;
  try {
    child = spawnCeremonyWorker(
      {
        v: 1,
        privateKeyB64: exportConnectionPrivateKeyB64(opts.keypair),
        publicKeyB64: opts.keypair.publicKeyB64,
        connectionId,
        userCode,
        baseUrl: opts.step.url as string,
        flowSecret: opts.flowSecret,
        prfSaltB64: prfSalt.toString('base64'),
        targetDir: opts.targetDir,
        serviceUrl: opts.serviceUrl,
        devMode: opts.devMode,
        machineName: opts.machineName,
        flowId: opts.step.flow_id,
        stepId: opts.step.step_id,
        mintOrgId,
      },
      { spawnImpl: opts.spawnImpl, resolveCommand: opts.resolveCommand },
    );
  } catch {
    deleteCeremonyMarker(opts.targetDir, connectionId);
    return { kind: 'settled', outcome: 'failed', code: CEREMONY_CODES.SPAWN_FAILED };
  }

  // Best-effort: an async 'error' event fires AFTER this function has
  // already returned the 'screen' step below (nothing here awaits the
  // worker), so it cannot change what THIS call reports. Rewriting the
  // marker to 'failed' is what stops the NEXT `prepareCeremonyScreen` call
  // for this same connection from reading a 'pending' marker forever — it
  // instead reads the coded failure above and folds it into the driver loop
  // exactly like a genuinely-run-but-failed ceremony. Guarded for test
  // doubles that don't implement a real `ChildProcess`'s `.on`.
  if (typeof (child as { on?: unknown }).on === 'function') {
    child.on('error', () => {
      writeCeremonyMarker(opts.targetDir, {
        state: 'failed',
        url,
        userCode,
        connectionId,
        createdAt: Date.now(),
        targetDir: opts.targetDir,
        code: CEREMONY_CODES.SPAWN_FAILED,
      });
    });
  }

  return { kind: 'screen', step: { ...opts.step, url } };
}

// ---------------------------------------------------------------------------
// 4. Worker side: `capy onboard --ceremony-worker`, reading its payload from stdin
// ---------------------------------------------------------------------------

async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The worker's entry point. Reads its payload from stdin ONCE, runs the
 * SAME `runSandboxCeremony` tail the old in-process design ran (unchanged
 * function, `presetPrfSalt` threaded through so it derives against the
 * exact salt already embedded in the URL the human was shown), and writes
 * the outcome to the marker file so the next `capy onboard` invocation in
 * this directory can read it. Never throws out of this function: a
 * malformed payload or a mid-ceremony exception both end in either a
 * written 'failed' marker (when a connection id is known) or a silent exit
 * (when it is not — nothing to key a marker on, and nothing was ever shown
 * to a human for this attempt).
 */
export async function runCeremonyWorker(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  let payload: CeremonyWorkerPayload | undefined;
  try {
    const raw = await readAllStdin(input);
    const parsed = JSON.parse(raw);
    if (isWorkerPayload(parsed)) payload = parsed;
  } catch {
    payload = undefined;
  }
  if (!payload) return;

  const keypair = importConnectionKeypair(payload.publicKeyB64, payload.privateKeyB64);
  const step: FlowStep = {
    contract_version: '1',
    flow_id: 'ceremony-worker',
    flow_type: 'onboard',
    step_id: 'ceremony-worker',
    kind: 'screen',
    resumed: false,
    screen: 'sandbox_session',
    url: payload.baseUrl,
    params: {
      connection_id: payload.connectionId,
      user_code: payload.userCode,
      // CAP-542: reconstructed from the payload so this worker's own
      // `buildCeremonyUrl` call (inside `runSandboxCeremony` below) produces
      // the fragment byte-identical to the one `prepareCeremonyScreen`
      // already showed the human.
      ...(payload.mintOrgId ? { mint_org_id: payload.mintOrgId } : {}),
    },
  };

  // Not secrets — the org/project ids the ceremony resolved, so this step's
  // outcome can be reported as `result:{org_id, project_id}` the same way
  // any other 'ok' local_action's is. See `runSandboxCeremony`'s own
  // `result.result.org_id`.
  const settled = await (async (): Promise<{
    ok: boolean;
    code?: string;
    orgId?: string;
    projectId?: string;
    token?: string;
  }> => {
    try {
      const outcome = await runSandboxCeremony({
        step,
        keypair,
        flowSecret: payload.flowSecret,
        serviceUrl: payload.serviceUrl,
        devMode: payload.devMode,
        machineName: payload.machineName,
        targetDir: payload.targetDir,
        presetPrfSalt: Buffer.from(payload.prfSaltB64, 'base64'),
      });
      return {
        ok: outcome.result.outcome === 'ok',
        code: outcome.result.code,
        orgId: outcome.result.result?.org_id,
        projectId: outcome.result.result?.project_id,
        token: outcome.session?.token,
      };
    } catch {
      return { ok: false, code: CEREMONY_CODES.SERVICE_ERROR };
    }
  })();

  writeCeremonyMarker(payload.targetDir, {
    state: settled.ok ? 'done' : 'failed',
    url: payload.baseUrl,
    userCode: payload.userCode,
    connectionId: payload.connectionId,
    createdAt: Date.now(),
    targetDir: payload.targetDir,
    ...(settled.ok
      ? {
          ...(settled.orgId ? { orgId: settled.orgId } : {}),
          ...(settled.projectId ? { projectId: settled.projectId } : {}),
        }
      : { code: settled.code ?? CEREMONY_CODES.SERVICE_ERROR }),
  });

  // Report the settled step to the service RIGHT NOW, from this worker —
  // never only via the marker. The marker path depends on a later driver
  // re-encountering the SAME sandbox_session step, and organically it never
  // does: this worker's own session-store write flips the next derivation's
  // `sessionLive` observation to true, the service (correctly) skips
  // authenticate AND derives past the satisfied ceremony screen, and the
  // settled marker is never consumed — so the service pins the org off the
  // bearer's claim but never learns the `project_id` the create_org mint
  // provisioned, and `write_keep_lock` dead-ends on the adopt-vs-create
  // picker (observed live: headless journey runs 6 and 7). The org-scoped
  // bearer this ceremony just settled is exactly the credential the service's
  // pin verification (`projectPinnableBy`) requires. Best-effort by design:
  // on any failure the marker remains, and the driver's consume-and-report
  // path (still intact above) covers every sequencing where the step IS
  // re-encountered.
  if (settled.ok && settled.orgId && payload.flowId && payload.stepId) {
    try {
      const { FlowClient } = await import('../client');
      const { observeOnboard } = await import('./observe');
      const client = new FlowClient(payload.serviceUrl, payload.devMode);
      await client.next(
        payload.flowId,
        {
          contract_version: FLOW_CONTRACT_VERSION,
          observations: observeOnboard({ targetDir: payload.targetDir, sessionLive: true }),
          last_step: {
            step_id: payload.stepId,
            outcome: 'ok',
            result: {
              org_id: settled.orgId,
              ...(settled.projectId ? { project_id: settled.projectId } : {}),
            },
          },
          client_pubkey: payload.publicKeyB64,
        },
        { secret: payload.flowSecret, token: settled.token },
      );
    } catch (err) {
      debug(
        `[ceremony-worker] settle report failed, marker remains the fallback: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
