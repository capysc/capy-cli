/**
 * Dokploy Application adapter.
 *
 * Delivers the `_SECRETS_BLOB` + `_PROJECT_KEY` pair `capy run` reads first
 * into a Dokploy Application's environment, then triggers a Dokploy
 * deployment and polls it to a real outcome. Individual secrets never reach
 * Dokploy: the service is expected to start with `capy run -- <app
 * command>`, which decrypts at boot and injects the values into the child
 * process only.
 *
 * Dokploy stores an Application's environment as one text blob (plus
 * buildArgs / buildSecrets / createEnvFile) and only offers a whole-object
 * write, so every update is read → merge → write. Capy owns exactly one
 * marked block inside `env`; every other line is carried through verbatim.
 * The write is NOT atomic per key — a dashboard edit landing between our read
 * and our write is lost. We re-read after the write and fail loudly when the
 * stored env is not the one we wrote.
 *
 * Deploys are meant to be REVERSIBLE: Capy never edits or deletes anything
 * outside its own block, so deleting the block (by hand, or via `capy deploy
 * remove`'s offer) returns the app to exactly its prior config.
 *
 * The API token is never written to `.capy/deploy.json`. The target stores
 * the NAME of the environment variable that holds it (default
 * DOKPLOY_API_KEY), read at deploy time.
 */
import {
  DeployAdapter,
  DeployContext,
  DeployResult,
  DeployStep,
  DeployWarning,
  DetectedDefaults,
  PreflightResult,
  RemoveOfferContext,
  RemoveOfferResult,
  TargetConfig,
} from '../adapter';
import {
  DEFAULT_TOKEN_ENV,
  DokployApiError,
  DokployClient,
  DokployDeployment,
  EnvWarning,
  FetchLike,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  apiBase,
  createDokployClient,
  describeEnvProblem,
  describeEnvWarning,
  envKeys,
  envProblems,
  envWarnings,
  mergeManagedBlock,
  outsideLines,
  resolveDokployToken,
  sortedCopy,
  splitManagedBlock,
  stripManagedBlock,
} from '../dokployApi';

// Re-exported for back-compat: callers (tests, deployCommand.ts) import the
// client + env-merge primitives from this module today. New code should
// import them from `dokployApi` directly.
export {
  DEFAULT_TOKEN_ENV,
  DokployApiError,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  apiBase,
  createDokployClient,
  describeEnvProblem,
  describeEnvWarning,
  envKeys,
  envProblems,
  envWarnings,
  mergeManagedBlock,
  outsideLines,
  splitManagedBlock,
  stripManagedBlock,
};
export type {
  DokployApplication,
  DokployClient,
  DokployDeployment,
  DokployDeploymentStatus,
  DokployErrorCode,
  DotenvEntry,
  EnvMergeProblem,
  EnvMergeProblemCode,
  EnvSplit,
  EnvWarning,
  EnvWarningCode,
  FetchLike,
  ImportableEnvEntry,
  ImportSkipReason,
} from '../dokployApi';

export interface DokployOptions {
  /** Dokploy dashboard URL, e.g. https://dokploy.example.com. `/api` is appended. */
  baseUrl: string;
  /** Application id from the Dokploy dashboard URL / API. */
  applicationId: string;
  /** Name of the environment variable holding the Dokploy API token. */
  tokenEnv: string;
  /** How long to wait for the deployment to finish. Defaults to 600. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 3000;

// ── Polling ────────────────────────────────────────────────────────────────

export type DeploymentOutcome =
  | { kind: 'succeeded'; deployment: DokployDeployment }
  | { kind: 'failed'; deployment: DokployDeployment }
  | { kind: 'timed_out'; deployment: DokployDeployment | null };

export interface PollDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onRunning?: (d: DokployDeployment) => void;
}

/**
 * Wait for the deployment our trigger created. Dokploy's deploy call returns
 * no id, so "ours" is the newest deployment whose id was not in the list
 * taken just before the trigger.
 */
export async function pollDeployment(
  client: DokployClient,
  applicationId: string,
  before: ReadonlySet<string>,
  deadline: number,
  deps: PollDeps,
  seenRunning: boolean = false,
): Promise<DeploymentOutcome> {
  const list = await client.listDeployments(applicationId);
  const ours =
    sortedCopy(
      list.filter((d) => !before.has(d.deploymentId)),
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    )[0] ?? null;
  if (ours?.status === 'done') return { kind: 'succeeded', deployment: ours };
  if (ours?.status === 'error' || ours?.status === 'cancelled') {
    return { kind: 'failed', deployment: ours };
  }
  if (ours && !seenRunning) deps.onRunning?.(ours);
  if (deps.now() >= deadline) return { kind: 'timed_out', deployment: ours };
  await deps.sleep(POLL_INTERVAL_MS);
  return pollDeployment(client, applicationId, before, deadline, deps, seenRunning || !!ours);
}

// ── Adapter ────────────────────────────────────────────────────────────────

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise as a value, so each call site branches without try/catch. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Why a Dokploy URL is unusable, or null. Shared with the setup prompts. */
export function baseUrlProblem(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return 'required';
  const url = parseUrl(raw.trim());
  if (!url) return 'not a URL';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return 'must start with https://';
  }
  return null;
}

