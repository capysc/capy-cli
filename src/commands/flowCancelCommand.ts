/**
 * `capy flow cancel <id>` — the org-owner escape hatch for a stranded flow.
 *
 * WHY THIS EXISTS: an expired-but-unconsumed ceremony leaves a flow holding
 * a repo lock. Every subsequent `onboard --broker-ceremony` create on that
 * repo is refused with `concurrent_flow` for the flow's full TTL. The other
 * escape hatch, `onboard --reset`, only fires its cancel when a create is
 * itself blocked — which happens on the STRANDED machine, which by
 * definition has no identity yet to authorize a cancel with. Dead end.
 *
 * The server has always been able to do this: `POST /flows/:id/cancel`
 * (service/src/routes/flows.ts) authorizes either the normal secret/bound-
 * identity gate, or — the path this command uses — ORG OWNERSHIP of
 * whatever the flow pinned so far. An authenticated org owner can already
 * kill a stuck flow by id; this command is simply the CLI surface that was
 * missing for it.
 *
 * Thin on purpose: resolve auth → confirm → POST cancel → report. No plan
 * screen, no `--web`, no retry logic the server doesn't already give it.
 */
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';
import { isInteractive, refuseNonInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface FlowCancelOptions {
  json?: boolean;
  /** Skip the confirmation prompt — required off a TTY. */
  yes?: boolean;
  /** Treat stdin as non-interactive even if it happens to be a TTY (agents/CI). */
  nonTty?: boolean;
}

function printJson(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload, null, 2));
}

export class FlowCancelCommand {
  constructor(
    private apiUrl?: string,
    private devMode: boolean = false,
  ) {}

  async execute(flowId: string, opts: FlowCancelOptions = {}): Promise<void> {
    // ── Confirm before destroying, decided BEFORE any auth/network call ──────
    // Cancelling is irreversible (it supersedes the flow's ceremony
    // connection and marks the instance dead), so a run that cannot ask
    // must refuse rather than guess — and it must refuse before it does
    // anything, not after an auth round-trip nobody asked for.
    if (!opts.yes) {
      if (!isInteractive(opts.nonTty)) {
        if (opts.json) {
          printJson({
            ok: false,
            code: ERROR_CODES.FLOW_CANCEL_CONFIRMATION_REQUIRED,
            flow_id: flowId,
            detail: 'cancelling a flow is irreversible, and there is no interactive session to confirm it',
          });
          process.exit(EXIT_NEEDS_INPUT);
        }
        // Under `--web` this refusal owes the caller a page, not just a stream
        // they cannot read. `displayErrorAndExit` is not the tool here: it
        // hardcodes exit 1, and this refusal's contract is EXIT_NEEDS_INPUT (3)
        // — the code an agent branches on to learn a question needs answering.
        // So the page is served directly and the exit code is preserved.
        //
        // The sentences are `refuseNonInteractive`'s own, carried whole, so the
        // terminal and the browser say the same thing.
        const reason = 'cancelling a flow is irreversible, and there is no interactive session to confirm it';
        const hint = `Pass --yes to confirm non-interactively: capy flow cancel ${flowId} --yes`;
        const { isWebMode } = await import('../ui/webMode');
        if (isWebMode()) {
          console.error(`\n  non-interactive: ${reason}`);
          console.error(`  ${hint}\n`);
          try {
            const { buildCommandErrorData } = await import('../ui/commandErrorScreen');
            const { serveEndingPage } = await import('../ui/endingPage');
            await serveEndingPage(
              'command-error',
              buildCommandErrorData(
                new CapyError(`${reason}\n${hint}`, ERROR_CODES.FLOW_CANCEL_CONFIRMATION_REQUIRED),
                {},
              ),
              { lead: 'What went wrong is in your browser:', timeoutMs: 60_000, flow: 'error' },
            );
          } catch {
            // A failure while reporting a failure is not worth a second one.
          }
          process.exit(EXIT_NEEDS_INPUT);
        }
        refuseNonInteractive(reason, hint);
      }

      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Cancel flow ${B(flowId)}? This releases any lock it holds and cannot be undone.`,
          default: false,
        },
      ]);
      if (!confirm) {
        if (opts.json) {
          printJson({ ok: false, code: ERROR_CODES.FLOW_CANCEL_DECLINED, flow_id: flowId });
        } else {
          console.log('\n  Cancelled.\n');
        }
        return;
      }
    }

    // ── Resolve auth. Account-wide, not org-scoped: the server decides
    // ownership itself from whatever the flow pinned, so there is no org
    // to pick here (same bootstrap shape as `capy doors`). ─────────────────
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);

    // Silent (cached session) first, falling back to the interactive/browser
    // flow only when that comes back empty — one finished value, never a
    // reassigned binding (matches deployTokenCommand.ts's identical shape).
    const resolveAuth = async (): Promise<AuthResult> => {
      const silent = await authService.authenticateSilent();
      return silent.success ? silent : authService.authenticate();
    };
    const authResult = await resolveAuth();
    if (!authResult.success) {
      const detail = authResult.error || 'unknown error';
      if (opts.json) {
        printJson({ ok: false, code: ERROR_CODES.AUTH_FAILED, flow_id: flowId, detail });
      } else {
        console.error(`\n  Sign-in failed: ${detail}.\n`);
      }
      process.exitCode = 1;
      return;
    }

    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    // ── Apply ─────────────────────────────────────────────────────────────
    try {
      const result = await serviceClient.cancelFlow(flowId);
      if (opts.json) {
        printJson({ ok: true, flow_id: result.flow_id, state: result.state });
      } else {
        console.log('');
        console.log(`  \x1b[32m✓\x1b[0m Flow ${B(result.flow_id)} cancelled (state: ${result.state}).`);
        console.log('  Any repo lock it held is released.');
        console.log('');
      }
    } catch (err) {
      const capyErr =
        err instanceof CapyError
          ? err
          : new CapyError(err instanceof Error ? err.message : String(err), ERROR_CODES.SERVICE_ERROR);

      if (opts.json) {
        printJson({ ok: false, code: capyErr.code, flow_id: flowId, detail: capyErr.message });
      } else if (capyErr.code === ERROR_CODES.FLOW_NOT_FOUND) {
        console.error('');
        console.error(`  Flow ${B(flowId)} does not exist, or is not yours to cancel.`);
        console.error('  (The server does not distinguish the two, to avoid leaking which flows exist.)');
        console.error('');
      } else {
        console.error('');
        console.error(`  Failed to cancel flow ${B(flowId)}: ${capyErr.message}`);
        console.error('');
      }
      process.exitCode = 1;
    }
  }
}
