/**
 * Vercel adapter.
 *
 * Wraps the vercel CLI. Build-time secret delivery (NEXT_PUBLIC_, VITE_,
 * server-component process.env reads) is the dominant pattern; capy
 * injects vars into the env during `vercel build`, then `vercel deploy
 * --prebuilt` uploads the resulting build.
 *
 * Project linkage comes from `.vercel/project.json` (created by
 * `vercel link` once). Capy doesn't need to know project IDs explicitly
 * unless the user is running in CI without a checked-in `.vercel/`, in
 * which case VERCEL_PROJECT_ID + VERCEL_ORG_ID env vars do the same job.
 *
 * In CI mode (secretsOnly = true) the adapter is a no-op vendor-side, the
 * same as cf-pages: there's no separate runtime-secret push for Vercel
 * build-time inlining; the build runs in the user's CI when the deploy PR
 * merges.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  DeployAdapter,
  DeployContext,
  DeployResult,
  DeployStep,
  DetectedDefaults,
  PreflightResult,
  TargetConfig,
} from '../adapter';

export type VercelEnv = 'production' | 'preview';

interface VercelOptions {
  /** Directory the vercel CLI runs in. Holds .vercel/project.json. */
  projectDir: string;
  /**
   * Which Vercel deployment lane this target ships to.
   *   - 'production' → `vercel deploy --prod`. The prod alias updates.
   *   - 'preview'    → `vercel deploy` (default). Each push gets a unique
   *                    URL; can be associated with a git branch so Vercel's
   *                    branch-aware UI groups the deployments.
   * A common pattern is one capy target per env: `vercel-production`
   * (capy branch=production, vercelEnv=production), `vercel-staging`
   * (capy branch=staging, vercelEnv=preview, gitBranch=staging), etc.
   */
  vercelEnv: VercelEnv;
  /**
   * For preview deploys: associates the deployment with a git branch so
   * Vercel groups it under that branch's preview chain. Optional. Ignored
   * for production. Pass `--git-branch=<name>` to vercel deploy.
   */
  gitBranch?: string;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
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
  // Fallback: any package.json with a deploy or build script.
  for (const c of candidates) {
    const pkg = readPackageJson(c);
    if (pkg && (pkg.scripts?.build || pkg.scripts?.deploy)) return c;
  }
  return null;
}

function readVercelProjectId(dir: string): { projectId?: string; orgId?: string } {
  const p = join(dir, '.vercel', 'project.json');
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return { projectId: raw.projectId, orgId: raw.orgId };
  } catch {
    return {};
  }
}

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? 1 }),
    );
  });
}

