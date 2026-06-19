/**
 * AWS SSM Parameter Store adapter.
 *
 * One SecureString parameter per var, written via `aws ssm put-parameter`.
 * Unlike cf-worker there is no code-ship step: the consumer (typically an
 * ECS task definition) references each parameter by ARN via `valueFrom`,
 * so "deploy" here means the values land in SSM and the keep.lock PR is
 * the signal for the user's pipeline to roll tasks.
 *
 * An env var name and a parameter name are not the same thing — the adapter
 * owns the mapping: full name = pathPrefix + leaf, where the leaf comes from
 * a per-target naming convention ('verbatim' keeps the env var name,
 * 'kebab' lowercases and swaps _ for -). A per-var `overrides` map adopts
 * pre-existing parameters that fit neither convention.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
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

export type SsmNaming = 'verbatim' | 'kebab';

export interface AwsSsmOptions {
  /** AWS region the parameters live in. */
  region: string;
  /** Parameter path prefix — starts and ends with '/', e.g. '/capy/prod/'. */
  pathPrefix: string;
  /** Leaf naming convention (see leafFor). */
  naming: SsmNaming;
  /**
   * Per-var full parameter names for params that fit neither convention.
   * Wins over pathPrefix+leafFor. Values must start with '/'.
   */
  overrides?: Record<string, string>;
}

/** Standard-tier parameter value ceiling (bytes). Above it we need Advanced. */
const STANDARD_TIER_MAX = 4096;
/** Advanced-tier ceiling — values past this can't go in SSM at all. */
const ADVANCED_TIER_MAX = 8192;

// ── Name mapping ───────────────────────────────────────────────────────────

/** Env var name → parameter leaf under the prefix. */
export function leafFor(varName: string, naming: SsmNaming): string {
  return naming === 'kebab' ? varName.toLowerCase().replace(/_/g, '-') : varName;
}

/**
 * Parameter leaf → env var name. Inverse of leafFor; bijective for standard
 * env var names ([A-Z0-9_]+), which keeps drift checks and orphan detection
 * deterministic.
 */
export function envVarFor(leaf: string, naming: SsmNaming): string {
  return naming === 'kebab' ? leaf.toUpperCase().replace(/-/g, '_') : leaf;
}

