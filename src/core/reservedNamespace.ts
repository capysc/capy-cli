/**
 * The `_SAGE_*` namespace is reserved for variables that a Capy cloud runtime
 * manages on your behalf (the `_SAGE_CONNECTOR_*` family being the first such
 * use). The cloud copy is authoritative, so the CLI treats every variable in
 * this namespace as read-only locally:
 *
 *   - never injected into a `capy run` child process (it is the runtime's own
 *     tooling, not the application's secrets),
 *   - never reconciled by sync — no push, pull, conflict, or local-delete
 *     propagation; the cloud value always wins, and
 *   - never editable in the `capy edit` screen.
 *
 * Keeping the rule in one predicate means every surface enforces it the same
 * way and a new surface can opt in with a single import.
 */
export const SAGE_RESERVED_PREFIX = '_SAGE_';

export function isReservedNamespace(name: string): boolean {
  return name.startsWith(SAGE_RESERVED_PREFIX);
}
