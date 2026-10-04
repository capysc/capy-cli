/**
 * The Dokploy dashboard URL: ONE resolver for every path that needs it (CAP-703) -
 * `capy deploy dokploy --discover`, `capy connect dokploy --discover`, the
 * single-service `capy connect dokploy` import and the `capy deploy` setup picker.
 *
 * Order:
 *   1. `--base-url`
 *   2. the org system variable `_CONNECTOR_DOKPLOY_BASE_URL` (same store as the API key)
 *   3. the Dokploy target already saved in the current folder's `.capy/deploy.json`
 *   4. a structured refusal: `DOKPLOY_SETTINGS_MISSING` with `unanswered: [{ id: 'base_url', ... }]`
 *
 * Saving: a `--base-url` given while the variable is unset, by someone who can open the (admin-only)
 * system store, is saved to it - normalised, no prompt. A non-admin gets a `BASE_URL_NOT_SAVED`
 * notice with the reason code. A flag that differs from the stored URL wins for this run, never
 * overwrites, and adds `BASE_URL_DIFFERS_FROM_STORED`. A dry run saves nothing.
 *
 * The URL is not a secret and may be printed; it still goes through the encrypted store path.
 * Decisions key on codes and statuses only, never on message text.
 */
import { baseUrlProblem } from './adapters/dokploy';
import { DOKPLOY_BASE_URL_VAR_NAME } from './dokployApi';
import { ERROR_CODES } from '../types/index';

export type BaseUrlSource = 'flag' | 'system' | 'saved_target';

export interface BaseUrlNotice {
  readonly code: 'BASE_URL_NOT_SAVED' | 'BASE_URL_DIFFERS_FROM_STORED';
  /** `BASE_URL_NOT_SAVED`: why, as a code (`SYSTEM_STORE_ADMIN_ONLY`, `DRY_RUN`, ...). */
  readonly reason?: string;
  /** `BASE_URL_DIFFERS_FROM_STORED`: the stored URL and the one used for this run. */
  readonly stored?: string;
  readonly used?: string;
}

/** The two operations on the system variable. Opening the store is what needs an admin: a failure carries a code. */
export interface BaseUrlStore {
  get(name: string): string | null;
  set(name: string, value: string): Promise<void>;
}

export interface ResolveBaseUrlOptions {
  /** `--base-url` */
  readonly flag?: string;
  /** Saves nothing when true. */
  readonly dryRun?: boolean;
  /** Opens the org system store. Absent: the system variable is not consulted (an offline caller). Rejects with a coded error when the caller cannot open it. */
  readonly openStore?: () => Promise<BaseUrlStore>;
  /** The base URL of a Dokploy target saved in the current folder's deploy.json. */
  readonly savedTargetUrl: () => string | undefined;
}

export type ResolvedBaseUrl =
  | {
      readonly ok: true;
      readonly baseUrl: string;
      readonly source: BaseUrlSource;
      /** `{ base_url: true }` when this run saved it to the system variable. */
      readonly saved?: { readonly base_url: true };
      readonly notices: readonly BaseUrlNotice[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      readonly unanswered?: readonly Unanswered[];
    };

/** Trimmed, no trailing slash. `null` when it is not a usable Dokploy URL (the shared rule: https, or http on loopback). */
export function normalizeDokployBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return baseUrlProblem(trimmed) === null ? trimmed : null;
}

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : ERROR_CODES.SERVICE_ERROR;
};

/** One thing a refusal says is still needed, as a flag. */
export interface Unanswered {
  readonly id: string;
  readonly flag: string;
  readonly hint: string;
  readonly alternative?: string;
}

const BASE_URL_UNANSWERED: Unanswered = { id: 'base_url', flag: '--base-url', hint: 'your Dokploy dashboard URL, e.g. https://dokploy.example.com' }; // COPY-FLAG
const SERVICE_UNANSWERED: Unanswered = { id: 'service', flag: '--application', alternative: '--compose', hint: 'the Dokploy application or compose service id' }; // COPY-FLAG

/**
 * The `unanswered` of every `DOKPLOY_SETTINGS_MISSING` refusal, in every Dokploy command that cannot ask: the base URL
 * (always), and the service id when that is missing too. Same shape everywhere, so an agent branches on one thing.
 */
export function settingsUnanswered(needs: { readonly baseUrl: boolean; readonly service?: boolean }): readonly Unanswered[] {
  return [...(needs.baseUrl ? [BASE_URL_UNANSWERED] : []), ...(needs.service === true ? [SERVICE_UNANSWERED] : [])];
}

const missing = (): ResolvedBaseUrl => ({
  ok: false,
  code: 'DOKPLOY_SETTINGS_MISSING',
  error: 'No Dokploy base URL. Pass --base-url <url>.', // COPY-FLAG
  unanswered: [BASE_URL_UNANSWERED],
});

const invalid = (what: string): ResolvedBaseUrl => ({
  ok: false,
  code: ERROR_CODES.DOKPLOY_URL_INVALID,
  error: `The ${what} is not a usable Dokploy URL: it must be https (http only on localhost).`, // COPY-FLAG
});

type StoreRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly code: string }
  | { readonly kind: 'ready'; readonly store: BaseUrlStore; readonly stored: string | null };

