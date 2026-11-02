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

/**
 * Project -> repo link reporting (CAP-697) talks to the service from inside
 * `resolveContext` and the sync/push/edit/run paths. No test may report a real
 * repo of the developer's checkout anywhere; the tests that exercise reporting
 * pass their own dependencies, or switch it back on (`CAPY_NO_REPO_LINK=''`) for
 * a child process pointed at a mock service.
 */
process.env.CAPY_NO_REPO_LINK = '1';
