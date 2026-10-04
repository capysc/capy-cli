// The coloured `● status` badge shared by `capy edit`'s STATUS column and
// `capy secrets`' STATUS column (CAP-702), so both screens colour a status
// the same way.

import { BEHIND_LABEL } from '../core/deployStatus';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;

/** Status codes. Every code is its own on-screen word except `behind`, shown as BEHIND_LABEL. */
export type StatusWord = 'in sync' | 'deployed' | 'local' | 'remote' | 'conflict' | 'behind' | 'unknown';

export function statusColor(status: StatusWord): string {
  switch (status) {
    case 'in sync':
    case 'deployed':
      return GREEN;
    case 'local':
    case 'behind':
      return YELLOW;
    case 'remote':
      return CYAN;
    case 'conflict':
      return RED;
    case 'unknown':
    default:
      return DIM;
  }
}

/** `● <label>` in the status's colour. `label` defaults to the status's own word; `capy secrets` passes e.g. `<BEHIND_LABEL> (1 of 3)`. */
export function statusBadge(status: StatusWord, label: string = statusLabel(status)): string {
  return `${statusColor(status)}● ${label}${RESET}`;
}

export function statusLabel(status: StatusWord): string {
  return status === 'behind' ? BEHIND_LABEL : status;
}
