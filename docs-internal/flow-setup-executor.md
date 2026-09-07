# Keep-owned repository executor

`capy[-dev] flow setup PARENT --expected-user-id USER --service-origin ORIGIN --json`
is a bounded, noninteractive executor. It requires the completed same-flow
pairing checkpoint, matching CLI account, runtime custody, environment and Git
root. It never transfers tokens, opens a browser, grants approval or creates a
local MCP server. Every successful invocation returns to `capy_onboard`.

The service's `/flows/:id/repository` state selects observation, attribution,
planning, approval, application and verified completion. Observation uses exact
root `.env` names and `keep.lock`; `.capy` alone is never project attribution.
Free accounts use the service default project without a local lock. Paid/team
fresh repositories require explicit organization/project selection, even with
only one choice. Service-created projects arrive as concrete target IDs.

Existing `SetupCommand` and `SyncCommand` execute the operation. Setup's
`--org` plus `--project` or `--create-project` choices are included in its
existing consent hash, together with the environment and environment-file path;
the printed confirm command preserves those flags. Sync's optional plan/confirm
seam describes its existing pull without replacing conflict checks. Both offer
an injected result reporter; ordinary CLI stdout remains unchanged. Neither
current operation deletes remote entries, and their plans say so explicitly.

An approved setup already performs the first canonical push/pull. Applied,
synced and verified are milestones from that one operation, not instructions to
perform it twice. A paid empty local stub remains valid without manufacturing a
remote marker; free empty initialization retains its canonical remote marker.
Absent `.env` remains absent unless the approved operation pulls actual values.

Protected, logout-cleared setup receipts record exact flow/user/environment,
runtime/repository, target, approved hash and operation UUID. A completed receipt
also pins the resulting local file digest. Reporting can resume in another
process without repeating application, and the service independently validates
remote target/hash/access. Changed local files refuse receipt reuse. A crash
inside the local operation before its completion receipt is saved produces
`SETUP_APPLY_INTERRUPTED`; it does not blindly repeat potentially partial writes.
That ambiguous interval requires inspection, not a false success claim.

Focused executor tests cover state/approval authority, changed facts, receipt
replay and interruption. These are not substitutes for a real owner-approved
agent-to-Keep-to-CLI acceptance run.
