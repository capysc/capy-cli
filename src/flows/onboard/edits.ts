// Deterministic, idempotent edit computation for onboarding. Reads the actual
// files in an app directory and computes the precise run-command wraps. Reads
// env files for variable NAMES only — never values.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';

/**
 * The command onboarding writes into run scripts, e.g. `capy run -- `.
 *
 * It has to name the binary the user will actually run, and a dev/staging build
 * keeps its session in a separate home — a script wrapped with plain `capy`
 * would run against a CLI with no session for the project that was just
 * onboarded, and fail "unauthenticated" on a project that is in fact synced. So
 * the wrap tracks THIS binary's own name when that name is a real capy name,
 * and falls back to plain `capy` for anything else (a test stub, a wrapper).
 */
export function capyRunPrefix(): string {
  const name = basename(process.argv[1] ?? 'capy');
  return /^capy(-[A-Za-z0-9]+)?$/.test(name) ? `${name} run -- ` : 'capy run -- ';
}

export interface Edit {
  path: string; // relative to the target app directory
  action: 'create' | 'modify';
  kind: 'run-wrap' | 'deploy-wire' | 'agent-docs';
  before: string | null;
  after: string;
  summary: string;
  noop: boolean;
}

// The wrap we WRITE tracks the binary this server actually runs (`capy` vs a
// dev/staging build with its own session home) — see capyRunPrefix.
const CAPY_PREFIX = capyRunPrefix();
// What counts as ALREADY wrapped: any capy-ish binary, by bare name or full
// path. Keeps the edits idempotent across binaries — re-onboarding a project
// that was wrapped with a different capy build must not stack a second wrap.
const WRAPPED_RE = /^\S*capy[\w-]*\s+run\s+--\s+/;
const NODE_SCRIPTS = ['dev', 'start', 'serve'];

function detectIndent(text: string): string | number {
  const m = text.match(/\n([ \t]+)"/);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

function packageJsonEdit(targetDir: string): Edit | null {
  const pkgPath = join(targetDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const before = readFileSync(pkgPath, 'utf8');

  let parsed: { scripts?: Record<string, unknown> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(before);
  } catch {
    return null;
  }
  if (!parsed.scripts || typeof parsed.scripts !== 'object') return null;

  const scripts: Record<string, unknown> = { ...parsed.scripts };
  const wrapped: string[] = [];
  let already = false;
  for (const name of NODE_SCRIPTS) {
    const val = scripts[name];
    if (typeof val !== 'string' || !val.trim()) continue;
    if (WRAPPED_RE.test(val)) {
      already = true;
      continue;
    }
    scripts[name] = CAPY_PREFIX + val;
    wrapped.push(name);
  }

  if (wrapped.length > 0) {
    const after = JSON.stringify({ ...parsed, scripts }, null, detectIndent(before)) + '\n';
    return { path: 'package.json', action: 'modify', kind: 'run-wrap', before, after, summary: `wrap ${wrapped.join(', ')} script(s) with \`${CAPY_PREFIX.trim()}\``, noop: false };
  }
  if (already) {
    return { path: 'package.json', action: 'modify', kind: 'run-wrap', before, after: before, summary: 'scripts already wrapped with `capy run --`', noop: true };
  }
  return null;
}

function procfileEdit(targetDir: string): Edit | null {
  const procPath = join(targetDir, 'Procfile');
  if (!existsSync(procPath)) return null;
  const before = readFileSync(procPath, 'utf8');

  let changed = false;
  let already = false;
  const after = before
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*[A-Za-z0-9_-]+:\s*)(.+)$/);
      if (!m) return line;
      const [, prefix, cmd] = m;
      if (WRAPPED_RE.test(cmd)) {
        already = true;
        return line;
      }
      changed = true;
      return prefix + CAPY_PREFIX + cmd;
    })
    .join('\n');

  if (changed) {
    return { path: 'Procfile', action: 'modify', kind: 'run-wrap', before, after, summary: 'wrap Procfile process command(s) with `capy run --`', noop: false };
  }
  if (already) {
    return { path: 'Procfile', action: 'modify', kind: 'run-wrap', before, after: before, summary: 'Procfile already wrapped with `capy run --`', noop: true };
  }
  return null;
}

/** Compute the run-command wrap edits for an app directory. Idempotent. */
export function computeRunWrapEdits(targetDir: string): Edit[] {
  const edits: Edit[] = [];
  for (const fn of [packageJsonEdit, procfileEdit]) {
    const e = fn(targetDir);
    if (e) edits.push(e);
  }
  return edits;
}

/** Read env var NAMES from any env files in the directory. Never reads values. */
export function readEnvKeys(targetDir: string): string[] {
  const keys = new Set<string>();
  // The dotless `env.example` / `env.sample` spellings are common (capysc's
  // own test-project ships one) and were previously invisible here, so a repo
  // that documents its variables that way read as "uses no env vars at all".
  for (const f of ['.env.example', '.env', '.env.local', '.env.sample', 'env.example', 'env.sample']) {
    const p = join(targetDir, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}
