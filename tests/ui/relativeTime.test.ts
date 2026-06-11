import { describe, test, expect } from 'bun:test';
import { formatRelativeTime } from '../../src/ui/relativeTime';

const NOW = new Date('2026-06-11T12:00:00.000Z');

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  test('under a minute is "just now"', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(59 * SEC), NOW)).toBe('just now');
  });

  test('minutes, singular and plural', () => {
    expect(formatRelativeTime(ago(MIN), NOW)).toBe('1 minute ago');
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(59 * MIN), NOW)).toBe('59 minutes ago');
  });

  test('hours, singular and plural', () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(formatRelativeTime(ago(5 * HOUR), NOW)).toBe('5 hours ago');
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe('23 hours ago');
  });

  test('days, singular and plural', () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe('1 day ago');
    expect(formatRelativeTime(ago(13 * DAY), NOW)).toBe('13 days ago');
    expect(formatRelativeTime(ago(29 * DAY), NOW)).toBe('29 days ago');
  });

  test('months and years', () => {
    expect(formatRelativeTime(ago(30 * DAY), NOW)).toBe('1 month ago');
    expect(formatRelativeTime(ago(90 * DAY), NOW)).toBe('3 months ago');
    expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe('1 year ago');
    expect(formatRelativeTime(ago(800 * DAY), NOW)).toBe('2 years ago');
  });

  test('future timestamps (server/client clock skew) render as "just now"', () => {
    expect(formatRelativeTime(ago(-30 * SEC), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(-2 * HOUR), NOW)).toBe('just now');
  });

  test('unparseable input renders as the empty placeholder', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });
});
