import { ConnectorMetadata } from '../../types/index';
import type { Blocked } from '../../ui/screens/contract';
import type { DokployImportSource } from '../../deploy/dokployApi';
import type { DiscoveryContext, DiscoveryOutcome } from './dokployDiscovery';
import { ResolvedContext } from './shared';

export interface ConnectOpts {
  live?: boolean;
  var?: string;
  account?: string;
  noPush?: boolean;
  /**
   * This connect is a STEP inside another command rather than the whole run.
   *
   * `capy rotate <var>` on a variable with no connector links it first and then
   * rotates it — one journey, drawn as one rail. Without this the link half
   * serves its own ENDING page and signs off with "run `capy rotate <var>` to
   * replace it", which is the command the user is already inside. An ending is
   * a claim that the run is over, so a nested one has to be suppressed rather
   * than merely tolerated.
   *
   * Only the SUCCESS ending is suppressed. A decline or a failed push still
   * gets its page, because the outer command stops there and something has to
   * say why.
   */
  subStep?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
  /**
   * Pair with the provider again even when a usable session already exists.
   *
   * Off by default on purpose. `stripe login` rewrites the machine's shared
   * provider config and can make the provider issue a new key, so re-running
   * `connect` must not do it as a side effect of recording a link. This is the
   * way to ask for it deliberately.
   */
  reauth?: boolean;
  /**
   * Render this command's questions as compiled screens in a local browser.
   *
   * Not the same axis as `nonTty`, and the pairing is the whole point: the
   * caller `--web` exists for runs with piped stdio, so `isInteractive()` is
   * already false and every picker below has either defaulted or refused
   * without asking. `--web` is what turns those back into questions.
   */
  web?: boolean;
  /**
   * A `capy-dev` binary. Live mode is refused outright, so the mode question
   * says so beside the option rather than accepting it and exiting afterwards.
   */
  devMode?: boolean;
  /**
   * Dokploy import only: dashboard URL (flag `--base-url`). Other connectors
   * never read this.
   */
  baseUrl?: string;
  /**
   * Dokploy import only: Application id (flag `--application`). Other
   * connectors never read this. Mutually exclusive with `compose` — both set
   * is `DOKPLOY_SOURCE_AMBIGUOUS`, checked before any Dokploy request.
   */
  application?: string;
  /**
   * Dokploy import only: Compose service id (flag `--compose`). Every one of
   * a `compose.one` org's Dokploy services is a Compose service, never an
   * Application — this is the other half of `--application`. Other
   * connectors never read this. Mutually exclusive with `application`.
   */
  compose?: string;
  /**
   * Dokploy import only: name of the env var holding the API token (flag
   * `--token-env`). Other connectors never read this.
   */
  tokenEnv?: string;
  /**
   * Emit machine-readable JSON on stdout instead of the human UI. Currently
   * read only by import-kind connectors (`dokploy`); a link-kind connector
   * ignores it.
   */
  json?: boolean;
  /**
   * Dokploy import only: preview the plan — resolve the key, read the source
   * (`application.one` or `compose.one`), and print/emit what WOULD happen —
   * without writing anything locally (`.env`, keep.lock) or pushing anything
   * to Capy, and without prompting for the API key (see
   * `dokployApi.ts#dokploySecretsMayPrompt`). Vince's rule: a dry run changes
   * nothing. A link-kind connector ignores it. Also read by discovery mode
   * (`discover`, below) — same "changes nothing" contract.
   */
  dryRun?: boolean;
  /**
   * Dokploy DISCOVERY mode only (CAP-657 follow-up): find every Dokploy
   * service whose git source matches a repo reachable from `cwd`, rather
   * than importing one named `--application`/`--compose`. Mutually
   * exclusive in PURPOSE with the single-service path, though not refused
   * when combined with `application`/`compose` — under `discover`, those two
   * instead name the service that should win a mapping collision (see
   * `DOKPLOY_MAPPING_COLLISION`), a different meaning from the single-
   * service import's "which one to read". Other connectors never read this.
   */
  discover?: boolean;
  /**
   * Dokploy DISCOVERY mode only: skip the interactive "write this?"
   * confirmation and apply directly. Required for a non-interactive
   * (including `--json`) real (non-dry-run) discovery run to write
   * anything at all — without it, that combination refuses
   * `DOKPLOY_CONFIRMATION_REQUIRED` with zero writes, exactly like an
   * interactive run that declines the same confirmation. Other connectors
   * never read this (`rotate`'s own `-y/--yes` is a separate flag on a
   * separate command).
   */
  yes?: boolean;
  /**
   * Dokploy import only (usable on the plain single-service import, and
   * threaded through unchanged by discovery to every environment it runs):
   * set the branch's vars to EXACTLY Dokploy's importable set for this
   * service — names not in Dokploy are CLEARED, names in both with a
   * different value are REPLACED with Dokploy's, names only in Dokploy are
   * a plain import. A reference value (`${{...}}`) is never cleared for —
   * skipped and reported instead, same as every other import. Without this
   * flag, import behaves exactly as it always has: it never clears
   * anything, and a differing value is asked about (or skipped
   * non-interactively) rather than silently overwritten. Gated the same way
   * discovery's own real-run confirmation is: interactive asks (default
   * no), `--yes` skips the ask, non-interactive without `--yes` refuses
   * `DOKPLOY_CONFIRMATION_REQUIRED`, and `--dry-run` shows the by-name
   * lists without writing anything.
   */
  overwrite?: boolean;
  /**
   * Dokploy DISCOVERY mode only: restrict the plan to these Dokploy
   * ENVIRONMENT names — comma-separated (e.g. `--environment staging,preview`),
   * same single-value-comma-list convention as `--var` (repeated
   * `--environment` flags are not merged). Case-sensitive exact match,
   * applied after grouping and nested-folder joining but BEFORE collision
   * resolution, so a collision is only raised about environments the
   * filter kept. A folder left with no matching environment drops out of
   * the plan entirely. An unknown name (matching nothing anywhere) refuses
   * `DOKPLOY_ENVIRONMENT_NOT_FOUND`, listing the names that DO exist.
   * Combined with `--application`/`--compose` WITHOUT `--discover` (the
   * single-service path, where there is no "plan" to filter) refuses
   * `DOKPLOY_ENVIRONMENT_NOT_APPLICABLE`, checked before any request.
   */
  environment?: string;
}

