/**
 * Compact recency label for a timestamp: "just now", "5 minutes ago",
 * "1 hour ago", "3 days ago", … Used by TUI columns that show when a value
 * last changed (keep.lock `changed_at`).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  // Clock skew between the server stamp and this machine can put a fresh
  // timestamp slightly in the future — render it as current, not negative.
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));

  if (seconds < 60) return 'just now';

  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');

  const days = Math.floor(hours / 24);
  if (days < 30) return unit(days, 'day');

  const months = Math.floor(days / 30);
  if (months < 12) return unit(months, 'month');

  return unit(Math.floor(days / 365), 'year');
}
