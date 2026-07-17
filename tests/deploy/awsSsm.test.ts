import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  awsSsmAdapter,
  leafFor,
  envVarFor,
  parameterNameFor,
  renderWiringSnippet,
  AwsSsmOptions,
} from '../../src/deploy/adapters/awsSsm';
import { TargetConfig } from '../../src/deploy/adapter';

// "Happy path" preflight needs the aws CLI on PATH (the binary check is the
// last step before ok:true). CI doesn't ship it, so gate that test.
// Config-error tests short-circuit before the binary check.
const HAS_AWS = spawnSync('which', ['aws']).status === 0;

const ROOT = join(tmpdir(), `capy-aws-ssm-adapter-${process.pid}`);

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

const baseOptions = (overrides: Partial<AwsSsmOptions> = {}): AwsSsmOptions => ({
  region: 'us-east-1',
  pathPrefix: '/capy/prod/',
  naming: 'kebab',
  ...overrides,
});

const baseTarget = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'ssm-test',
  kind: 'aws-ssm',
  branch: 'production',
  vars: ['DATABASE_URL', 'WORKOS_API_KEY'],
  options: baseOptions() as unknown as Record<string, unknown>,
  ...overrides,
});

describe('awsSsm — name mapping', () => {
  test('kebab leaf: lowercase, _ → -', () => {
    expect(leafFor('DATABASE_URL', 'kebab')).toBe('database-url');
    expect(leafFor('POLAR_WEBHOOK_SECRET', 'kebab')).toBe('polar-webhook-secret');
  });

  test('verbatim leaf: unchanged', () => {
    expect(leafFor('DATABASE_URL', 'verbatim')).toBe('DATABASE_URL');
  });

  test('kebab round-trips for standard env var names', () => {
    for (const name of ['DATABASE_URL', 'X', 'A_B_C_9', 'WORKOS_CLIENT_ID']) {
      expect(envVarFor(leafFor(name, 'kebab'), 'kebab')).toBe(name);
    }
  });

  test('verbatim round-trips trivially', () => {
    expect(envVarFor(leafFor('FOO_BAR', 'verbatim'), 'verbatim')).toBe('FOO_BAR');
  });

  test('parameterNameFor joins prefix + leaf', () => {
    expect(parameterNameFor('DATABASE_URL', baseOptions())).toBe(
      '/capy/prod/database-url',
    );
    expect(
      parameterNameFor('DATABASE_URL', baseOptions({ naming: 'verbatim' })),
    ).toBe('/capy/prod/DATABASE_URL');
  });

  test('per-var override wins over prefix + convention', () => {
    const opts = baseOptions({
      overrides: { DATABASE_URL: '/legacy/db_url' },
    });
    expect(parameterNameFor('DATABASE_URL', opts)).toBe('/legacy/db_url');
    expect(parameterNameFor('WORKOS_API_KEY', opts)).toBe(
      '/capy/prod/workos-api-key',
    );
  });
});

describe('awsSsm — detect', () => {
  test('infers prefix + kebab naming from literal tf parameter names', async () => {
    mkdirSync(join(ROOT, 'infra'), { recursive: true });
    writeFileSync(
      join(ROOT, 'infra', 'main.tf'),
      `
data "aws_ssm_parameter" "database_url" {
  name = "/capy/prod/database-url"
}
data "aws_ssm_parameter" "workos_api_key" {
  name = "/capy/prod/workos-api-key"
}
`,
    );
    const r = await awsSsmAdapter.detect(ROOT);
    expect(r.options?.pathPrefix).toBe('/capy/prod/');
    expect(r.options?.naming).toBe('kebab');
    expect(r.summary).toContain('2 aws_ssm_parameter');
    expect(r.summary).toContain('/capy/prod/');
  });

  test('interpolated tf names: naming inferred, prefix NOT prefilled', async () => {
    writeFileSync(
      join(ROOT, 'main.tf'),
      `
data "aws_ssm_parameter" "database_url" {
  name = "/capy/\${var.environment}/database-url"
}
data "aws_ssm_parameter" "workos_api_key" {
  name = "/capy/\${var.environment}/workos-api-key"
}
`,
    );
    const r = await awsSsmAdapter.detect(ROOT);
    expect(r.options?.pathPrefix).toBeUndefined();
    expect(r.options?.naming).toBe('kebab');
  });

  test('verbatim naming inferred from uppercase leaves', async () => {
    writeFileSync(
      join(ROOT, 'main.tf'),
      `
data "aws_ssm_parameter" "db" {
  name = "/myapp/DATABASE_URL"
}
`,
    );
    const r = await awsSsmAdapter.detect(ROOT);
    expect(r.options?.naming).toBe('verbatim');
    expect(r.options?.pathPrefix).toBe('/myapp/');
  });

  test('returns empty when no tf files mention aws_ssm_parameter', async () => {
    writeFileSync(join(ROOT, 'main.tf'), `resource "aws_s3_bucket" "b" {}`);
    const r = await awsSsmAdapter.detect(ROOT);
    expect(r.options).toBeUndefined();
    expect(r.summary).toBeUndefined();
  });
});