export interface RotateOpts {
  noPush?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
  /** Render this command's questions as compiled screens in a local browser. */
  web?: boolean;
}

/** Result of provider.connect(): the provider hands us a value + the connector metadata to record on the keep.lock entry. */
export interface ConnectResult {
  varName: string;
  /**
   * A value to write, for a connector whose setup genuinely produces one.
   *
   * OMITTED IS THE NORMAL CASE, and the default is the point. `connect` sets up
   * the link between a variable and a provider — it is not a credential
   * operation. Returning a value here makes the command overwrite whatever the
   * variable already held, which is `rotate`'s job and nobody else's.
   *
   * Stripe returned one for exactly this reason and it was wrong: `connect
   * stripe` copied the key sitting in the Stripe CLI's own `config.toml` over
   * the top of the user's `.env`, silently, on a command whose name promises
   * an association. `undefined` leaves the value alone; only the keep.lock
   * connector entry is written.
   */
  value?: string;
  entry: ConnectorMetadata;
  /**
   * Further variables this connect should mark as managed, beyond `varName`.
   *
   * For providers where one variable is not the whole link. WorkOS is the
   * case: the API key is meaningless without the client ID that says which
   * environment it belongs to, so recording only the key would leave the other
   * half of the pair looking untracked.
   *
   * Each becomes an ordinary connector entry — managed, and offered by
   * `capy rotate` like any other.
   */
  also?: ReadonlyArray<{ varName: string; entry: ConnectorMetadata }>;
}

/** Result of provider.rotate(): the new value, plus updated connector metadata (rotated_at, expires_at, fingerprint refreshed). */
export interface RotateResult {
  value: string;
  entry: ConnectorMetadata;
}

/** One variable an `import`-kind connector pulled in, ready for `writeImportedAndSync`. */
export interface ImportedVarEntry {
  varName: string;
  value: string;
  entry: ConnectorMetadata;
}

/** A candidate that was NOT imported, and why — a stable code, never a sentence. */
export interface ImportSkip {
  name: string;
  code: string;
}

/** A non-blocking heads-up about the import, grouped by code like `DeployWarning`. */
export interface ImportWarning {
  code: string;
  names: readonly string[];
}

/** Result of provider.import(): what `capy connect <import-connector>` pulled in, or why it refused. */
export type ImportOutcome =
  | {
      ok: true;
      /**
       * Dokploy import only, back-compat: set when `source.kind ===
       * 'application'`, absent for a Compose import — see `source` below,
       * which every dokploy import now sets. Additive: existing callers
       * reading this for an application import see the exact same value as
       * before.
       */
      applicationId?: string;
      /** Dokploy import only: which Dokploy object this import read from. */
      source?: DokployImportSource;
      imported: readonly ImportedVarEntry[];
      unchanged: readonly string[];
      skipped: readonly ImportSkip[];
      warnings: readonly ImportWarning[];
      deployTargetSaved: boolean;
      /**
       * Dokploy import only: names with a different local value that a real
       * (non-dry-run) run would have prompted about. Only populated under
       * `ConnectOpts.dryRun` — a dry run never prompts, so these conflicts
       * are reported rather than resolved.
       */
      wouldAsk?: readonly string[];
      /**
       * `--overwrite` only: local names Dokploy no longer has — removed
       * from the branch entirely (never a reference-valued name — those are
       * skipped, not cleared). Absent when `--overwrite` wasn't passed.
       */
      cleared?: readonly string[];
      /**
       * `--overwrite` only: names present in both with a DIFFERENT value,
       * overwritten with Dokploy's — a subset of `imported`'s names (both
       * fields carry the same entries; this one is purely which of them
       * were a change rather than a brand-new write). Absent when
       * `--overwrite` wasn't passed.
       */
      replacedNames?: readonly string[];
    }
  | {
      ok: false;
      /** Stable refusal code — branch on this, never on `message`. */
      code: string;
      message: string;
    };

