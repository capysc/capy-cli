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


## Product UI: React only (owner ruling, 2026-09-05)

React is the only supported product UI. Keep’s native React kit and workbench
are canonical, permanently—not a temporary migration exception. Never create
or modify Svelte screens as the source of a product UI change.

1. Change screens in keep/src/components/screens and reuse keep/src/components/kit
   (paths relative to the monorepo; in Keep itself omit the keep/ prefix).
2. Add typed fixtures in keep/src/app/dev/kit-frame/fixtures and register new screens.
3. Verify every changed state at 480×640 in light and dark, including logos and overlays.
4. Run Keep typechecking, tests, builds, and relevant fixture/visual checks.
5. Other consumers receive generated artifacts through documented sync commands;
   never hand-edit generated or vendored output or build a consumer-only UI twin.

Use existing design tokens and native CSS modules. Do not add runtime style
injection, weaken CSP, or bypass authentication gates. Use headless isolated
browser profiles for visual checks; do not disturb the owner’s browser profile.

Svelte is the GOLDEN REFERENCE for styling and layouts. Preserve its sources,
design tokens, and visual/CSS parity checks. React owns the product runtime;
obsolete Svelte runtime consumers can be retired after migration, but the golden
reference and checks are not deletion targets. Do not weaken checks or reinterpret
React-only implementation as permission to redesign the reference styling.
