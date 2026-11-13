import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir, hostname } from 'os';
import path from 'path';

/** A runtime contract, not a remembered preference or an agent configuration file. */
export const PAIRING_PRESENTATION = {
  version: 1,
  event: 'pairing_required',
  stream: 'stderr',
  format: 'ndjson',
  instructions: [
    'Immediately show display.markdown to the human, including the inline QR image, clickable approval link, exact pairing code, expiry, purpose, and requesting runtime. Do not return only a link and code.',
    'If qr.file is inside a remote runtime, copy it to your display-accessible workspace and replace only the image path in display.markdown. Alternatively decode qr.data_uri locally. Never send the pairing link to an external QR service.',
    'If your client cannot display images, explicitly say so and still show the complete metadata and clickable link. Do not silently omit the QR.',
    'Keep this command running while the human approves. Do not start another pairing request unless this one expires or the human requests a replacement.',
    'The account is not known yet. After browser approval, show the returned email to the human and obtain explicit approval before answering the account confirmation. Never auto-confirm.',
  ],
} as const;

export interface PairingHandoff {
  readonly event: 'pairing_required';
  readonly version: 1;
  readonly status: 'pending';
  readonly command: 'capy pair';
  readonly purpose: string;
  readonly approval_url: string;
  readonly user_code: string;
  readonly expires_at: string;
  readonly expires_in_seconds: number;
  readonly runtime: { readonly hostname: string; readonly directory: string };
  readonly account: { readonly status: 'not_yet_confirmed' };
  readonly qr: { readonly mime_type: 'image/png'; readonly file: string; readonly data_uri: string };
  readonly display: { readonly format: 'markdown'; readonly markdown: string };
  readonly agent_instructions: readonly string[];
}

function cell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Encode the full approval URL even off a TTY and with NO_COLOR set. */
export async function createPairingHandoff(input: {
  readonly approvalUrl: string;
  readonly userCode: string;
  readonly expiresInSeconds: number;
  readonly requestedAtMs: number;
}): Promise<PairingHandoff> {
  const qrCode = await import('qrcode');
  const png = await qrCode.toBuffer(input.approvalUrl, { type: 'png', margin: 4, scale: 8 });
  const directory = await mkdtemp(path.join(tmpdir(), 'capy-pair-'));
  const file = path.join(directory, 'pair.png');
  try {
    await writeFile(file, png, { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const expiresAt = new Date(input.requestedAtMs + input.expiresInSeconds * 1000).toISOString();
  const runtime = { hostname: hostname(), directory: process.cwd() } as const;
  const purpose = 'Authorize this runtime to access your Capy secrets.';
  const markdown = [
    `![Scan to pair this runtime](<${file}>)`,
    '',
    `[Approve pairing](${input.approvalUrl})`,
    '',
    '| Pairing details | |',
    '| --- | --- |',
    `| Code | ${cell(input.userCode)} |`,
    `| Expires (UTC) | ${expiresAt} |`,
    `| Purpose | ${purpose} |`,
    `| Runtime | ${cell(runtime.hostname)} |`,
    `| Directory | ${cell(runtime.directory)} |`,
    '| Account | Confirm the returned email after browser approval. |',
  ].join('\n');
  return {
    event: PAIRING_PRESENTATION.event,
    version: PAIRING_PRESENTATION.version,
    status: 'pending',
    command: 'capy pair',
    purpose,
    approval_url: input.approvalUrl,
    user_code: input.userCode,
    expires_at: expiresAt,
    expires_in_seconds: input.expiresInSeconds,
    runtime,
    account: { status: 'not_yet_confirmed' },
    qr: { mime_type: 'image/png', file, data_uri: `data:image/png;base64,${png.toString('base64')}` },
    display: { format: 'markdown', markdown },
    agent_instructions: PAIRING_PRESENTATION.instructions,
  };
}

export async function removePairingHandoff(handoff: PairingHandoff): Promise<void> {
  await rm(path.dirname(handoff.qr.file), { recursive: true, force: true });
}
