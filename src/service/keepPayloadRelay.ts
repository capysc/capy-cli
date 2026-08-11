/**
 * Generic CLI-side relays for keep screens that carry a real CLI->page
 * request payload — `runKeepPayloadScreen` for `payload-both` (W2-A) and
 * `runKeepInfoScreen` below for `payload-in` (W2-B). The pattern every future
 * "migrate a loopback screen with a CLI->page payload" effort should reuse
 * rather than re-deriving.
 *
 * `runKeepPayloadScreen` sequence, all on one connection: create ->
 * print/open the keep URL -> wait for the page to attach and publish
 * `page_pubkey` -> seal and send the request payload over the broker reverse
 * channel -> wait for the page's sealed answer -> typed-validate it.
 * `runKeepInfoScreen` is the same sequence minus the last two steps — see its
 * own doc comment for why. Both mirror the no-submit relay (`authService.ts`'s
 * `relayAuthScreenViaKeep`) in spirit: every ending is a coded variant, NEVER
 * a throw, and the caller's contract is exactly the same one CAP-376
 * established — "fall back to the loopback transport on anything short of
 * success". Nothing here ever logs or returns the plaintext request/answer
 * payload; only the caller (who minted them and knows what they contain)
 * does that.
 */
import { hostname } from 'os';
import { BrokerClient, type BrokerConnection } from './brokerClient';
import { keepFlowUrl } from '../ui/screens/keepScreens';
import { relayUrl } from '../auth/deviceKey/brokerCeremonyTransport';
import type { HandoffFlow } from '../ui/handoffEvent';
import { debug } from '../ui/debug';

export type KeepPayloadRelayOutcome<TAnswer> =
  /** The page answered and the payload validated against the caller's
   *  typed contract. */
  | { kind: 'answered'; answer: TAnswer }
  /** The broker itself could not be reached, or no session token was
   *  available — the connection was never created. */
  | { kind: 'unavailable' }
  /** Created a connection but the ceremony did not finish: the page never
   *  attached/registered a key, the sealed request could not be sent, no
   *  answer arrived in time, or the answer failed the caller's own
   *  validation. Deliberately one coarse outcome rather than exposing every
   *  intermediate coded variant — the caller's ONLY correct response to any
   *  of these is "fall back to the loopback transport", exactly as CAP-376
   *  established for the no-submit screens. `debug()` still logs which one,
   *  for `--verbose` diagnosis. */
  | { kind: 'declined' };

export interface KeepPayloadRelayOptions<TAnswer> {
  /** A name registered in `KEEP_SCREENS` (`kind: 'payload-both'`). Doubles
   *  as the broker `purpose` and the keep-app `/flow/<screen>` route. */
  screen: string;
  /** The CAP-386 structured handoff-event flow slug for this screen's
   *  command — e.g. `'add'` for `capy add --web`. */
  handoffFlow: HandoffFlow;
  /** Printed on the line above the URL, mirroring every other
   *  browser-opening flow (`browserWizard.ts`, `oauthServer.ts`,
   *  `brokerCeremonyTransport.ts`). */
  label: string;
  serviceApiUrl: string;
  getToken: () => string | null | Promise<string | null>;
  machineName?: string;
  /** JSON-serializable request payload, sealed to the page's key once it
   *  attaches. This is what a `payload-both` screen's typed `__CAPY_DATA__`
   *  contract is built from — e.g. `SecretIntakeData` minus the
   *  loopback-only `nonce`. */
  requestPayload: unknown;
  /** See `brokerClient.ts`'s guidance on `DEFAULT_TTL_SECONDS` — a screen a
   *  human deliberates over (typing values, not just clicking through) is a
   *  ceremony, not a no-submit ack, and should pass >= 900. */
  ttlSeconds?: number;
  /** Applied independently to each of the three waits below (attach, send,
   *  answer) — NOT a single deadline shared across all three. A caller
   *  budgeting for human typing time should size this generously; see the
   *  same `ttlSeconds`/`deadlineMs` guidance in `brokerClient.ts`. */
  deadlineMs?: number;
  /** Typed parse + validate of the page's answer plaintext. Return `null`
   *  to treat the answer as malformed — folded into `declined`, same as any
   *  other failure to finish the ceremony. */
  validateAnswer: (plaintext: string) => TAnswer | null;
}

/** Best-effort cleanup; never lets a cancel failure change the outcome
 *  already decided above it. */
async function cancelQuietly(broker: BrokerClient, connectionId: string): Promise<void> {
  try {
    await broker.cancel(connectionId);
  } catch {
    /* best-effort by contract */
  }
}

