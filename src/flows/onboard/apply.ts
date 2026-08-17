// The only writer in the onboarding flow. Applies the run-wrap edits from a
// confirmed plan, re-checking each file against the content captured at plan
// time (TOCTOU guard) so a file changed since planning is skipped, not clobbered.
// Deploy is NOT written here — it is deferred to `capy deploy` (the real, tested
// path); apply only surfaces it as a next step.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OnboardPlan } from './plan';

export interface ApplyOutcome {
  path: string;
  summary?: string;
  reason?: string;
}

export interface ApplyResult {
  dryRun: boolean;
  applied: ApplyOutcome[];
  skipped: ApplyOutcome[];
  nextSteps: string[];
}

export function applyPlan(plan: OnboardPlan, opts: { dryRun?: boolean } = {}): ApplyResult {
  const dryRun = opts.dryRun === true;
  const applied: ApplyOutcome[] = [];
  const skipped: ApplyOutcome[] = [];

  for (const edit of plan.diffs) {
    const abs = join(plan.targetDir, edit.path);

    if (edit.noop) {
      skipped.push({ path: edit.path, reason: 'already done' });
      continue;
    }

    if (edit.action === 'create') {
      if (existsSync(abs)) {
        skipped.push({ path: edit.path, reason: 'file already exists — not overwriting' });
        continue;
      }
      if (!dryRun) writeFileSync(abs, edit.after);
      applied.push({ path: edit.path, summary: edit.summary });
      continue;
    }

    // modify: re-read and compare to the content captured at plan time.
    if (!existsSync(abs)) {
      skipped.push({ path: edit.path, reason: 'file no longer exists' });
      continue;
    }
    const current = readFileSync(abs, 'utf8');
    if (current === edit.after) {
      skipped.push({ path: edit.path, reason: 'already applied' });
      continue;
    }
    if (current !== edit.before) {
      skipped.push({ path: edit.path, reason: 'file changed since planning — re-run capy_onboard_plan' });
      continue;
    }
    if (!dryRun) writeFileSync(abs, edit.after);
    applied.push({ path: edit.path, summary: edit.summary });
  }

  return { dryRun, applied, skipped, nextSteps: buildNextSteps(plan) };
}

function buildNextSteps(plan: OnboardPlan): string[] {
  const steps: string[] = [];
  for (const c of plan.connectors.filter((x) => x.status === 'implemented')) {
    steps.push(`Install + authenticate the ${c.cli ?? c.provider} CLI, then run \`capy connect ${c.provider.toLowerCase()}\`.`);
  }
  const planned = plan.connectors.filter((x) => x.status === 'planned');
  if (planned.length) {
    steps.push(
      `Add these manually (no Capy connector yet) — use the secure secret-intake, never paste values into chat: ${planned.map((x) => x.provider).join(', ')}.`,
    );
  }
  if (plan.deployTargets.length) {
    // Phrase as a DETECTED-possibility prompt, not an assertion: onboarding writes
    // no deploy config (deferred to `capy deploy`, the source of truth), so a wrong
    // guess should read as a suggestion the user can ignore — not a claim. The user
    // picks the real target when they run `capy deploy <target>`.
    steps.push(
      `Detected possible deploy target(s): ${plan.deployTargets
        .map((t) => t.label)
        .join(', ')}. Run \`capy deploy <target>\` for whichever you actually use (\`capy targets\` lists them).`,
    );
  }
  return steps;
}
