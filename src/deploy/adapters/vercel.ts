/**
 * Vercel adapter — CI-only.
 *
 * Vercel has turnkey git CI: connect the repo once and every push to a tracked
 * branch builds and deploys automatically. capy leans entirely on that and
 * never runs the vercel CLI locally — no `vercel build`, no `vercel deploy`,
 * no `vercel link`. A Vercel deploy is just the keep.lock PR that `capy deploy`
 * opens against the target branch: merging it is the deploy signal, and
 * Vercel's git integration runs the build with the secrets snapshot pinned by
 * that keep.lock.
 *
 * Build-time secret delivery (NEXT_PUBLIC_, VITE_, server-component
 * process.env reads) is the dominant Vercel pattern, so this adapter is
 * classified 'build-time': the picker pre-selects public-prefixed vars and
 * they get inlined by the build that runs in the user's CI on merge.
 */
import { existsSync, readFileSync } from 'fs';
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

interface VercelOptions {
  /** Directory holding the Vercel app (package.json / .vercel). Relative to root. */
  projectDir: string;
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
  requires: {
    // No local vendor toolchain — the build runs in the user's CI on merge.
    binaries: [],
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
        reason: 'vercel target has no vars to inline',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    // Vercel is CI-only — capy never runs the vercel CLI. The actual deploy is
    // the keep.lock PR opened by `capy deploy` (see deployCommand); Vercel
    // builds and ships when that PR merges. There is no vendor-side work here.
    const steps: DeployStep[] = [];
    if (ctx.dryRun) {
      steps.push({
        label: 'open deploy PR',
        status: 'skip',
        detail: `dry-run — would pin ${config.vars.length} build-time var(s) via keep.lock and open a PR; Vercel deploys on merge`,
      });
      return { ok: true, steps };
    }
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
