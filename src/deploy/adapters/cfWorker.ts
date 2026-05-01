/**
 * Cloudflare Workers adapter.
 *
 * Push runtime secrets via `wrangler secret bulk` (stdin JSON), then
 * `wrangler deploy`. Build-time `VITE_*`/`NEXT_PUBLIC_*` should never reach
 * a Worker — caller must filter via `classify`. Adapter does its own filter
 * as a defense-in-depth, but the picker is the primary boundary.
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

interface CfWorkerOptions {
  /** Worker name (mirrors `name = ...` in wrangler.toml). */
  workerName: string;
  /** Directory containing wrangler.toml. Relative to project root. */
  workerDir: string;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function parseWranglerToml(path: string): { name?: string; account_id?: string } {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  const out: { name?: string; account_id?: string } = {};
  const nameM = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (nameM) out.name = nameM[1];
  const accM = content.match(/^\s*account_id\s*=\s*"([^"]+)"/m);
  if (accM) out.account_id = accM[1];
  return out;
}

/** Walk likely subdirs for a wrangler.toml. Return its containing dir. */
function findWorkerDir(cwd: string): string | null {
  const candidates = [cwd, join(cwd, 'worker'), join(cwd, 'workers'), join(cwd, 'api')];
  for (const c of candidates) {
    if (existsSync(join(c, 'wrangler.toml'))) return c;
  }
  return null;
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

export const cfWorkerAdapter: DeployAdapter = {
  id: 'cf-worker',
  label: 'Cloudflare Workers',
  description: 'Server-side, runtime secrets pushed via wrangler secret bulk',
  varKind: 'runtime',
  requires: { binaries: ['wrangler'] },

  async detect(cwd: string): Promise<DetectedDefaults> {
    const workerDir = findWorkerDir(cwd);
    if (!workerDir) return {};
    const tomlPath = join(workerDir, 'wrangler.toml');
    const parsed = parseWranglerToml(tomlPath);
    const rel = workerDir === cwd ? '.' : workerDir.slice(cwd.length + 1);
    const summary = parsed.name
      ? `worker "${parsed.name}" in ${rel}`
      : `wrangler.toml in ${rel}`;
    return {
      options: {
        workerName: parsed.name,
        workerDir: rel,
      },
      summary,
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
    const opts = config.options as Partial<CfWorkerOptions>;
    if (!opts.workerName || !opts.workerDir) {
      return {
        ok: false,
        reason: 'cf-worker target missing workerName/workerDir',
        hint: 'Run `capy deploy --edit ' + config.name + '` to fix.',
      };
    }
    const workerCwd = join(ctx.cwd, opts.workerDir);
    const tomlPath = join(workerCwd, 'wrangler.toml');
    if (!existsSync(tomlPath)) {
      return {
        ok: false,
        reason: `wrangler.toml not found at ${opts.workerDir}/wrangler.toml`,
      };
    }
    // If the worker has package.json deps, node_modules must exist before we
    // touch secrets. wrangler runs esbuild during deploy; missing deps fail
    // the build AFTER secret bulk has already mutated CF state, leaving a
    // half-deploy. Catch it here.
    const pkgPath = join(workerCwd, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const hasDeps =
          (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
          (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
        if (hasDeps && !existsSync(join(workerCwd, 'node_modules'))) {
          return {
            ok: false,
            reason: `${opts.workerDir}/node_modules missing — wrangler bundle would fail`,
            hint:
              `Install deps first:\n` +
              `  cd ${opts.workerDir} && bun install\n` +
              `(or npm/pnpm install)`,
          };
        }
      } catch {
        // malformed package.json — let wrangler surface the error
      }
    }
    // Auth: wrangler login session OR CLOUDFLARE_API_TOKEN. We don't probe
    // wrangler login state (no clean way) — wrangler itself surfaces a clean
    // error if neither is present, and we propagate it.
    if (config.vars.length === 0) {
      return {
        ok: false,
        reason: 'cf-worker target has no vars to push',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const opts = config.options as unknown as CfWorkerOptions;
    const workerCwd = join(ctx.cwd, opts.workerDir);
    const steps: DeployStep[] = [];

    // 1. Filter env to declared vars only. In dry-run we accept an empty env
    // and just report what *would* be pushed — dry-run skips decryption so
    // no value-presence check is meaningful.
    if (ctx.dryRun) {
      steps.push({
        label: `filter vars`,
        status: 'ok',
        detail: `${config.vars.length} runtime var(s) would push to ${opts.workerName}`,
      });
      steps.push({
        label: 'wrangler secret bulk',
        status: 'skip',
        detail: 'dry-run',
      });
      steps.push({ label: 'wrangler deploy', status: 'skip', detail: 'dry-run' });
      return { ok: true, steps };
    }

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
      label: `filter vars`,
      status: 'ok',
      detail: `${Object.keys(filtered).length} runtime var(s) for ${opts.workerName}`,
    });

    // 2. Push secrets via stdin to `wrangler secret bulk`.
    // Always runs unless dry-run; in `secretsOnly` mode (CI handoff) we push
    // secrets but skip the wrangler deploy below — CI will run the deploy.
    //
    // Pass `--name` so capy's configured workerName is the source of truth.
    // Without it, wrangler reads `name` from wrangler.toml — meaning a user
    // who points capy at a different worker name (e.g. -prod variant) would
    // silently push to the toml's name instead. capy's picker is the
    // authority; toml is the convenience default that detect() seeds from.
    const bulkPayload = JSON.stringify(filtered);
    const bulkR = await spawnAsync(
      'wrangler',
      ['secret', 'bulk', '--name', opts.workerName],
      workerCwd,
      {},
      bulkPayload,
    );
    if (bulkR.code !== 0) {
      steps.push({
        label: 'wrangler secret bulk',
        status: 'fail',
        detail: bulkR.stderr.trim().split('\n').slice(-3).join(' | '),
      });
      return { ok: false, steps };
    }
    steps.push({
      label: 'wrangler secret bulk',
      status: 'ok',
      detail: `${Object.keys(filtered).length} pushed`,
    });

    if (ctx.secretsOnly) {
      steps.push({
        label: 'wrangler deploy',
        status: 'skip',
        detail: 'CI mode — deploy runs on PR merge',
      });
      return { ok: true, steps };
    }

    // 3. Deploy. `--name` overrides wrangler.toml's `name` for the same
    // reason as above — capy's configured workerName wins.
    const deployR = await spawnAsync(
      'wrangler',
      ['deploy', '--name', opts.workerName],
      workerCwd,
    );
    if (deployR.code !== 0) {
      steps.push({
        label: 'wrangler deploy',
        status: 'fail',
        detail: deployR.stderr.trim().split('\n').slice(-3).join(' | '),
      });
      return { ok: false, steps };
    }
    const urlMatch = deployR.stdout.match(
      /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i,
    );
    steps.push({
      label: 'wrangler deploy',
      status: 'ok',
      url: urlMatch?.[0],
    });

    return { ok: true, steps };
  },
};
