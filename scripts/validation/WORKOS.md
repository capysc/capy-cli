# Synthetic WorkOS validation

This uses real staging Capy authentication, custody, sync and encrypted Keep conversation UI, with synthetic WorkOS responses. No real WorkOS account or credential is accessed. This does not constitute real-provider acceptance.

Prerequisites: Node 22+, Bun, the extracted `capy-staging` package, and a new disposable repository whose project name starts with `capy-flow-validation-`. Use an active agent host to launch the flow, relay its public link/code/purpose/expiry and explicit account-confirmation question, and keep reading until the Service records the result. Vince performs sign-in, account confirmation, Pawprint and browser approvals.

Set `CAPY_STAGING_PACKAGE` to the absolute extracted package directory. In a new folder named `capy-flow-validation-<your-suffix>`, run:

```sh
node "$CAPY_STAGING_PACKAGE/bin/capy-staging" onboard --json
```

Complete the Keep flow with the active host. Use the development branch of this disposable staging project. Confirm `keep.lock` names the intended `capy-flow-validation-…` project before proceeding.

Install only synthetic fixture values and the explicit marker in that repository:

```sh
printf '%s\n' '{"purpose":"capy-staging-workos-validation-v1"}' > .capy-workos-validation.json
printf '%s\n' 'capy-synthetic-workos-key-initial' | node "$CAPY_STAGING_PACKAGE/bin/capy-staging" edit WORKOS_API_KEY --json --no-pr
printf '%s\n' 'client_01JD4FCFQ5M1XGAV5E4CG8BT8A' | node "$CAPY_STAGING_PACKAGE/bin/capy-staging" edit WORKOS_CLIENT_ID --json --no-pr
CAPY_NO_AUTOCOMMIT=1 bun --preload "$CAPY_STAGING_PACKAGE/scripts/validation/workos-fixture.mjs" "$CAPY_STAGING_PACKAGE/bin/capy-staging" connect workos --var WORKOS_API_KEY
```

The two values are synthetic. The edit/connect steps save them and their managed metadata to the disposable staging project. The preload refuses other project names, missing markers, unexpected variables/values, real WorkOS subprocesses and production API requests. Do not use it in an existing customer repository.

Launch each rotation with the same active host reader:

```sh
CAPY_SYNTHETIC_WORKOS_SCENARIO=success CAPY_NO_AUTOCOMMIT=1 bun --preload "$CAPY_STAGING_PACKAGE/scripts/validation/workos-fixture.mjs" "$CAPY_STAGING_PACKAGE/bin/capy-staging" rotate-flow WORKOS_API_KEY --no-push --json
```

`--no-push` keeps the rotation result local and does not deploy. Normal sync still runs first; resolve any displayed synthetic drift explicitly before approving rotation. Use the exact `flow_id`, Keep URL and continuation from this invocation. Never restart an ambiguous mutation to make it appear successful.

Repeat with `CAPY_SYNTHETIC_WORKOS_SCENARIO` set to:

| Scenario | Expected result |
|---|---|
| `success` | Browser approves the explicit environment/application; one synthetic replacement is applied locally; final outcome succeeds. |
| `reauth` | Synthetic permission refusal asks whether to authenticate again; browser confirms synthetic authentication and reapproves the pinned target; succeeds. |
| `replacement-code` | The synthetic code expires; browser explicitly requests another code and confirms synthetic authentication; target is reapproved; succeeds. |
| `permission-denied` | One authentication recovery is allowed; persistent denial fails without an authentication loop or local replacement. |
| `changed-target` | The environment changes after authentication; rotation refuses before another create or local replacement. |
| `ambiguous-create` | Create response is lost; outcome is uncertain, no replay occurs, and no local replacement is written. |

For cancellation, decline the initial rotation approval, or cancel the active flow through the host. It must end as cancelled without replacement. After successful local-only rotation, normal sync may show drift against the remote synthetic value; resolve it through the ordinary browser flow before another run. Do not delete custody or authentication to reset a scenario.

Each synthetic provider panel says `WorkOS (synthetic)` and contains no provider website to visit. Your Capy/Keep sign-in remains real staging authentication and is separate from this synthetic provider ceremony.
