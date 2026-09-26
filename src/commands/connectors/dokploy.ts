/**
 * `capy connect dokploy` — a ONE-TIME IMPORT of env vars from a Dokploy
 * Application into this project's `.env`, then encrypted + synced the same
 * way every other connector's write lands (CAP-662, parent CAP-657).
 *
 * This is the PULL half of the Dokploy integration; `capy deploy` (the PUSH
 * half, see `../../deploy/adapters/dokploy.ts` and
 * `docs/dokploy-deploy-adapter.md`) delivers Capy's own runtime pair back out
 * to the same kind of Application.
 *
 * Import is READ-ONLY on the Dokploy side: the only call this file ever makes
 * is `GET application.one`. It never writes to Dokploy. The API token itself
 * is never stored by THIS file — it comes from `resolveDokployApiKey`
 * (CAP-664): the org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry by
 * default (which the store itself may prompt for and save, once, on an
 * admin's first use), or the NAME of an env var holding it (`--token-env`,
 * default `DOKPLOY_API_KEY` / `dokployApi.DEFAULT_TOKEN_ENV`) when that's
 * explicitly set. Resolved before any Dokploy request.
 *
 * `kind: 'import'` (see `registry.ts`) routes `capy connect dokploy` to
 * `import()` below instead of the single-variable `connect()`/`rotate()`
 * pair every other connector uses — there is no sensible "which variable"
 * question for a run that pulls many at once, and no rotation: re-running is
 * how you refresh it, and `capy rotate` refuses on a dokploy-managed var
 * (see `rotateCommand.ts`).
 */
import { TargetConfig } from '../../deploy/adapter';
import { baseUrlProblem } from '../../deploy/adapters/dokploy';
import {
  DEFAULT_TOKEN_ENV,
  DokployApiError,
  DokployClient,
  DokploySystemStoreCallOptions,
  FetchLike,
  createDokployClient,
  describeDokployTokenProblem,
  dokploySecretsMayPrompt,
  listImportableEntries,
  resolveDokployApiKey,
} from '../../deploy/dokployApi';
import { ConnectorMetadata } from '../../types/index';
import { isInteractive } from '../../ui/interactive';
import { fingerprint, ResolvedContext } from './shared';
import { ConnectOpts, ConnectorModule, ConnectResult, ImportOutcome, ImportWarning, RotateResult } from './registry';

/** Same option shape `capy deploy dokploy` targets store (see adapters/dokploy.ts). */
interface DokployTargetOptions {
  baseUrl?: string;
  applicationId?: string;
  tokenEnv?: string;
}

// ── Settings resolution ─────────────────────────────────────────────────────

export type DokploySettingsResult =
  | { ok: true; baseUrl: string; applicationId: string; tokenEnv: string }
  | { ok: false; code: 'DOKPLOY_TARGET_AMBIGUOUS' | 'DOKPLOY_SETTINGS_MISSING'; message: string };

export interface DokploySettingsDeps {
  pickTarget: (names: readonly string[]) => Promise<string>;
  askSettings: () => Promise<{ baseUrl: string; applicationId: string }>;
}

/**
 * Base URL + application id + token-var-name, in the priority order CAP-662
 * decided: `--base-url`/`--application` flags, then the lone saved Dokploy
 * deploy target, then an interactive ask, then a non-interactive refusal.
 * `--token-env` (or a saved target's own `tokenEnv`) always overrides
 * independently — it is a simple knob, not part of what makes targets
 * ambiguous.
 *
 * Pure aside from the two injected prompts, so it is testable with a plain
 * array of `TargetConfig` and stub callbacks — no fs, no network.
 */
