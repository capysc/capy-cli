import { DEPLOY_PAGE_CSS } from './deployPage/generatedAssets';
import { VENDOR_LOGOS } from './vendorLogos';

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

// Common dashboard/console subdomains stripped so we key off the vendor's
// registrable domain (dashboard.stripe.com → stripe.com).
const VENDOR_SUBDOMAIN_RE = /^(www|dashboard|console|app|api|manage|admin|portal|my|account|secure)\./i;

/**
 * Confidently infer the single vendor these secrets belong to. Two signals, in
 * order of strength:
 *   1. The per-variable `helpUrl` (points at that provider's dashboard).
 *   2. The variable NAME — a token that matches a known vendor (e.g.
 *      STRIPE_SECRET_KEY → stripe.com), used when no helpUrl is present (e.g.
 *      `capy add STRIPE_SECRET_KEY` from the terminal).
 * Returns the registrable domain only when EVERY signal agrees on ONE vendor —
 * otherwise undefined (not confident), so a mixed/unknown set shows no logo.
 */
function detectVendorDomain(vars: IntakeVar[]): string | undefined {
  // 1) Strongest signal: the helpUrl's registrable domain.
  const domains = new Set<string>();
  for (const v of vars) {
    const u = safeHttpUrl(v.helpUrl);
    if (!u) continue;
    let host: string;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    host = host.replace(VENDOR_SUBDOMAIN_RE, '');
    const labels = host.split('.');
    domains.add((labels.length > 2 ? labels.slice(-2).join('.') : host).toLowerCase());
  }
  if (domains.size >= 1) return domains.size === 1 ? [...domains][0] : undefined;

  // 2) Fallback: infer from variable NAME tokens. A vendor's registry key first
  //    label (stripe.com → "stripe") matched as a whole token in the var name.
  const byToken = new Map<string, string>();
  for (const domain of Object.keys(VENDOR_LOGOS)) {
    const token = domain.split('.')[0];
    if (!byToken.has(token)) byToken.set(token, domain);
  }
  const matched = new Set<string>();
  for (const v of vars) {
    for (const token of v.name.toLowerCase().split(/[^a-z0-9]+/)) {
      const domain = byToken.get(token);
      if (domain) matched.add(domain);
    }
  }
  return matched.size === 1 ? [...matched][0] : undefined;
}

const CAPY_LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