/** Why a token variable name is unusable, or null. Shared with the setup prompts. */
export function tokenEnvProblem(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return 'required';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.trim()) ? null : 'not a valid environment variable name';
}

/** Config-shape problems, checked before any network call. */
export function optionsProblem(config: TargetConfig): PreflightResult | null {
  const opts = config.options as Partial<DokployOptions>;
  const hint = 'Run `capy deploy --edit ' + config.name + '` to fix.';
  const urlProblem = baseUrlProblem(opts.baseUrl);
  if (urlProblem) return { ok: false, reason: `dokploy baseUrl: ${urlProblem}`, hint };
  if (!opts.applicationId || !opts.applicationId.trim()) {
    return { ok: false, reason: 'dokploy applicationId: required', hint };
  }
  const envProblem = tokenEnvProblem(opts.tokenEnv);
  if (envProblem) return { ok: false, reason: `dokploy tokenEnv: ${envProblem}`, hint };
  if (
    opts.timeoutSeconds !== undefined &&
    !(Number.isInteger(opts.timeoutSeconds) && opts.timeoutSeconds > 0)
  ) {
    return { ok: false, reason: 'dokploy timeoutSeconds: must be a positive whole number', hint };
  }
  if (config.vars.length === 0) {
    return {
      ok: false,
      reason: 'dokploy target has no vars to ship',
      hint: 'Re-run with `--edit` and select at least one var.',
    };
  }
  return null;
}

/** A failed Dokploy call as a reason (and fix-it hint) a person can act on. */
export function explainApiError(
  err: unknown,
  what: string,
  opts: DokployOptions,
): { reason: string; hint?: string } {
  if (!(err instanceof DokployApiError)) {
    return { reason: `${what}: ${err instanceof Error ? err.message : String(err)}` };
  }
  switch (err.code) {
    case 'unauthorized':
      return {
        reason: `${what}: Dokploy rejected the API token in $${opts.tokenEnv} (HTTP ${err.status})`,
        hint: `Create an API token in the Dokploy dashboard and export it as ${opts.tokenEnv}.`,
      };
    case 'not_found':
      return {
        reason: `${what}: no Dokploy application ${opts.applicationId} at ${opts.baseUrl}`,
        hint: 'Check the application id — it is part of the application URL in the Dokploy dashboard.',
      };
    default:
      return { reason: `${what}: ${err.message}` };
  }
}

/** `envWarnings` as the generic, printable `DeployWarning` shape. */
function toDeployWarning(w: EnvWarning): DeployWarning {
  return { code: w.code, names: w.names, message: describeEnvWarning(w) };
}

export interface DokployAdapterDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

function lastLogLines(logs: string, n = 30): string {
  return logs
    .trimEnd()
    .split('\n')
    .slice(-n)
    .map((l) => `    ${l}`)
    .join('\n');
}

/** Printed once a deploy succeeds: the wiring Capy never applies for you. */
export function runtimeEpilogue(deployId: string | undefined): string {
  const revoke = deployId ? `capy deploy revoke ${deployId}` : 'capy deploy revoke <deployId>';
  return [
    '  Your service must start through `capy run` to receive these secrets:',
    '',
    '    capy run -- <your start command>',
    '',
    '  Capy does not change your start or build settings. If the app already',
    '  starts this way, there is nothing else to do.',
    '',
    `  To cut this deploy off:  ${revoke}`,
    '  Revoking stops future boots from decrypting. It cannot take values back',
    '  from a process that is already running — restart or redeploy the',
    '  application after revoking.',
  ].join('\n');
}

