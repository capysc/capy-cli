/**
 * Plugin tests — Cloudflare Pages
 *
 * Two tiers:
 *   • hermetic — vite build with capy-injected VITE_*; verify inlining.
 *   • live     — needs CF_API_TOKEN + CF_ACCOUNT_ID + CF_TEST_PAGES_PROJECT.
 *                Real `wrangler pages deploy` of a built bundle.
 *
 * Run: bun test tests/plugins/cloudflare-pages.test.ts
 *  or: bun run test:plugins:cloudflare-pages
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, spawn } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const REPO_WEB = join(
  __dirname,
  '../../../../demos/cf-workers-demo/after/web',
);

const CF_API_TOKEN = process.env.CF_API_TOKEN ?? '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '';
const CF_TEST_PAGES_PROJECT =
  process.env.CF_TEST_PAGES_PROJECT ?? 'capy-plugintest-pages';

const HAS_CREDS = !!(CF_API_TOKEN && CF_ACCOUNT_ID);

if (!HAS_CREDS) {
  console.log(
    '\x1b[33m[plugin] cloudflare-pages live tier skipped — set CF_API_TOKEN, CF_ACCOUNT_ID to run\x1b[0m',
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const HAS_VITE = existsSync(join(REPO_WEB, 'node_modules/.bin/vite'));
if (!HAS_VITE) {
  console.log(
    `\x1b[33m[plugin] cloudflare-pages: vite not installed at ${REPO_WEB}/node_modules — run \`bun install\` in the demo first\x1b[0m`,
  );
}

function capySync(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs: number = 240_000,
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
  });
}

const FIXTURE_ENV = {
  VITE_SUPABASE_URL: 'https://e2e-fixture.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_e2e_fixture_anon_key',
  VITE_API_BASE_URL: 'http://localhost:8787',
  // Service-role key included to verify it does NOT leak into the public bundle.
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_e2e_fixture_service_role',
};

function envToDotenv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

const ROOT = join(
  tmpdir(),
  `capy-plugin-cf-pages-${process.pid}-${Date.now()}`,
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

function buildPagesBundle(buildOutDir: string): Promise<{ stdout: string; stderr: string; code: number; assetsDir: string }> {
  const dir = join(ROOT, 'build-src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), envToDotenv(FIXTURE_ENV));

  const exportR = capySync(['export', '--format=json'], dir);
  if (exportR.code !== 0) {
    return Promise.resolve({
      stdout: exportR.stdout,
      stderr: exportR.stderr,
      code: exportR.code,
      assetsDir: '',
    });
  }
  const env = JSON.parse(exportR.stdout) as Record<string, string>;

  return spawnAsync(
    join(REPO_WEB, 'node_modules/.bin/vite'),
    ['build', '--outDir', buildOutDir, '--emptyOutDir'],
    REPO_WEB,
    env,
  ).then((r) => ({ ...r, assetsDir: join(buildOutDir, 'assets') }));
}

// ── Hermetic tier ──────────────────────────────────────────────────────────

describe('cloudflare-pages (hermetic)', () => {
  test.if(HAS_VITE)(
    'vite build inlines VITE_* into the bundle, never the service-role key',
    async () => {
      const outDir = join(ROOT, 'hermetic-dist');
      const r = await buildPagesBundle(outDir);
      expect(r.code).toBe(0);
      expect(existsSync(r.assetsDir)).toBe(true);

      const jsFiles = readdirSync(r.assetsDir).filter((f) => f.endsWith('.js'));
      expect(jsFiles.length).toBeGreaterThan(0);
      const bundle = readFileSync(join(r.assetsDir, jsFiles[0]), 'utf-8');

      expect(bundle).toContain(FIXTURE_ENV.VITE_SUPABASE_URL);
      expect(bundle).toContain(FIXTURE_ENV.VITE_API_BASE_URL);
      expect(bundle).toContain(FIXTURE_ENV.VITE_SUPABASE_ANON_KEY);

      // Negative assertion — runtime secrets must never reach the public bundle.
      expect(bundle).not.toContain(FIXTURE_ENV.SUPABASE_SERVICE_ROLE_KEY);
    },
    300_000,
  );
});

// ── Live tier ──────────────────────────────────────────────────────────────

describe('cloudflare-pages (live)', () => {
  test.if(HAS_CREDS && HAS_VITE)(
    'real deploy: build with capy env, wrangler pages deploy, fetch site',
    async () => {
      const outDir = join(ROOT, 'live-dist');
      const buildR = await buildPagesBundle(outDir);
      expect(buildR.code).toBe(0);

      const wranglerEnv = {
        CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
      };

      const deployR = await spawnAsync(
        'wrangler',
        [
          'pages',
          'deploy',
          outDir,
          `--project-name=${CF_TEST_PAGES_PROJECT}`,
          '--branch=plugin-test',
        ],
        ROOT,
        wranglerEnv,
        300_000,
      );
      expect(deployR.code).toBe(0);

      const urlMatch = deployR.stdout.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
      expect(urlMatch).not.toBeNull();
      const url = urlMatch![0];

      // Smoke fetch — Pages can take a few seconds to propagate.
      let html = '';
      for (let i = 0; i < 10; i++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          html = await res.text();
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(html.length).toBeGreaterThan(0);
      // Sanity — the masked-secrets table page should contain a known marker.
      expect(html.toLowerCase()).toContain('<!doctype html>');
    },
    600_000,
  );
});