export async function resolveDokploySettings(
  opts: ConnectOpts,
  dokployTargets: readonly TargetConfig[],
  interactive: boolean,
  deps: DokploySettingsDeps,
): Promise<DokploySettingsResult> {
  const tokenEnvFlag = opts.tokenEnv?.trim();
  const fromTarget = (t: TargetConfig): DokploySettingsResult => {
    const saved = t.options as DokployTargetOptions;
    return {
      ok: true,
      baseUrl: (opts.baseUrl ?? saved.baseUrl ?? '').trim(),
      applicationId: (opts.application ?? saved.applicationId ?? '').trim(),
      tokenEnv: tokenEnvFlag || saved.tokenEnv || DEFAULT_TOKEN_ENV,
    };
  };

  if (opts.baseUrl && opts.application) {
    return {
      ok: true,
      baseUrl: opts.baseUrl.trim(),
      applicationId: opts.application.trim(),
      tokenEnv: tokenEnvFlag || DEFAULT_TOKEN_ENV,
    };
  }

  if (dokployTargets.length === 1) {
    return fromTarget(dokployTargets[0]);
  }

  if (dokployTargets.length > 1) {
    if (!interactive) {
      return {
        ok: false,
        code: 'DOKPLOY_TARGET_AMBIGUOUS',
        message:
          `Several Dokploy deploy targets are configured (${dokployTargets.map((t) => t.name).join(', ')}). ` +
          'Pass --base-url and --application, or run this interactively to pick one.',
      };
    }
    const picked = await deps.pickTarget(dokployTargets.map((t) => t.name));
    return fromTarget(dokployTargets.find((t) => t.name === picked) ?? dokployTargets[0]);
  }

  if (!interactive) {
    return {
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      message: 'No Dokploy settings found. Pass --base-url <url> and --application <id>, or run this interactively.',
    };
  }
  const asked = await deps.askSettings();
  return {
    ok: true,
    baseUrl: asked.baseUrl.trim(),
    applicationId: asked.applicationId.trim(),
    tokenEnv: tokenEnvFlag || DEFAULT_TOKEN_ENV,
  };
}

/** A failed `application.one` call as a stable code + message. Never a value. */
export function mapImportApiError(err: unknown, applicationId: string): { code: string; message: string } {
  if (err instanceof DokployApiError) {
    if (err.code === 'unauthorized') {
      return { code: 'DOKPLOY_AUTH_FAILED', message: `Dokploy rejected the API token (HTTP ${err.status}).` };
    }
    if (err.code === 'not_found') {
      return { code: 'DOKPLOY_APP_NOT_FOUND', message: `No Dokploy application ${applicationId}.` };
    }
    return { code: 'DOKPLOY_API_ERROR', message: err.message };
  }
  return { code: 'DOKPLOY_API_ERROR', message: err instanceof Error ? err.message : String(err) };
}

type FetchAppEnvResult = { ok: true; env: string | null } | ({ ok: false } & { code: string; message: string });

/** `GET application.one`, mapped to a stable code + message on failure — never a thrown value. */
async function fetchApplicationEnv(client: DokployClient, applicationId: string): Promise<FetchAppEnvResult> {
  try {
    const { env } = await client.getApplication(applicationId);
    return { ok: true, env };
  } catch (err) {
    return { ok: false, ...mapImportApiError(err, applicationId) };
  }
}

// ── Deploy-target offer ─────────────────────────────────────────────────────

function uniqueTargetName(existing: readonly TargetConfig[], base: string): string {
  const names = new Set(existing.map((t) => t.name));
  if (!names.has(base)) return base;
  const numbered = (n: number): string => (names.has(`${base}-${n}`) ? numbered(n + 1) : `${base}-${n}`);
  return numbered(2);
}

interface DeployTargetOfferArgs {
  importedNames: readonly string[];
  applicationId: string;
  baseUrl: string;
  tokenEnv: string;
  branch: string;
  allTargets: readonly TargetConfig[];
  interactive: boolean;
  cwd: string;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
}

/**
 * After a successful import, offer to save a Dokploy deploy target for the
 * SAME application — so `capy deploy` can ship Capy's runtime pair back to
 * it. Only offered when nothing imported (nothing to offer) and only asked
 * interactively; non-interactive never asks and never saves.
 */
async function maybeOfferDeployTarget(args: DeployTargetOfferArgs): Promise<boolean> {
  if (args.importedNames.length === 0) return false;
  const already = args.allTargets.some(
    (t) => t.kind === 'dokploy' && (t.options as DokployTargetOptions).applicationId === args.applicationId,
  );
  if (already || !args.interactive) return false;

  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const yes = await args.confirm(
    'Save a Dokploy deploy target for this application, so `capy deploy` can ship the runtime pair to it?',
    false,
  );
  if (!yes) return false;

  const { upsertTarget } = await import('../../deploy/config');
  upsertTarget(args.cwd, {
    name: uniqueTargetName(args.allTargets, 'dokploy'),
    kind: 'dokploy',
    branch: args.branch,
    vars: [...args.importedNames],
    options: { baseUrl: args.baseUrl, applicationId: args.applicationId, tokenEnv: args.tokenEnv },
  });
  return true;
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface DokployConnectorDeps {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => Date;
  /** Injectable for tests. Real `inquirer` confirm otherwise. */
  confirm?: (message: string, defaultValue: boolean) => Promise<boolean>;
  /** Injectable for tests. Real `inquirer` checkbox (all pre-checked) otherwise. */
  selectVars?: (candidates: readonly string[]) => Promise<readonly string[]>;
  /** Injectable for tests. Real `inquirer` list otherwise. */
  pickTarget?: (names: readonly string[]) => Promise<string>;
  /** Injectable for tests. Real `inquirer` input x2 otherwise. */
  askSettings?: () => Promise<{ baseUrl: string; applicationId: string }>;
  /**
   * Reads the org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry — see
   * `dokployApi.ts#ResolveDokployApiKeyDeps`. Defaults to a no-op (never
   * touches the network): every test constructs this connector directly with
   * its own `env`/`fetch` and none of them exercise the store, so this dep
   * stays opt-in here. The exported `dokployConnector` singleton below wires
   * the real `system/systemStore.ts#getConnectorSecret` explicitly — that is
   * the one instance `capy connect dokploy` actually runs.
   */
  getConnectorSecret?: (name: string, opts: DokploySystemStoreCallOptions) => Promise<string | null>;
}

async function defaultConfirm(message: string, defaultValue: boolean): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: defaultValue }]);
  return ok;
}

