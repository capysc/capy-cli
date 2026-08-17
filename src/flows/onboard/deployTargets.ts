// Deploy targets capy supports, with the CLI each needs and whether the
// onboarding analyzer AUTO-WIRES config for it in v1. Auto-wiring is deliberately
// narrow (only where we have known-good config) — others are surfaced as a
// "run `capy deploy`" recommendation rather than risking invented config.

export interface DeployTargetInfo {
  target: string; // normalized key
  label: string;
  cli?: string;
  autoWire: boolean;
  aliases: string[];
}

// autoWire is false for every target: the onboarding analyzer does NOT hand-author
// deploy config (which can't be validated without a real deploy). Deploy is
// deferred to `capy deploy`, the real + tested path. The field is retained for a
// possible future where a target's config is generated from a validated template.
export const DEPLOY_TARGETS: DeployTargetInfo[] = [
  { target: 'github-actions', label: 'GitHub Actions', cli: 'gh', autoWire: false, aliases: ['github', 'gha', 'actions'] },
  { target: 'vercel', label: 'Vercel', cli: 'vercel', autoWire: false, aliases: [] },
  { target: 'cloudflare-workers', label: 'Cloudflare Workers', cli: 'wrangler', autoWire: false, aliases: ['workers', 'cf-workers'] },
  { target: 'cloudflare-pages', label: 'Cloudflare Pages', cli: 'wrangler', autoWire: false, aliases: ['pages', 'cf-pages'] },
  { target: 'aws-ssm', label: 'AWS SSM', cli: 'aws', autoWire: false, aliases: ['aws', 'ssm'] },
  { target: 'fly', label: 'Fly.io', cli: 'fly', autoWire: false, aliases: ['flyio'] },
  { target: 'render', label: 'Render', cli: undefined, autoWire: false, aliases: [] },
  { target: 'railway', label: 'Railway', cli: 'railway', autoWire: false, aliases: [] },
];

export function normalizeTarget(input: string): DeployTargetInfo | undefined {
  const key = input.trim().toLowerCase();
  return DEPLOY_TARGETS.find((t) => t.target === key || t.label.toLowerCase() === key || t.aliases.includes(key));
}
