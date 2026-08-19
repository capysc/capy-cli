/**
 * Every word this CLI shows for a flow step.
 *
 * The service names a dialog, a screen or a blocked reason; the WORDS come from
 * here. That split is deliberate and it is a security property, not a style
 * choice: a service that has been compromised can reorder or repeat a step, but
 * it cannot write the sentence a human reads before approving something, and it
 * cannot invent a remedy that sends them somewhere.
 *
 * Anything not in these tables is unknown copy for a known-closed enum, which
 * means this binary is older than the service. Say exactly that, rather than
 * rendering whatever arrived.
 */

const BLOCKED_COPY: Record<string, string> = {
  invalid_target_dir: 'That directory does not exist. Point capy at the app you want to onboard and run it again.',
  incompatible_project:
    "This project doesn't read its configuration from environment variables, so there is nothing for Capy to wire up yet.",
  branch_conflict:
    'Local state is inconsistent: the branch your .env was encrypted for and the branch .capy/branch names disagree.\n' +
    'Finish the interrupted checkout with `capy checkout <branch>`, then run this again.',
  key_not_on_device:
    "You have access to this organization, but its encryption key has never been transferred to this device.\n" +
    'Ask an owner for an invite code, then run `capy redeem <code>`.',
  human_stop_unreachable:
    'This step needs a decision only a human can make, and this run has no terminal or browser to ask in. Run `capy` in your terminal to finish it.',
  keep_lock_corrupt: 'keep.lock could not be read. It is tracked in git — restore it, then run this again.',
  foreign_encrypted_values:
    'Your .env holds values encrypted with a different project\'s key. Remove or replace them, then run this again.',
  auth_declined: 'Sign-in was not completed.',
  ceremony_declined: 'The approval was declined.',
  ceremony_expired: 'The approval link expired before it was used. Run this again for a fresh one.',
  consent_declined: 'Nothing was changed.',
  concurrent_flow: 'Another onboarding run is already in progress for this project.',
  upgrade_required: 'This version of capy is too old for the onboarding service. Upgrade capy and try again.',
  service_error: 'The Capy service could not complete this step. Try again shortly.',
  network_error: 'Could not reach the Capy service. Check your connection and try again.',
};

const SCREEN_COPY: Record<string, string> = {
  sandbox_session: 'Open this link to approve this machine:',
};

export function describeBlocked(reason: string): string {
  return BLOCKED_COPY[reason] ?? `Onboarding stopped (${reason}). Upgrade capy — this version has no guidance for that.`;
}

export function describeScreen(screen: string, params: Record<string, unknown>): string {
  const lead = SCREEN_COPY[screen] ?? `Continue in your browser (${screen}):`;
  const code = params.user_code;
  if (typeof code !== 'string' || code.length === 0) return lead;
  // The code is the anti-phishing binding: it exists to be compared, and a
  // comparison with no stated failure action is one most people skip.
  return `${lead}\n\nThe page will ask for this code (must match): ${code}\nIf the codes differ, decline.`;
}

/** The plan dialog, rendered from structured params. Names and counts only — never a value. */
export function renderPlanDialog(params: Record<string, unknown>): string {
  const lines: string[] = ['Capy onboarding plan', '='.repeat(20), ''];
  lines.push(`  Directory    ${String(params.target_dir ?? '')}`);
  if (params.framework) lines.push(`  Framework    ${String(params.framework)}`);

  const paths = (params.edit_paths as string[] | undefined) ?? [];
  lines.push('', 'FILES TO CHANGE');
  if (paths.length === 0) lines.push('  ·  no file changes needed');
  for (const p of paths) lines.push(`  ~  ${p}`);

  const checks = (params.cli_checks as Array<{ cli: string; installed: boolean }> | undefined) ?? [];
  if (checks.length > 0) {
    lines.push('', 'CLIs');
    for (const c of checks) lines.push(`  ${c.installed ? '✓' : '☐'}  ${c.cli}`);
  }

  const providers = (params.connector_providers as string[] | undefined) ?? [];
  if (providers.length > 0) {
    lines.push('', 'CONNECTORS  (detected — nothing connected)');
    for (const p of providers) lines.push(`  ○  ${p}`);
  }

  const count = Number(params.variable_count ?? 0);
  if (params.will_encrypt === true && count > 0) {
    const names = ((params.variable_names as string[] | undefined) ?? []).slice(0, 5).join(', ');
    lines.push('', 'SECRETS', `  ${count} value(s) will be encrypted and pushed: ${names}${count > 5 ? ', etc.' : ''}`);
  }

  return lines.join('\n');
}
