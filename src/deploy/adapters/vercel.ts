/**
 * Vercel adapter.
 *
 * Code deploy is CI: `capy deploy` opens the keep.lock PR against the target
 * branch and Vercel's git integration builds + ships on merge. Secret delivery
 * is done HERE, by pushing each var into Vercel's Environment Variables (scoped
 * to the right Vercel environment) via the `vercel env` CLI — so the values are
 * live in Vercel before the build runs, not only inlined from the keep.lock.
 *
 * Target → Vercel environment mapping is explicit, via `options.vercelEnv`:
 *   - 'production' → Vercel `production`
 *   - 'preview'    → Vercel `preview`, scoped to the target's git branch
 *                    (so e.g. the `development` capy branch lands on the
 *                    Preview deployment for git branch `development`).
 */
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  DeployAdapter,
  DeployContext,
  DeployResult,
  DeployStep,
  DetectedDefaults,
  PreflightResult,
  TargetConfig,
} from '../adapter';

type VercelEnv = 'production' | 'preview';

interface VercelOptions {
  /** Directory holding the Vercel app (package.json / .vercel). Relative to root. */
  projectDir: string;
  /** Which Vercel environment these vars target. */
  vercelEnv?: VercelEnv;
}

/**
 * Upsert one env var into Vercel via the CLI. Value goes over stdin (never argv,
 * so it can't leak into the process list). `--force` overwrites an existing
 * value; preview vars are scoped to `gitBranch`.
 */
function setVercelEnv(
  name: string,
  value: string,
  vercelEnv: VercelEnv,
  gitBranch: string | undefined,
  cwd: string,
): { ok: boolean; error?: string } {
  const args = ['env', 'add', name, vercelEnv];
  if (vercelEnv === 'preview' && gitBranch) args.push(gitBranch);
  args.push('--force', '--yes', '--cwd', cwd);
  const r = spawnSync('vercel', args, { input: value, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'vercel env add failed').trim().split('\n').pop() };
  }
  return { ok: true };
}

function readPackageJson(dir: string): any | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Walk likely subdirs for either `.vercel/project.json` or a Next/Vite app. */
function findProjectDir(cwd: string): string | null {
  const candidates = [cwd, join(cwd, 'web'), join(cwd, 'app'), join(cwd, 'frontend'), join(cwd, 'apps/web')];
  // Prefer dirs already linked to Vercel.
  for (const c of candidates) {
    if (existsSync(join(c, '.vercel', 'project.json'))) return c;
  }
  // Fallback: any package.json with a build or deploy script.
  for (const c of candidates) {
    const pkg = readPackageJson(c);
    if (pkg && (pkg.scripts?.build || pkg.scripts?.deploy)) return c;
  }
  return null;
}

