import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FileManager } from '../files/fileManager';

export type ExportFormat = 'dotenv' | 'json' | 'shell';

export interface ExportOptions {
  format?: ExportFormat;
  vars?: string[];
}

interface ResolvedEnv {
  vars: Record<string, string>;
}

async function resolveEnv(devMode: boolean): Promise<ResolvedEnv> {
  const fm = new FileManager();
  const envFromFile = fm.readEnvFile();

  const toDecrypt: Array<[string, string]> = [];
  const plaintext: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(envFromFile)) {
    if (typeof v !== 'string') continue;
    if (fm.isEncrypted(v)) toDecrypt.push([k, v]);
    else plaintext.push([k, v]);
  }

  const out: Record<string, string> = {};
  for (const [k, v] of plaintext) out[k] = v;

  if (toDecrypt.length === 0) return { vars: out };

  const keepPath = join(process.cwd(), 'keep.lock');
  if (!existsSync(keepPath)) {
    throw new Error('no keep.lock in the current directory. Run `capy` here first to sync.');
  }

  let orgId: string | undefined;
  let projectId: string | undefined;
  try {
    const keep = JSON.parse(readFileSync(keepPath, 'utf-8'));
    orgId = keep?.org_id;
    projectId = keep?.project_id;
  } catch {
    throw new Error('keep.lock is malformed. Run `capy` to re-sync.');
  }
  if (!orgId || !projectId) {
    throw new Error('keep.lock missing org_id/project_id. Run `capy` to re-sync.');
  }

  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveProjectKey } = await import('../crypto/keyResolver');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(orgId);
  if (!result.success || !result.user_id) {
    throw new Error('not authenticated. Run `capy` to sign in.');
  }

  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());
  const keyServiceOps = {
    coDecrypt: (o: string, c: string) => svc.coDecrypt(o, c).then(r => r.plaintext),
    wrapOuterLayer: (o: string, p: string) => svc.wrapOuterLayer(o, p).then(r => r.ciphertext),
    getEpoch: (o: string) => svc.getEpoch(o).then(r => r.epoch),
    getEpochEscrows: (o: string) => svc.getEpochEscrows(o).then(r => r.escrows),
  };

  const projectKeyHex = await resolveProjectKey(orgId, projectId, result.user_id, keyServiceOps);

  for (const [k, v] of toDecrypt) {
    try {
      out[k] = fm.decryptValue(v, projectKeyHex);
    } catch (err: any) {
      throw new Error(`failed to decrypt "${k}": ${err.message}`);
    }
  }

  return { vars: out };
}

export function dotenvEscape(value: string): string {
  // Quote when value contains whitespace, quotes, $, #, =, or newlines.
  // Within double quotes, escape backslash, quote, and newline.
  if (/^[A-Za-z0-9_./:@,+-]*$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export function shellEscape(value: string): string {
  // Single-quote everything; escape embedded single quotes via '\''.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatExport(vars: Record<string, string>, fmt: ExportFormat): string {
  const keys = Object.keys(vars).sort();
  if (fmt === 'json') {
    const ordered: Record<string, string> = {};
    for (const k of keys) ordered[k] = vars[k];
    return JSON.stringify(ordered, null, 2) + '\n';
  }
  if (fmt === 'shell') {
    return keys.map(k => `export ${k}=${shellEscape(vars[k])}`).join('\n') + '\n';
  }
  return keys.map(k => `${k}=${dotenvEscape(vars[k])}`).join('\n') + '\n';
}

export async function exportCommand(
  options: ExportOptions = {},
  devMode: boolean = false,
): Promise<number> {
  const fmt: ExportFormat = options.format ?? 'dotenv';
  if (!['dotenv', 'json', 'shell'].includes(fmt)) {
    process.stderr.write(`capy export: unknown format "${fmt}". Use dotenv|json|shell.\n`);
    return 1;
  }

  let resolved: ResolvedEnv;
  try {
    resolved = await resolveEnv(devMode);
  } catch (err: any) {
    process.stderr.write(`capy export: ${err.message}\n`);
    return 1;
  }

  let vars = resolved.vars;
  if (options.vars && options.vars.length > 0) {
    const filtered: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of options.vars) {
      if (name in vars) filtered[name] = vars[name];
      else missing.push(name);
    }
    if (missing.length > 0) {
      process.stderr.write(`capy export: missing var(s): ${missing.join(', ')}\n`);
      return 1;
    }
    vars = filtered;
  }

  process.stdout.write(formatExport(vars, fmt));
  return 0;
}
