import { ConnectorMetadata } from '../../types/index';
import { ResolvedContext } from './shared';

export interface ConnectOpts {
  live?: boolean;
  var?: string;
  account?: string;
  noPush?: boolean;
  force?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
}

export interface RotateOpts {
  noPush?: boolean;
  /** Disable interactive prompts: resolve every choice from flags or fail fast. */
  nonTty?: boolean;
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
