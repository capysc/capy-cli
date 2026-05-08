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
}

export interface DeployContext {
  /** Decrypted env for the chosen branch. Adapter may filter to config.vars. */
  env: Record<string, string>;
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
   * Mode the picker pre-selects on first config when there's no saved
   * preference. Adapters whose vendor has turnkey git-CI (Vercel, Netlify,
   * CF Pages with git integration) should set 'ci' — the deploy PR is the
   * deploy signal. Adapters where capy is the deploy actor (cf-worker
   * without GH Actions) should set 'direct'.
   */
  defaultMode: DeployMode;
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
