import { describe, expect, test } from "bun:test";
import {
  buildPushReview,
  pushReviewDecision,
  type PushReviewInput,
} from "../../src/sync/pushReview";
import type { KeepFile } from "../../src/types/index";

// The lockless "free_snapshot" push mode — and the remote-removal detection
// (`removedNames`) that only ever fired for it — was deliberately removed by
// commit b910c372 ("refactor: require explicit Keep project context"), which
// narrowed PushReviewInput["mode"] to "paid_merge" | "local_only" and replaced
// the removal computation with an unconditional `const removedNames: readonly
// string[] = [];`. Fixtures below use "paid_merge" (the closest surviving
// mode to the original free_snapshot scenario) and no longer expect any
// removed_remote_names, since no mode reports removals any more.
const keep = (variables: KeepFile["variables"]): KeepFile => ({
  version: "3.0",
  org_id: "org_fixture",
  project_id: "project_fixture",
  project_name: "fixture-project",
  variables,
});

const base: PushReviewInput = {
  repository: "/fictional/repository",
  serviceOrigin: "https://service.example.invalid",
  mode: "paid_merge",
  userId: "user_fixture",
  organizationId: "org_fixture",
  projectId: "project_fixture",
  branch: "development",
  keep: keep({
    BRAVO: [
      {
        branch: "development",
        resource_id: "remote-bravo",
        value_hash: "remote-hash-bravo",
      },
    ],
    ALPHA: [
      {
        branch: "development",
        resource_id: "remote-alpha",
        value_hash: "remote-hash-alpha",
      },
    ],
    RELEASE_ONLY: [
      {
        branch: "release",
        resource_id: "remote-release",
        value_hash: "remote-hash-release",
      },
    ],
  }),
  baseKeepHash: "base-hash-fixture",
  localRaw: { ZULU: "local-zulu-plaintext", ALPHA: "local-alpha-plaintext" },
  projectKey: "project-key-plaintext",
};

describe("push review", () => {
  test("uses deterministic code-unit ordering independent of input insertion order", () => {
    const reversed: PushReviewInput = {
      ...base,
      localRaw: {
        ALPHA: "local-alpha-plaintext",
        ZULU: "local-zulu-plaintext",
      },
      keep: keep({
        RELEASE_ONLY: [
          {
            branch: "release",
            resource_id: "remote-release",
            value_hash: "remote-hash-release",
          },
        ],
        ALPHA: [
          {
            branch: "development",
            resource_id: "remote-alpha",
            value_hash: "remote-hash-alpha",
          },
        ],
        BRAVO: [
          {
            branch: "development",
            resource_id: "remote-bravo",
            value_hash: "remote-hash-bravo",
          },
        ],
      }),
    };

    expect(buildPushReview(base)).toMatchObject({
      variable_names: ["ALPHA", "ZULU"],
      removed_remote_names: [],
    });
    expect(buildPushReview(reversed).plan_hash).toBe(
      buildPushReview(base).plan_hash,
    );
  });

  test("binds every reviewed scope and value input into the keyed plan hash", () => {
    const expected = buildPushReview(base).plan_hash;
    const variants: readonly PushReviewInput[] = [
      { ...base, repository: "/fictional/other-repository" },
      { ...base, serviceOrigin: "https://other-service.example.invalid" },
      { ...base, userId: "user_other" },
      { ...base, organizationId: "org_other" },
      { ...base, projectId: "project_other" },
      { ...base, branch: "release" },
      { ...base, mode: "local_only" },
      { ...base, projectKey: "other-project-key-plaintext" },
      {
        ...base,
        localRaw: { ...base.localRaw, ALPHA: "changed-local-plaintext" },
      },
      {
        ...base,
        keep: keep({
          ...base.keep.variables,
          ALPHA: [
            {
              branch: "development",
              resource_id: "remote-alpha",
              value_hash: "changed-remote-hash",
            },
          ],
        }),
      },
      { ...base, baseKeepHash: "changed-base-hash" },
    ];

    expect(
      variants
        .map(buildPushReview)
        .map((review) => review.plan_hash)
        .filter((hash) => hash === expected),
    ).toEqual([]);
  });

  // A prior "requires the exact plan hash for one or more free snapshot
  // removals" test lived here. It exercised the free_snapshot removal-
  // detection and confirmation gate (removedNames computed from keep vs.
  // localRaw, requires_confirmation, PUSH_CONFIRM_REQUIRED). That entire
  // mechanism was deliberately removed by commit b910c372 ("refactor:
  // require explicit Keep project context"): PushReviewInput["mode"] no
  // longer includes "free_snapshot", and removedNames is now unconditionally
  // `[]` for every remaining mode, so no push review can ever require
  // removal confirmation any more. The test is removed rather than updated;
  // the invariant that paid/local pushes never report removals is still
  // covered below.
  test("never attributes free snapshot removals to paid merges", () => {
    const review = buildPushReview({
      ...base,
      mode: "paid_merge",
      localRaw: { ALPHA: "local-alpha-plaintext" },
    });

    expect(review).toMatchObject({
      removed_remote_names: [],
      requires_confirmation: false,
    });
    expect(pushReviewDecision(review, {})).toBeNull();
  });

  test("rejects a confirmation from a different plan", () => {
    const review = buildPushReview(base);

    expect(
      pushReviewDecision(review, { confirm: "hmac-sha256:not-this-plan" }),
    ).toMatchObject({
      ok: false,
      code: "PUSH_PLAN_CHANGED",
    });
  });

  test("reports names only and leaves frozen inputs unchanged", () => {
    const frozenEntry = Object.freeze({
      branch: "development",
      resource_id: "remote-secret-id",
      value_hash: "remote-secret-hash",
    });
    const frozenVariables = Object.freeze({
      REMOTE_ONLY: Object.freeze([frozenEntry]),
    });
    const frozenKeep = Object.freeze({
      version: "3.0",
      org_id: "org_fixture",
      project_id: "project_fixture",
      project_name: "fixture-project",
      variables: frozenVariables,
    });
    const frozenLocal = Object.freeze({
      LOCAL_ONLY: "local-super-secret-plaintext",
    });
    const frozenInput = Object.freeze({
      repository: "/fictional/repository",
      serviceOrigin: "https://service.example.invalid",
      mode: "paid_merge" as const,
      userId: "user_fixture",
      organizationId: "org_fixture",
      projectId: "project_fixture",
      branch: "development",
      keep: frozenKeep,
      baseKeepHash: "base-hash-fixture",
      localRaw: frozenLocal,
      projectKey: "project-key-super-secret",
    });
    const before = JSON.stringify(frozenInput);
    const review = buildPushReview(frozenInput);
    const reported = JSON.stringify(review);

    expect(before).toBe(JSON.stringify(frozenInput));
    expect(Object.isFrozen(frozenInput)).toBe(true);
    expect(Object.isFrozen(frozenKeep)).toBe(true);
    expect(Object.isFrozen(frozenVariables)).toBe(true);
    expect(Object.isFrozen(frozenLocal)).toBe(true);
    expect(review).toMatchObject({
      variable_names: ["LOCAL_ONLY"],
      removed_remote_names: [],
    });
    for (const privateValue of [
      "local-super-secret-plaintext",
      "project-key-super-secret",
      "remote-secret-id",
      "remote-secret-hash",
    ]) {
      expect(reported).not.toContain(privateValue);
    }
  });
});
