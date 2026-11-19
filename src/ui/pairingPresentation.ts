import { rmSync, rmdirSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

/**
 * What `capy help --json` (`conventions.pairing`) tells an agent about `capy pair`: the one agent flow
 * (`pairAgentCommand.ts`) and how to show its link step. A runtime contract, not a remembered preference or an
 * agent configuration file.
 *
 * COPY-FLAG: every sentence below is minimal and neutral, awaiting approval. One is adapted from an earlier sentence
 * (the remote-runtime one), which keeps its wording except for the field names.
 */
export const PAIRING_PRESENTATION = {
  version: 1,
  command: 'capy pair --email <email> --json',
  instructions: [
    'Ask the human which email will approve, then run `capy pair --email <email> --json`. Never fill in the email yourself.', // COPY-FLAG
    'The refusal PAIR_APPROVAL_PENDING carries an elicitation of kind "link". Always show the human its `url`, `code` and `expires_at`.', // COPY-FLAG
    'Show the QR in this order. First, if your client can show images, show the PNG: attach or send `qr.image.file`, or decode `qr.image.data_uri`.', // COPY-FLAG
    'Second, show `qr.text` only if your client is a real terminal with a monospace grid and no extra line spacing.', // COPY-FLAG
    'Otherwise say plainly that the QR cannot be shown here.', // COPY-FLAG
    'If qr.image.file is inside a remote runtime, copy it to your display-accessible workspace. Alternatively decode qr.image.data_uri locally. Never send the pairing link to an external QR service.', // COPY-FLAG (adapted from an earlier sentence)
    'Then run `answer.wait` at once in the foreground, and run it again whenever it exits 3 with PAIR_STILL_WAITING. The wait response does not repeat `qr.text` or `qr.image.data_uri`.', // COPY-FLAG
    'If a different account approves, PAIR_ACCOUNT_MISMATCH is returned and nothing is installed.', // COPY-FLAG
  ],
} as const;

/** The PNG's own name and its temp directory's prefix: the only shape `removePairingQrImage` will remove. */
const QR_DIR_PREFIX = 'capy-pair-';
const QR_FILE_NAME = 'pair.png';

export interface PairingQrImage {
  readonly mime_type: 'image/png';
  readonly file: string;
  readonly data_uri: string;
}

/**
 * Makes the PNG QR of `approvalUrl`: a 0600 file in a fresh 0700 temp directory, and the same bytes as a data URI.
 * Encodes the URL it is given and nothing else, even off a TTY and with NO_COLOR set.
 */
export async function createPairingQrImage(approvalUrl: string): Promise<PairingQrImage> {
  const qrCode = await import('qrcode');
  const png = await qrCode.toBuffer(approvalUrl, { type: 'png', margin: 4, scale: 8 });
  const directory = await mkdtemp(path.join(tmpdir(), QR_DIR_PREFIX));
  const file = path.join(directory, QR_FILE_NAME);
  try {
    await writeFile(file, png, { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { mime_type: 'image/png', file, data_uri: `data:image/png;base64,${png.toString('base64')}` };
}

/**
 * Removes a PNG made by `createPairingQrImage` and its directory. A file that is already gone is not an error. The
 * path may come back from a file on disk, so anything that is not `<dir>/pair.png` with a `capy-pair-` directory is left
 * alone, and the directory is only removed when empty.
 */
export function removePairingQrImage(file: string): void {
  const directory = path.dirname(file);
  if (path.basename(file) !== QR_FILE_NAME || !path.basename(directory).startsWith(QR_DIR_PREFIX)) return;
  rmSync(file, { force: true });
  try {
    rmdirSync(directory);
  } catch {
    // Already gone, or not empty: nothing more to remove.
  }
}
