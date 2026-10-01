/**
 * `src/ui/projectsScreenDriver.ts` — the imperative shell that drives the
 * `capy projects` type-to-search screen. Exercised with a fake TTY stream,
 * the same pattern `tests/ui/maskedLinkPrompt.test.ts` uses for
 * `maskedLinkPrompt.ts`: `stdin` is a real `EventEmitter` plus mocked
 * `setRawMode`/`resume`/`pause`/`setEncoding` (so `runProjectsScreen` never
 * touches a real file descriptor), and `stdout` is a `mock()` whose calls
 * are read back directly rather than accumulated into a mutable buffer of
 * this file's own.
 *
 * `secretsScreenDriver.ts` has no driver-level test of its own (its
 * `secretsCommand.test.ts` only ever mocks the whole module out) — this
 * file is the first one for this event-bus/async-iterator driver shape in
 * this codebase, hence the injectable `stdin`/`stdout`/`getSize`/`onResize`/
 * `onSignal` on `runProjectsScreen` (mirroring `fullScreenQr.ts`'s own
 * injectable `getSize`/`onResize`), which `secretsScreenDriver.ts` doesn't
 * need since nothing drives it directly today.
 */
import { EventEmitter } from 'node:events';
import { describe, test, expect, mock } from 'bun:test';
import { runProjectsScreen } from '../../src/ui/projectsScreenDriver';
import type { ProjectBranchSummary, ProjectSummary } from '../../src/commands/projectsCommand';
import type { KeyStdin } from '../../src/ui/maskedLinkPrompt';

const ESC = '\x1b';
const CTRL_C = '\x03';

function branch(name: string, isProtected = false, id = name): ProjectBranchSummary {
  return { id, name, protected: isProtected };
}

function project(name: string, branches: readonly ProjectBranchSummary[] = [], id = name): ProjectSummary {
  return { id, name, branches };
}

const FIXTURE_PROJECTS: readonly ProjectSummary[] = [
  project('web', [branch('development'), branch('production', true)]),
  project('api', [branch('main')]),
  project('billing-queue', []),
];

/** Same fake stdin `maskedLinkPrompt.test.ts` uses: a real `EventEmitter` (so `.on('data', …)`/`.removeListener(...)`/`.listenerCount(...)` behave exactly like the real thing) plus mocked TTY-control methods. */
function fakeStdin(isTTY = true) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY,
    setRawMode: mock((_mode: boolean) => {}),
    resume: mock(() => {}),
    pause: mock(() => {}),
    setEncoding: mock((_enc: string) => {}),
  }) as unknown as KeyStdin & EventEmitter & { setRawMode: ReturnType<typeof mock>; resume: ReturnType<typeof mock>; pause: ReturnType<typeof mock>; setEncoding: ReturnType<typeof mock> };
}

/** Fake stdout: every `write()` call recorded on the mock's own call log. */
function fakeStdout() {
  const write = mock((_text: string) => {});
  return {
    write,
    text: () => write.mock.calls.map((c) => c[0] as string).join(''),
    lastFrame: () => write.mock.calls[write.mock.calls.length - 1]?.[0] as string | undefined,
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Lets the driver's event-bus/async-iterator chain drain however many microtask ticks it needs after a synchronous `stdin.emit('data', …)` — one keypress can take several ticks to turn into a redraw (the `on()` async iterator's own queueing, plus one recursive `loop()` call per action). Recurses rather than looping with a counter — no mutable binding needed for "do this N more times". */
async function flush(ticks = 30): Promise<void> {
  if (ticks <= 0) return;
  await Promise.resolve();
  return flush(ticks - 1);
}

/** Starts the driver against a fresh fake TTY and returns everything a test needs — never awaited itself until the test drives it to quit (that's the point: it only resolves once the user quits). */
function startScreen(projects: readonly ProjectSummary[] = FIXTURE_PROJECTS) {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const done = runProjectsScreen(projects, {
    stdin,
    stdout,
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    onSignal: () => () => {},
  });
  return { stdin, stdout, done };
}

describe('runProjectsScreen — initial draw', () => {
  test('enters the alt screen, hides the cursor, and draws the list immediately (before any keypress)', async () => {
    const { stdin, stdout, done } = startScreen();

    expect(stdout.text()).toContain('\x1b[?1049h'); // ENTER_ALT_SCREEN
    expect(stdout.text()).toContain('\x1b[?25l'); // HIDE_CURSOR
    expect(stripAnsi(stdout.lastFrame() ?? '')).toContain('capy projects');
    expect(stripAnsi(stdout.lastFrame() ?? '')).toContain('web');
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);

    stdin.emit('data', CTRL_C);
    await done;
  });
});

