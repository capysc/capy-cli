import { lstatSync, realpathSync, rmdirSync, unlinkSync, type Stats } from 'fs';
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
/**
 * CAP-888: how the pairing QR reaches the human. The AGENTS block, `conventions.pairing` and the README all carry this
 * exact sentence, and a test fails if they drift apart. An attached file is not an image the human can scan.
 */
export const PAIRING_QR_IMAGE_RULE =
  'Show the QR as an image the human can scan right in the conversation: if your client can show images or HTML widgets, show the PNG inline with `qr.image.data_uri` as the image source (a wait response has no data URI, so read `qr.image.file` and show it inline the same way). An attached file, a download link or a file path is not showing the QR.';

/**
 * CAP-900: the link always reaches the human as text. The link instructions, the AGENTS block, `conventions.pairing` and
 * the README all carry this exact sentence, and a test fails if they drift apart.
 */
export const PAIR_LINK_TEXT_RULE =
  'Every time you show a link (the first one and each PAIR_LINK_RENEWED), write the `url` as a clickable link, with the `code`, `fingerprint` and `expires_at`, as plain text in your reply. The QR is an addition, never the only way: not every agent or client can show images.'; // COPY-FLAG

/**
 * CAP-897: what every `link` elicitation says to do next, in its own `instructions` field. An agent in a fresh folder
 * has no AGENTS block yet and may never read `capy help --json`, so the link response itself has to carry the wait and
 * renew rule (run 9: the agent showed the link, ended its turn and planned a new `capy pair` on expiry).
 */
export const PAIR_LINK_INSTRUCTIONS =
  PAIR_LINK_TEXT_RULE +
  ' Do that now and add the QR as an inline image if your client can show one (never as an attached file), then run `answer.wait` at once in the foreground, without waiting for a reply. It can take up to 9 minutes, because it returns only when something changes, so give it a tool timeout of at least 10 minutes. Run it again whenever it exits 3 with PAIR_STILL_WAITING, or if your tool stopped it early. If it exits 3 with PAIR_LINK_RENEWED, the old link expired and this is a new one: show the human the new link the same way and run its `answer.wait`. Never start a new `capy pair` for an expired link, and never fill in the one-time code yourself.'; // COPY-FLAG

export const PAIRING_PRESENTATION = {
  version: 1,
  command: 'capy pair --json',
  instructions: [
    'Run `capy pair --json` without asking the human anything first, and add no flags. It gives one approval link: Keep signs the human in or up and decides whether this machine gets their organization keys or a new organization.', // COPY-FLAG
    'The refusal PAIR_APPROVAL_PENDING carries an elicitation of kind "link". Always show the human its `url`, `code`, `fingerprint` and `expires_at`.', // COPY-FLAG
    PAIR_LINK_TEXT_RULE, // CAP-900: the same sentence as the link instructions, the AGENTS block and the README
    PAIRING_QR_IMAGE_RULE, // CAP-888: the same sentence as the AGENTS block and the README
    'If you cannot show an image, show `qr.text` only if your client is a real terminal with a monospace grid and no extra line spacing.', // COPY-FLAG
    'Otherwise say plainly that the QR cannot be shown here.', // COPY-FLAG
    'Never send the pairing link to an external QR service.', // COPY-FLAG
    'Then run `answer.wait` at once in the foreground. It can take up to 9 minutes, because it returns only when something changes, so give it a tool timeout of at least 10 minutes. Run it again whenever it exits 3 with PAIR_STILL_WAITING, or if your tool stopped it early. The wait response does not repeat `qr.text` or `qr.image.data_uri`. A wait that exits 3 with PAIR_LINK_RENEWED carries a new link with its full QR, because the old one expired: show the human the new link, code and QR, then run `answer.wait` again.', // COPY-FLAG
    'After the human approves, Keep shows them a one-time code and the wait exits 3 with PAIR_CODE_REQUIRED and a form with one `code` field: ask the human for that code and run `answer.rerun` (`capy pair --wait --code <code>`). Never fill in the code yourself; only the person who approved can see it. A wrong code returns PAIR_CODE_MISMATCH with the form again.', // COPY-FLAG
    'When the keys are already on this machine, the pairing only signs in: the result says `"keys": "already_present"`.', // COPY-FLAG
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

/** The real path of `target`, or null when it cannot be resolved. */
function realPathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/** The lstat of `target` (a symlink is reported as a symlink), or null when it is not there or cannot be read. */
function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * The real directory `file` may be removed from, or null. Only what `createPairingQrImage` makes qualifies: an
 * absolute path named `pair.png`, whose parent is a real directory (not a symlink) that is a direct child of the real OS
 * temp directory and whose name starts with `capy-pair-`. The path may come back from a file on disk, so everything
 * else (a relative path, another name, another place, a symlinked directory) is refused.
 */
function ownedQrDirectory(file: string): string | null {
  if (!path.isAbsolute(file) || path.basename(file) !== QR_FILE_NAME) return null;
  const directory = path.dirname(file);
  const stat = lstatOrNull(directory);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const realDirectory = realPathOrNull(directory);
  const realTemp = realPathOrNull(tmpdir());
  if (realDirectory === null || realTemp === null) return null;
  if (path.dirname(realDirectory) !== realTemp || !path.basename(realDirectory).startsWith(QR_DIR_PREFIX)) return null;
  return realDirectory;
}

/** Whether `file` is, or was, a regular file: a missing one counts, a directory or a symlink does not. */
function isRegularFileOrGone(file: string): boolean {
  const stat = lstatOrNull(file);
  return stat === null || (stat.isFile() && !stat.isSymbolicLink());
}

/** Unlinks `target`; whether it was removed. A file that is not there, or that cannot be removed, is false. */
function unlinkQuietly(target: string): boolean {
  try {
    unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Removes `directory` when it is empty; anything else (not empty, already gone, no permission) leaves it. */
function rmdirQuietly(directory: string): void {
  try {
    rmdirSync(directory);
  } catch {
    // Not empty, or already gone: nothing more to remove.
  }
}

/**
 * Removes a PNG made by `createPairingQrImage` and its directory. Best effort: it never throws, and it returns
 * whether it removed the file. A file that is already gone is not an error. Only a regular file named `pair.png` in a
 * real `capy-pair-` directory directly under the real OS temp directory is removed (see `ownedQrDirectory`); anything
 * else is left alone. The directory is only removed when empty.
 */
export function removePairingQrImage(file: string): boolean {
  try {
    const directory = ownedQrDirectory(file);
    if (directory === null) return false;
    const target = path.join(directory, QR_FILE_NAME);
    if (!isRegularFileOrGone(target)) return false;
    const removed = unlinkQuietly(target);
    rmdirQuietly(directory);
    return removed;
  } catch {
    return false;
  }
}