export const vercelAdapter: DeployAdapter = {
  id: 'vercel',
  label: 'Vercel',
  description: 'Wraps the vercel CLI: vercel build with capy env + vercel deploy --prebuilt',
  varKind: 'build-time',
  // Vercel has turnkey git CI: connect the repo once, every push auto-
  // deploys. The natural capy flow is `ci` mode — capy commits keep.lock
  // to a branch and opens the deploy PR; Vercel's git integration picks
  // up the merge and runs the build itself. `direct` mode (capy builds
  // and uploads via `vercel deploy --prebuilt`) is the exception, useful
  // when the repo isn't connected to a Vercel git integration.
  defaultMode: 'ci',
  requires: {
    binaries: ['vercel'],
    // VERCEL_TOKEN is only required in CI. Local runs use `vercel login`.
    // Preflight checks one or the other, not strictly both.
    env: [],
  },

  async detect(cwd: string): Promise<DetectedDefaults> {
    const projectDir = findProjectDir(cwd);
    if (!projectDir) return {};
    const linked = readVercelProjectId(projectDir);
    const pkg = readPackageJson(projectDir);
    const framework = detectFramework(pkg);
    const rel = projectDir === cwd ? '.' : projectDir.slice(cwd.length + 1);
    const linkedSummary = linked.projectId
      ? `linked to project ${linked.projectId.slice(0, 12)}…`
      : 'NOT linked — run `vercel link` once before deploying';
    return {
      options: {
        projectDir: rel,
        vercelEnv: 'preview',
      },
      summary: framework
        ? `${framework} app in ${rel} (${linkedSummary})`
        : `app in ${rel} (${linkedSummary})`,
    };
  },

  async preflight(config: TargetConfig, ctx: { cwd: string }): Promise<PreflightResult> {
    // Order: config first, filesystem next, vendor checks last (binary,
    // linkage, auth). Lets unit tests for config errors run without the
    // vercel CLI installed.
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
    // node_modules check, same logic as cfPages.
    const pkg = readPackageJson(projectDir);
    if (pkg) {
      const hasDeps =
        (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
        (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
      if (hasDeps && !existsSync(join(projectDir, 'node_modules'))) {
        return {
          ok: false,
          reason: `${opts.projectDir}/node_modules missing — vercel build would fail`,
          hint:
            `Install deps first:\n` +
            `  cd ${opts.projectDir} && bun install\n` +
            `(or npm/pnpm install)`,
        };
      }
    }
    if (config.vars.length === 0) {
      return {
        ok: false,
        reason: 'vercel target has no vars to inline',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    // Vendor checks last so config-error tests don't depend on vercel
    // being installed.
    if (!which('vercel')) {
      return {
        ok: false,
        reason: 'vercel not found on PATH',
        hint:
          'Install the Vercel CLI:\n' +
          '  bun add -g vercel        (recommended)\n' +
          '  npm i -g vercel          (alternative)\n' +
          'Re-run `capy deploy` after install.',
      };
    }
    // Linkage: either .vercel/project.json exists OR VERCEL_PROJECT_ID +
    // VERCEL_ORG_ID are in env (CI). Either is sufficient.
    const linked = readVercelProjectId(projectDir);
    const hasEnvIds =
      !!process.env.VERCEL_PROJECT_ID && !!process.env.VERCEL_ORG_ID;
    if (!linked.projectId && !hasEnvIds) {
      return {
        ok: false,
        reason: `${opts.projectDir} is not linked to a Vercel project`,
        hint:
          `Link the project once:\n` +
          `  cd ${opts.projectDir} && vercel link\n` +
          `Or in CI, set VERCEL_PROJECT_ID + VERCEL_ORG_ID + VERCEL_TOKEN.`,
      };
    }
    // Auth: either VERCEL_TOKEN env (CI) or `vercel whoami` works (local).
    if (!process.env.VERCEL_TOKEN) {
      const who = spawnSync('vercel', ['whoami'], {
        cwd: projectDir,
        encoding: 'utf-8',
      });
      if (who.status !== 0) {
        return {
          ok: false,
          reason: 'not authenticated with Vercel',
          hint:
            'One of:\n' +
            '  vercel login                       (local dev)\n' +
            '  set VERCEL_TOKEN=<token>           (CI)\n' +
            'Tokens: Vercel dashboard → Settings → Tokens.',
        };
      }
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const opts = config.options as unknown as VercelOptions;
    const projectDir = join(ctx.cwd, opts.projectDir);
    const steps: DeployStep[] = [];

    if (ctx.dryRun) {
      const lane =
        opts.vercelEnv === 'production'
          ? '--prod'
          : opts.gitBranch
            ? `preview, --git-branch=${opts.gitBranch}`
            : 'preview';
      steps.push({
        label: 'inject build env',
        status: 'ok',
        detail: `${config.vars.length} build-time var(s) would inline`,
      });
      steps.push({ label: 'vercel build', status: 'skip', detail: 'dry-run' });
      steps.push({
        label: 'vercel deploy',
        status: 'skip',
        detail: `dry-run (${lane})`,
      });
      return { ok: true, steps };
    }

    // CI mode: no vendor-side step. Build+deploy run in the user's CI when
    // the deploy PR merges. capy only commits keep.lock here.
    if (ctx.secretsOnly) {
      steps.push({
        label: 'vercel build + deploy',
        status: 'skip',
        detail: 'CI mode — both run in CI when the deploy PR merges',
      });
      return { ok: true, steps };
    }

    // Filter env to declared vars.
    const filtered: Record<string, string> = {};
    for (const name of config.vars) {
      if (name in ctx.env) filtered[name] = ctx.env[name];
    }
    const missing = config.vars.filter((v) => !(v in ctx.env));
    if (missing.length > 0) {
      steps.push({
        label: `filter vars (${config.vars.length} declared)`,
        status: 'fail',
        detail: `missing in branch ${config.branch}: ${missing.join(', ')}`,
      });
      return { ok: false, steps };
    }
    steps.push({
      label: 'filter vars',
      status: 'ok',
      detail: `${Object.keys(filtered).length} build-time var(s)`,
    });

    // Build env: capy vars + (passthrough) VERCEL_TOKEN/PROJECT/ORG. The
    // vercel CLI reads process.env directly — no extra plumbing needed.
    const buildEnv = { ...filtered };
    const isProd = opts.vercelEnv === 'production';
    const buildArgs = ['build'];
    if (isProd) buildArgs.push('--prod');
    const tokenArg: string[] = process.env.VERCEL_TOKEN
      ? ['--token', process.env.VERCEL_TOKEN]
      : [];
    const buildR = await spawnAsync(
      'vercel',
      [...buildArgs, ...tokenArg],
      projectDir,
      buildEnv,
    );
    if (buildR.code !== 0) {
      const tail = buildR.stderr.trim().split('\n').slice(-3).join(' | ');
      const notLinked = /Project not found|not linked/i.test(buildR.stderr);
      steps.push({
        label: 'vercel build',
        status: 'fail',
        detail: notLinked
          ? `Project not linked. Run:\n      cd ${opts.projectDir} && vercel link`
          : tail,
      });
      return { ok: false, steps };
    }
    steps.push({
      label: 'vercel build',
      status: 'ok',
      detail: isProd ? 'production build' : 'preview build',
    });

    // Deploy. --prebuilt skips the remote build (we just built locally).
    // For previews, --git-branch tags the deployment under the named branch
    // in Vercel's branch-aware UI so it groups with prior deploys for that
    // branch (matches capy's natural mapping: capy branch ↔ git branch ↔
    // vercel preview lane).
    const deployArgs = ['deploy', '--prebuilt', '--yes'];
    if (isProd) {
      deployArgs.push('--prod');
    } else if (opts.gitBranch) {
      deployArgs.push('--git-branch', opts.gitBranch);
    }
    const deployR = await spawnAsync(
      'vercel',
      [...deployArgs, ...tokenArg],
      projectDir,
      buildEnv,
    );
    if (deployR.code !== 0) {
      steps.push({
        label: 'vercel deploy',
        status: 'fail',
        detail: deployR.stderr.trim().split('\n').slice(-3).join(' | '),
      });
      return { ok: false, steps };
    }
    const urlMatch = deployR.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i);
    steps.push({
      label: 'vercel deploy',
      status: 'ok',
      url: urlMatch?.[0],
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