async function defaultSelectVars(candidates: readonly string[]): Promise<readonly string[]> {
  if (candidates.length === 0) return [];
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'picked',
      message: 'Which variables to import from Dokploy:',
      choices: candidates.map((name) => ({ name, value: name, checked: true })),
    },
  ]);
  return picked;
}

async function defaultPickTarget(names: readonly string[]): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    { type: 'list', name: 'picked', message: 'Which Dokploy deploy target:', choices: [...names] },
  ]);
  return picked;
}

async function defaultAskSettings(): Promise<{ baseUrl: string; applicationId: string }> {
  const inquirer = (await import('inquirer')).default;
  const ans = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Dokploy URL:',
      validate: (v: string) => baseUrlProblem(v) ?? true,
      filter: (v: string) => v.trim(),
    },
    {
      type: 'input',
      name: 'applicationId',
      message: 'Dokploy application ID:',
      validate: (v: string) => (v.trim() ? true : 'required'),
      filter: (v: string) => v.trim(),
    },
  ]);
  return { baseUrl: ans.baseUrl, applicationId: ans.applicationId };
}

/** `--var` on `capy connect dokploy`: comma-separated names, restricting the import. */
function parseVarRestriction(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

export function createDokployConnector(deps: DokployConnectorDeps = {}): ConnectorModule {
  const cwd = () => deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const confirm = deps.confirm ?? defaultConfirm;
  const selectVars = deps.selectVars ?? defaultSelectVars;
  const pickTarget = deps.pickTarget ?? defaultPickTarget;
  const askSettings = deps.askSettings ?? defaultAskSettings;

  return {
    name: 'dokploy',
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    description: 'One-time import of env vars from a Dokploy Application',
    kind: 'import',

    // Never reached: `connectCommand.ts` and `rotateCommand.ts`'s promotion
    // flow both route on `kind === 'import'` before this could be called.
    // Kept only because `ConnectorModule.connect` is a required method —
    // defence in depth against a future call site that forgets the branch.
    async connect(): Promise<ConnectResult> {
      throw new Error('dokploy is import-only; connectCommand should have routed to import() instead.');
    },
    async rotate(): Promise<RotateResult> {
      throw new Error('dokploy is import-only; rotateCommand should have refused before calling rotate().');
    },

    async import(ctx: ResolvedContext, opts: ConnectOpts): Promise<ImportOutcome> {
      // No `--web` branching here by design: browser screens are a separate
      // surface (built in the Keep workbench, later phase — see
      // docs/dokploy-deploy-adapter.md's "Browser setup" section for the
      // equivalent stance on the deploy side). `--web` flows through
      // unchanged, exactly as the shared `connect` code path already handles
      // it for every connector.
      const interactive = isInteractive(opts.nonTty);

      const { listTargets } = await import('../../deploy/config');
      const allTargets = listTargets(cwd());
      const dokployTargets = allTargets.filter((t) => t.kind === 'dokploy');

      const settings = await resolveDokploySettings(opts, dokployTargets, interactive, { pickTarget, askSettings });
      if (!settings.ok) return { ok: false, code: settings.code, message: settings.message };
      const { baseUrl, applicationId, tokenEnv } = settings;

      // Resolved BEFORE any Dokploy request — a missing/refused token still
      // means zero requests (see the class doc's "READ-ONLY" note). A
      // SEPARATE interactive flag from the one above: `--web` (the store's
      // prompt is a raw terminal prompt, not a browser screen) and `--json`
      // (machine output must never have a prompt interleaved with it) both
      // suppress ONLY this prompt, not the settings prompts above.
      const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.web || !!opts.json);
      const resolved = await resolveDokployApiKey({
        tokenEnv,
        env: deps.env ?? process.env,
        interactive: secretsInteractive,
        orgId: ctx.orgId,
        devMode: opts.devMode,
        deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
      });
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, tokenEnv);
        return { ok: false, code: resolved.code, message: `${reason}.` };
      }
      const token = resolved.value;

      const client = createDokployClient(baseUrl, token, deps.fetch);
      const envResult = await fetchApplicationEnv(client, applicationId);
      if (!envResult.ok) return { ok: false, code: envResult.code, message: envResult.message };
      const appEnv = envResult.env;

      const restrict = parseVarRestriction(opts.var);
      const importable = listImportableEntries(appEnv).filter((e) => !restrict || restrict.includes(e.name));
      const referenceSkipped = importable.filter((e) => e.skip === 'DOKPLOY_REFERENCE_VALUE').map((e) => e.name);
      const candidates = importable.filter((e) => !e.skip);

      const selectedNames = restrict
        ? candidates.map((e) => e.name)
        : interactive
          ? await selectVars(candidates.map((e) => e.name))
          : candidates.map((e) => e.name);
      const selected = candidates.filter((e) => selectedNames.includes(e.name));

      interface Classified {
        unchanged: readonly string[];
        skipped: ReadonlyArray<{ name: string; code: string }>;
        toImport: ReadonlyArray<{ name: string; value: string }>;
      }
      const EMPTY_CLASSIFIED: Classified = { unchanged: [], skipped: [], toImport: [] };

      // Sequential (not parallel): a conflict's `confirm()` is a real prompt
      // when interactive, and every entry is classified in selection order —
      // a `.reduce` over a promise keeps that order without a mutable
      // accumulator.
      const { unchanged, skipped, toImport } = await selected.reduce<Promise<Classified>>(
        async (accPromise, e) => {
          const acc = await accPromise;
          const local = ctx.localPlaintext[e.name];
          if (local === undefined) {
            return { ...acc, toImport: [...acc.toImport, { name: e.name, value: e.value }] };
          }
          if (local === e.value) {
            return { ...acc, unchanged: [...acc.unchanged, e.name] };
          }
          if (interactive) {
            // COPY-FLAG: new user-facing string, minimal/neutral wording.
            // Names only — never the value on either side.
            const replace = await confirm(
              `${e.name} is already set locally with a different value. Replace it with the Dokploy value?`,
              false,
            );
            return replace
              ? { ...acc, toImport: [...acc.toImport, { name: e.name, value: e.value }] }
              : { ...acc, skipped: [...acc.skipped, { name: e.name, code: 'IMPORT_CONFLICT_SKIPPED' }] };
          }
          return { ...acc, skipped: [...acc.skipped, { name: e.name, code: 'IMPORT_CONFLICT_SKIPPED' }] };
        },
        Promise.resolve(EMPTY_CLASSIFIED),
      );

      const importedAt = now().toISOString();
      const createdAtSec = Math.floor(now().getTime() / 1000);
      const imported = toImport.map(({ name, value }) => ({
        varName: name,
        value,
        entry: {
          provider: 'dokploy',
          source: 'import',
          created_at: createdAtSec,
          fingerprint: fingerprint(value),
          application_id: applicationId,
          imported_at: importedAt,
        } as ConnectorMetadata,
      }));

      const warnings: ImportWarning[] = [
        ...(referenceSkipped.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceSkipped }] : []),
        // Reminder, names only: the plaintext stays in Dokploy — reversible by
        // design (see docs/dokploy-deploy-adapter.md) — and is ignored at
        // boot once `capy deploy` writes the runtime pair.
        ...(imported.length > 0
          ? [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: imported.map((i) => i.varName) }]
          : []),
      ];

      const deployTargetSaved = await maybeOfferDeployTarget({
        importedNames: imported.map((i) => i.varName),
        applicationId,
        baseUrl,
        tokenEnv,
        branch: ctx.branch,
        allTargets,
        interactive,
        cwd: cwd(),
        confirm,
      });

      return { ok: true, applicationId, imported, unchanged, skipped, warnings, deployTargetSaved };
    },
  };
}

/**
 * The `capy connect dokploy` production instance — the only place this file
 * wires the org system store for real (every other construction, including
 * every test, gets the safe env-only default — see `DokployConnectorDeps`).
 */
export const dokployConnector: ConnectorModule = createDokployConnector({
  getConnectorSecret: async (name, opts) => {
    const { getConnectorSecret } = await import('../../system/systemStore');
    return getConnectorSecret(name, opts);
  },
});
