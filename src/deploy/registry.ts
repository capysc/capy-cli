/**
 * Deploy adapter registry.
 *
 * Adapters register here so the picker, CLI, and config validation share one
 * source of truth. Add a new adapter by importing it and pushing into ALL.
 *
 * `PLANNED_ADAPTERS` lists shapes we intend to ship but haven't yet — surfaced
 * in the picker as disabled entries so users see the roadmap and the manual
 * escape hatch (`capy export | <vendor-cli>`) instead of an empty menu.
 */
import { DeployAdapter } from './adapter';
import { cfWorkerAdapter } from './adapters/cfWorker';

export const ALL_ADAPTERS: DeployAdapter[] = [cfWorkerAdapter];

export interface PlannedAdapter {
  id: string;
  label: string;
  description: string;
  /** One-line nudge shown in the picker. */
  fallbackHint: string;
}

export const PLANNED_ADAPTERS: PlannedAdapter[] = [
  {
    id: 'cf-pages',
    label: 'Cloudflare Pages',
    description: 'Static, build-time VITE_*/NEXT_PUBLIC_* inlined',
    fallbackHint: 'capy run -- vite build && wrangler pages deploy dist',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    description: 'Next/Vite/etc. via the Vercel CLI',
    fallbackHint: 'capy run -- vercel build && vercel deploy --prebuilt',
  },
  {
    id: 'fly',
    label: 'Fly.io',
    description: 'Long-running services with fly secrets + fly deploy',
    fallbackHint: 'capy export --format=json | fly secrets import && fly deploy',
  },
  {
    id: 'render',
    label: 'Render',
    description: 'Web services / static sites',
    fallbackHint: 'capy export | render env import (manual today)',
  },
  {
    id: 'railway',
    label: 'Railway',
    description: 'Deploys via railway up',
    fallbackHint: 'capy export | railway variables set --batch',
  },
  {
    id: 'gh-actions',
    label: 'GitHub Actions (secrets only)',
    description: 'Push to repo/environment secrets; no deploy',
    fallbackHint: 'capy export --format=json | gh secret set -e <env> -f -',
  },
];

export function getAdapter(id: string): DeployAdapter | null {
  return ALL_ADAPTERS.find((a) => a.id === id) ?? null;
}

export function listAdapters(): DeployAdapter[] {
  return [...ALL_ADAPTERS];
}

export function listPlanned(): PlannedAdapter[] {
  return [...PLANNED_ADAPTERS];
}