describe('runProjectsScreen — type-to-search', () => {
  test('typing filters the list live and updates the match count', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', 'api');
    await flush();

    const frame = stripAnsi(stdout.lastFrame() ?? '');
    expect(frame).toContain('1/3');
    expect(frame).toContain('api');
    expect(frame).not.toContain('billing-queue');

    stdin.emit('data', CTRL_C);
    await done;
  });

  test('Esc clears a non-empty query without quitting', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', 'api');
    await flush();
    expect(stripAnsi(stdout.lastFrame() ?? '')).toContain('1/3');

    stdin.emit('data', ESC);
    await flush();
    const frame = stripAnsi(stdout.lastFrame() ?? '');
    expect(frame).toContain('3/3');
    expect(frame).toContain('billing-queue'); // back to the full list

    stdin.emit('data', CTRL_C);
    await done;
  });

  test('Esc pressed again on an already-empty query quits and restores the terminal', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', ESC);
    await done;

    expect(stdout.text()).toContain('\x1b[?25h'); // SHOW_CURSOR
    expect(stdout.text()).toContain('\x1b[?1049l'); // EXIT_ALT_SCREEN
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.listenerCount('data')).toBe(0);
  });
});

describe('runProjectsScreen — inspect view (Enter / q / Esc)', () => {
  test('Enter opens the inspect view for the selected row; q closes it back to the list', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', '\r');
    await flush();
    const opened = stripAnsi(stdout.lastFrame() ?? '');
    expect(opened).toContain('branches');
    expect(opened).toContain('development');
    expect(opened).toContain('production');
    expect(opened).toContain('close');

    stdin.emit('data', 'q');
    await flush();
    const closed = stripAnsi(stdout.lastFrame() ?? '');
    expect(closed).toContain('inspect');
    expect(closed).toContain('clear/quit');

    stdin.emit('data', CTRL_C);
    await done;
  });

  test('Esc also closes the inspect view (without quitting)', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', '\r');
    await flush();
    expect(stripAnsi(stdout.lastFrame() ?? '')).toContain('close');

    stdin.emit('data', ESC);
    await flush();
    expect(stripAnsi(stdout.lastFrame() ?? '')).toContain('inspect');

    stdin.emit('data', CTRL_C);
    await done;
  });
});

describe('runProjectsScreen — Ctrl-C always quits and restores the terminal', () => {
  test('Ctrl-C quits immediately, even mid-search', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', 'web');
    await flush();
    stdin.emit('data', CTRL_C);
    await done;

    expect(stdout.text()).toContain('\x1b[?25h');
    expect(stdout.text()).toContain('\x1b[?1049l');
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(stdin.listenerCount('data')).toBe(0);
  });
});

describe('runProjectsScreen — a chunk carrying several keypresses at once', () => {
  test('a paste-sized chunk ("api\\r") types each character then opens the matching row\'s inspect view', async () => {
    const { stdin, stdout, done } = startScreen();

    stdin.emit('data', 'api\r');
    await flush();

    const frame = stripAnsi(stdout.lastFrame() ?? '');
    expect(frame).toContain('branches');
    expect(frame).toContain('main');

    stdin.emit('data', CTRL_C);
    await done;
  });
});