/** Env var name → full parameter name, honoring per-var overrides. */
export function parameterNameFor(varName: string, opts: AwsSsmOptions): string {
  const override = opts.overrides?.[varName];
  if (override) return override;
  return opts.pathPrefix + leafFor(varName, opts.naming);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Region from the ambient aws CLI config, for picker defaults. */
export function detectAwsRegion(): string | null {
  const r = spawnSync('aws', ['configure', 'get', 'region'], {
    encoding: 'utf-8',
  });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function spawnAsync(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Run an aws command whose input carries a secret value. The payload goes in
 * via --cli-input-json so the value never appears in argv (visible to `ps`).
 * POSIX reads it from the child's stdin through /dev/stdin; Windows has no
 * such path, so fall back to a 0600 temp file removed immediately after.
 */
async function awsWithSecretInput(
  args: string[],
  payload: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const json = JSON.stringify(payload);
  if (process.platform !== 'win32') {
    return spawnAsync(
      'aws',
      [...args, '--cli-input-json', 'file:///dev/stdin'],
      json,
    );
  }
  const tmp = join(tmpdir(), `capy-ssm-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(tmp, json, { mode: 0o600 });
  try {
    return await spawnAsync('aws', [...args, '--cli-input-json', `file://${tmp}`]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function lastLines(s: string, n = 3): string {
  return s.trim().split('\n').slice(-n).join(' | ');
}

// ── detect() — sniff Terraform for existing aws_ssm_parameter refs ─────────

const TF_DIR_CANDIDATES = ['.', 'infra', 'infrastructure', 'terraform', 'deploy', 'iac'];

function tfParameterNames(cwd: string): string[] {
  const names: string[] = [];
  for (const dir of TF_DIR_CANDIDATES) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.tf')) continue;
      let content: string;
      try {
        content = readFileSync(join(abs, f), 'utf-8');
      } catch {
        continue;
      }
      if (!content.includes('aws_ssm_parameter')) continue;
      // Heuristic prefill, not a parser: collect quoted absolute paths
      // assigned to `name`. Over-collecting a stray non-SSM name attr is
      // harmless — this only seeds picker defaults.
      for (const m of content.matchAll(/\bname\s*=\s*"(\/[^"]+)"/g)) {
        names.push(m[1]);
      }
    }
  }
  return names;
}

/** Longest common prefix of full names, cut at the last '/'. */
function commonPathPrefix(names: string[]): string | null {
  if (names.length === 0) return null;
  let prefix = names[0];
  for (const n of names.slice(1)) {
    while (!n.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return null;
    }
  }
  const cut = prefix.lastIndexOf('/');
  if (cut < 1) return null; // only the root '/' is common — no usable prefix
  return prefix.slice(0, cut + 1);
}

function inferNaming(leaves: string[]): SsmNaming | null {
  if (leaves.length === 0) return null;
  if (leaves.every((l) => /^[a-z0-9][a-z0-9-]*$/.test(l))) return 'kebab';
  if (leaves.every((l) => /^[A-Z0-9_]+$/.test(l))) return 'verbatim';
  return null;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export const awsSsmAdapter: DeployAdapter = {
  id: 'aws-ssm',
  label: 'AWS SSM Parameter Store',
  description: 'One SecureString per var; ECS/task-def reads via valueFrom',
  varKind: 'runtime',
  // The keep.lock PR is the deploy signal for the user's pipeline (ECS roll
  // on merge), so CI is the natural default. Direct stays available for
  // setups where tasks restart out-of-band.
  defaultMode: 'ci',
  requires: { binaries: ['aws'] },

  async detect(cwd: string): Promise<DetectedDefaults> {
    const names = tfParameterNames(cwd);
    if (names.length === 0) return {};
    const prefix = commonPathPrefix(names);
    const leaves = names.map((n) => n.slice(n.lastIndexOf('/') + 1));
    const naming = inferNaming(leaves);
    const options: Record<string, unknown> = {};
    // Terraform names often interpolate ("/capy/${var.environment}/…") —
    // not a usable literal parameter path, so don't prefill it.
    if (prefix && !prefix.includes('$')) options.pathPrefix = prefix;
    if (naming) options.naming = naming;
    const region = detectAwsRegion();
    if (region) options.region = region;
    const bits = [
      prefix ? `prefix ${prefix}` : null,
      naming ? `${naming === 'kebab' ? 'kebab-case' : 'verbatim'} names` : null,
    ].filter(Boolean);
    return {
      options,
      summary: `${names.length} aws_ssm_parameter ref(s) in *.tf${bits.length ? ` (${bits.join(', ')})` : ''}`,
    };
  },

  async preflight(config: TargetConfig, _ctx: { cwd: string }): Promise<PreflightResult> {
    // Config errors first, binary check last — same ordering as cf-worker,
    // so config-error tests run without the aws CLI installed. Ambient
    // credentials are NOT probed here (mirrors cf-worker punting auth to
    // wrangler): the deploy's first step is `sts get-caller-identity`,
    // which fails cleanly before any value is pushed.
    const opts = config.options as Partial<AwsSsmOptions>;
    if (!opts.region || !opts.region.trim()) {
      return {
        ok: false,
        reason: 'aws-ssm target missing region',
        hint: 'Run `capy deploy --edit ' + config.name + '` to fix.',
      };
    }
    if (
      !opts.pathPrefix ||
      !/^\/[a-zA-Z0-9_.\-/]*\/$/.test(opts.pathPrefix)
    ) {
      return {
        ok: false,
        reason: `aws-ssm pathPrefix must start and end with '/' (got "${opts.pathPrefix ?? ''}")`,
        hint: 'Example: /capy/prod/  — run `capy deploy --edit ' + config.name + '` to fix.',
      };
    }
    if (opts.naming !== 'verbatim' && opts.naming !== 'kebab') {
      return {
        ok: false,
        reason: `aws-ssm naming must be 'verbatim' or 'kebab' (got "${String(opts.naming)}")`,
      };
    }
    for (const [k, v] of Object.entries(opts.overrides ?? {})) {
      if (typeof v !== 'string' || !v.startsWith('/')) {
        return {
          ok: false,
          reason: `aws-ssm override for ${k} must be a full parameter name starting with '/'`,
        };
      }
    }
    if (config.vars.length === 0) {
      return {
        ok: false,
        reason: 'aws-ssm target has no vars to push',
        hint: 'Re-run with `--edit` and select at least one var.',
      };
    }
    if (!which('aws')) {
      return {
        ok: false,
        reason: 'aws CLI not found on PATH',
        hint:
          'Install the AWS CLI:\n' +
          '  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n' +
          'Re-run `capy deploy` after install.',
      };
    }
    return { ok: true };
  },

  async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
    const opts = config.options as unknown as AwsSsmOptions;
    const steps: DeployStep[] = [];

    if (ctx.dryRun) {
      steps.push({
        label: 'filter vars',
        status: 'ok',
        detail: `${config.vars.length} runtime var(s) would push under ${opts.pathPrefix}`,
      });
      steps.push({ label: 'ssm put-parameter', status: 'skip', detail: 'dry-run' });
      return { ok: true, steps };
    }

    // 1. Deploy the declared vars that are actually in the branch right now.
    //    A declared var that's been removed from the branch is SKIPPED with a
    //    warning, not fatal: the effective set is (declared ∩ branch), so the
    //    live .env is the source of truth and a trimmed branch (e.g. dropping
    //    box-set vars) doesn't block the deploy. Only an empty result fails.
    const filtered: Record<string, string> = {};
    for (const name of config.vars) {
      if (name in ctx.env) filtered[name] = ctx.env[name];
    }
    const missing = config.vars.filter((v) => !(v in ctx.env));
    if (Object.keys(filtered).length === 0) {
      steps.push({
        label: `filter vars (${config.vars.length} declared)`,
        status: 'fail',
        detail: `none present in branch ${config.branch} — nothing to push`,
      });
      return { ok: false, steps };
    }
    steps.push({
      label: `filter vars (${config.vars.length} declared)`,
      status: 'ok',
      detail:
        `${Object.keys(filtered).length} var(s) for ${opts.pathPrefix}` +
        (missing.length > 0
          ? ` — skipped ${missing.length} not in branch ${config.branch} (${missing.join(', ')})`
          : ''),
    });

    // 2. Resolve the caller identity before any value leaves the process —
    // this is the ambient-credential check, and the account id feeds the
    // valueFrom ARNs in the wiring snippet below.
    const sts = await spawnAsync('aws', [
      'sts', 'get-caller-identity', '--output', 'json', '--region', opts.region,
    ]);
    if (sts.code !== 0) {
      steps.push({
        label: 'aws sts get-caller-identity',
        status: 'fail',
        detail: lastLines(sts.stderr),
      });
      return { ok: false, steps };
    }
    let account = '';
    let callerArn = '';
    try {
      const id = JSON.parse(sts.stdout);
      account = id.Account ?? '';
      callerArn = id.Arn ?? '';
    } catch {
      steps.push({
        label: 'aws sts get-caller-identity',
        status: 'fail',
        detail: 'unparseable response',
      });
      return { ok: false, steps };
    }
    steps.push({
      label: 'aws identity',
      status: 'ok',
      detail: `${account}${callerArn ? ` (${callerArn})` : ''}`,
    });

    // 3. Oversize check BEFORE pushing anything, so a too-big value can't
    // leave the target half-written.
    const tooBig = Object.entries(filtered).filter(
      ([, v]) => Buffer.byteLength(v, 'utf-8') > ADVANCED_TIER_MAX,
    );
    if (tooBig.length > 0) {
      steps.push({
        label: 'ssm put-parameter',
        status: 'fail',
        detail: `${tooBig.map(([k]) => k).join(', ')} exceed the ${ADVANCED_TIER_MAX / 1024}KB advanced-tier limit`,
      });
      return { ok: false, steps };
    }

    // 4. One put-parameter per var. Abort on first failure: every parameter
    // is overwrite-idempotent, so the user just re-runs after fixing.
    let created = 0;
    let overwritten = 0;
    const advanced: string[] = [];
    const pushed: Array<{ varName: string; paramName: string }> = [];
    for (const [varName, value] of Object.entries(filtered)) {
      const paramName = parameterNameFor(varName, opts);
      const needsAdvanced = Buffer.byteLength(value, 'utf-8') > STANDARD_TIER_MAX;
      if (needsAdvanced) advanced.push(varName);
      const r = await awsWithSecretInput(
        ['ssm', 'put-parameter', '--region', opts.region, '--output', 'json'],
        {
          Name: paramName,
          Value: value,
          Type: 'SecureString',
          Overwrite: true,
          ...(needsAdvanced ? { Tier: 'Advanced' } : {}),
        },
      );
      if (r.code !== 0) {
        steps.push({
          label: 'ssm put-parameter',
          status: 'fail',
          detail: `${paramName}: ${lastLines(r.stderr)}${pushed.length ? ` (${pushed.length} already pushed)` : ''}`,
        });
        return { ok: false, steps };
      }
      try {
        const out = JSON.parse(r.stdout);
        if (out.Version === 1) created++;
        else overwritten++;
      } catch {
        overwritten++;
      }
      pushed.push({ varName, paramName });
    }
    steps.push({
      label: 'ssm put-parameter',
      status: 'ok',
      detail:
        `${pushed.length}/${pushed.length} SecureString under ${opts.pathPrefix}` +
        (created > 0 ? ` (${created} new)` : '') +
        (advanced.length > 0 ? ` (advanced tier: ${advanced.join(', ')})` : ''),
    });

    // 5. No code-ship step for SSM — say what happens next instead.
    steps.push({
      label: 'runtime refresh',
      status: 'skip',
      detail: ctx.secretsOnly
        ? 'CI mode — your pipeline redeploys on PR merge'
        : 'values are live; tasks pick them up on next start',
    });

    // New parameters mean the user's task definition doesn't reference them
    // yet — print the wiring once, when it's actually needed.
    const epilogue =
      created > 0
        ? renderWiringSnippet(pushed, opts, account)
        : undefined;

    return { ok: true, steps, epilogue };
  },
};

/**
 * The task-definition / IAM wiring for the parameters just pushed. Printed
 * (not applied): capy never edits the user's IaC.
 */
export function renderWiringSnippet(
  pushed: Array<{ varName: string; paramName: string }>,
  opts: AwsSsmOptions,
  account: string,
): string {
  const arnBase = `arn:aws:ssm:${opts.region}:${account}:parameter`;
  const pad = Math.max(...pushed.map((p) => p.varName.length));
  const secretLines = pushed
    .map(
      (p) =>
        `      { "name": "${p.varName}",${' '.repeat(pad - p.varName.length)} "valueFrom": "${arnBase}${p.paramName}" }`,
    )
    .join(',\n');
  return [
    '  Wire these into your task definition (env var name ← parameter):',
    '',
    '    "secrets": [',
    secretLines,
    '    ]',
    '',
    '  Execution role needs (replaces any per-ARN grants):',
    '',
    '    { "Action": ["ssm:GetParameter", "ssm:GetParameters"],',
    `      "Resource": "${arnBase}${opts.pathPrefix}*" }`,
    '',
    '  Already wired? Nothing to do — values are live on next task start.',
  ].join('\n');
}
