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
 *   - 'preview'    → Vercel `preview`, scoped to `options.gitBranch` (the git
 *                    branch that Preview env is wired to). That git branch is
 *                    picked explicitly at setup and need NOT match the capy
 *                    branch name or the branch you're checked out on — e.g.
 *                    sitting on git `main` with capy branch `development`, you
 *                    can still push to the Preview env for git `development`.
 *                    Required for preview targets — deployCommand heals
 *                    targets saved before `options.gitBranch` existed by
 *                    prompting once and persisting.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { spawnSync, spawn } from 'child_process';
import { homedir } from 'os';
import { basename, join } from 'path';
import inquirer from 'inquirer';
import { LIST_THEME } from '../../ui/promptStyle';
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
   * This is a git branch Vercel knows about, NOT a capy branch name. Required:
   * preflight rejects preview targets without it, and deployCommand prompts to
   * backfill targets saved before this field existed.
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
    return { ok: false, error: extractVercelError(r.stderr, r.stdout) };
  }
  return { ok: true };
}

/**
 * Pull the meaningful line out of vercel CLI output. The last line is often
 * noise — e.g. the bottom border of the "Update available!" box — so prefer
 * an explicit Error line, then fall back to the last line that isn't box
 * drawing or blank.
 */
function extractVercelError(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[╭╰│─╮╯\s]+$/.test(l));
  const errLine = lines.find((l) => /error/i.test(l));
  return errLine ?? lines.pop() ?? 'vercel env add failed';
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

// ── Link by project picker ──────────────────────────────────────────────────
// Instead of handing the user off to `vercel link`'s own wizard, ask which
// Vercel project this is and write `.vercel/project.json` ourselves — that
// file is the entirety of what `vercel link` produces. Project lists come from
// the Vercel REST API using the login token the `vercel` CLI already saved.

/**
 * The CLI's login token: VERCEL_TOKEN env first, then auth.json from the
 * CLI's data dirs (current platform-native location, then the legacy
 * ~/.vercel one). Null when the user has never run `vercel login`.
 */
function readVercelCliToken(): string | null {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const home = homedir();
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const candidates = [
    join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    join(xdgData, 'com.vercel.cli', 'auth.json'),
    join(home, '.vercel', 'auth.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof raw.token === 'string' && raw.token) return raw.token;
    } catch {
      // unreadable — try the next location
    }
  }
  return null;
}

async function vercelApi(token: string, path: string): Promise<any> {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${path.split('?')[0]} → HTTP ${res.status}`);
  }
  return res.json();
}

interface PickableProject {
  projectId: string;
  projectName: string;
  /** Personal account uid or team id — what project.json calls orgId. */
  orgId: string;
  scopeLabel: string;
}

/** Every project visible to the token, across the personal scope and all teams. */
async function listAllVercelProjects(token: string): Promise<PickableProject[]> {
  const [userRes, teamsRes] = await Promise.all([
    vercelApi(token, '/v2/user'),
    vercelApi(token, '/v2/teams?limit=100'),
  ]);
  const user = userRes.user ?? userRes;
  const personalId: string = user.uid ?? user.id;
  const teams: Array<{ id: string; slug?: string; name?: string }> =
    teamsRes.teams ?? [];

  const scopes = [
    { orgId: personalId, teamId: undefined as string | undefined, label: user.username ?? 'personal' },
    ...teams.map((t) => ({ orgId: t.id, teamId: t.id, label: t.slug ?? t.name ?? t.id })),
  ];
  const perScope = await Promise.all(
    scopes.map(async (s) => {
      const q = s.teamId ? `?limit=100&teamId=${s.teamId}` : '?limit=100';
      const res = await vercelApi(token, `/v9/projects${q}`);
      const projects: Array<{ id: string; name: string }> = res.projects ?? [];
      return projects.map((p) => ({
        projectId: p.id,
        projectName: p.name,
        orgId: s.orgId,
        scopeLabel: s.label,
      }));
    }),
  );
  return perScope.flat();
}

/** What `vercel link` leaves behind: project.json + a .gitignore entry. */
function writeVercelLink(projectDir: string, p: PickableProject): void {
  const dir = join(projectDir, '.vercel');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      { projectId: p.projectId, orgId: p.orgId, projectName: p.projectName },
      null,
      2,
    ) + '\n',
  );
  const gi = join(projectDir, '.gitignore');
  if (existsSync(gi)) {
    const lines = readFileSync(gi, 'utf-8').split('\n');
    if (!lines.some((l) => l.trim() === '.vercel' || l.trim() === '.vercel/')) {
      appendFileSync(gi, '\n.vercel\n');
    }
  }
}

/**
 * Ask which Vercel project this is and link it. Returns false (so the caller
 * can fall back to interactive `vercel link`) when there's no saved login
 * token, the API calls fail, or the user picks "none of these".
 */
async function linkByProjectPicker(projectDir: string): Promise<boolean> {
  const token = readVercelCliToken();
  if (!token) return false;

  let projects: PickableProject[];
  try {
    projects = await listAllVercelProjects(token);
  } catch (e) {
    process.stdout.write(
      `\x1b[90m  could not list Vercel projects (${e instanceof Error ? e.message : e})\x1b[0m\n`,
    );
    return false;
  }
  if (projects.length === 0) return false;

  // Best guess first: a project named like the directory it lives in.
  const dirName = basename(projectDir);
  projects.sort((a, b) => {
    const aMatch = a.projectName === dirName;
    const bMatch = b.projectName === dirName;
    if (aMatch !== bMatch) return aMatch ? -1 : 1;
    return a.projectName.localeCompare(b.projectName);
  });

  process.stdout.write(
    '\n\x1b[33m▸ This directory is not linked to a Vercel project yet.\x1b[0m\n',
  );
  const ans: { picked: PickableProject | null } = (await inquirer.prompt([
    {
      type: 'list',
      name: 'picked',
      message: 'Which Vercel project is this?',
      theme: LIST_THEME,
      choices: [
        ...projects.map((p) => ({
          name: `${p.scopeLabel}/${p.projectName}`,
          value: p,
        })),
        { name: 'None of these — run `vercel link` instead', value: null },
      ],
    } as any,
  ])) as any;
  if (!ans.picked) return false;

  writeVercelLink(projectDir, ans.picked);
  process.stdout.write(
    `\x1b[32m✓\x1b[0m linked ${ans.picked.scopeLabel}/${ans.picked.projectName} ` +
      `\x1b[90m(.vercel/project.json)\x1b[0m\n`,
  );
  return true;
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
    if (opts.vercelEnv === 'preview' && !opts.gitBranch) {
      return {
        ok: false,
        reason: 'vercel preview target missing options.gitBranch',
        hint:
          `Preview env vars are scoped to a GIT branch Vercel knows about ` +
          `(not a capy branch). Run \`capy deploy --edit ${config.name}\` to pick one.`,
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
      // Preferred: list the user's Vercel projects and ask which one this
      // is, writing .vercel/project.json directly. Fall back to vercel
      // link's own wizard when there's no saved token, the API fails, or
      // the user picks "none of these".
      const linkOk =
        (await linkByProjectPicker(projectDir)) ||
        (await runVercelLink(projectDir));
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
    // Preview scope = the git branch the Preview env is wired to. Always the
    // explicit per-target option — preflight rejects preview targets without
    // it, because the old fallback (the capy branch name) is not a git branch
    // and made `vercel env add` fail with "Branch not found".
    const gitBranch = vercelEnv === 'preview' ? opts.gitBranch : undefined;
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
