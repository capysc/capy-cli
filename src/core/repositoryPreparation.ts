/** Local onboarding facts and guarded edits. Public summaries contain names, never file contents. */
import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { listProviders } from '../commands/connectors/registry';

export interface RepositoryDiscovery {
  readonly stack: readonly string[];
  readonly evidence_files: readonly string[];
}
export interface PreparationEdit {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly description: string;
}
export interface PreparationSummary {
  readonly stack: readonly string[];
  readonly services: readonly { readonly id: string; readonly name: string; readonly connection: 'available' | 'manual'; readonly variable_names: readonly string[] }[];
  readonly file_changes: readonly { readonly path: string; readonly description: string }[];
  readonly env_files: readonly string[];
}
export interface RepositoryPreparation {
  readonly edits: readonly PreparationEdit[];
  readonly evidence: readonly { readonly path: string; readonly hash: string }[];
  readonly summary: PreparationSummary;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export class RepositoryPreparationError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new RepositoryPreparationError(code); };
const sortedStrings = (values: readonly string[]): readonly string[] => values.reduce<readonly string[]>((sorted, value) => {
  const index = sorted.findIndex((candidate) => candidate > value);
  return index === -1 ? [...sorted, value] : [...sorted.slice(0, index), value, ...sorted.slice(index)];
}, []);
const relativeFile = (value: string): boolean => /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.startsWith('/')
  && !value.split('/').some((part) => ['..', '.', '', '.git', '.capy', 'node_modules'].includes(part));
const privateEvidence = (value: string): boolean => value.split('/').some((part) => /^\.env|^env\.(?:example|sample)(?:\.|$)/i.test(part));
const readLocal = (root: string, path: string): string => {
  if (!relativeFile(path)) return fail('SETUP_DISCOVERY_PATH_INVALID');
  // Refuse directory symlinks too: a relative spelling must not escape the repository.
  const parts = path.split('/');
  for (const index of parts.keys()) {
    const stat = lstatSync(join(root, ...parts.slice(0, index + 1)));
    if (stat.isSymbolicLink() || (index === parts.length - 1 && (!stat.isFile() || stat.size > 1_048_576))) {
      return fail('SETUP_DISCOVERY_FILE_UNSAFE');
    }
  }
  return readFileSync(join(root, path), 'utf8');
};
const RUN_SCRIPTS = ['dev', 'start', 'serve'] as const;
const wrapped = (command: string): boolean => /^\S*capy[\w-]*\s+run\s+--\s+/.test(command);
const object = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Historical package/Procfile wrapping, now immutable and confined to the approved repository. */
export function computeRepositoryEdits(root: string, binary: string): readonly PreparationEdit[] {
  if (!/^capy(?:-[A-Za-z0-9]+)?$/.test(binary)) return fail('SETUP_BINARY_INVALID');
  const prefix = `${binary} run -- `;
  const packageEdit = (): readonly PreparationEdit[] => {
    if (!existsSync(join(root, 'package.json'))) return [];
    const before = readLocal(root, 'package.json');
    const parsed: unknown = JSON.parse(before);
    if (!object(parsed)) return fail('SETUP_MANIFEST_INVALID');
    if (parsed.scripts === undefined) return [];
    if (!object(parsed.scripts)) return fail('SETUP_MANIFEST_INVALID');
    const scripts = parsed.scripts;
    const names = RUN_SCRIPTS.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim() && !wrapped(scripts[name]));
    if (!names.length) return [];
    const nextScripts = Object.fromEntries(Object.entries(scripts).map(([name, value]) =>
      [name, names.includes(name as typeof RUN_SCRIPTS[number]) ? `${prefix}${value}` : value]));
    const indentation = /\n([ \t]+)"/.exec(before)?.[1] ?? '  ';
    return [{ path: 'package.json', before, after: `${JSON.stringify({ ...parsed, scripts: nextScripts }, null, indentation)}\n`,
      description: `Run ${names.join(', ')} scripts through ${binary} run.` }];
  };
  const procfileEdit = (): readonly PreparationEdit[] => {
    if (!existsSync(join(root, 'Procfile'))) return [];
    const before = readLocal(root, 'Procfile');
    const lines = before.split('\n').map((line) => {
      const match = /^(\s*[A-Za-z0-9_-]+:\s*)(.+)$/.exec(line);
      return match && !wrapped(match[2]!) ? `${match[1]}${prefix}${match[2]}` : line;
    });
    const after = lines.join('\n');
    return after === before ? [] : [{ path: 'Procfile', before, after, description: `Run process commands through ${binary} run.` }];
  };
  return [...packageEdit(), ...procfileEdit()];
}

