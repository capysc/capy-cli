/**
 * Discovery for `capy setup` (spec 3k section 7, CAP-927): names and files only, never a value.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CATALOG, dependencies, discover, namesReadByCode, wranglerEnvironments, type DiscoveryInput, type ScanFile } from '../../src/core/discovery/scan';
import { walkFolder } from '../../src/core/discovery/walk';

const file = (path: string, text: string): ScanFile => ({ path, text: () => text });

function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return { files: [], truncated: false, envNames: [], envIsSet: () => false, bin: 'capy', ...over };
}

describe('discover: services', () => {
  test('an empty folder finds nothing', () => {
    expect(discover(input())).toEqual({
      catalog_version: CATALOG.version,
      services: [],
      unmapped: [],
      infrastructure: [],
      scanned: { files: 0, truncated: false, names_capped: false },
    });
  });

  test('.env names map to providers; ambiguous and runtime names do not', () => {
    const found = discover(input({ envNames: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'DATABASE_URL', 'NODE_ENV'] }));
    expect(found.services.map((s) => s.provider)).toEqual(['stripe', 'resend']);
    expect(found.services[0]).toEqual({
      provider: 'stripe',
      label: 'Stripe',
      variables: [
        { name: 'STRIPE_SECRET_KEY', in_env: true, read_in: [] },
        { name: 'STRIPE_WEBHOOK_SECRET', in_env: true, read_in: [] },
      ],
      packages: [],
      status: 'discovered',
      next: 'capy connect stripe',
    });
    // Resend has no Capy connector, so there is nothing to run next.
    expect(found.services[1].next).toBeUndefined();
    // DATABASE_URL is not mapped (decision 3); NODE_ENV is runtime noise, not a secret.
    expect(found.unmapped).toEqual([{ name: 'DATABASE_URL', in_env: true, read_in: [] }]);
  });

  test('a framework public prefix is removed before matching', () => {
    const found = discover(input({ envNames: ['NEXT_PUBLIC_SUPABASE_URL', 'VITE_POSTHOG_KEY'] }));
    expect(found.services.map((s) => s.provider)).toEqual(['supabase', 'posthog']);
  });

  test('names the code reads count, with where they are read, even when .env lacks them', () => {
    const files = [
      file('src/pay.ts', "const s = new Stripe(process.env.STRIPE_SECRET_KEY!);\nconst db = process.env['DATABASE_URL'];\n"),
      file('app/main.py', 'import os\nkey = os.environ.get("OPENAI_API_KEY")\nurl = os.getenv("REDIS_URL")\n'),
      file('cmd/main.go', 'token := os.Getenv("TWILIO_AUTH_TOKEN")\n'),
      file('lib/mail.rb', "ENV.fetch('POSTMARK_API_TOKEN')\n"),
    ];
    const found = discover(input({ files, envNames: ['STRIPE_SECRET_KEY'] }));
    expect(found.services.map((s) => s.provider)).toEqual(['stripe', 'openai', 'postmark', 'twilio']);
    expect(found.services[0].variables).toEqual([{ name: 'STRIPE_SECRET_KEY', in_env: true, read_in: ['src/pay.ts:1'] }]);
    expect(found.services[1].variables).toEqual([{ name: 'OPENAI_API_KEY', in_env: false, read_in: ['app/main.py:2'] }]);
    expect(found.unmapped).toEqual([
      { name: 'DATABASE_URL', in_env: false, read_in: ['src/pay.ts:2'] },
      { name: 'REDIS_URL', in_env: false, read_in: ['app/main.py:3'] },
    ]);
  });

  test('the code scan keeps at most five places per name', () => {
    const text = Array.from({ length: 8 }, () => 'process.env.SENTRY_DSN').join('\n');
    expect(namesReadByCode([file('a.ts', text)]).places.get('SENTRY_DSN')).toEqual(['a.ts:1', 'a.ts:2', 'a.ts:3', 'a.ts:4', 'a.ts:5']);
  });

  test('a file that is not code, and any .env file, is never scanned for names', () => {
    const files = [file('README.md', 'set process.env.STRIPE_KEY'), file('.env.example', 'process.env.STRIPE_KEY')];
    expect(namesReadByCode(files).places.size).toBe(0);
  });

  test('a value pasted where the name belongs, or a method, is never reported', () => {
    const files = [file('a.py', 'os.environ.get("sk_live_51Habc123")\nos.getenv("Mixed_Case")\n'), file('b.js', 'process.env.toString()\nprocess.env.STRIPE_KEYs\n')];
    const read = namesReadByCode(files).places;
    expect([...read.keys()]).toEqual([]);
    expect(JSON.stringify(discover(input({ files })))).not.toContain('sk_live');
  });

  test('an upper-case value where the name belongs is not reported either', () => {
    const read = namesReadByCode([file('a.py', 'os.getenv("AKIAIOSFODNN7EXAMPLE")\nos.getenv("ABCDEFGHIJKLMNOPQRSTUVWX")\nos.getenv("REAL_NAME")\n')]).places;
    expect([...read.keys()]).toEqual(['REAL_NAME']);
  });

  test('Vercel deploy names in .env show under the Vercel target', () => {
    const found = discover(input({ envNames: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'] }));
    expect(found.infrastructure.map((t) => [t.target, t.found])).toEqual([['vercel', ['.env:VERCEL_TOKEN', '.env:VERCEL_PROJECT_ID']]]);
    expect(found.unmapped).toEqual([]);
  });

  test('ENV[...] only as Ruby ENV, not inside another name', () => {
    const read = namesReadByCode([file('a.rb', 'MY_ENV["NOT_A_READ"]\nENV["REAL_ONE"]\n')]).places;
    expect([...read.keys()]).toEqual(['REAL_ONE']);
  });

  test('a bundled file with thousands of reads is capped, quick, and says so', () => {
    const text = Array.from({ length: 15000 }, (_, i) => `process.env.V${i}`).join('\n');
    const started = Date.now();
    const found = discover(input({ files: [file('public/bundle.js', text)] }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(found.unmapped.length).toBe(100);
    expect(found.scanned.names_capped).toBe(true);
  });

  test('more than 100 unmapped names across files are capped too', () => {
    const files = Array.from({ length: 3 }, (_, f) => file(`f${f}.ts`, Array.from({ length: 50 }, (_, i) => `process.env.N${f}_${i}`).join('\n')));
    const found = discover(input({ files }));
    expect(found.unmapped.length).toBe(100);
    expect(found.scanned.names_capped).toBe(true);
  });

  test('package dependencies point at providers even with no variable', () => {
    const files = [
      file('package.json', JSON.stringify({ dependencies: { '@clerk/nextjs': '^5', next: '15' }, devDependencies: { '@sentry/node': '8' } })),
      file('api/requirements.txt', 'anthropic>=0.30\nboto3==1.34\n# comment\n'),
      file('go.mod', 'module x\n\nrequire (\n\tgithub.com/stripe/stripe-go/v79 v79.1.0\n)\n'),
      file('Gemfile', "source 'https://rubygems.org'\ngem 'twilio-ruby'\n"),
    ];
    const found = discover(input({ files }));
    expect(found.services.map((s) => [s.provider, s.packages])).toEqual([
      ['stripe', ['go.mod: github.com/stripe/stripe-go/v79']],
      ['anthropic', ['api/requirements.txt: anthropic']],
      ['twilio', ['Gemfile: twilio-ruby']],
      ['clerk', ['package.json: @clerk/nextjs']],
      ['sentry', ['package.json: @sentry/node']],
      ['aws', ['api/requirements.txt: boto3']],
    ]);
  });

  test('names that could be several providers stay unmapped, and deployment names are not services', () => {
    const found = discover(input({ envNames: ['MONGO_URL', 'S3_BUCKET', 'DOKPLOY_URL', 'VERCEL_TOKEN', 'MONGODB_ATLAS_PUBLIC_KEY'] }));
    expect(found.services.map((s) => s.provider)).toEqual(['mongodb-atlas']);
    expect(found.unmapped.map((v) => v.name)).toEqual(['MONGO_URL', 'S3_BUCKET']);
    expect(found.infrastructure.map((t) => t.target)).toEqual(['dokploy', 'vercel']);
  });

  test('pyproject dependencies are read by name', () => {
    const deps = dependencies([file('pyproject.toml', '[project]\ndependencies = [\n  "openai>=1.0",\n  "httpx",\n]\n')]);
    expect(deps.map((d) => d.name)).toEqual(['openai', 'httpx']);
  });

  test('an unreadable package.json is a hint lost, not a failure', () => {
    expect(() => discover(input({ files: [file('package.json', '{not json')] }))).not.toThrow();
  });
});

describe('discover: infrastructure', () => {
  test('only the four launch targets, in a fixed order', () => {
    const files = [
      file('wrangler.toml', 'name = "api"\n[env.staging]\nname = "api-staging"\n[env.production]\n'),
      file('vercel.json', '{}'),
      file('infra/main.tf', 'resource "aws_ssm_parameter" "db" {\n  name = "/app/db"\n}\n'),
      file('docker-compose.yml', 'services:\n  web:\n    networks: [dokploy-network]\n'),
      file('fly.toml', 'app = "x"'),
      file('render.yaml', 'services: []'),
    ];
    const found = discover(input({ files }));
    expect(found.infrastructure.map((t) => t.target)).toEqual(['dokploy', 'vercel', 'aws-ssm', 'cloudflare']);
  });

  test('Vercel keeps the token state and the dry run from pre-discovery', () => {
    const [vercel] = discover(input({ files: [file('apps/web/.vercel/project.json', '{}')], envIsSet: (n) => n === 'VERCEL_TOKEN', bin: 'capy-staging' })).infrastructure;
    expect(vercel).toEqual({
      target: 'vercel',
      label: 'Vercel',
      found: ['apps/web/.vercel/project.json', 'env:VERCEL_TOKEN'],
      environments: [],
      adapters: ['vercel'],
      token: { name: '_CONNECTOR_VERCEL_TOKEN', state: 'present', env: 'VERCEL_TOKEN', set: 'capy-staging system set _CONNECTOR_VERCEL_TOKEN' },
      needs: 'A Vercel access token, saved by an organization owner or admin.',
      next: 'capy-staging connect vercel --discover --dry-run --json',
    });
  });

  test('Dokploy from a compose file on its network, or from a variable name, with the base URL setting', () => {
    const [fromCompose] = discover(input({ files: [file('compose.prod.yaml', 'networks:\n  dokploy-network:\n    external: true\n')] })).infrastructure;
    expect(fromCompose.found).toEqual(['compose.prod.yaml:2']);
    expect(fromCompose.token?.state).toBe('unknown');
    expect(fromCompose.settings).toEqual([{ name: '_CONNECTOR_DOKPLOY_BASE_URL', set: 'capy system set _CONNECTOR_DOKPLOY_BASE_URL' }]);
    const [fromName] = discover(input({ envNames: ['DOKPLOY_URL'] })).infrastructure;
    expect(fromName.found).toEqual(['.env:DOKPLOY_URL']);
    // A compose file without Dokploy is not Dokploy.
    expect(discover(input({ files: [file('docker-compose.yml', 'services: {}')] })).infrastructure).toEqual([]);
  });

  test('Cloudflare names its environments and whether it is Workers or Pages', () => {
    const [worker] = discover(input({ files: [file('wrangler.toml', '[env.staging]\n[[env.production.kv_namespaces]]\n')] })).infrastructure;
    expect(worker.environments).toEqual(['production', 'staging']);
    expect(worker.adapters).toEqual(['cf-worker']);
    expect(worker.next).toBeUndefined();
    const [pages] = discover(input({ files: [file('site/wrangler.jsonc', '// pages\n{"pages_build_output_dir": "dist", "env": {"preview": {}}}')] })).infrastructure;
    expect(pages.adapters).toEqual(['cf-pages']);
    expect(pages.environments).toEqual(['preview']);
  });

  test('wrangler JSON that does not parse names no environments', () => {
    expect(wranglerEnvironments('wrangler.json', '{')).toEqual([]);
  });

  test('wrangler JSONC with trailing and block comments and trailing commas still names its environments', () => {
    const text = '{\n  "name": "x", // trailing\n  /* block */ "route": "https://a.b/c",\n  "env": { "staging": {}, "production": {}, },\n}';
    expect(wranglerEnvironments('wrangler.jsonc', text)).toEqual(['staging', 'production']);
  });

  test('AWS SSM from Terraform, Serverless and SDK use', () => {
    const files = [
      file('serverless.yml', 'environment:\n  KEY: ${ssm:/app/key}\n'),
      file('src/config.ts', "import { SSMClient } from '@aws-sdk/client-ssm';\n"),
    ];
    const [ssm] = discover(input({ files })).infrastructure;
    expect(ssm.target).toBe('aws-ssm');
    expect(ssm.found).toEqual(['serverless.yml:2', 'src/config.ts:1']);
    expect(ssm.adapters).toEqual(['aws-ssm']);
  });
});

