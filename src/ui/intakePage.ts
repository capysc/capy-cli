import { DEPLOY_PAGE_CSS } from './deployPage/generatedAssets';

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Safe to inline inside a <script> block: escapes `<` so a value can never close
// the script tag (e.g. "</script>"). Works for any JSON-serializable value.
const jsStr = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c');
const jsJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

// A model-supplied "where to find this" link is rendered as a clickable anchor,
// so only http(s) URLs are allowed — never `javascript:`, `data:`, etc.
const safeHttpUrl = (u: string | undefined): string | undefined => {
  const t = u?.trim();
  return t && /^https?:\/\//i.test(t) ? t : undefined;
};

const CAPY_LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

export interface IntakeVar {
  /** Suggested env var name (editable in the form). */
  name: string;
  /** Optional "where to find this" link for THIS variable (e.g. its provider dashboard). */
  helpUrl?: string;
}

export interface IntakeFormOptions {
  /** Suggested variables (name + optional per-variable help link). The user fills in the values. */
  vars: IntakeVar[];
  nonce: string;
  reason?: string;
}

/**
 * Local browser form: a key/value editor pre-seeded with the suggested variable
 * NAMES (e.g. ones the AI proposed), each with an optional "where to find this"
 * link. The user fills in (and can edit/add/remove) the names + values; values
 * are POSTed back to the loopback server and never leave the machine in plaintext.
 */
export function generateIntakeForm(o: IntakeFormOptions): string {
  const reason = o.reason ? `<p class="text-sm text-neutral-500 dark:text-neutral-400 mb-2">${escHtml(o.reason)}</p>` : '';
  // Sanitize per-variable links to http(s) only before they reach the client.
  const suggested = o.vars.map((v) => {
    const helpUrl = safeHttpUrl(v.helpUrl);
    return helpUrl ? { name: v.name, helpUrl } : { name: v.name };
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy — Add secrets</title>
  <style>${DEPLOY_PAGE_CSS}</style>
</head>
<body class="min-h-screen bg-white dark:bg-black font-sans text-neutral-900 dark:text-white">
  <div class="max-w-xl mx-auto px-5 py-12">
    <div class="flex items-center gap-3 mb-6">
      <div class="dark:invert">${CAPY_LOGO_SVG}</div>
      <h1 class="text-xl font-semibold">Add secrets</h1>
    </div>
    ${reason}
    <form id="f" class="space-y-4">
      <div id="rows" class="space-y-4"></div>
      <button type="button" id="add" class="text-sm underline text-neutral-600 dark:text-neutral-300">+ add another variable</button>
      <div>
        <button type="submit" class="bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-sm uppercase tracking-wide">Save &amp; sync</button>
      </div>
    </form>
    <div id="status" class="text-sm mt-3"></div>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mt-8">Values are encrypted on your machine and synced to Capy. They never leave in plaintext and never pass through the AI assistant. (The AI suggested the names; you provide the values.)</p>
  </div>
  <script>
    const NONCE = ${jsStr(o.nonce)};
    const SUGGESTED = ${jsJson(suggested)};
    const rowsEl = document.getElementById('rows');
    const status = document.getElementById('status');

    function setStatus(msg, isError) {
      status.textContent = msg;
      status.className = 'text-sm mt-3 ' + (isError ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400');
    }

    // removable=true only for rows the user adds; suggested rows can be edited but not removed.
    function addRow(spec, removable) {
      const name = (spec && spec.name) || '';
      const helpUrl = spec && spec.helpUrl;
      const row = document.createElement('div');
      row.className = 'border border-neutral-300 dark:border-neutral-700 p-3 space-y-2';
      const nameInput = document.createElement('input');
      nameInput.className = 'w-full font-mono text-xs font-medium dark:bg-black outline-none';
      nameInput.placeholder = 'VARIABLE_NAME';
      nameInput.spellcheck = false;
      nameInput.autocapitalize = 'off';
      nameInput.value = name;
      const valueInput = document.createElement('textarea');
      valueInput.className = 'w-full font-mono text-xs border border-neutral-300 dark:border-neutral-700 dark:bg-black p-2 outline-none';
      valueInput.rows = 2;
      valueInput.placeholder = 'value (multiline OK)';
      valueInput.spellcheck = false;
      row.append(nameInput, valueInput);
      // Footer: per-variable "where to find this" link (left) + remove (right), justified between.
      // The link is http(s)-only, sanitized server-side; href is set as a property (no innerHTML).
      const hasLink = helpUrl && /^https?:\\/\\//i.test(helpUrl);
      if (hasLink || removable) {
        const footer = document.createElement('div');
        footer.className = 'flex items-center justify-between';
        if (hasLink) {
          const link = document.createElement('a');
          link.href = helpUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'where to find this ↗';
          link.className = 'text-xs underline text-neutral-500 dark:text-neutral-400';
          footer.append(link);
        } else {
          footer.append(document.createElement('span')); // spacer keeps remove right-justified
        }
        if (removable) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.textContent = 'remove';
          rm.className = 'text-xs text-neutral-400 hover:text-red-500';
          rm.onclick = () => row.remove();
          footer.append(rm);
        }
        row.append(footer);
      }
      row.__name = nameInput;
      row.__value = valueInput;
      rowsEl.append(row);
      return row;
    }

    SUGGESTED.forEach((s) => addRow(s, false));
    if (SUGGESTED.length === 0) addRow({}, false);
    // focus the first empty value field
    for (const row of rowsEl.children) { if (!row.__value.value) { row.__value.focus(); break; } }
    document.getElementById('add').onclick = () => addRow({}, true);

    const f = document.getElementById('f');
    const submitBtn = f.querySelector('button[type=submit]');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const vars = [];
      for (const row of rowsEl.children) {
        const name = row.__name.value.trim();
        const value = row.__value.value;
        if (name && value) vars.push({ name, value });
      }
      if (vars.length === 0) { setStatus('Enter at least one variable name and value.', true); return; }
      submitBtn.disabled = true;
      setStatus('Saving…', false);
      try {
        const r = await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: NONCE, vars }) });
        if (r.ok) {
          document.body.innerHTML = '<div class="max-w-xl mx-auto px-5 py-12"><h1 class="text-xl font-semibold">\\u2713 Saved</h1><p class="mt-2">' + vars.length + ' variable(s) were encrypted and synced. You can close this tab.</p></div>';
          return;
        }
        let detail = 'HTTP ' + r.status;
        try { const b = await r.json(); if (b && b.error) detail = b.error; } catch (_) {}
        setStatus('Could not save: ' + detail + ' — fix the issue and try again.', true);
        submitBtn.disabled = false;
      } catch (err) {
        setStatus('Could not reach the Capy CLI (' + err + '). Is it still running? Try again.', true);
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
