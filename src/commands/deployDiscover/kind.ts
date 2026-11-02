/**
 * What differs between the providers `capy deploy <provider> --discover`
 * serves, as one set of overrides (CAP-703 Dokploy, CAP-696 Vercel).
 *
 * The shared modules (`discovery.ts`, `plan.ts`, `evaluate.ts`, `apply.ts`,
 * `command.ts`) behave exactly as they always did for Dokploy when no `kind`
 * is passed. A provider that passes one replaces ONLY the points below; the
 * matching of services to Capy projects, the plan checks, the GitHub reads
 * and the one-PR-per-repo write are the same code for both.
 *
 * Types only: this file imports nothing at runtime, so any module may import it.
 */
import type { TargetConfig } from '../../deploy/adapter';
import type { OrgRepoLink } from '../../service/serviceClient';
import type { PlanEntry } from './discovery';
import type { ExistingTarget, ServiceFacts } from './facts';

/** A pointer into the `capy help --json` document. */
export interface SchemaRef {
  readonly command: string;
  readonly pointer: string;
}

export interface BranchChoice {
  readonly branch: string;
  /** The standard mapping, as opposed to a fallback. */
  readonly standard: boolean;
}

export interface KindOverrides {
  /** `capy deploy <provider> --discover`: what a next step tells the agent to run, up to the flags. */
  readonly command: string;
  readonly schemaRef: SchemaRef;
  /** Mixed into `plan_id`, so a Dokploy plan and a Vercel plan never share one. */
  readonly planDomain: string;
  /** The Capy branch for a service, or `null` when the project has none that fits. */
  readonly chooseCapyBranch: (service: ServiceFacts, defaultBranch: string | null | undefined, projectBranches: readonly string[]) => BranchChoice | null;
  /** The existing target that already is this service's target on this Capy branch. */
  readonly configured: (targets: readonly ExistingTarget[], service: ServiceFacts, capyBranch: string) => ExistingTarget | undefined;
  /** An existing target that would clash with a new one for this service on this Capy branch. */
  readonly conflicting: (targets: readonly ExistingTarget[], service: ServiceFacts, capyBranch: string) => ExistingTarget | undefined;
  /** A plan entry's identity: two entries with the same key are `DUPLICATE_ENTRY`. */
  readonly duplicateKey: (entry: PlanEntry) => string;
  /** The `target` a proposal shows. */
  readonly proposalTarget: (service: ServiceFacts, branch: string, gitBranch: string, vars: readonly string[]) => Readonly<Record<string, unknown>>;
  /** The first part of a target's name (made unique per deploy.json by the shared code). */
  readonly baseName: (entry: PlanEntry, service: ServiceFacts) => string;
  /** The target `.capy/deploy.json` gets. */
  readonly targetFor: (args: {
    readonly name: string;
    readonly entry: PlanEntry;
    readonly service: ServiceFacts;
    readonly link: OrgRepoLink;
    readonly knownVars: readonly string[];
  }) => TargetConfig;
  /** One line a person reads, for an entry that will be written. */
  readonly summaryLine: (args: { readonly project_name: string; readonly service: ServiceFacts; readonly entry: PlanEntry }) => string;
  /** The pull request. Names and ids only. */
  readonly pr: {
    readonly title: string;
    readonly intro: string;
    readonly line: (args: { readonly target: TargetConfig; readonly path: string; readonly service: ServiceFacts }) => string;
  };
}
