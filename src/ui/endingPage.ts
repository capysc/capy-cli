// The last page a `--web` command serves — and the wait that makes it arrive.
//
// An ending is a page with nothing to send back: what the rotation did, which
// key landed where, why the run could not start. It is served by `ScreenServer`
// rather than the wizard, so `screenHeaders()` gives it `connect-src 'none'` —
// a page that renders the outcome of a credential rotation cannot open a socket
// to anywhere, including us.
//
// TWO THINGS EVERY ENDING NEEDS, and both were missing at every call site:
//
//   1. The URL has to be printed. `open()` resolves when the browser process
//      was SPAWNED, not when it loaded anything, and under `CAPY_WEB_NO_OPEN`
//      — every agent-driven run — nothing is spawned at all. A URL that is
//      returned to the caller and never written down is a page nobody can
//      reach.
//   2. The run has to hold until the browser has the page. `start()` resolves
//      when the socket is LISTENING; the command then exits, which closes the
//      socket microseconds later and the browser gets ECONNREFUSED. Endings
//      are precisely where commands exit, so this is the one place that cannot
//      be got wrong by accident.
//
// The wait is bounded by the server's own timeout: a browser that never comes
// costs that ceiling, and the caller carries on and exits either way.
import { ScreenServer } from './screens/serve';
import type { ScreenDataMap, ScreenName } from './screens/contract';

export interface EndingPageOptions {
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  /**
   * Ceiling for a browser that never arrives. The work this page reports is
   * already over, so a finished command must not sit on the `ScreenServer`'s
   * two-minute default waiting for a report nobody is reading.
   */
  timeoutMs?: number;
  /** The line printed above the URL. Says what is on the page, in one clause. */
  lead: string;
}

/**
 * Serve one display-only screen, print where it is, and return once the
 * browser has it (or the wait ran out).
 *
 * Returns the URL, and whether it was ever fetched — a caller that wants to
 * say "nobody read it" has the fact rather than having to infer it.
 */
export async function serveEndingPage<K extends ScreenName>(
  screen: K,
  data: ScreenDataMap[K],
  p: EndingPageOptions,
): Promise<{ url: string; delivered: boolean }> {
  const server = new ScreenServer(screen, data, { timeoutMs: p.timeoutMs ?? 60_000 });
  const url = await server.start();
  p.onListen?.(url);

  // Printed before the open attempt, so the address exists in the transcript
  // even when opening throws — and so an agent relaying this run has something
  // to hand its user.
  console.log('');
  console.log(`  ${p.lead}`);
  console.log(`  ${url}`);
  console.log('');

  if (p.open ?? true) {
    // An ending is a loopback screen like any other, so it gets the same
    // chromeless window — and it knows its own name, so it can be sized right.
    const { openScreen } = await import('./openScreen');
    const { SCREEN_WIDE } = await import('./screens/generated');
    await openScreen(url, { kind: 'dialog', wide: SCREEN_WIDE[screen] });
  }

  const delivered = await server.delivered;
  // A short beat after the response was handed to the socket. `finish` means
  // the body reached the kernel, not that the kernel drained it, and the very
  // next thing several callers do is end the process — so this is the margin
  // between "the browser has the page" and "the browser has most of the page".
  // Not paid at all when nobody came: there is nothing to flush.
  if (delivered) await new Promise((r) => setTimeout(r, 100));
  return { url, delivered };
}
