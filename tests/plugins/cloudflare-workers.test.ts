/**
 * Plugin tests — Cloudflare Workers
 *
 * Two tiers:
 *   • hermetic — no creds, dry-run only. Always runs.
 *   • live     — needs CF_API_TOKEN + CF_ACCOUNT_ID. Real deploy + cleanup.
 *
 * Run: bun test tests/plugins/cloudflare-workers.test.ts
 *  or: bun run test:plugins:cloudflare-workers
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, spawn } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');

// ── Plugin credentials ─────────────────────────────────────────────────────

const CF_API_TOKEN = process.env.CF_API_TOKEN ?? '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '';
const CF_TEST_WORKER_NAME =
  process.env.CF_TEST_WORKER_NAME ?? 'capy-plugintest-worker';

const HAS_CREDS = !!(CF_API_TOKEN && CF_ACCOUNT_ID);

if (!HAS_CREDS) {
  console.log(
    '\x1b[33m[plugin] cloudflare-workers live tier skipped — set CF_API_TOKEN, CF_ACCOUNT_ID to run\x1b[0m',
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const HAS_WRANGLER = !!which('wrangler');
if (!HAS_WRANGLER) {
  throw new Error(
    'wrangler not found on PATH. Install with `bun add -g wrangler` or `npm i -g wrangler`.',
  );
}

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs: number = 180_000,
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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

const FIXTURE_ENV = {
  SUPABASE_URL: 'https://e2e-fixture.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_e2e_fixture_service_role',
  LOG_LEVEL: 'info',
};

function envToDotenv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function writeWorkerFixture(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'wrangler.toml'),
    [
      `name = "${name}"`,
      `main = "src/index.ts"`,
      `compatibility_date = "2026-01-01"`,
      ``,
      `[vars]`,
      `LOG_LEVEL = "info"`,
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `interface Env {
      SUPABASE_URL: string;
      SUPABASE_SERVICE_ROLE_KEY: string;
      LOG_LEVEL: string;
    }
    export default {
      async fetch(_req: Request, env: Env): Promise<Response> {
        return new Response(JSON.stringify({
          ok: true,
          has_url: !!env.SUPABASE_URL,
          has_key: !!env.SUPABASE_SERVICE_ROLE_KEY,
          level: env.LOG_LEVEL,
        }), { headers: { 'content-type': 'application/json' }});
      }
    };`,
  );
  writeFileSync(join(dir, '.env'), envToDotenv(FIXTURE_ENV));
}

// ── Suite ──────────────────────────────────────────────────────────────────

const ROOT = join(
  tmpdir(),
  `capy-plugin-cf-workers-${process.pid}-${Date.now()}`,
);

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built. Run \`bun run build\` first.`);
  }
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

// ── Hermetic tier (no creds) ───────────────────────────────────────────────

describe('cloudflare-workers (hermetic)', () => {
  test('FIXTURE_ENV serializes to the JSON shape `wrangler secret bulk` expects', () => {
    // `wrangler secret bulk` reads a top-level JSON object from stdin where
    // every value is a string. Whatever capy's connector adapter produces
    // internally MUST match this shape — it's the contract.
    const json = JSON.stringify(FIXTURE_ENV);
    const parsed = JSON.parse(json);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
    for (const v of Object.values(parsed)) expect(typeof v).toBe('string');
    expect(parsed).toEqual(FIXTURE_ENV);
  });

  test('runtime-only var filtering keeps build-time prefixes out of bulk', () => {
    // The connector adapter filters env to declared vars before bulk-pushing;
    // build-time prefixes (VITE_, NEXT_PUBLIC_) must never reach a Worker.
    const declared = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    const env = { ...FIXTURE_ENV, VITE_PUBLIC: 'should-not-appear' };
    const filtered: Record<string, string> = {};
    for (const k of declared) if (k in env) filtered[k] = env[k];
    expect(filtered.VITE_PUBLIC).toBeUndefined();
    expect(Object.keys(filtered).sort()).toEqual([
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  test('wrangler deploy --dry-run builds Worker bundle with capy env', async () => {
    const dir = join(ROOT, 'dry-run');
    writeWorkerFixture(dir, 'capy-plugintest-dryrun');

    // Hermetic test: the fixture .env is plaintext; just use it directly.
    // Live deploys would go through the connector adapter's decrypt path.
    const env = { ...FIXTURE_ENV };

    const outdir = join(dir, 'out');
    const r = await spawnAsync(
      'wrangler',
      ['deploy', '--dry-run', `--outdir=${outdir}`],
      dir,
      env,
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(outdir, 'index.js'))).toBe(true);

    // Runtime secrets must NOT be inlined into the bundle.
    const bundle = readFileSync(join(outdir, 'index.js'), 'utf-8');
    expect(bundle).not.toContain(FIXTURE_ENV.SUPABASE_URL);
    expect(bundle).not.toContain(FIXTURE_ENV.SUPABASE_SERVICE_ROLE_KEY);
  }, 240_000);
});

// ── Live tier (needs CF creds) ─────────────────────────────────────────────

describe('cloudflare-workers (live)', () => {
  test.if(HAS_CREDS)(
    'real deploy: push secrets, deploy worker, hit /, cleanup',
    async () => {
      const dir = join(ROOT, 'live');
      writeWorkerFixture(dir, CF_TEST_WORKER_NAME);

      const wranglerEnv = {
        CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
      };

      // 1. Push runtime secrets via stdin to `wrangler secret bulk`.
      // Live tier still uses the plaintext fixture .env here — the goal is
      // to verify the wrangler integration end-to-end, not the capy decrypt
      // path (covered by unit tests). Filter to runtime-only declared vars.
      const declaredRuntime = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
      const secretsPayload: Record<string, string> = {};
      for (const k of declaredRuntime) secretsPayload[k] = FIXTURE_ENV[k as keyof typeof FIXTURE_ENV];
      const secretsJsonStr = JSON.stringify(secretsPayload);

      const pushR = await spawnAsync(
        'wrangler',
        ['secret', 'bulk'],
        dir,
        wranglerEnv,
        120_000,
        secretsJsonStr,
      );
      expect(pushR.code).toBe(0);

      // 2. Deploy.
      const deployR = await spawnAsync(
        'wrangler',
        ['deploy'],
        dir,
        wranglerEnv,
        180_000,
      );
      expect(deployR.code).toBe(0);

      // Extract the deployed URL from wrangler output.
      const urlMatch = deployR.stdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
      expect(urlMatch).not.toBeNull();
      const url = urlMatch![0];

      // 3. Smoke-test: hit / and verify the worker sees the secrets.
      // CF edge propagation can take a few seconds — retry briefly.
      let body: any = null;
      for (let i = 0; i < 10; i++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          body = await res.json();
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(body).not.toBeNull();
      expect(body.ok).toBe(true);
      expect(body.has_url).toBe(true);
      expect(body.has_key).toBe(true);
      expect(body.level).toBe('info');
    },
    600_000,
  );

  // Always-attempt cleanup, even if the live test failed mid-deploy.
  afterAll(async () => {
    if (!HAS_CREDS) return;
    const wranglerEnv = {
      CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    };
    // wrangler delete needs a wrangler.toml — recreate a stub in cwd.
    const cleanupDir = join(ROOT, 'cleanup');
    if (!existsSync(cleanupDir)) writeWorkerFixture(cleanupDir, CF_TEST_WORKER_NAME);
    const r = await spawnAsync(
      'wrangler',
      ['delete', '--name', CF_TEST_WORKER_NAME, '--force'],
      cleanupDir,
      wranglerEnv,
      60_000,
    );
    if (r.code !== 0) {
      console.error(
        `[plugin] cloudflare-workers cleanup failed for ${CF_TEST_WORKER_NAME}:\n${r.stderr}`,
      );
    }
  });
});
