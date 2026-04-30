/**
 * Cloudflare Pages adapter.
 *
 * Pages is build-time-inlined: VITE_, NEXT_PUBLIC_, PUBLIC_ values get
 * baked into the public JS bundle by the build step. So the adapter:
 *   1. Filters env to declared (build-time) vars
 *   2. Runs the build command with those vars in process.env
 *   3. Uploads the dist directory via `wrangler pages deploy`
 *
 * In CI mode (secretsOnly = true) the adapter is a no-op vendor-side:
 * the build runs in the user's CI when the deploy PR merges. capy only
 * needs to ship the keep.lock pin via the PR.
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

interface CfPagesOptions {
  /** Pages project name (matches `wrangler pages project list`). */
  projectName: string;
  /** Directory the build runs in. Relative to project root. */
  buildCwd: string;
  /** Build command, e.g. `bun run build` or `vite build` or `next build`. */
  buildCmd: string;
  /** Output dir produced by the build, relative to buildCwd. e.g. 'dist'. */
  distDir: string;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Parse package.json for hints — deploy script, build script. */
function readPackageJson(dir: string): any | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function findBuildDir(cwd: string): string | null {
  const candidates = [join(cwd, 'web'), cwd, join(cwd, 'app'), join(cwd, 'frontend')];
  for (const c of candidates) {
    const pkg = readPackageJson(c);
    if (pkg && (pkg.scripts?.build || pkg.scripts?.deploy)) return c;
  }
  return null;
}

/**
 * Sniff a `wrangler pages deploy <dist> --project-name=<n>` invocation out
 * of `package.json` scripts. Returns project name + dist dir if found.
 */
