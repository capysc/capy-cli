/**
 * Loaded before every test file via `bunfig.toml`'s `[test] preload`.
 *
 * No test may launch the developer's browser. `tests/run-tests.sh` already
 * exports `CAPY_WEB_NO_OPEN=1`, but a bare `bun test <file>` skips that
 * script — so the suppression lives here too, where every `bun test` run
 * picks it up. Child processes a test spawns inherit it through
 * `process.env`. Writing to `process.env` is the only way to set it for the
 * whole process; nothing else in this file mutates anything.
 */
process.env.CAPY_WEB_NO_OPEN = '1';
