import { describe, expect, test } from "bun:test";
import {
  buildPushReview,
  pushReviewDecision,
  type PushReviewInput,
} from "../../src/sync/pushReview";
import type { KeepFile } from "../../src/types/index";

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
  mode: "free_snapshot",
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
      removed_remote_names: ["BRAVO"],
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
      { ...base, mode: "paid_merge" },
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

  test("requires the exact plan hash for one or more free snapshot removals", () => {
    const review = buildPushReview({
      ...base,
      localRaw: { ALPHA: "local-alpha-plaintext" },
      keep: keep({
        BRAVO: [
          {
            branch: "development",
            resource_id: "remote-bravo",
            value_hash: "remote-hash-bravo",
          },
        ],
        CHARLIE: [
          {
            branch: "development",
            resource_id: "remote-charlie",
            value_hash: "remote-hash-charlie",
          },
        ],
        ALPHA: [
          {
            branch: "development",
            resource_id: "remote-alpha",
            value_hash: "remote-hash-alpha",
          },
        ],
      }),
    });

    expect(review).toMatchObject({
      removed_remote_names: ["BRAVO", "CHARLIE"],
      requires_confirmation: true,
    });
    expect(pushReviewDecision(review, {})).toMatchObject({
      ok: false,
      code: "PUSH_CONFIRM_REQUIRED",
    });
    expect(
      pushReviewDecision(review, { confirm: review.plan_hash }),
    ).toBeNull();
  });

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
      mode: "free_snapshot" as const,
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
      removed_remote_names: ["REMOTE_ONLY"],
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
