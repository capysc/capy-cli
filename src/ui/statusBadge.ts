// The coloured `● status` badge shared by `capy edit`'s STATUS column and
// `capy secrets`' STATUS column (CAP-702), so both screens colour a status
// the same way.

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;

export type StatusWord = 'in sync' | 'local' | 'remote' | 'conflict' | 'not deployed' | 'unknown';

export function statusColor(status: StatusWord): string {
  switch (status) {
    case 'in sync':
      return GREEN;
    case 'local':
    case 'not deployed':
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

/** `● <label>` in the status's colour. `label` defaults to the status word; `capy secrets` passes `not deployed (1 of 3)`. */
export function statusBadge(status: StatusWord, label: string = status): string {
  return `${statusColor(status)}● ${label}${RESET}`;
}
