// The connector-support map: which providers `capy connect` actually supports
// today vs which we only RECOGNIZE by env-var name. Baked in for v1 (mirrors the
// connector spec); a `capy connectors --json` CLI surface can replace it later.
// IMPORTANT: only Stripe is implemented today — everything else is "planned" and
// must be surfaced as recognized-but-manual so the dialog never over-promises.

export interface ProviderInfo {
  provider: string;
  status: 'implemented' | 'planned';
  cli?: string;
  dashboardUrl?: string;
  patterns: RegExp[];
}

export const PROVIDERS: ProviderInfo[] = [
  { provider: 'Stripe', status: 'implemented', cli: 'stripe', dashboardUrl: 'https://dashboard.stripe.com', patterns: [/^STRIPE_/i, /^RESTRICTED_KEY$/i] },
  { provider: 'Supabase', status: 'planned', cli: 'supabase', dashboardUrl: 'https://app.supabase.com', patterns: [/^SUPABASE_/i] },
  { provider: 'GitHub', status: 'planned', cli: 'gh', dashboardUrl: 'https://github.com/settings/tokens', patterns: [/^GITHUB_TOKEN$/i, /^GH_TOKEN$/i, /^GITHUB_PAT$/i] },
  { provider: 'AWS', status: 'planned', cli: 'aws', dashboardUrl: 'https://console.aws.amazon.com', patterns: [/^AWS_(SECRET_ACCESS_KEY|ACCESS_KEY_ID|REGION)$/i] },
  { provider: 'OpenAI', status: 'planned', cli: undefined, dashboardUrl: 'https://platform.openai.com/api-keys', patterns: [/^OPENAI_API_KEY$/i] },
  { provider: 'Anthropic', status: 'planned', cli: undefined, dashboardUrl: 'https://console.anthropic.com', patterns: [/^ANTHROPIC_API_KEY$/i] },
  { provider: 'Sentry', status: 'planned', cli: 'sentry-cli', dashboardUrl: 'https://sentry.io', patterns: [/^SENTRY_DSN$/i, /^SENTRY_AUTH_TOKEN$/i] },
  { provider: 'Cloudflare', status: 'planned', cli: 'wrangler', dashboardUrl: 'https://dash.cloudflare.com', patterns: [/^CLOUDFLARE_/i, /^CF_/i, /^WRANGLER_/i] },
  { provider: 'Vercel', status: 'planned', cli: 'vercel', dashboardUrl: 'https://vercel.com/account/tokens', patterns: [/^VERCEL_/i] },
  { provider: 'Datadog', status: 'planned', cli: undefined, dashboardUrl: 'https://app.datadoghq.com', patterns: [/^DATADOG_/i, /^DD_/i] },
  { provider: 'Database', status: 'planned', cli: undefined, dashboardUrl: undefined, patterns: [/^DATABASE_URL$/i, /^POSTGRES_/i, /^MONGODB?_URI$/i] },
];

export interface InferredConnector {
  provider: string;
  status: 'implemented' | 'planned';
  cli?: string;
  dashboardUrl?: string;
  matchedVars: string[];
}

/** Map env var NAMES to providers. Names only — never values. */
export function inferConnectors(envVarNames: string[]): InferredConnector[] {
  const out = new Map<string, InferredConnector>();
  for (const name of envVarNames) {
    for (const p of PROVIDERS) {
      if (!p.patterns.some((re) => re.test(name))) continue;
      const existing = out.get(p.provider);
      if (existing) {
        if (!existing.matchedVars.includes(name)) existing.matchedVars.push(name);
      } else {
        out.set(p.provider, { provider: p.provider, status: p.status, cli: p.cli, dashboardUrl: p.dashboardUrl, matchedVars: [name] });
      }
    }
  }
  return [...out.values()];
}