export interface ConnectorModule {
  name: string;
  description: string;
  /**
   * 'link' (default, omitted) — `connect()` associates ONE existing `.env`
   * variable with a provider credential; nothing is pulled from the provider
   * except that one value's fingerprint/type.
   *
   * 'import' — a ONE-TIME pull of MANY variables from the provider into
   * `.env`. `connectCommand` routes to `import()` instead of `connect()`,
   * skipping the var-picking and live-mode questions that only make sense for
   * a single linked credential. `capy rotate` refuses on any var this kind of
   * connector manages (CAP-662): there is nothing to rotate through a one-time
   * import. Keyed off this field rather than the provider's name string, so
   * the refusal is not `=== 'dokploy'` reasoning about a human-readable id.
   */
  kind?: 'link' | 'import';
  /**
   * Set when rotating runs an interactive auth step the user must complete by
   * hand (e.g. Stripe shells out to `stripe login`, which opens a browser).
   * Surfaced as a leading "Auth" stop in the rotate plan so the user knows a
   * manual hand-off is coming. Omit for providers that rotate unattended.
   */
  requiresAuth?: boolean;
  /** Local binary `precheck` looks for, e.g. `stripe`. */
  requiresTool?: string;
  /**
   * Non-exiting form of `precheck`, for a list that previews whether a
   * connector can run. `precheck` itself exits the process, so the only way to
   * learn this today is to pick the connector and be refused.
   */
  toolInstalled?(): boolean;
  /**
   * The refusal `precheck` makes when `requiresTool` is missing.
   *
   * ONE object, so the preview in the connector list and the wall the command
   * runs into are the same condition rather than two — same code, same install
   * link, same command to run. Two screens wording one condition differently is
   * a bug in the product.
   */
  toolMissing?: Blocked;
  /**
   * Synchronous pre-check that runs before any auth or network. Use to bail
   * early on missing local dependencies (e.g. provider CLI not installed) so
   * we don't waste a user's OAuth round-trip on a request that can't succeed.
   * Should call `process.exit` or throw on failure.
   */
  precheck?(): void;
  connect(ctx: ResolvedContext, opts: ConnectOpts): Promise<ConnectResult>;
  rotate(
    ctx: ResolvedContext,
    varName: string,
    previous: ConnectorMetadata,
    opts: RotateOpts,
  ): Promise<RotateResult>;
  /** Present only when `kind === 'import'`. See `kind`'s doc above. */
  import?(ctx: ResolvedContext, opts: ConnectOpts): Promise<ImportOutcome>;
  /**
   * Discovery mode (CAP-657 follow-up, `dokploy` only): find every matching
   * Dokploy service rather than importing one named id. `connectCommand.ts`
   * routes here instead of `import()` when `opts.discover` is set — with its
   * OWN, lighter context (`DiscoveryContext`, no keep.lock/project key
   * required — see that type's own doc), resolved BEFORE the ordinary
   * `resolveContext()` a `ResolvedContext` needs. Present only on connectors
   * that implement it — no other provider does today.
   */
  discover?(ctx: DiscoveryContext, opts: ConnectOpts): Promise<DiscoveryOutcome>;
}

/** Registered providers, keyed by name (matches `connector.provider` on each keep.lock entry). */
export const providers: Record<string, () => Promise<ConnectorModule>> = {
  stripe: async () => (await import('./stripe')).stripeConnector,
  workos: async () => (await import('./workos')).workosConnector,
  dokploy: async () => (await import('./dokploy')).dokployConnector,
};

export function listProviders(): { name: string; description: string }[] {
  return [
    { name: 'stripe', description: 'Stripe API key (test or live, restricted)' },
    { name: 'workos', description: 'WorkOS environment API key (sandbox or production)' },
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    { name: 'dokploy', description: 'One-time import of env vars from a Dokploy Application or Compose service' },
  ];
}

export async function loadProvider(name: string): Promise<ConnectorModule> {
  const loader = providers[name];
  if (!loader) throw new Error(`Unknown connector: ${name}`);
  return loader();
}
