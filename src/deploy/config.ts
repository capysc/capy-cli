/**
 * `.capy/deploy.json` — per-project deploy targets.
 *
 * Lives next to keep.lock so it ships with the repo. No secrets, just
 * adapter ids, worker names, branch coupling, and var lists. Safe to commit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TargetConfig } from './adapter';

export interface DeployConfigFile {
  version: '1';
  targets: Record<string, TargetConfig>;
}

const FILE_VERSION = '1';

export function deployConfigPath(cwd: string): string {
  return join(cwd, '.capy', 'deploy.json');
}

export function readDeployConfig(cwd: string): DeployConfigFile | null {
  const p = deployConfigPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== FILE_VERSION) {
      throw new Error(
        `Unsupported deploy.json version: ${raw.version}. Update the CLI.`,
      );
    }
    if (!raw.targets || typeof raw.targets !== 'object') {
      return { version: FILE_VERSION, targets: {} };
    }
    return raw as DeployConfigFile;
  } catch (err: any) {
    if (err.message?.startsWith('Unsupported deploy.json')) throw err;
    throw new Error(`deploy.json is malformed: ${err.message}`);
  }
}

export function writeDeployConfig(cwd: string, cfg: DeployConfigFile): void {
  const p = deployConfigPath(cwd);
  mkdirSync(join(cwd, '.capy'), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function upsertTarget(
  cwd: string,
  target: TargetConfig,
): DeployConfigFile {
  const cfg: DeployConfigFile =
    readDeployConfig(cwd) ?? { version: FILE_VERSION, targets: {} };
  cfg.targets[target.name] = target;
  writeDeployConfig(cwd, cfg);
  return cfg;
}

export function removeTarget(cwd: string, name: string): boolean {
  const cfg = readDeployConfig(cwd);
  if (!cfg || !(name in cfg.targets)) return false;
  delete cfg.targets[name];
  writeDeployConfig(cwd, cfg);
  return true;
}

export function getTarget(cwd: string, name: string): TargetConfig | null {
  const cfg = readDeployConfig(cwd);
  return cfg?.targets[name] ?? null;
}

export function listTargets(cwd: string): TargetConfig[] {
  const cfg = readDeployConfig(cwd);
  if (!cfg) return [];
  return Object.values(cfg.targets);
}
