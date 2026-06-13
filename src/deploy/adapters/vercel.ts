/**
 * Vercel adapter.
 *
 * Code deploy is CI: `capy deploy` opens the keep.lock PR against the target
 * branch and Vercel's git integration builds + ships on merge. Secret delivery
 * is done HERE, by pushing each var as a plaintext Environment Variable into
 * Vercel (scoped to the right Vercel environment) via the `vercel env` CLI —
 * the same shape as cf-worker's `wrangler secret bulk`. The values are live in
 * Vercel's store before the build runs, so the build reads them natively and
 * needs NO `capy run` decrypt step. Vercel's single env store serves both the
 * build (it inlines `NEXT_PUBLIC_*`/`VITE_*` into the browser bundle by prefix)
 * and the server runtime, so a target typically pushes all of the app's vars.
 *
 * Target → Vercel environment mapping is explicit, via `options.vercelEnv`:
 *   - 'production' → Vercel `production`
 *   - 'preview'    → Vercel `preview`, scoped to `options.gitBranch` (the git
 *                    branch that Preview env is wired to). That git branch is
 *                    picked explicitly at setup and need NOT match the capy
 *                    branch name or the branch you're checked out on — e.g.
 *                    sitting on git `main` with capy branch `development`, you
 *                    can still push to the Preview env for git `development`.
 *                    Falls back to `config.branch` for targets saved before
 *                    `options.gitBranch` existed.
 */
import { existsSync, readFileSync } from 'fs';
import { spawnSync, spawn } from 'child_process';
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
  /**
   * For `vercelEnv: 'preview'` only — the GIT branch the Vercel Preview env is
   * wired to (what `vercel env add … preview <gitBranch>` scopes the value to).
   * This is a git branch Vercel knows about, NOT necessarily the capy branch
   * name. Defaults to `config.branch` when unset for back-compat with targets
   * saved before this field existed.
   */
  gitBranch?: string;
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

/**
 * Runs `vercel link` interactively so the user can pick scope + project. We
 * inherit stdio (vercel's scope/project pickers use arrow-key lists and
 * require a raw TTY on stdin — we can't both inject keystrokes AND let the
 * user navigate without a PTY). To honor the "decline env-var download"
 * intent, we print a clear instruction immediately before launching so the
 * answer is unambiguous: capy manages those vars, downloading them would
 * mix sources of truth.
 */
async function runVercelLink(projectDir: string): Promise<boolean> {
  // ANSI: 33 = yellow, 90 = grey, 0 = reset.
  process.stdout.write(
    '\n\x1b[33m▸ Project not linked to Vercel. Running `vercel link`…\x1b[0m\n',
  );
  process.stdout.write(
    '\x1b[90m  When asked "Download Environment Variables?", answer N.\x1b[0m\n',
  );
  process.stdout.write(
    '\x1b[90m  capy manages those — pulling them would mix sources.\x1b[0m\n\n',
  );
  return new Promise((resolve) => {
    const child = spawn('vercel', ['link'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export const vercelAdapter: DeployAdapter = {
  id: 'vercel',
  label: 'Vercel',
  description: 'Pushes plaintext env vars; opens a keep.lock PR Vercel CI deploys on merge',
  // Vercel's env store is consumed at both build and runtime, so we treat it
  // as runtime ("push to Vercel") for picker copy, but pre-select ALL vars via
  // presumeVars below — public-prefixed ones still get inlined by Vercel itself.
  varKind: 'runtime',
  // CI-only for CODE: capy never runs `vercel deploy`. The deploy PR is the
  // deploy signal; Vercel's git integration builds and ships when it merges.
  // (We do use the `vercel` CLI here, but only to set env vars, not to deploy.)
  defaultMode: 'ci',
  ciOnly: true,
  // Pre-check every var: Vercel's single env store holds both build-time public
  // vars (Vercel inlines them into the bundle by prefix) and runtime secrets.
  presumeVars: (cls) => [...cls.buildTime, ...cls.runtime].sort(),
  requires: {
    // Code deploy is CI (the PR), but we push the env vars via the vercel CLI.
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
    // Linkage: either .vercel/project.json exists OR VERCEL_PROJECT_ID +
    // VERCEL_ORG_ID are in env (CI). Either is sufficient. If neither holds
    // AND we're sitting at an interactive TTY, auto-run `vercel link` so the
    // user doesn't have to break flow. In CI/non-TTY we keep the original
    // hard fail with the install hint.
    let linked = readVercelProjectId(projectDir);
    const hasEnvIds =
      !!process.env.VERCEL_PROJECT_ID && !!process.env.VERCEL_ORG_ID;
    if (!linked.projectId && !hasEnvIds) {
      const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
      if (!interactive) {
        return {
          ok: false,
          reason: `${opts.projectDir} is not linked to a Vercel project`,
          hint:
            `Link the project once:\n` +
            `  cd ${opts.projectDir} && vercel link\n` +
            `Or in CI, set VERCEL_PROJECT_ID + VERCEL_ORG_ID + VERCEL_TOKEN.`,
        };
      }
      const linkOk = await runVercelLink(projectDir);
      if (!linkOk) {
        return {
          ok: false,
          reason: 'vercel link did not complete',
          hint: `Re-run, or link manually: cd ${opts.projectDir} && vercel link`,
        };
      }
      linked = readVercelProjectId(projectDir);
      if (!linked.projectId) {
        return {
          ok: false,
          reason: `${opts.projectDir} is still not linked after vercel link`,
          hint: `Try again: cd ${opts.projectDir} && vercel link`,
        };
      }
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const steps: DeployStep[] = [];
    const opts = config.options as Partial<VercelOptions>;
    const vercelEnv = opts.vercelEnv as VercelEnv;
    // Preview scope = the git branch the Preview env is wired to. Prefer the
    // explicit per-target option; fall back to the capy branch name for
    // targets saved before gitBranch existed.
    const gitBranch =
      vercelEnv === 'preview' ? (opts.gitBranch ?? config.branch) : undefined;
    const projectDir = join(ctx.cwd, opts.projectDir ?? '.');
    const scope = vercelEnv === 'preview' ? `preview · branch=${gitBranch}` : 'production';

    if (ctx.dryRun) {
      steps.push({
        label: 'set Vercel env',
        status: 'skip',
        detail: `dry-run — would push ${config.vars.length} var(s) to ${scope}, then open the deploy PR`,
      });
      return { ok: true, steps };
    }

    // Push each declared var as a plaintext Vercel Environment Variable, scoped
    // to the chosen Vercel env. Filter the decrypted branch env to the declared
    // names; fail loudly if any are missing rather than pushing a partial set.
    const filtered: Array<[string, string]> = [];
    const missing: string[] = [];
    for (const name of config.vars) {
      if (name in ctx.env) filtered.push([name, ctx.env[name]]);
      else missing.push(name);
    }
    if (missing.length > 0) {
      steps.push({
        label: 'set Vercel env',
        status: 'fail',
        detail: `missing in branch ${config.branch}: ${missing.join(', ')}`,
      });
      return { ok: false, steps };
    }

    const failed: string[] = [];
    for (const [name, value] of filtered) {
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
      detail: `${filtered.length} var(s) pushed to ${scope}`,
    });
    // Code ships via the keep.lock PR (opened by deployCommand); Vercel's git
    // CI builds on merge and reads these env vars natively — no `capy run`.
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
