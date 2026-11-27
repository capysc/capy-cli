/**
 * Discovery for `capy setup` (spec 3k section 7, CAP-927): which application services and which deployment targets
 * a folder shows signs of, from NAMES and files only. It replaces pre-discovery (3g).
 *
 * - Services: a variable name in `.env`, a name the code reads (`process.env.X` and the like), or a package
 *   dependency, matched against the catalog in `catalog.json`.
 * - Unmapped: names that match no provider (for example `DATABASE_URL`), with where the code reads them.
 * - Infrastructure: Dokploy, Vercel, AWS SSM and Cloudflare only (Vincent, 2026-11-26), from local files.
 *
 * Never reads a value: `.env` gives names only, `.env*` files are never read as code, and only the names a regex
 * captures leave a file. No network, no provider call, no system store.
 *
 * Pure: every input is a parameter. `walk.ts` supplies the real files.
 */
import catalogData from './catalog.json';
import { DEFAULT_TOKEN_ENV as DOKPLOY_TOKEN_ENV, DOKPLOY_BASE_URL_VAR_NAME, DOKPLOY_CONNECTOR_SECRET_NAME } from '../../deploy/dokployApi';
import { DEFAULT_VERCEL_TOKEN_ENV, VERCEL_CONNECTOR_SECRET_NAME } from '../../deploy/vercelApi';

type Ecosystem = 'npm' | 'pypi' | 'go' | 'gem';

interface CatalogService {
  readonly id: string;
  readonly label: string;
  readonly connector?: boolean;
  readonly env: readonly string[];
  readonly packages?: Partial<Record<Ecosystem, readonly string[]>>;
}

interface Catalog {
  readonly version: number;
  readonly publicPrefixes: readonly string[];
  readonly ignore: readonly string[];
  /** Names that are signals for a deployment target (`infrastructure`), so they are neither a service nor unmapped. */
  readonly infrastructureNames: readonly string[];
  readonly services: readonly CatalogService[];
  readonly infrastructure: {
    readonly vercel: { readonly label: string; readonly files: readonly string[] };
    readonly dokploy: { readonly label: string; readonly composeMarker: string };
    readonly cloudflare: { readonly label: string; readonly files: readonly string[] };
    readonly 'aws-ssm': { readonly label: string; readonly textMarkers: readonly string[] };
  };
}

export const CATALOG: Catalog = catalogData as Catalog;

/** The files a scan saw. Paths are relative to the folder, with `/` separators. */
export interface ScanFile {
  readonly path: string;
  /** The file's text. Only called for files the scan reads; undefined when it cannot be read. */
  readonly text: () => string | undefined;
}

export interface DiscoveryInput {
  readonly files: readonly ScanFile[];
  /** True when the walk stopped at its file cap. */
  readonly truncated: boolean;
  /** The names of the variables in the folder's `.env`. Never the values. */
  readonly envNames: readonly string[];
  /** Whether an environment variable of this name is set to something. */
  readonly envIsSet: (name: string) => boolean;
  /** The binary the next commands start with (`capy`, `capy-dev`, `capy-staging`). */
  readonly bin: string;
}

export interface DiscoveredVariable {
  readonly name: string;
  readonly in_env: boolean;
  /** Up to five `file:line` places the code reads the name. */
  readonly read_in: readonly string[];
}

export interface DiscoveredService {
  readonly provider: string;
  readonly label: string;
  readonly variables: readonly DiscoveredVariable[];
  /** Dependencies that point at the provider, as `<manifest>: <package>`. */
  readonly packages: readonly string[];
  /** `discovered` now; `connected` comes later, when Capy can fetch keys from the provider itself. */
  readonly status: 'discovered';
  /** For providers with a Capy connector: the command that connects it. It changes nothing until the human runs it. */
  readonly next?: string;
}

export interface IntegrationToken {
  /** The system store entry discovery reads. */
  readonly name: string;
  /** `present`: the fallback environment variable is set. `unknown`: setup cannot tell; the dry run in `next` can. */
  readonly state: 'present' | 'unknown';
  /** The environment variable that stands in for the system store entry. */
  readonly env: string;
  /** How an owner or admin saves the token (hidden prompt; a person runs it, in a terminal). */
  readonly set: string;
}

