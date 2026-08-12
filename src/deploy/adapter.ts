/**
 * Deploy adapter contract.
 *
 * Each adapter encapsulates one secret-delivery shape (cf-worker, cf-pages,
 * vercel, fly, …). The deploy flow:
 *
 *   1. picker chooses adapter id → user fills/confirms TargetConfig
 *   2. preflight runs BEFORE any decryption (fail fast, no plaintext exposure)
 *   3. capy decrypts current branch → calls adapter.deploy(config, env)
 *   4. adapter shells out to vendor CLI / API to push secrets and ship code
 */

import type { Classification } from './classify';

export type DeployMode = 'direct' | 'ci';

export interface TargetConfig {
  /** Stable identifier the user references with `capy deploy <name>`. */
  name: string;
  /** Adapter id — e.g. 'cf-worker', 'cf-pages'. */
  kind: string;
  /** capy branch to ship from. Per-target so worker-prod/-staging differ. */
  branch: string;
  /** Variable names this target consumes. */
  vars: string[];
  /**
   * The full set of project vars available on `branch` when `vars` was last
   * confirmed. Lets a deploy tell a genuinely-new project var (which would be
   * silently dropped) apart from one the user intentionally left unselected,
   * and re-confirm the selection when the project's var set drifts.
   */
  knownVars?: string[];
  /** Free-form adapter-specific options (worker name, build cmd, etc.). */
  options: Record<string, unknown>;
  /**
   * 'direct' — capy commits keep.lock + pushes secrets + ships code now.
   * 'ci'     — capy commits keep.lock on a branch + pushes secrets + opens
   *            a PR. Actual deploy runs in CI on merge.
   * Defaults to 'direct' for back-compat with targets saved before this
   * field existed.
   */
  mode?: DeployMode;
  /**
   * For CI mode only: the git branch the deploy PR opens AGAINST. Typically
   * `main` (production rollout via main-merge) or a long-lived
   * environment branch like `staging`. Persisted per target so the user
   * doesn't re-pick on every deploy. Ignored in 'direct' mode.
   */
  gitBaseBranch?: string;
}

export interface DetectedDefaults {
  /** Pre-filled fields to seed the picker prompts. */
  options?: Record<string, unknown>;
  /** Suggested var names (adapter sniffs config files). */
  suggestedVars?: string[];
  /** One-line summary shown in the picker for transparency. */
  summary?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Human-readable explanation if ok=false; the deploy flow prints this. */
  reason?: string;
  /** Optional fix-it hint shown alongside reason. */
  hint?: string;
}

export interface DeployStep {
  label: string;
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
  /** URL surfaced to the user (deployed worker URL, pages URL). */
  url?: string;
}

export interface DeployResult {
  ok: boolean;
  steps: DeployStep[];
  /**
   * Free-form block printed after the steps — for one-time follow-up the
   * user must do by hand (e.g. aws-ssm's task-definition wiring snippet).
   */
  epilogue?: string;
}

export interface DeployContext {
  /** Decrypted env for the chosen branch. Adapter may filter to config.vars. */
  env: Record<string, string>;
  /**
   * Minted `_CAPY_SECRETS_BLOB` + `_CAPY_DEPLOY_KEY` for build-time secret
   * injection (the pair `capy run` consumes). Present only when the adapter
   * sets `needsDeployToken`; the deploy flow mints it instead of decrypting
   * `env`. `deployKey` is a per-deploy derivation token (DT), never the raw
   * project key (CAP-411) — it decrypts nothing without a revocation-gated
   * round trip to the service at `capy run` time.
   */
  deployToken?: { secretsBlob: string; deployKey: string };
  /** Set by `capy deploy --dry-run`. Adapter must not push anything. */
  dryRun: boolean;
  /**
   * When true, push secrets only — don't ship code. Used by CI mode where
   * the CI pipeline runs the actual deploy after the PR merges.
   */
  secretsOnly?: boolean;
  /** cwd of the user's invocation. */
  cwd: string;
}

export type AdapterVarKind = 'runtime' | 'build-time';

export interface DeployAdapter {
  /** Stable canonical id used in CLI flags and config files. */
  id: string;
  /** Human-readable name shown in pickers. */
  label: string;
  /** Short description shown under label in pickers. */
  description: string;
  /**
   * Which classification bucket this adapter consumes:
   *   - 'runtime'   : non-public secrets the vendor injects at request time
   *                   (cf-worker, vercel server actions, fly secrets).
   *   - 'build-time': VITE_, NEXT_PUBLIC_, PUBLIC_ vars that get baked into
   *                   the public JS bundle at compile time (cf-pages,
   *                   vercel static, netlify).
   * Drives picker copy + defense-in-depth checks (refuse runtime vars in a
   * build-time target, or vice versa, since misclassification = secret
   * leak or bundle-time miss).
   */
  varKind: AdapterVarKind;
  /**
   * Optional override for which vars the picker pre-checks by default (the user
   * can still toggle any). When omitted, the picker uses the varKind bucket
   * (build-time → public-prefixed names, runtime → the rest). Vercel sets this
   * to "all" because its single env store serves BOTH build-time vars (which
   * Vercel inlines into the browser bundle by prefix) and runtime secrets
   * (server-side) — pre-checking only one bucket would silently drop half the
   * app's env.
   */
  presumeVars?(cls: Classification): string[];
  /**
   * Mode the picker pre-selects on first config when there's no saved
   * preference. Adapters whose vendor has turnkey git-CI (Vercel, Netlify,
   * CF Pages with git integration) should set 'ci' — the deploy PR is the
   * deploy signal. Adapters where capy is the deploy actor (cf-worker
   * without GH Actions) should set 'direct'.
   */
  defaultMode: DeployMode;
  /**
   * When true, this adapter ONLY deploys via CI: capy opens the keep.lock PR
   * and the vendor's git integration builds + ships on merge. capy never runs
   * the vendor CLI locally, so there is no 'direct' mode to choose. The picker
   * skips the direct/CI question (forced to 'ci') and `capy deploy` forces
   * mode='ci' regardless of any saved or ad-hoc target mode. Vercel sets this.
   */
  ciOnly?: boolean;
  /**
   * When true, the deploy flow mints a `_CAPY_SECRETS_BLOB` + `_CAPY_DEPLOY_KEY`
   * pair and passes it as `ctx.deployToken` (instead of decrypting individual
   * vars into `ctx.env`). For build-time adapters that inject secrets via
   * `capy run` at build, rather than setting each secret as a plaintext
   * vendor env var.
   */
  needsDeployToken?: boolean;
  /**
   * Hard requirements: binaries that must be on PATH, env vars that must be
   * set (typically only in CI), and an adapter-specific auth check. Any
   * failure here aborts BEFORE decryption.
   */
  requires: {
    binaries: string[];
    env?: string[];
  };
  /** Sniff the user's cwd for config files; pre-fill picker defaults. */
  detect(cwd: string): Promise<DetectedDefaults>;
  /** Validate config + binaries + auth without performing the deploy. */
  preflight(config: TargetConfig, ctx: { cwd: string }): Promise<PreflightResult>;
  /** Push secrets + deploy code. Adapter prints its own progress. */
  deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult>;
}
