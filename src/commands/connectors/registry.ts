import { ConnectorMetadata } from '../../types/index';
import type { Blocked } from '../../ui/screens/contract';
import { ResolvedContext } from './shared';

export interface ConnectOpts {
  live?: boolean;
  var?: string;
  account?: string;
  noPush?: boolean;
  force?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
  /**
   * Render this command's questions as compiled screens in a local browser.
   *
   * Not the same axis as `nonTty`, and the pairing is the whole point: the
   * caller `--web` exists for runs with piped stdio, so `isInteractive()` is
   * already false and every picker below has either defaulted or refused
   * without asking. `--web` is what turns those back into questions.
   */
  web?: boolean;
  /**
   * A `capy-dev` binary. Live mode is refused outright, so the mode question
   * says so beside the option rather than accepting it and exiting afterwards.
   */
  devMode?: boolean;
}

export interface RotateOpts {
  noPush?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
  /** Render this command's questions as compiled screens in a local browser. */
  web?: boolean;
}

/** Result of provider.connect(): the provider hands us a value + the connector metadata to record on the keep.lock entry. */
export interface ConnectResult {
  varName: string;
  value: string;
  entry: ConnectorMetadata;
}

/** Result of provider.rotate(): the new value, plus updated connector metadata (rotated_at, expires_at, fingerprint refreshed). */
export interface RotateResult {
  value: string;
  entry: ConnectorMetadata;
}

export interface ConnectorModule {
  name: string;
  description: string;
  /**
   * Set when rotating runs an interactive auth step the user must complete by
   * hand (e.g. Stripe shells out to `stripe login`, which opens a browser).
   * Surfaced as a leading "Auth" stop in the rotate plan so the user knows a
   * manual hand-off is coming. Omit for providers that rotate unattended.
   */
  requiresAuth?: boolean;
  /** Local binary `precheck` looks for, e.g. `stripe`. */
  requiresTool?: string;
  /**
   * Non-exiting form of `precheck`, for a list that previews whether a
   * connector can run. `precheck` itself exits the process, so the only way to
   * learn this today is to pick the connector and be refused.
   */
  toolInstalled?(): boolean;
  /**
   * The refusal `precheck` makes when `requiresTool` is missing.
   *
   * ONE object, so the preview in the connector list and the wall the command
   * runs into are the same condition rather than two — same code, same install
   * link, same command to run. Two screens wording one condition differently is
   * a bug in the product.
   */
  toolMissing?: Blocked;
  /**
   * Synchronous pre-check that runs before any auth or network. Use to bail
   * early on missing local dependencies (e.g. provider CLI not installed) so
   * we don't waste a user's OAuth round-trip on a request that can't succeed.
   * Should call `process.exit` or throw on failure.
   */
  precheck?(): void;
  connect(ctx: ResolvedContext, opts: ConnectOpts): Promise<ConnectResult>;
  rotate(
    ctx: ResolvedContext,
    varName: string,
    previous: ConnectorMetadata,
    opts: RotateOpts,
  ): Promise<RotateResult>;
}

/** Registered providers, keyed by name (matches `connector.provider` on each keep.lock entry). */
export const providers: Record<string, () => Promise<ConnectorModule>> = {
  stripe: async () => (await import('./stripe')).stripeConnector,
};

export function listProviders(): { name: string; description: string }[] {
  return [
    { name: 'stripe', description: 'Stripe API key (test or live, restricted)' },
  ];
}

export async function loadProvider(name: string): Promise<ConnectorModule> {
  const loader = providers[name];
  if (!loader) throw new Error(`Unknown connector: ${name}`);
  return loader();
}
