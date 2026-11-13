import { Branch, ERROR_CODES } from '../types/index';

/**
 * The protected-branch gate for the commands that put plaintext secret values
 * somewhere (`capy run`, `capy export`).
 *
 * Whether a branch is protected is the server's answer (`Branch.is_protected`
 * from the branch list). It is never read from a local file, never guessed from
 * the branch name, and never cached: each gated call asks again.
 *
 * The gate is only consulted on the path that already needs the server to
 * decrypt. Callers do not consult it for a plaintext-only `.env`, a local-only
 * profile, or deployed mode.
 */

type BranchStatus = Pick<Branch, 'name' | 'is_protected'>;

export type ProtectedGateVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | typeof ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG
        | typeof ERROR_CODES.PROTECTED_STATUS_UNREADABLE;
      readonly message: string;
    };

export interface ProtectedGateInput {
  /** `--protected` was passed. No lookup is made. */
  readonly allowProtected: boolean;
  /** The folder's active branch; null when the folder carries no branch signal. */
  readonly branch: string | null;
  readonly projectId: string;
  readonly listBranches: (projectId: string) => Promise<ReadonlyArray<BranchStatus>>;
}

const PROTECTED: ProtectedGateVerdict = {
  ok: false,
  code: ERROR_CODES.PROTECTED_BRANCH_NEEDS_FLAG,
  // COPY-FLAG: minimal neutral wording.
  message: 'The active branch is protected. Nothing was decrypted. Pass --protected to continue.',
};

const UNREADABLE: ProtectedGateVerdict = {
  ok: false,
  code: ERROR_CODES.PROTECTED_STATUS_UNREADABLE,
  // COPY-FLAG: minimal neutral wording.
  message: 'Could not read whether the active branch is protected. Nothing was decrypted.',
};

const OK: ProtectedGateVerdict = { ok: true };

/** The server's branch list, or null when it could not be read. */
async function readBranchList(input: ProtectedGateInput): Promise<ReadonlyArray<BranchStatus> | null> {
  try {
    return await input.listBranches(input.projectId);
  } catch {
    return null;
  }
}

function verdictFor(branches: ReadonlyArray<BranchStatus> | null, branch: string): ProtectedGateVerdict {
  if (!Array.isArray(branches)) return UNREADABLE;
  const found = branches.find((b) => b.name === branch);
  if (!found || typeof found.is_protected !== 'boolean') return UNREADABLE;
  return found.is_protected ? PROTECTED : OK;
}

/**
 * Decides whether decrypting for the folder's active branch may go ahead.
 * Passing `--protected`, or a folder with no branch signal, never looks anything up.
 */
export async function checkProtectedBranchGate(input: ProtectedGateInput): Promise<ProtectedGateVerdict> {
  if (input.allowProtected) return OK;
  if (input.branch === null) return OK;
  return verdictFor(await readBranchList(input), input.branch);
}
