# Security Policy

Capy is a secrets manager — security issues in it matter more than in most software.
If you think you've found a vulnerability, we want to hear about it, and we'll take
it seriously.

## Reporting a vulnerability

**Please report security issues privately — not in public GitHub issues.**

- **Preferred:** [Report a vulnerability](https://github.com/capysc/capy-cli/security/advisories/new)
  via GitHub private vulnerability reporting.
- **Email:** [security@capy.sc](mailto:security@capy.sc)

Include what you can: affected version (`capy --version`), steps to reproduce,
and impact as you understand it. **Never include real secrets, keys, seed
phrases, or customer data in a report** — a redacted example or synthetic values
are always enough.

## What to expect

- **Acknowledgment within 2 business days.**
- An assessment and expected timeline within **5 business days**.
- We'll keep you updated as we work on a fix, and credit you in the release
  notes when it ships (unless you'd rather stay anonymous).
- Critical issues are fixed and released as fast as we can build them —
  typically days, not weeks.

## Supported versions

Only the **latest release** receives security fixes. If you're on an older
version, update first — the issue may already be fixed:

```
npm install -g @capysc/cli@latest   # or: brew upgrade capy
```

## Scope

In scope:

- The `capy` CLI (this repository): command handling, local encryption and key
  storage, sync, and anything that could expose secret material.
- The Capy service APIs the CLI talks to.

Ground rules for testing:

- **Only test against your own account and your own data.** Never access,
  modify, or delete another user's or organization's data.
- No denial-of-service, spam, or social engineering.
- If you stumble into someone else's data, stop immediately and report it.

## Good-faith research

We will not pursue legal action against researchers who follow this policy:
report privately, act in good faith, don't harm users or the service, and give
us reasonable time to fix before any public disclosure. We currently don't run
a paid bounty program, but we do credit reporters.

## Keeping yourself secure

- Your **seed phrase is recovery-equivalent** — Capy staff will never ask for
  it. Anyone who does is phishing you.
- Install only from official sources: `npm` (`@capysc/cli`), Homebrew
  (`capysc/tap/capy`), or the GitHub releases on this repository.
