import { DEPLOY_PAGE_CSS } from './deployPage/generatedAssets';

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Safe to inline inside a <script> block: escapes `<` so a value can never close
// the script tag (e.g. "</script>").
const jsStr = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c');

const CAPY_LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

export interface IntakeFormOptions {
  varName: string;
  nonce: string;
  reason?: string;
  helpUrl?: string;
  exists: boolean;
}

/** Local browser form where the user pastes a secret value. The value is POSTed
 *  back to the loopback server and never leaves the machine in plaintext. */
export function generateIntakeForm(o: IntakeFormOptions): string {
  const v = escHtml(o.varName);
  const reason = o.reason ? `<p class="text-sm text-neutral-500 dark:text-neutral-400 mb-2">${escHtml(o.reason)}</p>` : '';
  const help = o.helpUrl
    ? `<p class="text-sm mb-4">Where to find it: <a class="underline" href="${escHtml(o.helpUrl)}" target="_blank" rel="noopener">${escHtml(o.helpUrl)}</a></p>`
    : '';
  const warn = o.exists
    ? `<p class="text-sm text-amber-600 dark:text-amber-400 mb-4">This variable already exists — submitting overwrites it.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy — Add ${v}</title>
  <style>${DEPLOY_PAGE_CSS}</style>
</head>
<body class="min-h-screen bg-white dark:bg-black font-sans text-neutral-900 dark:text-white">
  <div class="max-w-xl mx-auto px-5 py-12">
    <div class="flex items-center gap-3 mb-6">
      <div class="dark:invert">${CAPY_LOGO_SVG}</div>
      <h1 class="text-xl font-semibold">Add <span class="font-mono">${v}</span></h1>
    </div>
    ${reason}
    ${help}
    ${warn}
    <form id="f" class="space-y-3">
      <label class="block text-sm font-medium" for="v">Value <span class="text-neutral-400">(multiline OK — stored exactly as entered)</span></label>
      <textarea id="v" rows="5" autofocus spellcheck="false" autocomplete="off"
        class="w-full font-mono text-sm border border-black dark:border-white dark:bg-black p-3"></textarea>
      <button type="submit" class="bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-sm uppercase tracking-wide">Save &amp; sync</button>
    </form>
    <div id="status" class="text-sm text-red-600 dark:text-red-400 mt-3"></div>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mt-8">This value is encrypted on your machine and synced to Capy. It never leaves in plaintext and never passes through the AI assistant.</p>
  </div>
  <script>
    const NONCE = ${jsStr(o.nonce)};
    const VAR = ${jsStr(o.varName)};
    const f = document.getElementById('f');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = document.getElementById('v').value;
      const btn = f.querySelector('button');
      const status = document.getElementById('status');
      btn.disabled = true; status.textContent = '';
      try {
        const r = await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: NONCE, value }) });
        if (r.ok) {
          document.body.innerHTML = '<div class="max-w-xl mx-auto px-5 py-12"><h1 class="text-xl font-semibold">\\u2713 Saved</h1><p class="mt-2">' + VAR + ' was encrypted and synced. You can close this tab.</p></div>';
        } else {
          status.textContent = 'Error: ' + (await r.text());
          btn.disabled = false;
        }
      } catch (err) {
        status.textContent = 'Error: ' + err;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
