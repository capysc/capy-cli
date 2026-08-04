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

/**
 * "This file is from a newer CLI" — a typed class, so the catch below can
 * recognise it without reading its sentence.
 *
 * The version check and the catch that has to let it through are eight lines
 * apart in the same function, and they used to be joined by
 * `err.message?.startsWith('Unsupported deploy.json')`. Rewording that
 * sentence — including just moving the version number to the front — would
 * have turned "update the CLI" into "deploy.json is malformed", which sends
 * someone to edit a file that is perfectly well-formed.
 */
export class UnsupportedDeployConfigVersion extends Error {
  constructor(public readonly version: unknown) {
    super(`Unsupported deploy.json version: ${version}. Update the CLI.`);
    this.name = 'UnsupportedDeployConfigVersion';
  }
}

export function readDeployConfig(cwd: string): DeployConfigFile | null {
  const p = deployConfigPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== FILE_VERSION) {
      throw new UnsupportedDeployConfigVersion(raw.version);
    }
    if (!raw.targets || typeof raw.targets !== 'object') {
      return { version: FILE_VERSION, targets: {} };
    }
    return raw as DeployConfigFile;
  } catch (err: any) {
    if (err instanceof UnsupportedDeployConfigVersion) throw err;
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