async function readStore(openStore: ResolveBaseUrlOptions['openStore']): Promise<StoreRead> {
  if (openStore === undefined) return { kind: 'none' };
  try {
    const store = await openStore();
    return { kind: 'ready', store, stored: store.get(DOKPLOY_BASE_URL_VAR_NAME) };
  } catch (err) {
    return { kind: 'unreadable', code: codeOf(err) };
  }
}

/** First `--base-url`: save it when the variable is unset and the caller may; otherwise say why not. */
async function flagOutcome(flagUrl: string, read: StoreRead, dryRun: boolean): Promise<Extract<ResolvedBaseUrl, { ok: true }>> {
  const base = { ok: true as const, baseUrl: flagUrl, source: 'flag' as const };
  if (read.kind === 'none') return { ...base, notices: [] };
  if (read.kind === 'unreadable') return { ...base, notices: [{ code: 'BASE_URL_NOT_SAVED', reason: read.code }] };
  const stored = read.stored === null ? null : normalizeDokployBaseUrl(read.stored) ?? read.stored;
  if (stored !== null) {
    return {
      ...base,
      notices: stored === flagUrl ? [] : [{ code: 'BASE_URL_DIFFERS_FROM_STORED', stored, used: flagUrl }],
    };
  }
  if (dryRun) return { ...base, notices: [{ code: 'BASE_URL_NOT_SAVED', reason: 'DRY_RUN' }] };
  try {
    await read.store.set(DOKPLOY_BASE_URL_VAR_NAME, flagUrl);
    return { ...base, saved: { base_url: true }, notices: [] };
  } catch (err) {
    return { ...base, notices: [{ code: 'BASE_URL_NOT_SAVED', reason: codeOf(err) }] };
  }
}

/** The one resolver. See the file doc for the order and the saving rules. */
export async function resolveDokployBaseUrl(opts: ResolveBaseUrlOptions): Promise<ResolvedBaseUrl> {
  const flagRaw = opts.flag?.trim();
  const flagUrl = flagRaw ? normalizeDokployBaseUrl(flagRaw) : undefined;
  if (flagRaw && flagUrl === null) return invalid('--base-url');
  const read = await readStore(opts.openStore);
  if (flagUrl) return flagOutcome(flagUrl, read, opts.dryRun === true);

  if (read.kind === 'ready' && read.stored !== null) {
    const stored = normalizeDokployBaseUrl(read.stored);
    return stored === null
      ? invalid(`system variable ${DOKPLOY_BASE_URL_VAR_NAME}`)
      : { ok: true, baseUrl: stored, source: 'system', notices: [] };
  }
  const savedRaw = opts.savedTargetUrl()?.trim();
  if (savedRaw) {
    const saved = normalizeDokployBaseUrl(savedRaw);
    return saved === null ? invalid('Dokploy target saved in deploy.json') : { ok: true, baseUrl: saved, source: 'saved_target', notices: [] };
  }
  return missing();
}

/** The real system store, opened for `orgId` (admin-only: it rejects with `SYSTEM_STORE_ADMIN_ONLY` otherwise). */
export function realBaseUrlStoreOpener(orgId: string, devMode: boolean): () => Promise<BaseUrlStore> {
  return async () => {
    const { openSystemStore } = await import('../system/systemStore');
    return openSystemStore({ orgId, devMode });
  };
}

/** The URL of the first Dokploy target saved in `cwd`'s deploy.json, or `undefined` (no file, malformed, none). */
export async function savedDokployTargetUrl(cwd: string): Promise<string | undefined> {
  const { listTargets } = await import('./config');
  try {
    const target = listTargets(cwd).find((t) => t.kind === 'dokploy');
    const baseUrl = (target?.options as { baseUrl?: unknown } | undefined)?.baseUrl;
    return typeof baseUrl === 'string' ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

// ── A prompt collected the URL: offer to save it (admins only) ───────────────

const SAVED_LINE = 'Saved the Dokploy URL for your org.'; // COPY-FLAG
const NOT_ADMIN_LINE = 'Not saved for the org: only org admins can save the Dokploy URL.'; // COPY-FLAG

const dim = (line: string): string => `\x1b[90m${line}\x1b[0m`;

/**
 * After a terminal prompt collected a valid Dokploy URL: save it to the system variable through the shared resolver's save
 * path, and ONLY when the variable is unset and the caller may open the (admin-only) store. An existing value is never
 * overwritten. One short dim line on stderr says what happened: saved, or not saved because only admins can. Whether the
 * caller is an admin is the store's own structured answer (`SYSTEM_STORE_ADMIN_ONLY`), never a message.
 */
export async function offerSaveAskedBaseUrl(args: {
  readonly baseUrl: string;
  readonly openStore?: () => Promise<BaseUrlStore>;
  readonly dryRun?: boolean;
  /** Where the one line goes. Default: dim, on stderr. */
  readonly log?: (line: string) => void;
}): Promise<{ readonly saved: boolean }> {
  if (args.openStore === undefined) return { saved: false };
  const log = args.log ?? ((line: string) => console.error(dim(line)));
  const resolved = await resolveDokployBaseUrl({
    flag: args.baseUrl,
    dryRun: args.dryRun === true,
    openStore: args.openStore,
    savedTargetUrl: () => undefined,
  });
  if (!resolved.ok) return { saved: false };
  if (resolved.saved !== undefined) {
    log(SAVED_LINE);
    return { saved: true };
  }
  if (resolved.notices.some((n) => n.code === 'BASE_URL_NOT_SAVED' && n.reason === ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY)) log(NOT_ADMIN_LINE);
  return { saved: false };
}
