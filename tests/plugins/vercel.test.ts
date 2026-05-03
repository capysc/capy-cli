/**
 * Plugin tests — Vercel (Next.js)
 *
 * Mirrors ~/Dev/test-project. Two tiers:
 *   • hermetic — fixture .env → emit .capy/next-env.js → next build →
 *                assert values inlined into compiled output. No creds needed.
 *   • live     — needs VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID.
 *                vercel build + vercel deploy --prebuilt → fetch URL → scrape
 *                data-capy-value cells → assert. Cleanup via vercel remove.
 *
 * Vercel automation (capy deploy --target=vercel) does not exist yet.
 * This test exercises the *current* manual flow so it doesn't drift.
 *
 * Run: bun test tests/plugins/vercel.test.ts
 *  or: bun run test:plugins:vercel
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  cpSync,
  rmSync,
  existsSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, spawn } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');
const FIXTURE_SRC = join(__dirname, 'fixtures/nextjs-vercel');

// ── Plugin credentials ─────────────────────────────────────────────────────

const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? '';
const VERCEL_ORG_ID = process.env.VERCEL_ORG_ID ?? '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID ?? '';

const HAS_CREDS = !!(VERCEL_TOKEN && VERCEL_ORG_ID && VERCEL_PROJECT_ID);

if (!HAS_CREDS) {
  console.log(
    '\x1b[33m[plugin] vercel live tier skipped — set VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID to run\x1b[0m',
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const HAS_VERCEL = !!which('vercel');
if (!HAS_VERCEL) {
  console.log(
    '\x1b[33m[plugin] vercel: vercel CLI not on PATH. Install with `bun add -g vercel` or `npm i -g vercel`. Live tier disabled.\x1b[0m',
  );
}

const HAS_BUN = !!which('bun');

function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs: number = 600_000,
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

// Plaintext fixture vars — no encryption needed for the hermetic tier.
// Values must be distinctive enough to grep for in the built bundle.
const FIXTURE_ENV = {
  DATABASE_URL: 'postgres://capy-plugintest:hunter2@db.example.com:5432/plugintest',
  STRIPE_API_KEY: 'sk_test_capy_plugintest_stripe_xyz123',
  OPENAI_API_KEY: 'sk-capy-plugintest-openai-abcdef',
  APP_ENV: 'plugintest',
  DEBUG: 'true',
};

function envToDotenv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

/**
 * Emit .capy/next-env.js the same way `capy run` does in deploy mode. The
 * file maps each var name to a `process.env[NAME]` reference; next.config.ts
 * picks it up and Next inlines values at build time.
 */
function emitCapyNextEnvModule(projectDir: string, keys: string[]): void {
  const capyDir = join(projectDir, '.capy');
  mkdirSync(capyDir, { recursive: true });
  const body = keys
    .map((k) => `  ${JSON.stringify(k)}: process.env[${JSON.stringify(k)}]`)
    .join(',\n');
  const content =
    `// Auto-generated for plugin test. Do not edit.\n` +
    `module.exports = {\n${body}\n};\n`;
  writeFileSync(join(capyDir, 'next-env.js'), content, 'utf-8');
}

/**
 * Copy the fixture to a tmpdir, write a plaintext .env, install deps if a
 * shared cache copy doesn't already have node_modules. Returns the project
 * root for the test to operate on.
 */
async function setupNextProject(label: string): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = join(ROOT, label);
  cpSync(FIXTURE_SRC, dir, {
    recursive: true,
    filter: (src) => {
      const base = src.replace(FIXTURE_SRC, '');
      // Skip nested artifacts if a previous run left them around.
      return !base.startsWith('/node_modules') &&
        !base.startsWith('/.next') &&
        !base.startsWith('/.capy') &&
        !base.startsWith('/.vercel');
    },
  });
  writeFileSync(join(dir, '.env'), envToDotenv(FIXTURE_ENV));

  // Install if no node_modules. Reuse the per-suite shared install if present.
  if (!existsSync(join(dir, 'node_modules'))) {
    if (existsSync(join(SHARED_INSTALL, 'node_modules'))) {
      cpSync(join(SHARED_INSTALL, 'node_modules'), join(dir, 'node_modules'), {
        recursive: true,
      });
    } else {
      const installer = HAS_BUN ? 'bun' : 'npm';
      const installArgs = HAS_BUN ? ['install'] : ['install', '--no-audit', '--no-fund'];
      const r = await spawnAsync(installer, installArgs, dir, {}, 300_000);
      if (r.code !== 0) {
        throw new Error(
          `${installer} install failed in fixture dir:\n${r.stderr}\n${r.stdout}`,
        );
      }
      // Prime the shared cache for sibling tests.
      mkdirSync(SHARED_INSTALL, { recursive: true });
      cpSync(join(dir, 'node_modules'), join(SHARED_INSTALL, 'node_modules'), {
        recursive: true,
      });
    }
  }

  // Hermetic test: fixture .env is plaintext. The connector adapter would
  // decrypt at this point in a real run; here we use the fixture map
  // directly so the test stays self-contained.
  const env = { ...FIXTURE_ENV };

  // Emit .capy/next-env.js so next.config.ts maps the vars into Next's `env`
  // config — same shape capy run produces in deploy mode.
  emitCapyNextEnvModule(dir, Object.keys(env));

  return { dir, env };
}