// Recognition patterns are historical; availability is read from the current executable connector registry.
const recognizable = [
  { id: 'stripe', name: 'Stripe', pattern: /^(?:STRIPE_|RESTRICTED_KEY$)/i },
  { id: 'supabase', name: 'Supabase', pattern: /^(?:(?:NEXT_PUBLIC_|VITE_)?)SUPABASE_/i },
  { id: 'github', name: 'GitHub', pattern: /^(?:GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT)$/i },
  { id: 'aws', name: 'AWS', pattern: /^AWS_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID|REGION)$/i },
  { id: 'openai', name: 'OpenAI', pattern: /^OPENAI_API_KEY$/i },
  { id: 'anthropic', name: 'Anthropic', pattern: /^ANTHROPIC_API_KEY$/i },
  { id: 'sentry', name: 'Sentry', pattern: /^(?:(?:NEXT_PUBLIC_|VITE_)?)SENTRY_(?:DSN|AUTH_TOKEN)$/i },
  { id: 'cloudflare', name: 'Cloudflare', pattern: /^(?:CLOUDFLARE_|CF_|WRANGLER_)/i },
  { id: 'vercel', name: 'Vercel', pattern: /^VERCEL_/i },
  { id: 'datadog', name: 'Datadog', pattern: /^(?:DATADOG_|DD_)/i },
  { id: 'database', name: 'Database', pattern: /^(?:DATABASE_URL$|POSTGRES_|MONGODB?_URI$)/i },
] as const;
const envCandidates = ['.env', '.env.local', '.env.example', '.env.sample', 'env.example', 'env.sample'] as const;
export function inferRepositoryServices(names: readonly string[]): PreparationSummary['services'] {
  const available = listProviders().map((provider) => provider.name);
  return recognizable.flatMap((provider) => {
    const matches = sortedStrings([...new Set(names.filter((name) => provider.pattern.test(name)))]);
    return matches.length ? [{ id: provider.id, name: provider.name,
      connection: available.includes(provider.id) ? 'available' as const : 'manual' as const, variable_names: matches }] : [];
  });
}

export function prepareRepository(root: string, discovery: RepositoryDiscovery, binary = basename(process.argv[1] ?? 'capy')): RepositoryPreparation {
  if (!Array.isArray(discovery.stack) || !Array.isArray(discovery.evidence_files) || discovery.stack.length > 32
    || discovery.evidence_files.length > 64 || discovery.stack.some((label) => !/^[A-Za-z0-9 .+/#_-]{1,64}$/.test(label))
    || (discovery.stack.length > 0 && discovery.evidence_files.length === 0)) return fail('SETUP_DISCOVERY_INVALID');
  const evidence = discovery.evidence_files.map((path) => {
    if (path.length > 255 || privateEvidence(path)) return fail('SETUP_DISCOVERY_PATH_INVALID');
    return { path, hash: digest(readLocal(root, path)) };
  });
  const edits = computeRepositoryEdits(root, binary);
  const names = envCandidates.flatMap((path) => existsSync(join(root, path))
    ? readLocal(root, path).split('\n').flatMap((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return match ? [match[1]!] : [];
    }) : []);
  return { edits, evidence, summary: { stack: [...discovery.stack], services: inferRepositoryServices(names),
    file_changes: edits.map(({ path, description }) => ({ path, description })), env_files: [] } };
}

export function composeRepositoryPlan(base: Readonly<Record<string, unknown>>, preparation: RepositoryPreparation): Readonly<Record<string, unknown>> {
  if (base.ok !== true || typeof base.plan_hash !== 'string' || !Array.isArray(base.will_write)) return base;
  const writes = base.will_write as readonly string[];
  const env_files = writes.filter((path) => path === '.env');
  const file_changes = [...preparation.summary.file_changes, ...writes.filter((path) => !env_files.some((env) => env === path)
    && !preparation.summary.file_changes.some((change) => change.path === path)).map((path) => ({ path,
    description: path === 'keep.lock' ? 'Save this repository’s project binding.' : 'Update this file through the approved Capy setup.' }))];
  const summary = { ...preparation.summary, file_changes, env_files };
  const plan_hash = `sha256:${digest(JSON.stringify({ base: base.plan_hash, summary, evidence: preparation.evidence,
    edits: preparation.edits.map((edit) => ({ path: edit.path, before: digest(edit.before), after: digest(edit.after) })) }))}`;
  return { ...base, plan_hash, summary, will_write: [...new Set([...writes, ...preparation.edits.map((edit) => edit.path)])] };
}

/** Preflight all edits before any write. A concurrent change never becomes implicit consent. */
export function applyRepositoryEdits(root: string, edits: readonly PreparationEdit[]): void {
  for (const edit of edits) {
    if (readLocal(root, edit.path) !== edit.before) return fail('SETUP_FILES_CHANGED');
  }
  for (const edit of edits) {
    if (readLocal(root, edit.path) !== edit.before) return fail('SETUP_FILES_CHANGED');
    writeFileSync(join(root, edit.path), edit.after);
  }
}