// Keep (Capy's encrypted store) — from ~/Dev/capy-site/public/Keep.svg. stroke="black";
// wrapped in `dark:invert` at the call site so it flips white on dark.
const KEEP_LOGO_SVG = `<svg width="30" height="34" viewBox="0 0 52 60" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.2334 15.0688L8.86668 10.2383L0.5 15.0688M17.2334 15.0688V24.7299L8.86668 29.5604M17.2334 15.0688L8.86668 19.8994M8.86668 29.5604L0.5 24.7299V15.0688M8.86668 29.5604V19.8994M0.5 15.0688L8.86668 19.8994" stroke="black"/><path d="M50.7002 15.0688L42.3335 10.2383L33.9668 15.0688M50.7002 15.0688V24.7299L42.3335 29.5604M50.7002 15.0688L42.3335 19.8994M42.3335 29.5604L33.9668 24.7299V15.0688M42.3335 29.5604V19.8994M33.9668 15.0688L42.3335 19.8994" stroke="black"/><path d="M50.7002 34.3909V24.7299L42.3335 29.5604V39.2214L50.7002 34.3909Z" stroke="black"/><path d="M42.3335 39.1624V29.5014L33.9668 34.3319V43.9929L42.3335 39.1624Z" stroke="black"/><path d="M50.7002 44.0124V34.3514L42.3335 39.1819V48.8429L50.7002 44.0124Z" stroke="black"/><path d="M42.3335 48.8234V39.1624L33.9668 43.9929V53.6539L42.3335 48.8234Z" stroke="black"/><path d="M33.9668 5.40784L25.6001 0.577332L17.2334 5.40784M33.9668 5.40784V15.0688L25.6001 19.8994M33.9668 5.40784L25.6001 10.2383M25.6001 19.8994L17.2334 15.0688V5.40784M25.6001 19.8994V10.2383M17.2334 5.40784L25.6001 10.2383" stroke="black"/><path d="M33.9668 24.7299L25.6001 19.8994L17.2334 24.7299M33.9668 24.7299V34.3909L25.6001 39.2214M33.9668 24.7299L25.6001 29.5604M25.6001 39.2214L17.2334 34.3909V24.7299M25.6001 39.2214V29.5604M17.2334 24.7299L25.6001 29.5604" stroke="black"/><path d="M25.6001 48.8429L33.9668 44.0124V34.3514L25.6001 39.1819M25.6001 48.8429L17.2334 44.0124V34.3514L25.6001 39.1819M25.6001 48.8429V39.1819" stroke="black"/><path d="M0.5 44.0124L8.86668 48.8429V39.1819L0.5 34.3514V44.0124Z" stroke="black"/><path d="M8.8667 48.8234L17.2334 53.6539V43.9929L8.8667 39.1624V48.8234Z" stroke="black"/><path d="M8.8667 39.2214L17.2334 44.0519V34.3909L8.8667 29.5604V39.2214Z" stroke="black"/><path d="M0.5 34.3909L8.86668 39.2214V29.5604L0.5 24.7299V34.3909Z" stroke="black"/><path d="M25.6001 58.4844L33.9668 53.6539V43.9929L25.6001 48.8234M25.6001 58.4844L17.2334 53.6539V43.9929L25.6001 48.8234M25.6001 58.4844V48.8234" stroke="black"/></svg>`;

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
  // Per-variable vendor logo: detect the vendor for THIS variable alone (from its
  // helpUrl, else its name) and attach the bundled inline SVG. Logos are inlined
  // from VENDOR_LOGOS — this page NEVER makes an external request (see the
  // no-network rule in ./vendorLogos and the capy-mcp project).
  // Sanitize per-variable links to http(s) only before they reach the client.
  const suggested = o.vars.map((v) => {
    const helpUrl = safeHttpUrl(v.helpUrl);
    const domain = detectVendorDomain([v]);
    const logo = domain ? VENDOR_LOGOS[domain] : undefined;
    const spec: { name: string; helpUrl?: string; logo?: string } = { name: v.name };
    if (helpUrl) spec.helpUrl = helpUrl;
    if (logo) spec.logo = logo;
    return spec;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy — Add secrets</title>
  <style>${DEPLOY_PAGE_CSS}</style>
  <style>
    /* A little ASCII capybara that peeks up from the bottom on mouse-in
       (ported from the marketing site's terminal animation). Pure text — no
       assets, no network. */
    #capy-peek {
      position: fixed; left: 50%; bottom: 0;
      /* At rest, hide the bottom 2 of 5 lines so only the ears/eyes/upper face
         peek above the fold; on mouse-in the whole capybara rises. */
      transform: translate(-50%, 40%);
      transition: transform .45s cubic-bezier(.22, 1, .36, 1);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 15px; line-height: 1; white-space: pre;
      pointer-events: none; user-select: none; z-index: 50;
    }
    body.capy-show #capy-peek { transform: translate(-50%, 0); }
    @media (prefers-reduced-motion: reduce) {
      #capy-peek { transition: none; }
    }

    /* ── Celebration: dancing capybara + confetti on the "Saved" screen ── */
    #capy-dance-wrap {
      position: fixed; left: 50%; bottom: 0;
      /* Peek from the bottom: shift down so the lower rows sit below the fold. */
      transform: translateX(-50%) translateY(34%); z-index: 50; pointer-events: none;
    }
    #capy-dance {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 18px; line-height: 1; white-space: pre;
      display: inline-block; user-select: none;
      transform-origin: 50% 100%;
      animation: capy-dance 0.7s ease-in-out infinite;
    }
    @keyframes capy-dance {
      0%,100% { transform: translateY(0) rotate(-5deg); }
      25%     { transform: translateY(-6px) rotate(4deg); }
      50%     { transform: translateY(0) rotate(5deg); }
      75%     { transform: translateY(-6px) rotate(-4deg); }
    }
    .confetti {
      position: fixed; top: -12px; width: 8px; height: 14px;
      opacity: 0.9; will-change: transform; pointer-events: none; z-index: 60;
      animation: confetti-fall linear forwards;
    }
    @keyframes confetti-fall {
      to { transform: translateY(105vh) rotate(720deg); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      #capy-dance { animation: none; }
      .confetti { display: none; }
    }
  </style>
</head>
<body class="min-h-screen bg-white dark:bg-black font-sans text-neutral-900 dark:text-white">
  <div class="max-w-xl mx-auto px-5 py-12">
    <div class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-3">
        <div class="dark:invert">${CAPY_LOGO_SVG}</div>
        <span class="text-neutral-400" aria-hidden="true">&rarr;</span>
        <div class="dark:invert">${KEEP_LOGO_SVG}</div>
      </div>
      <h1 class="text-xl font-semibold">Add secrets</h1>
    </div>
    <!-- The reason this page exists, said where the person typing can read it.
         The CLI prints the same promise to the terminal, but the terminal is
         not where the secret gets typed — and an agent asking for credentials
         is exactly the moment someone wants to know who ends up seeing them.
         tests/ui/intakePage.test.ts asserts this line is present. -->
    <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-2">Values you type here go straight to the Capy CLI on this machine — they never pass through the AI, and never leave in plaintext.</p>
    ${reason}
    <form id="f" class="space-y-4">
      <div id="rows" class="space-y-4"></div>
      <button type="button" id="add" class="text-sm underline text-neutral-600 dark:text-neutral-300">+ add another variable</button>
      <div>
        <button type="submit" class="bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-sm uppercase tracking-wide">Save &amp; sync</button>
      </div>
    </form>
    <div id="status" class="text-sm mt-3"></div>
    <!-- Clearance ~= capybara height so it never covers the Save button / last row
         when content is tall enough to scroll to the bottom. -->
    <div aria-hidden="true" style="height: 80px"></div>
  </div>
  <pre id="capy-peek" aria-hidden="true"></pre>
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
      // Name line: a small vendor logo inline before the name (no separate column,
      // so it never pushes the value box). Sized to 1em so it's never taller than
      // the text next to it.
      const nameLine = document.createElement('div');
      nameLine.className = 'flex items-center gap-2 text-xs';
      if (spec && spec.logo) {
        const logoEl = document.createElement('span');
        logoEl.className = 'shrink-0 inline-flex items-center text-black dark:text-white';
        // Trusted, bundled inline SVG (audited: no scripts/handlers/external refs).
        logoEl.innerHTML = spec.logo;
        const svg = logoEl.querySelector('svg');
        if (svg) {
          svg.removeAttribute('width');
          svg.removeAttribute('height');
          svg.style.height = '1em';
          svg.style.width = 'auto';
          svg.style.maxWidth = '2.5em'; // keep wide wordmark logos from crowding the name
        }
        nameLine.append(logoEl);
      }
      const nameInput = document.createElement('input');
      nameInput.className = 'flex-1 min-w-0 font-mono text-xs font-medium dark:bg-black outline-none';
      nameInput.placeholder = 'VARIABLE_NAME';
      nameInput.spellcheck = false;
      nameInput.autocapitalize = 'off';
      nameInput.autocomplete = 'off';
      nameInput.value = name;
      nameLine.append(nameInput);
      const valueInput = document.createElement('textarea');
      valueInput.className = 'w-full font-mono text-xs border border-neutral-300 dark:border-neutral-700 dark:bg-black p-2 outline-none';
      valueInput.rows = 2;
      valueInput.placeholder = 'value (multiline OK)';
      valueInput.spellcheck = false;
      // A browser treats this like any other text field: remember it, offer it
      // back as autofill, let a password manager capture it. Every one of those
      // is wrong for a credential — it copies the value somewhere the CLI's
      // encryption does not reach. Same opt-outs the ui SecretField uses.
      valueInput.autocomplete = 'off';
      valueInput.autocapitalize = 'off';
      valueInput.setAttribute('autocorrect', 'off');
      valueInput.setAttribute('data-1p-ignore', 'true');
      valueInput.setAttribute('data-lpignore', 'true');
      valueInput.setAttribute('data-form-type', 'other');
      row.append(nameLine, valueInput);
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

    // Celebration screen: a dancing ASCII capybara + a burst of confetti.
    // Pure DOM/CSS, no assets or network. Reduced-motion users get a static capy.
    function showSaved(count) {
      // Same art + eye/nose maps as the peeking capybara so the face reads right:
      // BLACK_BG = partial-block cells whose gap is black (the eyes),
      // BLACK_FG = solid-black char (the nose).
      const LINES = ['   █▄▄▅▅▅▄▄█', '   ▅▅█████▅▅', '  ▟█████████▙', ' ▟███████████▙', '▐█████▄█▄█████▌'];
      const BLACK_BG = { 1: [3, 4, 10, 11], 4: [6, 8] };
      const BLACK_FG = { 3: [7] };
      const inSet = (m, li, i) => m[li] && m[li].indexOf(i) !== -1;
      const rand = (s) => { const x = Math.sin(s * 9301 + 49297) * 49297; return x - Math.floor(x); };
      // Per-character "fur shimmer": jitter the fur rgb each frame (same formula
      // as the peeking capybara). Eyes stay black-on-black, nose stays solid black.
      function renderFur(tick) {
        let html = '';
        for (let li = 0; li < LINES.length; li++) {
          const line = LINES[li];
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === ' ') { html += ' '; continue; }
            if (inSet(BLACK_FG, li, i)) { html += '<span style="color:#000">' + ch + '</span>'; continue; }
            const v = (rand(li * 100 + i + tick * 997) - 0.5) * 40;
            const r = Math.round(150 + v), g = Math.round(115 + v * 0.7), b = Math.round(80 + v * 0.5);
            html += '<span style="color:rgb(' + r + ',' + g + ',' + b + ')' + (inSet(BLACK_BG, li, i) ? ';background:#000' : '') + '">' + ch + '</span>';
          }
          if (li < LINES.length - 1) html += '\\n';
        }
        return html;
      }
      document.body.innerHTML =
        '<div class="max-w-xl mx-auto px-5 py-12 text-center font-mono">' +
        '<h1>Saved</h1>' +
        '<p class="mt-2">now, back to work</p>' +
        '</div>' +
        '<div id="capy-dance-wrap"><pre id="capy-dance"></pre></div>';
      const capyEl = document.getElementById('capy-dance');
      capyEl.innerHTML = renderFur(0); // static frame (also the reduced-motion frame)
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) return;
      let furTick = 0;
      const furTimer = setInterval(() => {
        if (!capyEl.isConnected) { clearInterval(furTimer); return; }
        capyEl.innerHTML = renderFur(++furTick);
      }, 140);
      const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#a855f7', '#ec4899'];
      for (let i = 0; i < 80; i++) {
        const c = document.createElement('div');
        c.className = 'confetti';
        c.style.left = (Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 100) + 'vw';
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = (2 + (i % 5) * 0.4) + 's';
        c.style.animationDelay = ((i % 10) * 0.08) + 's';
        document.body.appendChild(c);
        c.addEventListener('animationend', () => c.remove());
      }
    }

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
          showSaved(vars.length);
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

    // ── Peeking capybara: ASCII art that slides up from the bottom on mouse-in,
    //    with the marketing site's per-character "fur shimmer". Pure text, no
    //    assets, no network. Honors prefers-reduced-motion (static peek, no shimmer).
    (function () {
      const peek = document.getElementById('capy-peek');
      if (!peek) return;
      const LINES = ['   █▄▄▅▅▅▄▄█', '   ▅▅█████▅▅', '  ▟█████████▙', ' ▟███████████▙', '▐█████▄█▄█████▌'];
      const BLACK_BG = { 1: [3, 4, 10, 11], 4: [6, 8] }; // partial-block chars whose gap is black
      const BLACK_FG = { 3: [7] };                        // the nose
      const inSet = (m, li, i) => m[li] && m[li].indexOf(i) !== -1;
      const rand = (s) => { const x = Math.sin(s * 9301 + 49297) * 49297; return x - Math.floor(x); };
      function stop() { if (timer) { clearInterval(timer); timer = null; } }
      function render(tick) {
        if (!peek.isConnected) { stop(); return; }
        let html = '';
        for (let li = 0; li < LINES.length; li++) {
          const line = LINES[li];
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === ' ') { html += ' '; continue; }
            if (inSet(BLACK_FG, li, i)) { html += '<span style="color:#000">' + ch + '</span>'; continue; }
            const v = (rand(li * 100 + i + tick * 997) - 0.5) * 40;
            const r = Math.round(150 + v), g = Math.round(115 + v * 0.7), b = Math.round(80 + v * 0.5);
            html += '<span style="color:rgb(' + r + ',' + g + ',' + b + ')' + (inSet(BLACK_BG, li, i) ? ';background:#000' : '') + '">' + ch + '</span>';
          }
          if (li < LINES.length - 1) html += '\\n';
        }
        peek.innerHTML = html;
      }
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let timer = null, tick = 0;
      function start() { if (reduce || timer) return; timer = setInterval(() => { render(++tick); }, 140); }
      render(0); // static frame so the peek looks right even under reduced motion
      const root = document.documentElement;
      root.addEventListener('mouseenter', () => { document.body.classList.add('capy-show'); start(); });
      root.addEventListener('mouseleave', () => { document.body.classList.remove('capy-show'); stop(); });
    })();
  </script>
</body>
</html>`;
}
