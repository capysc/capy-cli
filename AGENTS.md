# Agent instructions — capy-cli

## CARDINAL RULE — `let` IS ILLEGAL. EVERYTHING IS `const`

NEVER write `let`. EVER. Under any circumstance. NO variable reassignment, ever, under any
circumstances. No hoisted variables — never declare a binding before the value that fills it.
`var` is likewise illegal. This is absolute and overrides style preferences, brevity, and your
own judgment about readability.

For CONTROL FLOW, ALWAYS USE EARLY RETURNS. Guard clauses first, the happy path last and
unindented. Never build a result by mutating it across branches.

Instead of reassignment, use:
- a ternary, or a small helper function that RETURNS the value
- `.map` / `.filter` / `.reduce` / `Object.fromEntries` over push-into-an-array loops
- `const` inside each branch of an early-return chain, never one `let` above the branches

## STANDING RULE — every browser page goes through the monorepo workbench

Not negotiable, and corrected more than once. If you are adding or changing ANY
user-facing browser page, this is the process. There is no "just this one".

**1. The screen is a Svelte screen in the capy monorepo `packages/ui/screens/<name>/`.**
Never hand-rolled React (or anything else) in a consuming app. A second
implementation drifts and will score "perfect" against a pixel test while being
visually wrong — that has already happened here.

**2. Build it on THE KIT, not on `packages/ui/src/lib/Card.svelte`.**
This is the trap. `capy origin/main`'s `packages/ui` is a two-screen SKELETON
(auth-error, auth-success; `src/lib` = CapyLogo/Card/base.css). Its `Card` is a
448px centred box with `border-radius: 0.5rem` — **that rounded card is NOT the
design system.** The real kit (~40 components: `Button`, `Page`, `Callout`,
`Badge`, `Field`, `StatusLine`, `tokens.css`) plus all 42 real screens lives on
capy branch `cvince/cli-ui-all-screens` (working copy:
`conductor/workspaces/capy-mcp/brazzaville/.context/capy-inline-select/packages/ui/`).
The kit language is: mark left / heading right-aligned, left-aligned body, FULL-BLEED
UPPERCASE buttons with NO radius, Callout for warnings, Badge for coded states.
If your page has a rounded centred card, you built it on the skeleton — wrong.
Port kit components verbatim (with an upstream header comment) if they are not
yet in `packages/ui`.

**3. Typed contract + golden fixtures** in `packages/fixtures`, registered at the
append markers (never reorder — parallel agents depend on clean union merges).

**4. ITERATE IN THE WORKBENCH** (`packages/workbench`, `?screen=&viewport=&theme=`).
Start vite directly — `bun run dev` passes `--open`. Headless only, isolated
mkdtemp profile. NEVER launch the user's real Chrome (it logs him out and breaks
his Keychain).

**5. Screenshot EVERY state at Popup 480×640 in BOTH light and dark**, compared
against a real kit screen. Popup is the default viewport because these are CLI
popup windows, not desktop pages. `base.css` carries a full dark palette plus
`--logo-invert`; dark mode has shipped broken here before and was caught only by
rendering it.

**6. The consuming app SERVES THE BUILT ARTIFACT** — vendored canonical CSS with
a byte-wise sync check, nonce-safe injected style/script under the existing CSP
(pattern: `.context/reports/device-key-on-kit.md`). It does not own a copy.

**7. Green before you report:** `svelte-check` 0 errors, fixtures validator,
`packages/ui` build under budget, workbench tsc.

Pages with no canonical twin still owe SYSTEM ADHERENCE: same tokens, same type
scale, same spacing, same light/dark behaviour, zero bespoke hex or px values.
Enforce mechanically in CI, never by review.