describe('the catalog', () => {
  test('every env pattern and package list is well formed', () => {
    for (const service of CATALOG.services) {
      expect(service.env.length).toBeGreaterThan(0);
      for (const pattern of service.env) expect(() => new RegExp(pattern)).not.toThrow();
    }
    expect(new Set(CATALOG.services.map((s) => s.id)).size).toBe(CATALOG.services.length);
  });

  test('the launch connectors are the only ones with a next command', () => {
    expect(CATALOG.services.filter((s) => s.connector === true).map((s) => s.id)).toEqual(['stripe', 'workos']);
  });
});

describe('walkFolder', () => {
  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'capy-discovery-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  test('skips dependencies, build output, lockfiles and every .env file, and never reads a value', () => {
    const root = folder({
      '.env': 'STRIPE_SECRET_KEY=sk_live_value',
      '.env.local': 'process.env.SHOULD_NOT_APPEAR',
      'src/index.ts': 'process.env.STRIPE_SECRET_KEY',
      'node_modules/stripe/index.js': 'process.env.FROM_DEPENDENCY',
      '.vercel/project.json': '{}',
      '.vercel/output/config.json': '{}',
      'dist/out.js': 'process.env.FROM_BUILD',
      'package-lock.json': '{}',
    });
    try {
      const walk = walkFolder(root);
      expect(walk.files.map((f) => f.path).sort()).toEqual(['.vercel/project.json', 'src/index.ts']);
      const found = discover(input({ files: walk.files, envNames: ['STRIPE_SECRET_KEY'] }));
      expect(JSON.stringify(found)).not.toContain('sk_live_value');
      expect(found.services[0].variables).toEqual([{ name: 'STRIPE_SECRET_KEY', in_env: true, read_in: ['src/index.ts:1'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stops at the file cap and says so', () => {
    const root = folder({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });
    try {
      expect(walkFolder(root, 2)).toMatchObject({ truncated: true });
      expect(walkFolder(root, 2).files.length).toBe(2);
      expect(walkFolder(root).truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not follow links', () => {
    const outside = folder({ 'secret.ts': 'process.env.OUTSIDE' });
    const root = folder({ 'src/a.ts': '' });
    try {
      symlinkSync(outside, join(root, 'linked'));
      expect(walkFolder(root).files.map((f) => f.path)).toEqual(['src/a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
