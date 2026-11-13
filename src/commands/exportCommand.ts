import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FileManager } from '../files/fileManager';
import { ERROR_CODES } from '../types/index';

export type ExportFormat = 'dotenv' | 'json' | 'shell';

export interface ExportOptions {
  format?: ExportFormat;
  vars?: string[];
  /** Export even when the folder's branch is protected. */
  allowProtected?: boolean;
}

interface ResolvedEnv {
  vars: Record<string, string>;
}

/** The protected-branch gate said no. Carries its stable code so the caller never reads the message. */
class ProtectedGateRefusal extends Error {
  constructor(
    readonly code: typeof ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG | typeof ERROR_CODES.PROTECTED_STATUS_UNREADABLE,
    message: string,
  ) {
    super(message);
  }
}

/** keep.lock's org and project ids; throws the same errors the inline checks did. */
function readKeepIds(keepPath: string): { orgId: string; projectId: string } {
  const keep = (() => {
    try {
      return JSON.parse(readFileSync(keepPath, 'utf-8'));
    } catch {
      throw new Error('keep.lock is malformed. Run `capy` to re-sync.');
    }
  })();
  const orgId: string | undefined = keep?.org_id;
  const projectId: string | undefined = keep?.project_id;
  if (!orgId || !projectId) {
    throw new Error('keep.lock missing org_id/project_id. Run `capy` to re-sync.');
  }
  return { orgId, projectId };
}

async function resolveEnv(devMode: boolean, allowProtected: boolean): Promise<ResolvedEnv> {
  const fm = new FileManager();
  const envFromFile = fm.readEnvFile();

  const entries = Object.entries(envFromFile).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  const toDecrypt = entries.filter(([, v]) => fm.isEncrypted(v));
  const plaintext: Record<string, string> = Object.fromEntries(entries.filter(([, v]) => !fm.isEncrypted(v)));

  if (toDecrypt.length === 0) return { vars: plaintext };

  const keepPath = join(process.cwd(), 'keep.lock');
  if (!existsSync(keepPath)) {
    throw new Error('no keep.lock in the current directory. Run `capy` here first to sync.');
  }

  const { orgId, projectId } = readKeepIds(keepPath);

  const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveProjectKey } = await import('../crypto/keyResolver');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(orgId);
  if (!result.success || !result.user_id) {
    throw new Error(silentAuthFailureMessage(result));
  }

  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());

  // Protected branches: the server says, before anything is decrypted. A local-only
  // profile has no server-side protection and is not asked.
  const { isLocalOnly } = await import('../config/profileConfig');
  if (!isLocalOnly()) {
    const { ProjectManager } = await import('../core/projectManager');
    const { checkProtectedBranchGate } = await import('../core/protectedBranchGate');
    const gate = await checkProtectedBranchGate({
      allowProtected,
      branch: new ProjectManager().deriveActiveBranch(),
      projectId,
      listBranches: (id) => svc.listBranches(id),
    });
    if (!gate.ok) throw new ProtectedGateRefusal(gate.code, gate.message);
  }

  const keyServiceOps = {
    coDecrypt: (o: string, c: string) => svc.coDecrypt(o, c).then(r => r.plaintext),
    wrapOuterLayer: (o: string, p: string) => svc.wrapOuterLayer(o, p).then(r => r.ciphertext),
  };

  const projectKeyHex = await resolveProjectKey(orgId, projectId, result.user_id, keyServiceOps);

  const decrypted = toDecrypt.map(([k, v]) => {
    try {
      return [k, fm.decryptValue(v, projectKeyHex)] as const;
    } catch (err: any) {
      throw new Error(`failed to decrypt "${k}": ${err.message}`);
    }
  });

  return { vars: { ...plaintext, ...Object.fromEntries(decrypted) } };
}

/** The one stderr line for a failed resolve: coded for the gate, the plain message for everything else. */
function failureLine(err: unknown): string {
  if (err instanceof ProtectedGateRefusal) return `capy export: [${err.code}] ${err.message}\n`;
  return `capy export: ${(err as Error).message}\n`;
}

type ResolveOutcome =
  | { readonly ok: true; readonly resolved: ResolvedEnv }
  | { readonly ok: false; readonly error: unknown };

async function settleResolve(devMode: boolean, allowProtected: boolean): Promise<ResolveOutcome> {
  try {
    return { ok: true, resolved: await resolveEnv(devMode, allowProtected) };
  } catch (error) {
    return { ok: false, error };
  }
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

  const outcome = await settleResolve(devMode, options.allowProtected === true);
  if (!outcome.ok) {
    process.stderr.write(failureLine(outcome.error));
    return 1;
  }

  const wanted = options.vars ?? [];
  const missing = wanted.filter((name) => !(name in outcome.resolved.vars));
  if (wanted.length > 0 && missing.length > 0) {
    process.stderr.write(`capy export: missing var(s): ${missing.join(', ')}\n`);
    return 1;
  }
  const vars =
    wanted.length > 0
      ? Object.fromEntries(wanted.map((name) => [name, outcome.resolved.vars[name]]))
      : outcome.resolved.vars;

  process.stdout.write(formatExport(vars, fmt));
  return 0;
}