export interface DiscoveredTarget {
  readonly target: 'vercel' | 'dokploy' | 'cloudflare' | 'aws-ssm';
  readonly label: string;
  /** What was found: file paths (with `:line` for a text match), and variable names prefixed with `.env:` or `env:`. */
  readonly found: readonly string[];
  /** Environments a file names (Cloudflare `[env.*]`). Empty when no file names any. */
  readonly environments: readonly string[];
  /** The Capy deploy adapters this target maps to. */
  readonly adapters: readonly string[];
  /** For targets whose discovery needs a token from the system store. */
  readonly token?: IntegrationToken;
  /** Other system store entries discovery reads that are not secrets (a dashboard URL), and how to save each. */
  readonly settings?: readonly { readonly name: string; readonly set: string }[];
  /** What connecting this target needs, in a sentence the agent can show the human. */
  readonly needs: string;
  /** The command that comes next for this target, when one exists. It changes nothing. */
  readonly next?: string;
}

export interface Discovery {
  readonly catalog_version: number;
  readonly services: readonly DiscoveredService[];
  readonly unmapped: readonly DiscoveredVariable[];
  readonly infrastructure: readonly DiscoveredTarget[];
  /** `truncated`: the walk stopped at its file cap. `names_capped`: a list below stopped at its cap. */
  readonly scanned: { readonly files: number; readonly truncated: boolean; readonly names_capped: boolean };
}

const MAX_PLACES = 5;
/** At most this many distinct names from one file (a bundled file can read thousands), and in `unmapped`. */
const MAX_NAMES_PER_FILE = 100;
const MAX_UNMAPPED = 100;

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro',
  '.py', '.go', '.rb', '.rs', '.php', '.ex', '.exs',
]);

/**
 * The usual environment-name shape only: upper case, digits and `_`. A lowercase or mixed-case capture is most likely
 * a value pasted where the name belongs (`getenv("sk_live_...")`) or a method (`process.env.toString`), and is never
 * reported.
 */
