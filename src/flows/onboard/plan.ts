// Compat verdict + the dry-run onboarding plan. Computes everything and writes
// nothing.
//
// Moved here from the MCP server, unchanged except for one deletion: the
// in-process plan store is gone. A plan used to live in a Map keyed by planId,
// which died with the process — a restart turned an approved plan into "re-run
// the scan". The plan now travels to the flow service at instance creation and
// lives with the instance, so it survives any client restart, and `planHash` is
// what binds an approval to the exact plan that was shown.
import { randomUUID, createHash } from 'node:crypto';
import { computeRunWrapEdits, readEnvKeys, type Edit } from './edits';
import { computeAgentDocsEdits } from './agentDocs';
import { checkClis, type CliRequirement } from './clis';
import { inferConnectors, type InferredConnector } from './providers';
import { normalizeTarget, type DeployTargetInfo } from './deployTargets';

export const INTEGRATE_URL = 'https://capy.sc/integrate';

export interface CompatFindings {
  usesEnvVars: boolean;
  framework?: string;
  externalSecretManager?: string;
}

export interface CompatVerdict {
  compatible: boolean;
  reason: string;
  integrateUrl?: string;
}

export function checkCompat(f: CompatFindings): CompatVerdict {
  if (f.externalSecretManager) {
    return {
      compatible: false,
      reason: `This project already uses an external secret manager (${f.externalSecretManager}), so Capy isn't a fit here yet.`,
      integrateUrl: INTEGRATE_URL,
    };
  }
  if (!f.usesEnvVars) {
    const detected = f.framework ? ` (detected: ${f.framework})` : '';
    return {
      compatible: false,
      reason: `This project doesn't appear to read configuration from environment variables${detected}. Capy injects secrets as env vars at runtime, so there's nothing for it to wire up here yet.`,
      integrateUrl: INTEGRATE_URL,
    };
  }
  const fw = f.framework ? ` (${f.framework})` : '';
  return { compatible: true, reason: `Compatible${fw}: reads configuration from environment variables.` };
}

export interface PlanInput {
  targetDir: string;
  framework?: string;
  deployTargets?: string[];
  envVarNames?: string[];
}

export interface PlanDeployTarget {
  target: string;
  label: string;
  cli?: string;
  autoWire: boolean;
}

export interface OnboardPlan {
  planId: string;
  planHash: string;
  targetDir: string;
  framework?: string;
  diffs: Edit[];
  connectors: InferredConnector[];
  deployTargets: PlanDeployTarget[];
  recommendedClis: string[];
  /** Every CLI this project needs, each marked present or missing, with why. */
  cliChecks: CliRequirement[];
  confirmDialog: string;
}

export function buildPlan(input: PlanInput): OnboardPlan {
  const diffs = [...computeRunWrapEdits(input.targetDir), ...computeAgentDocsEdits(input.targetDir)];
  const envKeys = [...new Set([...(input.envVarNames ?? []), ...readEnvKeys(input.targetDir)])];
  const connectors = inferConnectors(envKeys);

  const targets: DeployTargetInfo[] = [];
  for (const t of input.deployTargets ?? []) {
    const info = normalizeTarget(t);
    if (info && !targets.some((x) => x.target === info.target)) targets.push(info);
  }

  const recommendedClis = [
    ...new Set([
      ...connectors.filter((c) => c.status === 'implemented' && c.cli).map((c) => c.cli as string),
      ...targets.map((t) => t.cli).filter((c): c is string => Boolean(c)),
    ]),
  ];

  const cliChecks = checkClis(recommendedClis);

  const deployTargets: PlanDeployTarget[] = targets.map((t) => ({ target: t.target, label: t.label, cli: t.cli, autoWire: t.autoWire }));
  const planHash = createHash('sha256').update(JSON.stringify(diffs)).digest('hex');
  const planId = randomUUID();
  const confirmDialog = renderDialog(input, diffs, connectors, deployTargets, cliChecks);

  const plan: OnboardPlan = {
    planId,
    planHash,
    targetDir: input.targetDir,
    framework: input.framework,
    diffs,
    connectors,
    deployTargets,
    recommendedClis,
    cliChecks,
    confirmDialog,
  };
  return plan;
}

