// Browser-rendered local-only onboarding (`capy byoc --web`): the offline first-run
// setup trainstops — choose/show the recovery phrase, then set a local passphrase —
// rendered in the user's browser instead of TTY prompts.
//
// SECURITY INVARIANT: the 24-word recovery phrase is generated in this process and
// rendered into the loopback page for the user to write down. It is NEVER printed to
// stdout/stderr, NEVER logged, and NEVER returned from this function — so when an
// agent shells `capy byoc --web` through the MCP, the phrase cannot reach the model.
// The phrase lives only in this closure and is handed straight to `finalize`, which
// derives the master key and writes it (wrapped) to disk.
import { runBrowserWizard, type WizardScreen } from './browserWizard';
import { generateSeedPhrase, validateSeedPhrase } from '../crypto/keyManager';

export interface OnboardingWebOptions {
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BTN =
  'width:100%;background:#000;color:#fff;border:none;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px;';
const NOTE = 'color:#6b7280;font-size:13px;margin:8px 0 0;';

export function chooseSourceScreen(): WizardScreen {
  return {
    html: `
      <p style="margin:0 0 18px;color:#374151;">Local mode keeps your secrets only on this machine, encrypted with a key derived from a recovery phrase.</p>
      <form>
        <label style="display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid #000;margin-bottom:10px;cursor:pointer;">
          <input type="radio" name="mode" value="generate" checked style="margin-top:3px;accent-color:#000;">
          <span><strong>Generate a new recovery phrase</strong><br><span style="${NOTE}">Recommended — a fresh 24-word phrase for this machine.</span></span>
        </label>
        <label style="display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid #000;margin-bottom:10px;cursor:pointer;">
          <input type="radio" name="mode" value="enter" style="margin-top:3px;accent-color:#000;">
          <span><strong>Enter an existing recovery phrase</strong><br><span style="${NOTE}">Restore from a phrase you already have.</span></span>
        </label>
        <button type="submit" style="${BTN}">Continue</button>
      </form>`,
  };
}

export function phraseDisplayScreen(phrase: string): WizardScreen {
  const words = phrase.split(/\s+/).filter(Boolean);
  const grid = words
    .map(
      (w, i) =>
        `<div style="display:flex;gap:8px;align-items:baseline;padding:7px 10px;background:#f9fafb;border:1px solid #eef0f2;">
           <span style="color:#9ca3af;font-size:12px;min-width:18px;text-align:right;">${i + 1}</span>
           <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;">${esc(w)}</span>
         </div>`,
    )
    .join('');
  return {
    html: `
      <p style="margin:0 0 8px;color:#374151;">Write down these <strong>24 words</strong> in order and keep them somewhere safe.</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;padding:10px 14px;margin:0 0 16px;color:#9a3412;font-size:13px;">
        This is the only time it is shown. It never leaves this machine — if you lose it, your secrets cannot be recovered.
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px;">${grid}</div>
      <form>
        <label style="display:flex;gap:10px;align-items:center;margin-bottom:6px;cursor:pointer;">
          <input type="checkbox" name="saved" required style="width:16px;height:16px;accent-color:#000;">
          <span>I have written down my recovery phrase</span>
        </label>
        <button type="submit" style="${BTN}">Continue</button>
      </form>`,
  };
}

function enterPhraseScreen(): WizardScreen {
  return {
    html: `
      <p style="margin:0 0 12px;color:#374151;">Paste your existing 24-word recovery phrase.</p>
      <form>
        <textarea name="phrase" rows="3" placeholder="word1 word2 word3 …" style="width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;padding:12px;border:1px solid #000;resize:vertical;"></textarea>
        <button type="submit" style="${BTN}">Continue</button>
      </form>`,
  };
}

export function passphraseScreen(): WizardScreen {
  const field =
    'width:100%;box-sizing:border-box;font-size:15px;padding:11px 12px;border:1px solid #000;margin-bottom:10px;';
  return {
    html: `
      <p style="margin:0 0 12px;color:#374151;">Set a passphrase to lock your key on this machine. You'll enter it to unlock secrets later.</p>
      <form>
        <input type="password" name="passphrase" placeholder="Passphrase (at least 8 characters)" style="${field}">
        <input type="password" name="confirm" placeholder="Confirm passphrase" style="${field}">
        <button type="submit" style="${BTN}">Finish setup</button>
      </form>`,
  };
}

/**
 * Drive local-only onboarding in the browser. Collects the recovery phrase (new or
 * existing) and a local passphrase across a few screens, then calls `finalize` —
 * which derives + persists the wrapped master key — entirely inside this process.
 * Resolves true on success, false if the user closed/cancelled.
 *
 * The phrase is intentionally NOT part of the return value.
 */
export async function runLocalOnboardingWeb(
  finalize: (phrase: string, passphrase: string) => void,
  opts: OnboardingWebOptions = {},
): Promise<boolean> {
  // Closure-only state — never serialized back to the wizard result.
  let phrase: string | null = null;
  let source: 'generate' | 'enter' = 'generate';

  const result = await runBrowserWizard(
    {
      title: 'Set up Capy — local mode',
      firstScreen: chooseSourceScreen(),
      open: opts.open ?? true,
      onListen: opts.onListen,
      timeoutMs: opts.timeoutMs,
      doneMessage: 'Local mode is ready — back to your terminal.',
    },
    async (step, payload) => {
      if (step === 0) {
        source = payload.mode === 'enter' ? 'enter' : 'generate';
        if (source === 'generate') {
          phrase = generateSeedPhrase();
          return { screen: phraseDisplayScreen(phrase) };
        }
        return { screen: enterPhraseScreen() };
      }

      if (step === 1) {
        if (source === 'enter') {
          const entered = typeof payload.phrase === 'string' ? payload.phrase.trim() : '';
          // Inline error (NOT a new screen) — returning {error} keeps the wizard
          // on this step so a retry is still step 1, not the passphrase step.
          if (!validateSeedPhrase(entered)) {
            return { error: 'That is not a valid 24-word recovery phrase. Check the words and try again.' };
          }
          phrase = entered;
        }
        // generate path: the "saved" checkbox is enforced by the browser (required).
        return { screen: passphraseScreen() };
      }

      // step === 2: passphrase. Inline errors keep us on this step until valid.
      const pass = typeof payload.passphrase === 'string' ? payload.passphrase : '';
      const confirm = typeof payload.confirm === 'string' ? payload.confirm : '';
      if (pass.length < 8) {
        return { error: 'Use at least 8 characters.' };
      }
      if (pass !== confirm) {
        return { error: 'Passphrases do not match.' };
      }
      if (!phrase) {
        return { error: 'Lost the recovery phrase — please restart setup.' };
      }
      finalize(phrase, pass);
      return { done: true, result: { ok: true } };
    },
  );

  return !!(result && typeof result === 'object' && (result as { ok?: boolean }).ok);
}