describe('awsSsm — preflight (config errors, no aws CLI needed)', () => {
  test('missing region', async () => {
    const t = baseTarget({
      options: baseOptions({ region: '' }) as unknown as Record<string, unknown>,
    });
    const r = await awsSsmAdapter.preflight(t, { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('region');
  });

  test('pathPrefix must start and end with /', async () => {
    for (const bad of ['capy/prod/', '/capy/prod', '', '/ca py/']) {
      const t = baseTarget({
        options: baseOptions({ pathPrefix: bad }) as unknown as Record<string, unknown>,
      });
      const r = await awsSsmAdapter.preflight(t, { cwd: ROOT });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('pathPrefix');
    }
  });

  test('naming must be verbatim or kebab', async () => {
    const t = baseTarget({
      options: { ...baseOptions(), naming: 'camel' } as unknown as Record<string, unknown>,
    });
    const r = await awsSsmAdapter.preflight(t, { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('naming');
  });

  test('override values must be absolute parameter names', async () => {
    const t = baseTarget({
      options: baseOptions({
        overrides: { DATABASE_URL: 'no-leading-slash' },
      }) as unknown as Record<string, unknown>,
    });
    const r = await awsSsmAdapter.preflight(t, { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('override');
  });

  test('no vars selected', async () => {
    const t = baseTarget({ vars: [] });
    const r = await awsSsmAdapter.preflight(t, { cwd: ROOT });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no vars');
  });

  test.if(HAS_AWS)('valid config passes with aws on PATH', async () => {
    const r = await awsSsmAdapter.preflight(baseTarget(), { cwd: ROOT });
    expect(r.ok).toBe(true);
  });
});

describe('awsSsm — deploy (no AWS calls)', () => {
  test('dry-run reports without pushing', async () => {
    const r = await awsSsmAdapter.deploy(baseTarget(), {
      env: {},
      dryRun: true,
      cwd: ROOT,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'skip']);
    expect(r.epilogue).toBeUndefined();
  });

  test('an entirely-missing declared set fails before any AWS call', async () => {
    const r = await awsSsmAdapter.deploy(baseTarget(), {
      env: {}, // none of the declared vars present in the branch
      dryRun: false,
      cwd: ROOT,
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0].status).toBe('fail');
    expect(r.steps[0].detail).toContain('none present');
  });

  test('a partially-missing declared set skips the missing vars (does not fail the filter)', async () => {
    const r = await awsSsmAdapter.deploy(baseTarget(), {
      env: { DATABASE_URL: 'postgres://x' }, // WORKOS_API_KEY absent
      dryRun: false,
      cwd: ROOT,
    });
    // Filter passes: deploys DATABASE_URL, skips WORKOS_API_KEY with a note.
    // (The deploy then proceeds past the filter to the AWS calls.)
    expect(r.steps[0].status).toBe('ok');
    expect(r.steps[0].detail).toContain('skipped');
    expect(r.steps[0].detail).toContain('WORKOS_API_KEY');
  });
});

describe('awsSsm — wiring snippet', () => {
  test('renders valueFrom ARNs and the path-scoped IAM grant', () => {
    const opts = baseOptions();
    const snippet = renderWiringSnippet(
      [
        { varName: 'DATABASE_URL', paramName: '/capy/prod/database-url' },
        { varName: 'WORKOS_API_KEY', paramName: '/capy/prod/workos-api-key' },
      ],
      opts,
      '888888888812',
    );
    expect(snippet).toContain(
      '"name": "DATABASE_URL"',
    );
    expect(snippet).toContain(
      'arn:aws:ssm:us-east-1:888888888812:parameter/capy/prod/database-url',
    );
    expect(snippet).toContain(
      '"Resource": "arn:aws:ssm:us-east-1:888888888812:parameter/capy/prod/*"',
    );
    expect(snippet).toContain('ssm:GetParameter');
  });
});
