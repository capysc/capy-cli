/**
 * CAP-384 — the "am I ephemeral?" signal, and ONLY this signal.
 *
 * Explicitly rejected: hostname sniffing, container-filesystem heuristics
 * (/.dockerenv, cgroup inspection), CI env-var guessing. All of those are
 * either spoofable, wrong on real developer laptops running Docker, or wrong
 * on real sandboxes that happen to reuse a friendly hostname. The task
 * brief names the two honest alternatives; this module implements exactly
 * those two and nothing else:
 *
 *   1. An env var an ORCHESTRATOR sets deliberately (e.g. capy-mcp's session
 *      bootstrap, once it has minted a grant and wants every subsequent
 *      `capy` invocation in the sandbox to use it) —
 *      `CAPY_DEVICE_KEY_GRANT_SOCKET`, pointing at the daemon's socket path.
 *      Its value is produced by exactly one thing: `capy device-key grant`'s
 *      own stdout (see deviceKeyCommand.ts), never guessed or derived.
 *   2. An explicit invocation — `capy device-key grant` (or the CLI's own
 *      internal wiring calling `runGrantCeremony` directly) — which is, by
 *      construction, a deliberate act naming this session ephemeral. There
 *      is no ambient/automatic promotion into grant mode: a command that
 *      never sees the env var and is never told to grant just uses today's
 *      behavior, unchanged.
 *
 * "Ephemeral" here means "prefer a grant over a durable unlock," not "is
 * this a container." A long-lived desktop session could in principle export
 * this env var and opt into grant semantics too — the signal is about
 * intent, not about detecting a fact about the host.
 */
import { GRANT_SOCKET_ENV_VAR } from './grantHolder';

/**
 * The configured grant socket path, or null if none is set. Presence alone
 * is the signal that a caller should PREFER a grant over a durable unlock —
 * callers still verify liveness (`isGrantActive`) before trusting it, since
 * an env var can point at a socket whose daemon already expired and exited.
 */
export function configuredGrantSocketPath(): string | null {
  const value = process.env[GRANT_SOCKET_ENV_VAR];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
