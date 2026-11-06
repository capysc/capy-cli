import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { SecretIndexRow } from '../../src/service/serviceClient';
import { handleKey, initialSecretsScreenState, render } from '../../src/ui/secretsScreen';
import { runSecretsScreen, type SecretsEditActions } from '../../src/ui/secretsScreenDriver';

const ESC = '\x1b';
const BEGIN_FRAME = `${ESC}[?2026h${ESC}[H`;
const END_FRAME = `${ESC}[J${ESC}[?2026l`;
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const rows: readonly SecretIndexRow[] = Array.from({ length: 240 }, (_, index) => ({
  name: `SECRET_${String(index).padStart(3, '0')}`,
  value_hash: `hash-${index}`,
  locations: [{ project_id: 'p1', project_name: 'web', branch: 'development', protected: false, service: null }],
  users: [],
}));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => { await tick(); await tick(); };
const press = (keys: string): void => { process.stdin.emit('data', Buffer.from(keys)); };
const afterKeys = (...keys: readonly string[]) => keys.reduce((state, key) => handleKey(state, key).state, initialSecretsScreenState(rows));
const frame = (state = initialSecretsScreenState(rows), width = 80, height = 24): string =>
  BEGIN_FRAME + render(state, width, height) + END_FRAME;

async function withScreen(
  check: (screen: Readonly<{
    frames: () => readonly string[];
    resize: (width: number, height: number) => void;
  }>) => Promise<void>,
  edit?: SecretsEditActions,
) {
  const write = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const columns = spyOn(process.stdout, 'columns', 'get').mockReturnValue(80);
  const height = spyOn(process.stdout, 'rows', 'get').mockReturnValue(24);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const done = runSecretsScreen(rows, async () => ({ ok: false, code: 'UNAVAILABLE' }), edit);
  const writes = () => write.mock.calls.map((call) => String(call[0]));
  const frames = () => writes().filter((text) => text.startsWith(BEGIN_FRAME));
  try {
    await check({
      frames,
      resize: (width, nextHeight) => {
        columns.mockReturnValue(width);
        height.mockReturnValue(nextHeight);
        process.emit('SIGWINCH');
      },
    });
    press('\x03\x03\x03');
    await done;
    return { writes: writes(), frames: frames() };
  } finally {
    press('\x03\x03\x03');
    await done;
    write.mockRestore();
    columns.mockRestore();
    height.mockRestore();
    log.mockRestore();
  }
}

describe('secrets screen redraws (CAP-719)', () => {
  test('writes the unchanged rendered content inside one synchronized frame, without a screen clear', async () => {
    await withScreen(async ({ frames }) => {
      expect(frames()).toEqual([frame()]);
      expect(frames()[0]).not.toContain(`${ESC}[2J`);
      expect(frames()[0]).not.toContain(`${ESC}[3J`);
      expect(frames()[0]).toEndWith(END_FRAME);
      expect(frames()[0].slice(BEGIN_FRAME.length, -END_FRAME.length).split('\n').every((line) => line.endsWith(`${ESC}[K`))).toBe(true);
    });
  });

  test('100 arrow keys in one input chunk apply every movement and draw once', async () => {
    await withScreen(async ({ frames }) => {
      const keys = Array.from({ length: 100 }, () => DOWN);
      press(keys.join(''));
      await settle();
      expect(frames()).toEqual([frame(), frame(afterKeys(...keys))]);
      expect(afterKeys(...keys).cursorIndex).toBe(100);
    });
  });

  test('separate input chunks in the same tick share a draw; a later burst gets its own', async () => {
    await withScreen(async ({ frames }) => {
      press(DOWN);
      press(DOWN);
      press(UP);
      await settle();
      expect(frames()).toEqual([frame(), frame(afterKeys(DOWN, DOWN, UP))]);
      press(DOWN);
      press(DOWN);
      await settle();
      expect(frames()).toHaveLength(3);
      expect(frames()[2]).toBe(frame(afterKeys(DOWN, DOWN, UP, DOWN, DOWN)));
    });
  });

  test('a shorter frame clears line tails and all rows below it', async () => {
    await withScreen(async ({ frames }) => {
      press('SECRET_239');
      await settle();
      const shorter = frames()[1];
      expect(shorter).toBe(frame(afterKeys(...'SECRET_239')));
      expect(shorter.split('\n').length).toBeLessThan(frames()[0].split('\n').length);
      expect(shorter.slice(BEGIN_FRAME.length, -END_FRAME.length).split('\n').every((line) => line.endsWith(`${ESC}[K`))).toBe(true);
      expect(shorter).toEndWith(END_FRAME);
    });
  });

  test('edit effects still run when their intermediate screens are coalesced', async () => {
    const loadRepos = mock(async () => ({ ok: true as const, links: [] }));
    const edit: SecretsEditActions = {
      loadRepos,
      loadBases: async () => ({}),
      run: async () => ({ ok: false, code: 'UNAVAILABLE' }),
      cancel: () => {},
    };
    await withScreen(async ({ frames }) => {
      press('\x05new-value\r\r');
      await settle();
      expect(loadRepos.mock.calls).toHaveLength(1);
      expect(loadRepos.mock.calls[0]).toEqual([['p1']]);
      expect(frames()).toHaveLength(2);
      expect(frames()[1]).not.toContain('new-value');
    }, edit);
  });

  test('a burst of resize signals repaints once at the latest dimensions, then scrolling uses those dimensions', async () => {
    await withScreen(async ({ frames, resize }) => {
      resize(100, 30);
      resize(60, 18);
      await settle();
      expect(frames()).toEqual([frame(), frame(initialSecretsScreenState(rows), 60, 18)]);
      const keys = Array.from({ length: 40 }, () => DOWN);
      press(keys.join(''));
      await settle();
      expect(frames()[2]).toBe(frame(afterKeys(...keys), 60, 18));
      resize(120, 40);
      await settle();
      expect(frames()[3]).toBe(frame(afterKeys(...keys), 120, 40));
    });
  });

  test('keys after quit are ignored and an already-scheduled draw cannot paint after cleanup', async () => {
    const captured = await withScreen(async ({ frames }) => {
      press(`${DOWN}\x03${DOWN}`);
      await settle();
      expect(frames()).toEqual([frame()]);
    });
    expect(captured.writes).toContain(`${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`);
  });
});
