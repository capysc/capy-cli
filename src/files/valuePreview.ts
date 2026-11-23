/**
 * The plaintext preview Capy splices around a ciphertext in an encrypted .env
 * value: `capy:<id>:<head>...<ciphertext>...<tail>`.
 *
 * The preview is cosmetic, but it lands in a real .env file that other tools
 * parse before Capy runs, so it may only contain characters every common .env
 * reader treats as inert:
 *
 * - `$`, `{`, `}` — Docker Compose interpolates `.env` values. A Laravel value
 *   like `"${PUSHER_APP_KEY}"` previewed as `${...` makes every
 *   `docker compose` command fail with "Invalid template".
 * - `.` — `...` is the preview/ciphertext separator; a value ending in `...`
 *   would add a fourth part and break decryption.
 * - `#` and spaces — ` #` starts a comment in unquoted dotenv values, which
 *   would cut the ciphertext off.
 * - quotes, backslashes, backticks, newlines — change how the line is parsed.
 *
 * Anything outside the allowlist below is shown as `*`. The ciphertext itself
 * is base64 (`A-Z a-z 0-9 + / =`), which the allowlist already covers.
 */
const UNSAFE_PREVIEW_CHAR = /[^A-Za-z0-9_\-+/=@,:]/g;

export function safePreview(text: string): string {
  return text.replace(UNSAFE_PREVIEW_CHAR, '*');
}

export function snippetWithEncryption(originalValue: string, encryptedValue: string): string {
  // Collapse whitespace first so length tiers match what a person sees, then
  // mask unsafe characters (newlines included).
  const source = originalValue.replace(/\s+/g, ' ');
  const n = source.length;
  const head = (k: number) => safePreview(source.slice(0, k));
  const tail = (k: number) => safePreview(source.slice(-k));

  if (n <= 4) return `${encryptedValue}...${tail(1)}`;
  if (n <= 8) return `${head(1)}...${encryptedValue}...${tail(1)}`;
  if (n <= 16) return `${head(1)}...${encryptedValue}...${tail(3)}`;
  if (n <= 24) return `${head(2)}...${encryptedValue}...${tail(6)}`;
  return `${head(4)}...${encryptedValue}...${tail(6)}`;
}

/**
 * Re-mask the preview of a value Capy already encrypted, leaving the ciphertext
 * untouched. Files written before the allowlist existed can still hold `${`
 * etc.; rewriting them on the next sync heals them without re-encrypting.
 */
export function healPreview(value: string): string {
  const prefix = value.match(/^capy:[^:]+:/)?.[0] ?? '';
  const parts = value.slice(prefix.length).split('...');
  if (parts.length === 2) return `${prefix}${parts[0]}...${safePreview(parts[1])}`;
  if (parts.length === 3) return `${prefix}${safePreview(parts[0])}...${parts[1]}...${safePreview(parts[2])}`;
  return value;
}