/** A parenthetical beside a section title. Plain text — this crosses to a browser too. */
const DIM_NOTE = (s: string) => `(${s})`;

function renderDialog(
  input: PlanInput,
  diffs: Edit[],
  connectors: InferredConnector[],
  deployTargets: PlanDeployTarget[],
  cliChecks: CliRequirement[],
): string {
  // A CHECKLIST, in sections. The old layout was one label column with every
  // fact glued into a run-on value — connectors wrapped past the fold, the
  // variable that named each provider was missing entirely, and "supported
  // today" sat in the same column as a file path. Nothing here is new
  // information; it is the same plan with the sections separated and a marker
  // per row, so a person can see at a glance what will change (✓) and what is
  // only being reported (○).
  const L: string[] = [];
  const section = (title: string, note?: string) => {
    const head = note ? `${title}  ${DIM_NOTE(note)}` : title;
    // Rule the full header, note included — a 12-char rule under a 40-char
    // heading reads as a rendering bug rather than a divider.
    L.push('', head, '─'.repeat(head.length));
  };

  L.push('Capy onboarding plan', '═'.repeat(20));

  section('STACK');
  L.push(`  ${'Directory'.padEnd(11)} ${input.targetDir}`);
  if (input.framework) L.push(`  ${'Framework'.padEnd(11)} ${input.framework}`);

  if (cliChecks.length) {
    // A checklist, not a list. `installed` is the whole point: "stripe, vercel"
    // told you nothing about which of them you already had, so the only way to
    // act on it was to go and check each one by hand.
    const missing = cliChecks.filter((c) => !c.installed).length;
    section('CLIs', missing ? `${missing} to install` : 'all present');
    const w = Math.max(...cliChecks.map((c) => c.cli.length));
    for (const c of cliChecks) {
      L.push(`  ${c.installed ? '✓' : '☐'}  ${c.cli.padEnd(w)}  ${c.why}`);
    }
  }

  section('RUN COMMANDS');
  const runEdits = diffs.filter((d) => d.kind === 'run-wrap' && !d.noop);
  const runNoops = diffs.filter((d) => d.kind === 'run-wrap' && d.noop);
  if (!runEdits.length && !runNoops.length) L.push('  ·  nothing detected to wrap');
  for (const e of runEdits) L.push(`  ✓  ${e.path.padEnd(14)} ${e.summary}`);
  for (const e of runNoops) L.push(`  ·  ${e.path.padEnd(14)} ${e.summary}`);

  if (deployTargets.length) {
    // NOT wired here, on purpose: config that cannot be validated without a
    // real deploy is not worth generating. `capy deploy` is the tested path.
    section('DEPLOY TARGETS', 'nothing wired');
    for (const t of deployTargets) L.push(`  ○  ${t.label.padEnd(14)} run \`capy deploy\``);
  }

  if (connectors.length) {
    // Also not wired: `capy connect` is a chain of provider sign-ins, and
    // firing them mid-onboarding is the most fatiguing thing this flow could
    // do. Naming them costs nothing and is the most actionable thing here.
    section('CONNECTORS', 'detected — nothing connected');
    const w = Math.max(...connectors.map((c) => c.provider.length));
    const v = Math.max(...connectors.map((c) => c.matchedVars.join(', ').length));
    for (const c of connectors) {
      const mark = c.status === 'implemented' ? '✓' : '○';
      const vars = c.matchedVars.join(', ');
      const hint =
        c.status === 'implemented' && c.cli
          ? `\`capy connect ${c.provider.toLowerCase()}\``
          : c.dashboardUrl
            ? `manual — ${c.dashboardUrl}`
            : 'manual';
      L.push(`  ${mark}  ${c.provider.padEnd(w)}  ${vars.padEnd(v)}  ${hint}`);
    }
  }

  section('FILES TO CHANGE', 'dry run');
  if (diffs.length) {
    for (const d of diffs) {
      L.push(`  ${d.noop ? '·' : '~'}  ${d.path.padEnd(14)} ${d.summary}${d.noop ? '  (already done)' : ''}`);
    }
  } else {
    L.push('  ·  no file changes needed');
  }

  L.push('', 'Proceed?  yes  /  edit  /  no');
  return L.join('\n');
}
