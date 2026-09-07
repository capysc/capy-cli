# Connected secret intake executor

`capy[-dev] flow add CHILD --expected-user-id USER --service-origin ORIGIN --json`
executes one bounded step of the service-owned secret-intake child. The completed
onboarding receipt, live paired runtime, CLI identity, environment, repository
fingerprint and target must agree. `.capy` metadata never establishes a binding.

The service owns first-`.env` creation approval. The CLI only observes names and
file digests, relays a public Keep handoff, and stores the decision reference.
Keep locks the requested names; the CLI independently rejects missing, extra or
duplicate names before applying anything. Ordinary interactive Add is unchanged.

The existing broker's private connection handle is checkpointed in the protected
authentication-flows directory before publishing its link. Each new process polls
once: an immediate state read before the request is sent, then a bounded
20-second answer poll on later invocations. Attachment does not wake the broker's
answer long-poll, so the initial read must not wait for an answer to a request the
CLI has not sent yet. An attached page receives the fixed encrypted request; a delivered raw
ciphertext is saved before opening it. No browser, loopback form, listener, new
cryptography or dependency is introduced. Logout already removes this directory.

The executor reports application intent to the service before one existing
`syncResolvedSnapshot` operation. The canonical CAS conflict gate remains the
authority; same-name concurrent overwrite is never automatically approved. Free
mode stays lockless; paid mode retains its manifest and auto-commit behavior, with
an injected reporter so stdout contains one JSON result. The service verifies the
remote hash, encrypted blob, target and requested names before acknowledging done.

An applied receipt can retry completion without repeating writes. A crash inside
application is deliberately ambiguous and fails closed. A consumed broker answer
without its encrypted checkpoint requires a new request; it is never success.
`--cancel` cancels only before application, with service acknowledgement; it cannot
erase an applying or applied operation. Normal results return the typed
`capy_add({flow_id: CHILD})` continuation; cancellation has no continuation.

Evidence is layered: executor tests cover sealed-answer/checkpoint/replay and
binding/consent refusals; strict context tests cover free/paid targets; broker tests
exercise bounded local HTTP transport; canonical writer tests retain CAS coverage.
These are not by themselves a live browser or owner acceptance claim.
