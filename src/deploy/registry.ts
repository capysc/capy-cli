/**
 * Deploy adapter registry.
 *
 * Adapters register here so the picker, CLI, and config validation share one
 * source of truth. Add a new adapter by importing it and pushing into ALL.
 */
import { DeployAdapter } from './adapter';
import { cfWorkerAdapter } from './adapters/cfWorker';

export const ALL_ADAPTERS: DeployAdapter[] = [cfWorkerAdapter];

export function getAdapter(id: string): DeployAdapter | null {
  return ALL_ADAPTERS.find((a) => a.id === id) ?? null;
}

export function listAdapters(): DeployAdapter[] {
  return [...ALL_ADAPTERS];
}
