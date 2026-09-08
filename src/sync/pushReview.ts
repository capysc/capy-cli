import { createHash, createHmac } from "crypto";
import type { KeepFile, KeepVariableEntry } from "../types/index";

/** ECMAScript code-unit ordering, independent of host locale and ES2023 APIs. */
function sorted(values: readonly string[]): readonly string[] {
  return values.reduce<readonly string[]>((ordered, value) => {
    const insertionIndex = ordered.findIndex((candidate) => candidate > value);
    return insertionIndex < 0
      ? [...ordered, value]
      : [
          ...ordered.slice(0, insertionIndex),
          value,
          ...ordered.slice(insertionIndex),
        ];
  }, []);
}

export interface PushReviewOptions {
  readonly plan?: boolean;
  readonly confirm?: string;
}

export interface PushReviewScope {
  readonly repository: string;
  readonly serviceOrigin: string;
}

/** The review is observational: callers may provide an already-frozen keep file. */
export type PushReviewKeep = Readonly<Omit<KeepFile, "variables">> & {
  readonly variables: Readonly<
    Record<string, readonly Readonly<KeepVariableEntry>[]>
  >;
};

export interface PushReviewInput extends PushReviewScope {
  readonly mode: "free_snapshot" | "paid_merge" | "local_only";
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly branch: string;
  readonly keep: PushReviewKeep;
  readonly baseKeepHash?: string;
  /** Local-only inputs. Neither these values nor this key may be reported. */
  readonly localRaw: Readonly<Record<string, string>>;
  readonly projectKey: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .reduce<readonly (readonly [string, unknown])[]>((ordered, entry) => {
        const insertionIndex = ordered.findIndex(([key]) => key > entry[0]);
        return insertionIndex < 0
          ? [...ordered, entry]
          : [
              ...ordered.slice(0, insertionIndex),
              entry,
              ...ordered.slice(insertionIndex),
            ];
      }, [])
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A keyed digest binds values without publishing an offline password-guessing oracle. */
export function buildPushReview(input: PushReviewInput) {
  const variableNames = sorted(Object.keys(input.localRaw));
  const removedNames =
    input.mode === "free_snapshot"
      ? sorted(
          Object.entries(input.keep.variables)
            .filter(
              ([name, entries]) =>
                !variableNames.includes(name) &&
                entries.some((entry) => entry.branch === input.branch),
            )
            .map(([name]) => name),
        )
      : [];
  const summary = {
    version: 1,
    mode: input.mode,
    repository_fingerprint: createHash("sha256")
      .update(input.repository)
      .digest("hex"),
    service_origin: input.serviceOrigin,
    user_id: input.userId,
    organization_id: input.organizationId,
    project_id: input.projectId,
    project_name: input.keep.project_name,
    branch: input.branch,
    variable_names: variableNames,
    removed_remote_names: removedNames,
    requires_confirmation: removedNames.length > 0,
  } as const;
  const digest = createHmac("sha256", input.projectKey)
    .update(
      canonical({
        purpose: "capy-push-review-v1",
        summary,
        local: input.localRaw,
        keep: input.keep,
        base: input.baseKeepHash ?? null,
      }),
    )
    .digest("hex");
  return { ...summary, plan_hash: `hmac-sha256:${digest}` } as const;
}

export type PushReview = ReturnType<typeof buildPushReview>;
export function pushReviewDecision(
  review: PushReview,
  options: PushReviewOptions,
) {
  if (options.confirm !== undefined && options.confirm !== review.plan_hash)
    return {
      ok: false,
      code: "PUSH_PLAN_CHANGED",
      plan: review,
      message:
        "The push changed since it was reviewed. Ask the agent to prepare a fresh review.",
    } as const;
  if (options.plan)
    return {
      ok: true,
      code: "PUSH_PLANNED",
      plan: review,
      message: "Push prepared. No project files or remote values were changed.",
    } as const;
  if (review.requires_confirmation && options.confirm !== review.plan_hash)
    return {
      ok: false,
      code: "PUSH_CONFIRM_REQUIRED",
      plan: review,
      message:
        "This push removes remote values. Review the listed names and approve before continuing.",
    } as const;
  return null;
}

export function pushCompleted(review: PushReview) {
  return {
    ok: true,
    code: "PUSH_DONE",
    plan: review,
    pushed_count: review.variable_names.length,
    removed_count: review.removed_remote_names.length,
  } as const;
}

export type PushReviewResult =
  | NonNullable<ReturnType<typeof pushReviewDecision>>
  | ReturnType<typeof pushCompleted>;
