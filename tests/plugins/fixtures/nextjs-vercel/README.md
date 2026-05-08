# Vercel plugin test fixture

Self-contained Next.js 16 app, mirrors `~/Dev/test-project`. Used by
`tests/plugins/vercel.test.ts` to exercise the capy → Vercel build chain.

The page renders a server-component table with `data-capy-var={NAME}` and
`data-capy-value={NAME}` attributes so the plugin test can scrape rendered
HTML and assert each env var got inlined at build time.

This directory is the **fixture only** — node_modules, .next, .capy, .env,
and .vercel are gitignored. The plugin test copies this tree to a tmpdir and
runs `bun install` + `next build` there so the repo stays clean.