/** Walk a directory tree and return all file paths under it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Search every .js/.html file under a tree for the given literal. */
function bundleContains(dir: string, needle: string): boolean {
  for (const p of walk(dir)) {
    if (!/\.(js|mjs|html)$/.test(p)) continue;
    let content: string;
    try {
      content = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes(needle)) return true;
  }
  return false;
}

// ── Suite ──────────────────────────────────────────────────────────────────

const ROOT = join(tmpdir(), `capy-plugin-vercel-${process.pid}-${Date.now()}`);
const SHARED_INSTALL = join(ROOT, '.shared-install');

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built. Run \`bun run build\` first.`);
  }
  if (!existsSync(FIXTURE_SRC)) {
    throw new Error(`Fixture missing at ${FIXTURE_SRC}`);
  }
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

// ── Hermetic tier ──────────────────────────────────────────────────────────

describe('vercel (hermetic)', () => {
  test(
    'next build inlines capy-injected env into the compiled output',
    async () => {
      const { dir, env } = await setupNextProject('hermetic');

      const buildR = await spawnAsync(
        join(dir, 'node_modules/.bin/next'),
        ['build'],
        dir,
        env,
        300_000,
      );
      expect(buildR.code).toBe(0);
      expect(existsSync(join(dir, '.next'))).toBe(true);

      // Each fixture value should appear as a literal somewhere in .next/.
      for (const [name, value] of Object.entries(FIXTURE_ENV)) {
        const found = bundleContains(join(dir, '.next'), value);
        expect(found).toBe(true);
        if (!found) {
          // Useful diagnostic if the assertion fails.
          console.error(`[plugin] missing inlined value for ${name}=${value}`);
        }
      }
    },
    600_000,
  );
});

// ── Live tier ──────────────────────────────────────────────────────────────

describe('vercel (live)', () => {
  let liveDeploymentUrl: string | null = null;

  test.if(HAS_CREDS && HAS_VERCEL)(
    'real deploy: vercel build + vercel deploy --prebuilt + scrape rendered cells',
    async () => {
      const { dir, env } = await setupNextProject('live');

      const vercelEnv = {
        ...env,
        VERCEL_TOKEN,
        VERCEL_ORG_ID,
        VERCEL_PROJECT_ID,
      };

      // 1. vercel build — runs Next under Vercel's build pipeline. capy env
      //    is in the spawned env, so process.env access at build time picks
      //    up the values.
      const buildR = await spawnAsync(
        'vercel',
        ['build', '--token', VERCEL_TOKEN],
        dir,
        vercelEnv,
        600_000,
      );
      expect(buildR.code).toBe(0);
      expect(existsSync(join(dir, '.vercel/output'))).toBe(true);

      // 2. vercel deploy --prebuilt — uploads the build artifacts.
      const deployR = await spawnAsync(
        'vercel',
        ['deploy', '--prebuilt', '--token', VERCEL_TOKEN, '--yes'],
        dir,
        vercelEnv,
        600_000,
      );
      expect(deployR.code).toBe(0);

      // Vercel prints the deployment URL on stdout.
      const urlMatch = deployR.stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i);
      expect(urlMatch).not.toBeNull();
      liveDeploymentUrl = urlMatch![0];

      // 3. Scrape the rendered HTML and verify each row's value cell got the
      //    capy-injected secret. Vercel can take a moment to propagate.
      let html = '';
      for (let i = 0; i < 15; i++) {
        const res = await fetch(liveDeploymentUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          html = await res.text();
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(html.length).toBeGreaterThan(0);

      // Each cell is rendered with `data-capy-value={NAME}` so we can scrape
      // by attribute. Match value content between the data attribute and
      // closing </td>.
      for (const [name, value] of Object.entries(FIXTURE_ENV)) {
        const re = new RegExp(
          `data-capy-value="${name}"[^>]*>([^<]*)<`,
          'i',
        );
        const m = html.match(re);
        expect(m).not.toBeNull();
        if (m) {
          expect(m[1]).toBe(value);
        }
      }
    },
    900_000,
  );

  // Best-effort cleanup. `vercel remove` deletes a deployment by URL.
  afterAll(async () => {
    if (!HAS_CREDS || !HAS_VERCEL || !liveDeploymentUrl) return;
    const r = await spawnAsync(
      'vercel',
      ['remove', liveDeploymentUrl, '--yes', '--token', VERCEL_TOKEN],
      ROOT,
      { VERCEL_ORG_ID, VERCEL_PROJECT_ID },
      120_000,
    );
    if (r.code !== 0) {
      console.error(
        `[plugin] vercel cleanup failed for ${liveDeploymentUrl}:\n${r.stderr}`,
      );
    }
  });
});
