/**
 * CAP-729: the folder's project was deleted.
 *
 * The service answers 410 with the code `PROJECT_DELETED` on every route that takes the project's id, and the
 * service client mints that code (serviceClient.ts `classifyResponse`). Everything here keys on the code, never on text.
 *
 * A deleted project is not a missing one: nothing may offer to recreate it, and nothing may touch keep.lock.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CapyError, ERROR_CODES } from '../types/index';

/** Whether `err` is the service's "this project was deleted" answer. */
export function isProjectDeletedError(err: unknown): err is CapyError {
  return err instanceof CapyError && err.code === ERROR_CODES.PROJECT_DELETED;
}

/** The project the folder's keep.lock points at. Read only, never written; `undefined` when there is no readable keep.lock. */
export function keepLockProject(dir: string): { name?: string; id?: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'keep.lock'), 'utf-8'));
    return {
      name: typeof raw?.project_name === 'string' ? raw.project_name : undefined,
      id: typeof raw?.project_id === 'string' ? raw.project_id : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The command an owner runs to bring the folder's project back, or `undefined` when keep.lock names no project id. */
export function restoreCommandFor(dir: string): string | undefined {
  const id = keepLockProject(dir)?.id;
  return id === undefined ? undefined : `capy org restore-project ${id}`;
}