/** One line, printed either way, for `onRemove`'s manual fallback. */
function manualStripHint(opts: DokployOptions): string {
  return (
    `In the Dokploy dashboard, open Application → Environment for ` +
    `${opts.applicationId}, delete the block between "${MANAGED_BEGIN}" and ` +
    `"${MANAGED_END}" (inclusive), and save.`
  );
}

export function createDokployAdapter(deps: DokployAdapterDeps = {}): DeployAdapter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const tokenFor = (opts: DokployOptions): string | null =>
    resolveDokployToken(opts.tokenEnv, deps.env ?? process.env);
  const clientFor = (opts: DokployOptions): DokployClient | null => {
    const token = tokenFor(opts);
    return token ? createDokployClient(opts.baseUrl, token, deps.fetch) : null;
  };

  return {
    id: 'dokploy',
    label: 'Dokploy',
    description: 'Application env gets the capy run pair; capy triggers and watches the deploy',
    varKind: 'runtime',
    defaultMode: 'direct',
    needsDeployToken: true,
    requires: { binaries: [] },

    async detect(): Promise<DetectedDefaults> {
      return { options: { tokenEnv: DEFAULT_TOKEN_ENV } };
    },

    async preflight(config: TargetConfig): Promise<PreflightResult> {
      const shape = optionsProblem(config);
      if (shape) return shape;
      const opts = config.options as unknown as DokployOptions;
      const client = clientFor(opts);
      if (!client) {
        return {
          ok: false,
          reason: `$${opts.tokenEnv} is not set`,
          hint: `Export your Dokploy API token first:\n  export ${opts.tokenEnv}=…`,
        };
      }
      const app = await settle(client.getApplication(opts.applicationId));
      if (!app.ok) return { ok: false, ...explainApiError(app.error, 'application.one', opts) };
      const problem = envProblems(app.value.env);
      if (problem) return { ok: false, ...describeEnvProblem(problem) };
      const warning = envWarnings(app.value.env, config.vars);
      return { ok: true, ...(warning ? { warnings: [toDeployWarning(warning)] } : {}) };
    },

    async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
      const opts = config.options as unknown as DokployOptions;
      if (ctx.dryRun) {
        return {
          ok: true,
          steps: [
            {
              label: 'runtime pair',
              status: 'ok',
              detail: `${config.vars.length} var(s) would ship inside ${RUNTIME_PAIR[0]} + ${RUNTIME_PAIR[1]}`,
            },
            { label: 'application.saveEnvironment', status: 'skip', detail: 'dry-run' },
            { label: 'application.deploy', status: 'skip', detail: 'dry-run' },
          ],
        };
      }
      const fail = (
        steps: readonly DeployStep[],
        step: DeployStep,
        epilogue?: string,
      ): DeployResult => ({
        ok: false,
        steps: [...steps, step],
        ...(epilogue ? { epilogue } : {}),
      });
      if (!ctx.deployToken) {
        return fail([], { label: 'runtime pair', status: 'fail', detail: 'no deploy token was minted' });
      }
      const client = clientFor(opts);
      if (!client) {
        return fail([], { label: 'dokploy auth', status: 'fail', detail: `$${opts.tokenEnv} is not set` });
      }

      // 1. Fresh read — what preflight saw may be stale by now.
      const read = await settle(client.getApplication(opts.applicationId));
      if (!read.ok) {
        return fail([], {
          label: 'application.one',
          status: 'fail',
          detail: explainApiError(read.error, 'read', opts).reason,
        });
      }
      const current = read.value;
      const s1: readonly DeployStep[] = [
        { label: 'dokploy application', status: 'ok', detail: current.name ?? current.applicationId },
      ];
      const split = splitManagedBlock(current.env);
      const problem = 'code' in split ? split : envProblems(current.env);
      if (problem || 'code' in split) {
        return fail(s1, {
          label: 'env merge',
          status: 'fail',
          detail: problem ? describeEnvProblem(problem).reason : 'unreadable environment',
        });
      }
      const warning = envWarnings(current.env, config.vars);
      const warnings: readonly DeployWarning[] | undefined = warning ? [toDeployWarning(warning)] : undefined;
      const withWarnings = (r: DeployResult): DeployResult => (warnings ? { ...r, warnings } : r);
      // Not printed here: `preflight()` (above, in `deployCommand.ts`'s flow)
      // already surfaced this same warning to the terminal once. `warnings`
      // still rides on the `DeployResult` below for any caller reading it
      // structurally — this just isn't a second (or third) console line.
      const nextEnv = mergeManagedBlock(split, ctx.deployToken);

      // 2. Whole-object write: buildArgs / buildSecrets / createEnvFile ride
      //    through exactly as read.
      const saved = await settle(
        client.saveEnvironment({
          applicationId: current.applicationId,
          env: nextEnv,
          buildArgs: current.buildArgs,
          buildSecrets: current.buildSecrets,
          createEnvFile: current.createEnvFile,
        }),
      );
      if (!saved.ok) {
        return withWarnings(
          fail(s1, {
            label: 'application.saveEnvironment',
            status: 'fail',
            detail: explainApiError(saved.error, 'write', opts).reason,
          }),
        );
      }

      // 3. Dokploy has no conditional write, so a concurrent dashboard edit can
      //    only be detected, not prevented: re-read and compare.
      const reread = await settle(client.getApplication(opts.applicationId));
      const intact =
        reread.ok &&
        reread.value.env === nextEnv &&
        reread.value.buildArgs === current.buildArgs &&
        reread.value.buildSecrets === current.buildSecrets &&
        reread.value.createEnvFile === current.createEnvFile;
      if (!intact) {
        return withWarnings(
          fail(s1, {
            label: 'application.saveEnvironment',
            status: 'fail',
            detail:
              'the stored environment is not what Capy wrote — another edit may have landed at the ' +
              'same moment. Check the Environment tab in Dokploy, then re-run.',
          }),
        );
      }
      const s2: readonly DeployStep[] = [
        ...s1,
        {
          label: 'application.saveEnvironment',
          status: 'ok',
          detail:
            `${RUNTIME_PAIR[0]} + ${RUNTIME_PAIR[1]} ${split.hadBlock ? 'replaced' : 'added'}; ` +
            `${envKeys(outsideLines(split)).length} other var(s), build args and build secrets kept`,
        },
      ];

      if (ctx.secretsOnly) {
        return withWarnings({
          ok: true,
          steps: [
            ...s2,
            { label: 'application.deploy', status: 'skip', detail: 'CI mode — deploy runs on PR merge' },
          ],
          epilogue: runtimeEpilogue(ctx.deployToken.deployId),
        });
      }

      // 4. Trigger, remembering which deployments already existed — Dokploy's
      //    deploy call does not say which deployment it created.
      const before = await settle(client.listDeployments(opts.applicationId));
      if (!before.ok) {
        return withWarnings(
          fail(s2, {
            label: 'deployment.all',
            status: 'fail',
            detail: explainApiError(before.error, 'list', opts).reason,
          }),
        );
      }
      const triggered = await settle(client.deploy(opts.applicationId, `capy deploy ${config.name}`));
      if (!triggered.ok) {
        return withWarnings(
          fail(s2, {
            label: 'application.deploy',
            status: 'fail',
            detail: explainApiError(triggered.error, 'trigger', opts).reason,
          }),
        );
      }
      const s3: readonly DeployStep[] = [
        ...s2,
        { label: 'application.deploy', status: 'ok', detail: 'accepted' },
      ];
      log('  · deployment accepted — waiting for Dokploy…');

      // 5. Poll to a real outcome; the trigger response alone proves nothing.
      const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const polled = await settle(
        pollDeployment(
          client,
          opts.applicationId,
          new Set(before.value.map((d) => d.deploymentId)),
          now() + timeoutMs,
          { sleep, now, onRunning: () => log('  · deployment running…') },
        ),
      );
      if (!polled.ok) {
        return withWarnings(
          fail(s3, {
            label: 'deployment',
            status: 'fail',
            detail: explainApiError(polled.error, 'status', opts).reason,
          }),
        );
      }
      const outcome = polled.value;
      switch (outcome.kind) {
        case 'succeeded':
          return withWarnings({
            ok: true,
            steps: [
              ...s3,
              { label: 'deployment', status: 'ok', detail: `succeeded (${outcome.deployment.deploymentId})` },
            ],
            epilogue: runtimeEpilogue(ctx.deployToken.deployId),
          });
        case 'failed': {
          const logs = await settle(client.readLogs(outcome.deployment.deploymentId));
          const logText = logs.ok ? logs.value.trim() : '';
          return withWarnings(
            fail(
              s3,
              {
                label: 'deployment',
                status: 'fail',
                detail:
                  `${outcome.deployment.status} (${outcome.deployment.deploymentId})` +
                  (outcome.deployment.errorMessage ? ` — ${outcome.deployment.errorMessage}` : ''),
              },
              logText
                ? `  Last lines of the Dokploy deployment log:\n\n${lastLogLines(logText)}`
                : '  Dokploy returned no deployment log — open the deployment in the Dokploy dashboard.',
            ),
          );
        }
        case 'timed_out':
          return withWarnings(
            fail(s3, {
              label: 'deployment',
              status: 'fail',
              detail: outcome.deployment
                ? `still running after ${timeoutMs / 1000}s (${outcome.deployment.deploymentId}) — ` +
                  'check the Dokploy dashboard'
                : `Dokploy recorded no new deployment within ${timeoutMs / 1000}s — check the Dokploy dashboard`,
            }),
          );
      }
    },

    async onRemove(config: TargetConfig, ctx: RemoveOfferContext): Promise<RemoveOfferResult | null> {
      const opts = config.options as unknown as DokployOptions;
      const token = tokenFor(opts);
      if (!token) {
        return {
          ok: false,
          code: 'no_token',
          detail: `Dokploy environment left untouched — $${opts.tokenEnv} is not set, so Capy could not check for its block.`,
          manualHint: manualStripHint(opts),
        };
      }
      const client = createDokployClient(opts.baseUrl, token, deps.fetch);
      const read = await settle(client.getApplication(opts.applicationId));
      if (!read.ok) {
        return {
          ok: false,
          code: 'api_error',
          detail: `Dokploy environment left untouched — ${explainApiError(read.error, 'read', opts).reason}`,
          manualHint: manualStripHint(opts),
        };
      }
      const app = read.value;
      const split = splitManagedBlock(app.env);
      if ('code' in split) {
        return {
          ok: false,
          code: 'malformed_block',
          detail:
            'Dokploy environment left untouched — the Capy block looks edited or duplicated; ' +
            'Capy will not guess which lines are its own.',
          manualHint: manualStripHint(opts),
        };
      }
      if (!split.hadBlock) {
        return {
          ok: true,
          code: 'nothing_to_remove',
          detail: 'No Capy block found in the Dokploy environment — nothing to remove.',
        };
      }
      if (!ctx.interactive) {
        return {
          ok: false,
          code: 'non_interactive',
          detail: 'Dokploy environment left untouched — not asking to strip the Capy block outside a terminal.',
          manualHint: manualStripHint(opts),
        };
      }
      const confirmed = await ctx.confirm(
        `Also strip the Capy block from the Dokploy Application env for "${config.name}"?`,
      );
      if (!confirmed) {
        return {
          ok: false,
          code: 'declined',
          detail: 'Dokploy environment left untouched.',
          manualHint: manualStripHint(opts),
        };
      }
      const strippedEnv = stripManagedBlock(split);
      const saved = await settle(
        client.saveEnvironment({
          applicationId: app.applicationId,
          env: strippedEnv,
          buildArgs: app.buildArgs,
          buildSecrets: app.buildSecrets,
          createEnvFile: app.createEnvFile,
        }),
      );
      if (!saved.ok) {
        return {
          ok: false,
          code: 'api_error',
          detail: `Could not write the Dokploy environment — ${explainApiError(saved.error, 'write', opts).reason}`,
          manualHint: manualStripHint(opts),
        };
      }
      const reread = await settle(client.getApplication(opts.applicationId));
      const intact =
        reread.ok &&
        reread.value.env === strippedEnv &&
        reread.value.buildArgs === app.buildArgs &&
        reread.value.buildSecrets === app.buildSecrets &&
        reread.value.createEnvFile === app.createEnvFile;
      if (!intact) {
        return {
          ok: false,
          code: 'verify_mismatch',
          detail:
            'The stored environment after removal did not match what Capy wrote — check the ' +
            'Environment tab in Dokploy.',
          manualHint: manualStripHint(opts),
        };
      }
      return {
        ok: true,
        code: 'stripped',
        detail: 'Removed the Capy block from the Dokploy environment; everything else was left untouched.',
      };
    },
  };
}

export const dokployAdapter: DeployAdapter = createDokployAdapter();