export async function runKeepPayloadScreen<TAnswer>(
  opts: KeepPayloadRelayOptions<TAnswer>,
): Promise<KeepPayloadRelayOutcome<TAnswer>> {
  const broker = new BrokerClient(opts.serviceApiUrl, opts.getToken);

  let connection: BrokerConnection;
  try {
    connection = await broker.createConnection({
      purpose: opts.screen,
      machineName: opts.machineName ?? hostname(),
      ttlSeconds: opts.ttlSeconds,
    });
  } catch {
    debug(`[keep-screens] ${opts.screen}: broker unavailable, falling back to loopback`);
    return { kind: 'unavailable' };
  }

  const url = keepFlowUrl(opts.screen, connection.connectionId);
  relayUrl(opts.label, url, opts.handoffFlow);

  const pageKey = await broker.awaitPagePubkey(connection, { deadlineMs: opts.deadlineMs });
  if (pageKey.kind !== 'ready') {
    debug(`[keep-screens] ${opts.screen}: page never attached (${pageKey.kind})`);
    await cancelQuietly(broker, connection.connectionId);
    return { kind: 'declined' };
  }

  const sent = await broker.sendRequest(
    connection,
    pageKey.pagePubkeyB64,
    JSON.stringify(opts.requestPayload),
  );
  if (sent.kind !== 'sent') {
    debug(`[keep-screens] ${opts.screen}: request send failed (${sent.kind})`);
    await cancelQuietly(broker, connection.connectionId);
    return { kind: 'declined' };
  }

  const answer = await broker.awaitAnswer(connection, { deadlineMs: opts.deadlineMs });
  if (answer.kind !== 'answered') {
    debug(`[keep-screens] ${opts.screen}: no answer (${answer.kind})`);
    return { kind: 'declined' };
  }

  const validated = opts.validateAnswer(answer.plaintext);
  if (validated === null) {
    debug(`[keep-screens] ${opts.screen}: answer failed typed validation`);
    return { kind: 'declined' };
  }

  return { kind: 'answered', answer: validated };
}

/**
 * W2-B: generic CLI-side relay for a `payload-in` keep screen — the seven
 * no-submit "ending" screens (CommandError, ConnectResult, DeployRunResult,
 * RotateProgress, SessionInfo, SyncResult, SyncStatus). Half of
 * `runKeepPayloadScreen` above: create -> print/open the keep URL -> wait for
 * the page to attach and publish `page_pubkey` -> seal and send the request
 * payload over the broker reverse channel -> DONE. There is no answer to wait
 * for — these screens have no submit control at all, so there is nothing the
 * page could send back and nothing to poll for. This mirrors the loopback
 * `serveEndingPage`/`showScreenInBrowser` posture exactly: "return once the
 * browser has the page, not once it has been read" — the same
 * fire-and-forget contract those helpers already document, just delivering
 * the payload over the broker instead of inlining it into an HTTP response.
 */
export type KeepInfoRelayOutcome =
  /** The request was sealed and handed to the broker for the page to fetch.
   *  `url` is the keep-hosted page, for a caller whose own public contract
   *  returns the URL it served (e.g. `showSyncStatusInBrowser`). */
  | { kind: 'sent'; url: string }
  /** The broker itself could not be reached, or no session token was
   *  available — the connection was never created. */
  | { kind: 'unavailable' }
  /** Created a connection but the page never attached/registered a key, or
   *  the sealed request could not be sent. One coarse outcome, same posture
   *  as `KeepPayloadRelayOutcome['declined']` — the caller's only correct
   *  response is "fall back to the loopback transport". */
  | { kind: 'declined' };

export interface KeepInfoRelayOptions {
  /** A name registered in `KEEP_SCREENS` (`kind: 'payload-in'`). Doubles as
   *  the broker `purpose` and the keep-app `/flow/<screen>` route. */
  screen: string;
  /** The CAP-386 structured handoff-event flow slug for this screen's
   *  command. */
  handoffFlow: HandoffFlow;
  /** Printed on the line above the URL, mirroring every other
   *  browser-opening flow. */
  label: string;
  serviceApiUrl: string;
  getToken: () => string | null | Promise<string | null>;
  machineName?: string;
  /** JSON-serializable payload to display, sealed to the page's key once it
   *  attaches. */
  requestPayload: unknown;
  /** A report a human reads and closes is not a ceremony — the loopback
   *  siblings (`serveEndingPage`, `showScreenInBrowser`) default their own
   *  wait to well under a minute. Callers should size this the same way,
   *  not reach for `runKeepPayloadScreen`'s 900s ceremony default. */
  ttlSeconds?: number;
  /** Applied to the one wait this relay has (for `page_pubkey`) — there is
   *  no second wait for an answer, unlike `runKeepPayloadScreen`. */
  deadlineMs?: number;
}

export async function runKeepInfoScreen(
  opts: KeepInfoRelayOptions,
): Promise<KeepInfoRelayOutcome> {
  const broker = new BrokerClient(opts.serviceApiUrl, opts.getToken);

  let connection: BrokerConnection;
  try {
    connection = await broker.createConnection({
      purpose: opts.screen,
      machineName: opts.machineName ?? hostname(),
      ttlSeconds: opts.ttlSeconds,
    });
  } catch {
    debug(`[keep-screens] ${opts.screen}: broker unavailable, falling back to loopback`);
    return { kind: 'unavailable' };
  }

  const url = keepFlowUrl(opts.screen, connection.connectionId);
  relayUrl(opts.label, url, opts.handoffFlow);

  const pageKey = await broker.awaitPagePubkey(connection, { deadlineMs: opts.deadlineMs });
  if (pageKey.kind !== 'ready') {
    debug(`[keep-screens] ${opts.screen}: page never attached (${pageKey.kind})`);
    await cancelQuietly(broker, connection.connectionId);
    return { kind: 'declined' };
  }

  const sent = await broker.sendRequest(
    connection,
    pageKey.pagePubkeyB64,
    JSON.stringify(opts.requestPayload),
  );
  if (sent.kind !== 'sent') {
    debug(`[keep-screens] ${opts.screen}: request send failed (${sent.kind})`);
    await cancelQuietly(broker, connection.connectionId);
    return { kind: 'declined' };
  }

  return { kind: 'sent', url };
}