const NAME = '([A-Z_][A-Z0-9_]*)(?![A-Za-z0-9_])';
const Q = `["'\`]`;
/** The forms code reads an environment variable in. Each captures the NAME only. */
const READ_PATTERNS: readonly RegExp[] = [
  new RegExp(`process\\.env\\.${NAME}`, 'g'),
  new RegExp(`process\\.env\\[\\s*${Q}${NAME}${Q}\\s*\\]`, 'g'),
  new RegExp(`import\\.meta\\.env\\.${NAME}`, 'g'),
  new RegExp(`Deno\\.env\\.get\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`os\\.environ\\[\\s*${Q}${NAME}${Q}\\s*\\]`, 'g'),
  new RegExp(`os\\.environ\\.get\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`os\\.getenv\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`os\\.Getenv\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`os\\.LookupEnv\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`(?<![A-Za-z0-9_.])ENV\\[\\s*${Q}${NAME}${Q}\\s*\\]`, 'g'),
  new RegExp(`(?<![A-Za-z0-9_.])ENV\\.fetch\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`env::var(?:_os)?\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`(?<![A-Za-z_.])getenv\\(\\s*${Q}${NAME}${Q}`, 'g'),
  new RegExp(`System\\.get_env\\(\\s*${Q}${NAME}${Q}`, 'g'),
];

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/** `.env`, `.env.local`, `.env.example`: never read as code, whatever they hold. */
export function isEnvFile(path: string): boolean {
  return basename(path).startsWith('.env');
}

function isCode(path: string): boolean {
  return !isEnvFile(path) && CODE_EXTENSIONS.has(extension(path));
}

/** A path is `file` itself, or `file` in a subfolder (monorepos). */
function isNamed(path: string, file: string): boolean {
  return path === file || path.endsWith(`/${file}`);
}

/** The offset each line starts at, so a match's line is a binary search, not a rescan of the file. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Upper-case strings that are values, not names: AWS key ids (`AKIA...`), and any long run with no `_` at all, which
 * env names almost always have. Such a capture is never reported.
 */
function looksLikeValue(name: string): boolean {
  return /^(AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{12,}$/.test(name) || (name.length >= 20 && !name.includes('_'));
}

export interface NamesRead {
  /** Each name, with up to five `file:line` places, in the order the files came. */
  readonly places: Map<string, string[]>;
  /** True when a file read more distinct names than the per-file cap, and the rest were left out. */
  readonly capped: boolean;
}

export function namesReadByCode(files: readonly ScanFile[]): NamesRead {
  const places = new Map<string, string[]>();
  let capped = false;
  for (const file of files) {
    if (!isCode(file.path)) continue;
    const text = file.text();
    if (text === undefined) continue;
    let starts: number[] | undefined;
    const inFile = new Set<string>();
    for (const pattern of READ_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (looksLikeValue(name)) continue;
        if (!inFile.has(name)) {
          if (inFile.size >= MAX_NAMES_PER_FILE) {
            capped = true;
            continue;
          }
          inFile.add(name);
        }
        const list = places.get(name) ?? [];
        if (list.length < MAX_PLACES) {
          starts ??= lineStarts(text);
          const at = `${file.path}:${lineAt(starts, match.index ?? 0)}`;
          if (!list.includes(at)) list.push(at);
        }
        places.set(name, list);
      }
    }
  }
  return { places, capped };
}

/** The name with a framework's public prefix removed, so `NEXT_PUBLIC_STRIPE_KEY` matches `^STRIPE_`. */
function withoutPublicPrefix(name: string, catalog: Catalog): string {
  const upper = name.toUpperCase();
  const prefix = catalog.publicPrefixes.find((p) => upper.startsWith(p) && upper.length > p.length);
  return prefix === undefined ? upper : upper.slice(prefix.length);
}

function serviceFor(name: string, catalog: Catalog): CatalogService | undefined {
  const bare = withoutPublicPrefix(name, catalog);
  return catalog.services.find((service) => service.env.some((pattern) => new RegExp(pattern, 'i').test(bare)));
}

/** The dependencies each manifest names, by ecosystem. Rough on purpose: names only, no versions, no lockfiles. */
export function dependencies(files: readonly ScanFile[]): { readonly manifest: string; readonly ecosystem: Ecosystem; readonly name: string }[] {
  const found: { manifest: string; ecosystem: Ecosystem; name: string }[] = [];
  const add = (manifest: string, ecosystem: Ecosystem, names: Iterable<string>) => {
    for (const name of names) found.push({ manifest, ecosystem, name });
  };
  for (const file of files) {
    const name = basename(file.path);
    if (name === 'package.json') {
      const text = file.text();
      if (text === undefined) continue;
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const keys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
          .flatMap((key) => (json[key] !== null && typeof json[key] === 'object' ? Object.keys(json[key] as object) : []));
        add(file.path, 'npm', new Set(keys));
      } catch {
        // An unreadable manifest is a hint lost, never a failure.
      }
    } else if (name === 'requirements.txt' || (name.startsWith('requirements') && name.endsWith('.txt'))) {
      const text = file.text() ?? '';
      add(file.path, 'pypi', text.split('\n').map((line) => line.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1]).filter((n): n is string => n !== undefined));
    } else if (name === 'pyproject.toml') {
      const text = file.text() ?? '';
      const names = [...text.matchAll(/^\s*["']([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?["'],?\s*$/gm)].map((m) => m[1]);
      const poetry = [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*["{]/gm)].map((m) => m[1]);
      add(file.path, 'pypi', new Set([...names, ...poetry]));
    } else if (name === 'go.mod') {
      const text = file.text() ?? '';
      add(file.path, 'go', [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gm)].map((m) => m[1]));
    } else if (name === 'Gemfile') {
      const text = file.text() ?? '';
      add(file.path, 'gem', [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]));
    }
  }
  return found;
}

function packageMatches(pattern: string, name: string, ecosystem: Ecosystem): boolean {
  if (pattern.endsWith('/')) return name.startsWith(pattern);
  if (ecosystem === 'pypi') return name.toLowerCase().replace(/_/g, '-') === pattern.toLowerCase().replace(/_/g, '-');
  if (ecosystem === 'go') return name === pattern || name.startsWith(`${pattern}/`) || name.startsWith(`${pattern}-`);
  return name === pattern;
}

function services(input: DiscoveryInput, readByCode: Map<string, string[]>, catalog: Catalog): { services: DiscoveredService[]; unmapped: DiscoveredVariable[]; capped: boolean } {
  const ignored = new Set(catalog.ignore.map((name) => name.toUpperCase()));
  const infrastructure = catalog.infrastructureNames.map((pattern) => new RegExp(pattern, 'i'));
  const inEnv = new Set(input.envNames);
  const names = [...new Set([...input.envNames, ...readByCode.keys()])].sort();
  const byService = new Map<string, DiscoveredVariable[]>();
  const unmapped: DiscoveredVariable[] = [];
  for (const name of names) {
    const variable: DiscoveredVariable = { name, in_env: inEnv.has(name), read_in: readByCode.get(name) ?? [] };
    const service = serviceFor(name, catalog);
    if (service !== undefined) byService.set(service.id, [...(byService.get(service.id) ?? []), variable]);
    else if (!ignored.has(name.toUpperCase()) && !infrastructure.some((pattern) => pattern.test(name))) unmapped.push(variable);
  }
  const deps = dependencies(input.files);
  const found: DiscoveredService[] = [];
  for (const service of catalog.services) {
    const variables = byService.get(service.id) ?? [];
    const packages = [...new Set(deps
      .filter((dep) => (service.packages?.[dep.ecosystem] ?? []).some((pattern) => packageMatches(pattern, dep.name, dep.ecosystem)))
      .map((dep) => `${dep.manifest}: ${dep.name}`))];
    if (variables.length === 0 && packages.length === 0) continue;
    found.push({
      provider: service.id,
      label: service.label,
      variables,
      packages,
      status: 'discovered',
      ...(service.connector === true ? { next: `${input.bin} connect ${service.id}` } : {}),
    });
  }
  return { services: found, unmapped: unmapped.slice(0, MAX_UNMAPPED), capped: unmapped.length > MAX_UNMAPPED };
}

function token(input: DiscoveryInput, name: string, env: string): IntegrationToken {
  return { name, state: input.envIsSet(env) ? 'present' : 'unknown', env, set: `${input.bin} system set ${name}` };
}

/** `path:line` for each line of the file holding one of the markers. */
function markerLines(file: ScanFile, markers: readonly string[]): string[] {
  const text = file.text();
  if (text === undefined) return [];
  const lines = text.split('\n');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (markers.some((marker) => line.includes(marker))) hits.push(`${file.path}:${i + 1}`);
  });
  return hits;
}

const VERCEL_NAMES = /^VERCEL_(TOKEN|ORG_ID|PROJECT_ID)$/i;

function vercel(input: DiscoveryInput, catalog: Catalog): DiscoveredTarget[] {
  const rule = catalog.infrastructure.vercel;
  const found = [
    ...input.files.filter((file) => rule.files.some((name) => isNamed(file.path, name))).map((file) => file.path),
    ...input.envNames.filter((name) => VERCEL_NAMES.test(name)).map((name) => `.env:${name}`),
    ...(input.envIsSet(DEFAULT_VERCEL_TOKEN_ENV) ? [`env:${DEFAULT_VERCEL_TOKEN_ENV}`] : []),
  ];
  if (found.length === 0) return [];
  return [{
    target: 'vercel',
    label: rule.label,
    found,
    environments: [],
    adapters: ['vercel'],
    token: token(input, VERCEL_CONNECTOR_SECRET_NAME, DEFAULT_VERCEL_TOKEN_ENV),
    needs: 'A Vercel access token, saved by an organization owner or admin.',
    next: `${input.bin} connect vercel --discover --dry-run --json`,
  }];
}

function isCompose(path: string): boolean {
  return /^(docker-)?compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/.test(basename(path));
}

/** Dokploy leaves no file of its own: its signals are variable names and compose files on its network. */
function dokploy(input: DiscoveryInput, catalog: Catalog): DiscoveredTarget[] {
  const rule = catalog.infrastructure.dokploy;
  const found = [
    ...input.files.filter((file) => isCompose(file.path)).flatMap((file) => markerLines(file, [rule.composeMarker])),
    ...input.envNames.filter((name) => /DOKPLOY/i.test(name)).map((name) => `.env:${name}`),
    ...(input.envIsSet(DOKPLOY_TOKEN_ENV) ? [`env:${DOKPLOY_TOKEN_ENV}`] : []),
  ];
  if (found.length === 0) return [];
  return [{
    target: 'dokploy',
    label: rule.label,
    found,
    environments: [],
    adapters: ['dokploy'],
    token: token(input, DOKPLOY_CONNECTOR_SECRET_NAME, DOKPLOY_TOKEN_ENV),
    // Discovery also needs the dashboard URL, which is a system store entry of its own (or `--base-url`).
    settings: [{ name: DOKPLOY_BASE_URL_VAR_NAME, set: `${input.bin} system set ${DOKPLOY_BASE_URL_VAR_NAME}` }],
    needs: 'A Dokploy API key and the dashboard URL, saved by an organization owner or admin.',
    next: `${input.bin} connect dokploy --discover --dry-run --json`,
  }];
}

/** JSONC to JSON: drops line and block comments outside strings, and trailing commas. */
export function withoutJsoncExtras(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Environment names a wrangler file declares: `[env.NAME]` in TOML, the keys of `"env"` in JSON. */
export function wranglerEnvironments(path: string, text: string): string[] {
  if (path.endsWith('.toml')) {
    return [...new Set([...text.matchAll(/^\s*\[{1,2}env\.([A-Za-z0-9_-]+)/gm)].map((m) => m[1]))];
  }
  try {
    const json = JSON.parse(withoutJsoncExtras(text)) as { env?: Record<string, unknown> };
    return json.env !== undefined && typeof json.env === 'object' ? Object.keys(json.env) : [];
  } catch {
    return [];
  }
}

function cloudflare(input: DiscoveryInput, catalog: Catalog): DiscoveredTarget[] {
  const rule = catalog.infrastructure.cloudflare;
  const wrangler = input.files.filter((file) => rule.files.some((name) => isNamed(file.path, name)));
  if (wrangler.length === 0) return [];
  const environments = new Set<string>();
  const adapters = new Set<string>();
  for (const file of wrangler) {
    const text = file.text() ?? '';
    for (const env of wranglerEnvironments(file.path, text)) environments.add(env);
    adapters.add(/pages_build_output_dir/.test(text) ? 'cf-pages' : 'cf-worker');
  }
  return [{
    target: 'cloudflare',
    label: rule.label,
    found: wrangler.map((file) => file.path),
    environments: [...environments].sort(),
    adapters: [...adapters].sort(),
    needs: 'A Cloudflare API token that can edit Workers or Pages. Setup cannot connect it yet; `capy deploy` does.',
  }];
}

function awsSsm(input: DiscoveryInput, catalog: Catalog): DiscoveredTarget[] {
  const rule = catalog.infrastructure['aws-ssm'];
  const candidates = input.files.filter((file) => {
    if (isEnvFile(file.path)) return false;
    const ext = extension(file.path);
    return ext === '.tf' || ext === '.yml' || ext === '.yaml' || ext === '.json' || ext === '.sh' || isCode(file.path);
  });
  const found = candidates.flatMap((file) => markerLines(file, rule.textMarkers));
  if (found.length === 0) return [];
  return [{
    target: 'aws-ssm',
    label: rule.label,
    found: found.slice(0, 10),
    environments: [],
    adapters: ['aws-ssm'],
    needs: 'AWS credentials on the machine that deploys, and the parameter path to write to. Setup cannot connect it yet; `capy deploy` does.',
  }];
}

/** What this folder shows signs of. Every list is empty when it shows none. */
export function discover(input: DiscoveryInput, catalog: Catalog = CATALOG): Discovery {
  const read = namesReadByCode(input.files);
  const found = services(input, read.places, catalog);
  return {
    catalog_version: catalog.version,
    services: found.services,
    unmapped: found.unmapped,
    infrastructure: [...dokploy(input, catalog), ...vercel(input, catalog), ...awsSsm(input, catalog), ...cloudflare(input, catalog)],
    scanned: { files: input.files.length, truncated: input.truncated, names_capped: read.capped || found.capped },
  };
}