function parsePagesDeployScript(
  pkg: any,
): { projectName?: string; distDir?: string } {
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  for (const cmd of Object.values(scripts)) {
    const projM = cmd.match(/--project-name[=\s]+([A-Za-z0-9_.-]+)/);
    const distM = cmd.match(/wrangler\s+pages\s+deploy\s+([A-Za-z0-9_./-]+)/);
    if (projM || distM) {
      return { projectName: projM?.[1], distDir: distM?.[1] };
    }
  }
  return {};
}

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  stdin?: string,
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
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export const cfPagesAdapter: DeployAdapter = {
  id: 'cf-pages',
  label: 'Cloudflare Pages',
  description: 'Static site build-inlined VITE_*/NEXT_PUBLIC_*, deployed via wrangler pages deploy',
  varKind: 'build-time',
  requires: { binaries: ['wrangler'] },

  async detect(cwd: string): Promise<DetectedDefaults> {
    const buildCwd = findBuildDir(cwd);
    if (!buildCwd) return {};
    const pkg = readPackageJson(buildCwd);
    const parsed = parsePagesDeployScript(pkg);
    // Default to `bun run build` whenever a build script exists. Running via
    // `bun run` (vs spawning `vite build` directly) lets bun set PATH so
    // locally-installed binaries resolve. capy's own spawn doesn't run a
    // shell or look in node_modules/.bin, so a bare `vite` would ENOENT.
    const buildCmd = 'bun run build';
    // Default dist dir: 'dist' for Vite/Astro/Rollup, '.next' (or 'out')
    // for Next, 'build' for CRA. Pull from script if we can.
    const distDir = parsed.distDir ?? 'dist';
    const rel = buildCwd === cwd ? '.' : buildCwd.slice(cwd.length + 1);
    return {
      options: {
        projectName: parsed.projectName,
        buildCwd: rel,
        buildCmd,
        distDir,
      },
      summary: parsed.projectName
        ? `pages project "${parsed.projectName}" in ${rel} (build: ${buildCmd})`
        : `build dir ${rel} (build: ${buildCmd})`,
    };
  },

  async preflight(config: TargetConfig, ctx: { cwd: string }): Promise<PreflightResult> {
    if (!which('wrangler')) {
      return {
        ok: false,
        reason: 'wrangler not found on PATH',
        hint:
          'Install wrangler:\n' +
          '  bun add -d wrangler        (project-local, recommended)\n' +
          '  npm i -g wrangler          (global)\n' +
          'Re-run `capy deploy` after install.',
      };
    }
    const opts = config.options as Partial<CfPagesOptions>;
    if (!opts.projectName || !opts.buildCwd || !opts.buildCmd || !opts.distDir) {
      return {
        ok: false,
        reason: 'cf-pages target missing projectName/buildCwd/buildCmd/distDir',
        hint: `Run \`capy deploy --edit ${config.name}\` to fix.`,
      };
    }
    const buildCwd = join(ctx.cwd, opts.buildCwd);
    if (!existsSync(buildCwd)) {
      return {
        ok: false,
        reason: `build directory ${opts.buildCwd} not found`,
      };
    }
    // node_modules check — same logic as cfWorker. The build will fail mid-
    // flight without deps; catch it before any decryption.
    const pkg = readPackageJson(buildCwd);
    if (pkg) {
      const hasDeps =
        (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
        (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
      if (hasDeps && !existsSync(join(buildCwd, 'node_modules'))) {
        return {
          ok: false,
          reason: `${opts.buildCwd}/node_modules missing — build would fail`,
          hint:
            `Install deps first:\n` +
            `  cd ${opts.buildCwd} && bun install\n` +
            `(or npm/pnpm install)`,
        };
      }
    }
    if (config.vars.length === 0) {
      return {
        ok: false,
        reason: 'cf-pages target has no vars to inline',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const opts = config.options as unknown as CfPagesOptions;
    const buildCwd = join(ctx.cwd, opts.buildCwd);
    const steps: DeployStep[] = [];

    if (ctx.dryRun) {
      steps.push({
        label: 'inject build env',
        status: 'ok',
        detail: `${config.vars.length} build-time var(s) would inline into ${opts.projectName}`,
      });
      steps.push({
        label: opts.buildCmd,
        status: 'skip',
        detail: 'dry-run',
      });
      steps.push({
        label: 'wrangler pages deploy',
        status: 'skip',
        detail: 'dry-run',
      });
      return { ok: true, steps };
    }

    // CI mode: no vendor-side step. Pages build runs in CI on PR merge.
    if (ctx.secretsOnly) {
      steps.push({
        label: 'pages build + deploy',
        status: 'skip',
        detail: 'CI mode — both run in CI when the deploy PR merges',
      });
      return { ok: true, steps };
    }

    // Filter env to declared vars. Missing values are a fatal config drift.
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
      detail: `${Object.keys(filtered).length} build-time var(s) for ${opts.projectName}`,
    });

    // Run the build with capy-injected env. Two fix-ups so a bare
    // `vite` / `next` / `astro` resolves the way `bun run` / `npm run`
    // would:
    //   1. Prepend node_modules/.bin to PATH (handles child processes the
    //      build itself spawns).
    //   2. Resolve the command's first token to an absolute path when a
    //      matching bin exists. Node's spawn doesn't re-search PATH from
    //      env on macOS/Linux for the immediate child, so `vite` would
    //      ENOENT even with PATH set above.
    const localBin = join(buildCwd, 'node_modules', '.bin');
    const buildEnv = {
      ...filtered,
      PATH: `${localBin}:${process.env.PATH ?? ''}`,
    };
    const buildArgs = opts.buildCmd.trim().split(/\s+/);
    let cmd = buildArgs[0];
    if (!cmd.includes('/')) {
      const localCmd = join(localBin, cmd);
      if (existsSync(localCmd)) cmd = localCmd;
    }
    const buildR = await spawnAsync(cmd, buildArgs.slice(1), buildCwd, buildEnv);
    if (buildR.code !== 0) {
      steps.push({
        label: opts.buildCmd,
        status: 'fail',
        detail: buildR.stderr.trim().split('\n').slice(-3).join(' | '),
      });
      return { ok: false, steps };
    }
    steps.push({
      label: opts.buildCmd,
      status: 'ok',
      detail: `built to ${opts.distDir}`,
    });

    const distAbs = join(buildCwd, opts.distDir);
    if (!existsSync(distAbs)) {
      steps.push({
        label: 'wrangler pages deploy',
        status: 'fail',
        detail: `expected dist at ${distAbs} after build, not found`,
      });
      return { ok: false, steps };
    }

    // Upload via wrangler pages deploy. Run from project root so Pages
    // metadata (.wrangler/) lives next to the rest of capy state.
    const deployR = await spawnAsync(
      'wrangler',
      ['pages', 'deploy', distAbs, `--project-name=${opts.projectName}`, '--commit-dirty=true'],
      ctx.cwd,
    );
    if (deployR.code !== 0) {
      const tail = deployR.stderr.trim().split('\n').slice(-3).join(' | ');
      const projectMissing =
        /Project not found|does not match any of your existing projects/i.test(deployR.stderr);
      steps.push({
        label: 'wrangler pages deploy',
        status: 'fail',
        detail: projectMissing
          ? `Pages project "${opts.projectName}" doesn't exist. Create it once:\n` +
            `      wrangler pages project create ${opts.projectName} --production-branch=main\n` +
            `      then re-run capy deploy.`
          : tail,
      });
      return { ok: false, steps };
    }
    const urlMatch = deployR.stdout.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
    steps.push({
      label: 'wrangler pages deploy',
      status: 'ok',
      url: urlMatch?.[0],
    });

    return { ok: true, steps };
  },
};
