/**
 * CAP-702: deploy targets that are configured but have never received a
 * push. They count as behind, in `capy edit` and in `capy secrets`.
 *
 * "Configured" means the target is in `.capy/deploy.json` as committed on
 * the repo's default branch (read from local git, `origin/<default>`), so a
 * `capy deploy dokploy --discover` PR that never merges never counts.
 *
 * `capy edit` reads this directly. `capy secrets` only reads the server, so
 * `recordConfiguredTargets` adds one
 * placeholder record per configured (variable, target) that has none:
 * `{ provider, target }` with no `deployed_value_hash`, which the server's
 * index already reports as stale. The first real `capy deploy` to that target
 * replaces it (same provider + target). Not `deployed: false`: that means
 * "values pushed, release not triggered", and nothing was pushed here.
 */
import type { TargetConfig } from './adapter';
import type { KeepFile, KeepVariableEntry, TargetDelivery } from '../types/index';
import { readFileAtRef, repoRelPath, resolveDefaultBranch } from './git';

/** Where `.capy/deploy.json` sits relative to the project folder (same place `deployConfigPath` points). */
const DEPLOY_CONFIG_REL = '.capy/deploy.json';

/** The targets in `.capy/deploy.json` on `origin/<default branch>`; `[]` when there is no such file or it can't be read. */
export function readDefaultBranchTargets(cwd: string): readonly TargetConfig[] {
  try {
    const defaultBranch = resolveDefaultBranch(cwd);
    if (!defaultBranch) return [];
    const raw = readFileAtRef(cwd, `origin/${defaultBranch}`, repoRelPath(cwd, DEPLOY_CONFIG_REL));
    return raw === null ? [] : parseTargets(raw);
  } catch {
    return [];
  }
}

function parseTargets(raw: string): readonly TargetConfig[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== '1' || !isRecord(parsed.targets)) return [];
    return Object.values(parsed.targets).filter(isTargetConfig);
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTargetConfig(value: unknown): value is TargetConfig {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.branch === 'string' &&
    Array.isArray(value.vars) &&
    value.vars.every((v) => typeof v === 'string')
  );
}

export interface MissingTargetRecord {
  readonly varName: string;
  readonly provider: string;
  readonly target: string;
}

function entryFor(keep: KeepFile, varName: string, branch: string): KeepVariableEntry | undefined {
  return keep.variables[varName]?.find((e) => e.branch === branch);
}

function hasRecord(entry: KeepVariableEntry, provider: string, target: string): boolean {
  return (entry.targets ?? []).some((t) => t.provider === provider && t.target === target);
}

/** Configured targets on `branch` that ship `varName` but have no record on that variable's keep entry. */
export function unrecordedTargetsFor(
  targets: readonly TargetConfig[],
  keep: KeepFile | undefined,
  varName: string,
  branch: string,
): readonly TargetConfig[] {
  const entry = keep ? entryFor(keep, varName, branch) : undefined;
  if (!entry) return [];
  return targets.filter((t) => t.branch === branch && t.vars.includes(varName) && !hasRecord(entry, t.kind, t.name));
}

/** Every configured (variable, target) on `branch` whose variable exists in Capy but has no record for that target. */
export function missingTargetRecords(targets: readonly TargetConfig[], keep: KeepFile, branch: string): readonly MissingTargetRecord[] {
  return targets
    .filter((t) => t.branch === branch)
    .flatMap((t) =>
      t.vars
        .filter((varName) => unrecordedTargetsFor([t], keep, varName, branch).length > 0)
        .map((varName) => ({ varName, provider: t.kind, target: t.name })),
    );
}

/** `keep` with a placeholder record added for each missing one. Returns `keep` itself when there is nothing to add. */
export function withPlaceholderRecords(keep: KeepFile, branch: string, missing: readonly MissingTargetRecord[]): KeepFile {
  if (missing.length === 0) return keep;
  const variables = Object.fromEntries(
    Object.entries(keep.variables).map(([varName, entries]) => {
      const added = missing.filter((m) => m.varName === varName);
      if (added.length === 0) return [varName, entries];
      return [
        varName,
        entries.map((entry) => {
          if (entry.branch !== branch) return entry;
          const placeholders: readonly TargetDelivery[] = added.map((m) => ({ provider: m.provider, target: m.target }));
          return { ...entry, targets: [...(entry.targets ?? []), ...placeholders] };
        }),
      ];
    }),
  );
  return { ...keep, variables };
}

/** What `recordConfiguredTargets` needs from the service client. */
export interface ConfiguredTargetsClient {
  getLatestSecrets(projectId: string, branch: string): Promise<{ env_file: string; keep_hash: string; keep_file?: string } | null>;
  pushSecrets(projectId: string, keepFile: string, envBlob: string, branch?: string): Promise<unknown>;
}

/**
 * NOT WIRED: held until Vince approves an automatic server write (2026-10-04).
 * Meant to run after a bare `capy` sync, as one call in capyCommand.ts.
 *
 * Records configured-but-never-pushed targets on
 * the server, so `capy secrets` sees them. Builds on the SERVER's own keep
 * file (it holds CI-mode records the local keep.lock may not have yet) and
 * re-sends that branch's blob unchanged. One write per branch, only when a
 * record is missing; nothing on a dry run. Best-effort: a failure never
 * changes the command's result.
 */
export async function recordConfiguredTargets(input: {
  cwd: string;
  projectId: string;
  client: ConfiguredTargetsClient;
  dryRun: boolean;
}): Promise<{ readonly recorded: number }> {
  if (input.dryRun) return { recorded: 0 };
  const targets = readDefaultBranchTargets(input.cwd);
  const branches = [...new Set(targets.map((t) => t.branch))];
  const counts = await Promise.all(branches.map((branch) => recordBranch(input, targets, branch)));
  return { recorded: counts.reduce((a, b) => a + b, 0) };
}

async function recordBranch(
  input: { projectId: string; client: ConfiguredTargetsClient },
  targets: readonly TargetConfig[],
  branch: string,
): Promise<number> {
  try {
    const latest = await input.client.getLatestSecrets(input.projectId, branch);
    const keep = latest?.keep_file ? parseKeep(latest.keep_file) : undefined;
    if (!latest || !keep) return 0;
    const missing = missingTargetRecords(targets, keep, branch);
    if (missing.length === 0) return 0;
    await input.client.pushSecrets(input.projectId, JSON.stringify(withPlaceholderRecords(keep, branch, missing)), latest.env_file, branch);
    return missing.length;
  } catch {
    return 0;
  }
}

function parseKeep(raw: string): KeepFile | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && isRecord(parsed.variables) ? (parsed as unknown as KeepFile) : undefined;
  } catch {
    return undefined;
  }
}