export const vercelAdapter: DeployAdapter = {
  id: 'vercel',
  label: 'Vercel',
  description: 'Opens a keep.lock PR; Vercel git CI builds + deploys on merge',
  varKind: 'build-time',
  // CI-only: capy never invokes the vercel CLI. The deploy PR is the deploy
  // signal; Vercel's git integration builds and ships when it merges.
  defaultMode: 'ci',
  ciOnly: true,
  // Inject secrets the capy way: push SECRETS_BLOB + PROJECT_KEY and let the
  // build decrypt them via `capy run` — not individual plaintext vendor vars.
  needsDeployToken: true,
  requires: {
    // Code deploy is CI (the PR), but we push the blob via the vercel CLI.
    binaries: ['vercel'],
    env: [],
  },

  async detect(cwd: string): Promise<DetectedDefaults> {
    const projectDir = findProjectDir(cwd);
    if (!projectDir) return {};
    const pkg = readPackageJson(projectDir);
    const framework = detectFramework(pkg);
    const rel = projectDir === cwd ? '.' : projectDir.slice(cwd.length + 1);
    return {
      options: { projectDir: rel },
      summary: framework ? `${framework} app in ${rel}` : `app in ${rel}`,
    };
  },

  async preflight(config: TargetConfig, ctx: { cwd: string }): Promise<PreflightResult> {
    // CI-only: no vendor checks at all (no vercel binary, project linkage, or
    // login) — the build runs in the user's CI when the deploy PR merges. We
    // only validate that the config is coherent and there's something to ship.
    const opts = config.options as Partial<VercelOptions>;
    if (!opts.projectDir) {
      return {
        ok: false,
        reason: 'vercel target missing projectDir',
        hint: `Run \`capy deploy --edit ${config.name}\` to fix.`,
      };
    }
    const projectDir = join(ctx.cwd, opts.projectDir);
    if (!existsSync(projectDir)) {
      return {
        ok: false,
        reason: `project directory ${opts.projectDir} not found`,
      };
    }
    if (config.vars.length === 0) {
      return {
        ok: false,
        reason: 'vercel target has no vars to push',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    if (opts.vercelEnv !== 'production' && opts.vercelEnv !== 'preview') {
      return {
        ok: false,
        reason: `vercel target missing vercelEnv (got ${JSON.stringify(opts.vercelEnv)})`,
        hint: `Set options.vercelEnv to "production" or "preview" (run \`capy deploy --edit ${config.name}\`).`,
      };
    }
    // Must be linked so the CLI knows which project to target.
    if (!existsSync(join(projectDir, '.vercel', 'project.json'))) {
      return {
        ok: false,
        reason: `${opts.projectDir} is not linked to a Vercel project`,
        hint: 'Run `vercel link` in that directory first.',
      };
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const steps: DeployStep[] = [];
    const opts = config.options as Partial<VercelOptions>;
    const vercelEnv = opts.vercelEnv as VercelEnv;
    const gitBranch = vercelEnv === 'preview' ? config.branch : undefined;
    const projectDir = join(ctx.cwd, opts.projectDir ?? '.');
    const scope = vercelEnv === 'preview' ? `preview · branch=${gitBranch}` : 'production';

    if (ctx.dryRun) {
      steps.push({
        label: 'set Vercel env',
        status: 'skip',
        detail: `dry-run — would set SECRETS_BLOB + PROJECT_KEY on ${scope}, then open the deploy PR`,
      });
      return { ok: true, steps };
    }

    // Push the capy build-time pair so the build can `capy run` to decrypt the
    // secrets — not the plaintext secrets themselves. Scoped to the Vercel env.
    if (!ctx.deployToken) {
      steps.push({
        label: 'set Vercel env',
        status: 'fail',
        detail: 'no deploy token minted (SECRETS_BLOB + PROJECT_KEY unavailable)',
      });
      return { ok: false, steps };
    }
    const pairs: Array<[string, string]> = [
      ['SECRETS_BLOB', ctx.deployToken.secretsBlob],
      ['PROJECT_KEY', ctx.deployToken.projectKey],
    ];
    const failed: string[] = [];
    for (const [name, value] of pairs) {
      const r = setVercelEnv(name, value, vercelEnv, gitBranch, projectDir);
      if (!r.ok) failed.push(`${name} (${r.error})`);
    }

    if (failed.length > 0) {
      steps.push({
        label: 'set Vercel env',
        status: 'fail',
        detail: `${scope}: ${failed.join(', ')}`,
      });
      return { ok: false, steps };
    }
    steps.push({
      label: 'set Vercel env',
      status: 'ok',
      detail: `SECRETS_BLOB + PROJECT_KEY set on ${scope} (build decrypts via capy run)`,
    });
    // Code ships via the keep.lock PR (opened by deployCommand); Vercel's git
    // CI builds on merge and `capy run` injects the secrets from the blob.
    steps.push({
      label: 'vercel build + deploy',
      status: 'skip',
      detail: 'CI mode — Vercel builds and deploys when the deploy PR merges',
    });
    return { ok: true, steps };
  },
};

function detectFramework(pkg: any): string | null {
  if (!pkg?.dependencies && !pkg?.devDependencies) return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps.next) return 'Next.js';
  if (deps.astro) return 'Astro';
  if (deps['@sveltejs/kit']) return 'SvelteKit';
  if (deps.vite) return 'Vite';
  if (deps['react-scripts']) return 'CRA';
  return null;
}
