import { CapyError, ERROR_CODES } from '../types/index';

/**
 * `_system` is reserved for the org's system store (CAP-664) — the project
 * that holds connector credentials (see `src/system/systemStore.ts`). It is
 * never a real project: the server hides it from every listing endpoint, and
 * the CLI must never let a user create or pick a project by this name.
 *
 * Comparison is case-insensitive and trimmed throughout — `_System`,
 * ` _system `, `_SYSTEM` are all the reserved name. One constant, imported by
 * every project-creation and project-picker call site, so the two only ever
 * drift together.
 */
export const SYSTEM_PROJECT_NAME = '_system';

/** COPY-FLAG: minimal neutral wording for the one user-facing sentence this module owns. */
export const PROJECT_NAME_RESERVED_MESSAGE = '"_system" is a reserved name and cannot be used for a project.';

/**
 * True when `name` (after trim + lowercase) is the reserved system project
 * name. Defensive about non-string input (`undefined`/`null`/anything else
 * a caller's own validation hasn't ruled out yet) rather than throwing —
 * this runs ahead of other validation at several call sites, and "not a
 * string" is never the reserved name, so there is nothing to refuse here.
 */
export function isReservedProjectName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return name.trim().toLowerCase() === SYSTEM_PROJECT_NAME;
}

/**
 * Drops a `_system` entry from a project listing.
 *
 * Belt-and-braces: the service already excludes the system project from every
 * listing endpoint (`GET /projects`, `/orgs/:orgId/me`,
 * `/orgs/:orgId/members/details`), so this is normally a no-op. Kept as a
 * second guard so an older or misbehaving service can never surface it in a
 * picker.
 */
export function excludeSystemProject<T extends { name: string }>(projects: readonly T[]): T[] {
  return projects.filter((p) => !isReservedProjectName(p.name));
}

/**
 * Throws a typed `PROJECT_NAME_RESERVED` `CapyError` when `name` is the
 * reserved system project name. Call this immediately before any
 * project-creation request — the reserved name must never reach the service.
 */
export function assertProjectNameAllowed(name: string): void {
  if (!isReservedProjectName(name)) return;
  throw new CapyError(PROJECT_NAME_RESERVED_MESSAGE, ERROR_CODES.PROJECT_NAME_RESERVED, { name });
}
