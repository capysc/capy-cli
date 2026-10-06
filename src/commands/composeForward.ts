import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join, resolve } from 'path';

/**
 * `capy run -- docker compose …` support.
 *
 * Containers don't inherit the environment of the `docker compose` process:
 * `env_file: .env` makes compose read the file on disk — ciphertext — so the
 * values `capy run` decrypted never reach the container. Compose only forwards
 * its own environment for `environment:` entries that name a variable without
 * a value. So we hand compose one extra file, listing only the NAMES of the
 * decrypted vars for every service whose `env_file` is the Capy-managed `.env`:
 *
 *   {"services":{"app":{"environment":["DB_PASSWORD","APP_KEY"]}}}
 *
 * (JSON is valid YAML.) No values are ever written: compose resolves each name
 * from the environment `capy run` gives it. On POSIX the override is piped in
 * on fd 3 (`-f /dev/fd/3`), keeping stdin free for `run`/`exec`; on Windows,
 * which has no /dev/fd, it goes in a temp file removed when the child exits.
 */

/** Compose's global flags that take a value (`-f x` or `--file=x`). */
const VALUE_FLAGS = new Set([
  '-f', '--file', '-p', '--project-name', '--project-directory', '--env-file',
  '--profile', '--ansi', '--parallel', '--progress',
]);

/** Default file names, in compose's own lookup order. */
const DEFAULT_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Where the override goes when it's piped rather than written. */
export const OVERRIDE_FD = 3;

export interface ComposeInvocation {
  /** argv up to and including `compose` (`['docker','compose']` or `['docker-compose']`). */
  readonly head: readonly string[];
  /** Global flags between `compose` and the subcommand. */
  readonly globals: readonly string[];
  /** The subcommand and everything after it. */
  readonly rest: readonly string[];
}

/** Splits `docker compose …` / `docker-compose …` argv; undefined for anything else. */
export function parseComposeArgs(args: readonly string[]): ComposeInvocation | undefined {
  const bin = args[0] === undefined ? '' : basename(args[0]).replace(/\.exe$/i, '');
  const headLen = bin === 'docker' && args[1] === 'compose' ? 2 : bin === 'docker-compose' ? 1 : 0;
  if (headLen === 0) return undefined;
  const after = args.slice(headLen);
  // `-f=x` / `--file=x` carry their own value, so only a bare value flag eats the next arg.
  const subIdx = after.findIndex((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(after[i - 1] ?? ''));
  const split = subIdx === -1 ? after.length : subIdx;
  return { head: args.slice(0, headLen), globals: after.slice(0, split), rest: after.slice(split) };
}

/** Values of a global flag, in order (`-f a --file=b` → `['a','b']`). */
function flagValues(globals: readonly string[], names: readonly string[]): string[] {
  return globals.flatMap((a, i) => {
    if (names.includes(a)) return globals[i + 1] === undefined ? [] : [globals[i + 1]];
    const prefix = names.filter((n) => n.startsWith('--')).map((n) => `${n}=`).find((p) => a.startsWith(p));
    return prefix ? [a.slice(prefix.length)] : [];
  });
}

/**
 * The files compose would load without our extra `-f` — because once any `-f`
 * is passed, compose stops discovering defaults (including the override file).
 * Undefined when we can't tell, in which case the caller leaves argv alone.
 */
export function resolveComposeFiles(
  globals: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): string[] | undefined {
  const explicit = flagValues(globals, ['-f', '--file']);
  if (explicit.length > 0) return explicit;
  if (env.COMPOSE_FILE) return env.COMPOSE_FILE.split(env.COMPOSE_PATH_SEPARATOR || delimiter).filter(Boolean);
  if (flagValues(globals, ['--project-directory']).length > 0) return undefined;
  const main = DEFAULT_FILES.find((f) => exists(join(cwd, f)));
  if (!main) return undefined;
  const override = main.replace(/\.(ya?ml)$/, '.override.$1');
  return exists(join(cwd, override)) ? [main, override] : [main];
}

/** Service name → its `env_file` entries, from `docker compose config --no-interpolate`. */
export type ComposeEnvFiles = Record<string, string[]>;

/**
 * Asks compose itself which services read which env files, so we never parse
 * YAML. `--no-interpolate` keeps `env_file` instead of inlining its values.
 */
export function readComposeEnvFiles(head: readonly string[], globals: readonly string[], cwd: string): ComposeEnvFiles | undefined {
  const r = spawnSync(head[0], [...head.slice(1), ...globals, 'config', '--format', 'json', '--no-interpolate'], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0 || !r.stdout) return undefined;
  try {
    const services: Record<string, { env_file?: unknown }> = JSON.parse(r.stdout).services ?? {};
    return Object.fromEntries(
      Object.entries(services).map(([name, svc]) => {
        const raw = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
        const paths = raw.map((e) => (typeof e === 'string' ? e : (e as { path?: string })?.path)).filter((p): p is string => typeof p === 'string');
        return [name, paths];
      }),
    );
  } catch {
    return undefined;
  }
}

/** The override body: decrypted var NAMES for each service whose env_file is `envPath`. */
export function buildOverride(envFiles: ComposeEnvFiles, envPath: string, keys: readonly string[], cwd: string): string | undefined {
  const target = resolve(envPath);
  const services = Object.keys(envFiles).filter((s) => envFiles[s].some((p) => resolve(cwd, p) === target));
  if (services.length === 0 || keys.length === 0) return undefined;
  const sorted = [...keys].sort();
  return JSON.stringify({ services: Object.fromEntries(services.map((s) => [s, { environment: sorted }])) });
}

export interface ComposePlan {
  /** argv to spawn instead of the user's. */
  readonly args: string[];
  /** Override body to write to fd {@link OVERRIDE_FD}, when piped. */
  readonly pipe?: string;
  /** Removes the temp file, when not piped. */
  readonly cleanup: () => void;
}

export interface ComposeDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly exists?: (p: string) => boolean;
  readonly readEnvFiles?: typeof readComposeEnvFiles;
}

/**
 * Rewrites `docker compose …` so services reading `envPath` get the decrypted
 * `keys` forwarded from capy's environment. Undefined = run argv unchanged.
 */
export function planComposeForward(
  args: readonly string[],
  envPath: string,
  keys: readonly string[],
  deps: ComposeDeps,
): ComposePlan | undefined {
  const inv = parseComposeArgs(args);
  if (!inv) return undefined;
  const files = resolveComposeFiles(inv.globals, deps.cwd, deps.env, deps.exists);
  if (!files) return undefined;
  const envFiles = (deps.readEnvFiles ?? readComposeEnvFiles)(inv.head, inv.globals, deps.cwd);
  if (!envFiles) return undefined;
  const body = buildOverride(envFiles, envPath, keys, deps.cwd);
  if (!body) return undefined;

  // Our -f goes last so it merges over the user's files; the user's own -f
  // flags (if any) stay where they were, otherwise we name the defaults.
  const userFiles = flagValues(inv.globals, ['-f', '--file']).length > 0 ? [] : files.flatMap((f) => ['-f', f]);
  const build = (overridePath: string): string[] => [
    ...inv.head, ...inv.globals, ...userFiles, '-f', overridePath, ...inv.rest,
  ];

  if (deps.platform !== 'win32') {
    return { args: build(`/dev/fd/${OVERRIDE_FD}`), pipe: body, cleanup: () => undefined };
  }
  const dir = mkdtempSync(join(tmpdir(), 'capy-compose-'));
  const file = join(dir, 'override.json');
  writeFileSync(file, body, { mode: 0o600 });
  return { args: build(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
