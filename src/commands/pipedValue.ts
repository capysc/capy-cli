/**
 * The one way a secret value reaches `capy edit NAME` / `capy add NAME` without
 * a person at a terminal: bytes on stdin, from the command that produces them.
 *
 *     op read "op://Prod/Stripe/secret" | capy edit STRIPE_SECRET_KEY --json
 *
 * Everything the two commands share lives here, so there is exactly one stdin
 * reader and one set of rules for what a piped value is:
 *
 *  - read as UTF-8, hard cap {@link MAX_PIPED_BYTES}; reading STOPS the moment
 *    the cap is passed, it never buffers unbounded input;
 *  - exactly ONE trailing line ending (`\r\n` or `\n`) is removed, nothing else
 *    (leading/trailing spaces and inner newlines are part of the value: PEM
 *    keys, JSON);
 *  - empty after that, a NUL byte, or bytes that are not UTF-8 are refused, and
 *    nothing is written.
 *
 * THE HARD RULE: the value never leaves the process except encrypted. Nothing in
 * this file formats, logs or throws the value; refusals name a variable at most.
 * Every refusal is coded (callers branch on `code`, never on the sentence).
 */
import { ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import type { KeepLockPrOutcome } from './keepLockPr';

/** 1 MiB. A value over this is refused without reading further. */
export const MAX_PIPED_BYTES = 1024 * 1024;

/** Chunks are folded into one Buffer after this many, so many tiny writes stay linear. */
const COALESCE_AT = 256;

export type PipedValueResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

type Chunk = Buffer | string;

interface Drained {
  readonly bytes: Buffer;
  readonly tooLarge: boolean;
}

function toBuffer(chunk: Chunk): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * Pulls chunks until the stream ends or the cap is passed. State is carried as
 * parameters (no mutation): `parts` is replaced, never pushed to.
 */
async function drain(
  it: AsyncIterator<Chunk>,
  parts: readonly Buffer[],
  total: number,
  cap: number,
): Promise<Drained> {
  const next = await it.next();
  if (next.done) return { bytes: Buffer.concat(parts), tooLarge: false };

  const chunk = toBuffer(next.value);
  const size = total + chunk.length;
  if (size > cap) {
    // Stop reading NOW: hand the stream back so nothing further is consumed.
    await it.return?.();
    return { bytes: Buffer.alloc(0), tooLarge: true };
  }
  const nextParts = parts.length >= COALESCE_AT ? [Buffer.concat([...parts, chunk])] : [...parts, chunk];
  return drain(it, nextParts, size, cap);
}

function stripOneLineEnding(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

function refusal(code: string, error: string): PipedValueResult {
  return { ok: false, code, error };
}

/** Pure: turns the bytes read from stdin into a value, or a coded refusal. */
export function interpretPipedBytes(bytes: Buffer): PipedValueResult {
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) {
    return refusal(ERROR_CODES.INVALID_FORMAT, 'The piped value is not valid UTF-8. Nothing was written.'); // COPY-FLAG
  }
  if (decoded.includes('\u0000')) {
    return refusal(ERROR_CODES.INVALID_FORMAT, 'The piped value contains a NUL byte. Nothing was written.'); // COPY-FLAG
  }
  const value = stripOneLineEnding(decoded);
  if (value.length === 0) {
    return refusal(ERROR_CODES.STDIN_EMPTY, 'No value was piped in. Nothing was written.'); // COPY-FLAG
  }
  return { ok: true, value };
}

/** Strict UTF-8 (a BOM is kept as part of the value); `undefined` when the bytes are not valid UTF-8. */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Reads the whole of `source` (stdin by default) as one piped value.
 *
 * A stream that errors is reported as an empty value: the error text of an I/O
 * failure is not something to forward, and "nothing usable arrived" is true.
 */
export async function readPipedValue(
  source: AsyncIterable<Chunk> = process.stdin,
  cap: number = MAX_PIPED_BYTES,
): Promise<PipedValueResult> {
  const drained = await drainSafely(source, cap);
  if (drained === undefined) {
    return refusal(ERROR_CODES.STDIN_EMPTY, 'No value was piped in. Nothing was written.'); // COPY-FLAG
  }
  if (drained.tooLarge) {
    return refusal(ERROR_CODES.STDIN_TOO_LARGE, 'The piped value is over 1 MiB. Nothing was written.'); // COPY-FLAG
  }
  return interpretPipedBytes(drained.bytes);
}

async function drainSafely(source: AsyncIterable<Chunk>, cap: number): Promise<Drained | undefined> {
  try {
    return await drain(source[Symbol.asyncIterator](), [], 0, cap);
  } catch {
    return undefined;
  }
}

/** Exit code for a refusal: 3 when a person or a different invocation is needed, 1 otherwise. */
export function exitCodeForRefusal(code: string): number {
  switch (code) {
    case ERROR_CODES.EDIT_NEEDS_TTY:
    case ERROR_CODES.ADD_STDIN_ONE_NAME:
    case ERROR_CODES.ADD_VAR_EXISTS:
      return EXIT_NEEDS_INPUT;
    default:
      return 1;
  }
}

/**
 * Refuses and exits. `--json`: `{ ok:false, code, error }` as pure JSON on
 * stdout. Otherwise the sentence on stderr. Never carries a value.
 */
export function refusePiped(json: boolean, code: string, error: string): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  } else {
    console.error(error);
  }
  process.exit(exitCodeForRefusal(code));
}

/**
 * `INVALID_FORMAT` for a bad variable name. The argument is NOT echoed: a
 * `NAME=value` typed by mistake must not be printed back.
 */
export function refuseInvalidName(json: boolean): never {
  return refusePiped(
    json,
    ERROR_CODES.INVALID_FORMAT,
    'The variable name is not valid. Use letters, digits and underscores, not starting with a digit.', // COPY-FLAG
  );
}

export type PipedAction ='created' | 'updated' | 'unchanged';

export interface PipedSuccess {
  readonly name: string;
  readonly branch: string;
  readonly action: PipedAction;
  readonly pushed: boolean;
}

/** The result line. Names the variable and the branch, never the value, never a hash of it. */
export function pipedSuccessLine(result: PipedSuccess): string {
  if (result.action === 'unchanged') {
    return `✓ ${result.name} on ${result.branch} already has this value. Nothing changed.`; // COPY-FLAG
  }
  const where = result.pushed ? '(synced)' : '(.env only — not pushed)';
  return `✓ Set ${result.name} on ${result.branch} ${where}`;
}

/**
 * `--json`: pure JSON on stdout, with `keep_lock` (and `unanswered`) when the
 * keep.lock PR step ran. Human: one line on stderr.
 */
export function reportPipedSuccess(json: boolean, result: PipedSuccess, keepLock?: KeepLockPrOutcome): void {
  if (json) {
    const payload = { ok: true, ...result };
    console.log(
      JSON.stringify(
        keepLock === undefined
          ? payload
          : {
              ...payload,
              keep_lock: keepLock.keep_lock,
              ...(keepLock.unanswered === undefined ? {} : { unanswered: keepLock.unanswered }),
            },
        null,
        2,
      ),
    );
    return;
  }
  console.error(pipedSuccessLine(result));
}
