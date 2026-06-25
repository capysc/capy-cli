import { describe, test, expect } from 'bun:test';
import { generateIntakeForm } from '../../src/ui/intakePage';

describe('generateIntakeForm', () => {
  const html = generateIntakeForm({ varName: 'STRIPE_SECRET_KEY', nonce: 'abc123', exists: false });

  test('shows the var name and embeds the nonce', () => {
    expect(html).toContain('STRIPE_SECRET_KEY');
    expect(html).toContain('abc123');
  });

  test('has a multiline value textarea and posts to /submit', () => {
    expect(html).toContain('<textarea');
    expect(html).toContain("fetch('/submit'");
  });

  test('assures the value never reaches the AI', () => {
    expect(html).toMatch(/never passes through the AI/i);
  });

  test('warns on overwrite when the var exists', () => {
    expect(generateIntakeForm({ varName: 'X', nonce: 'n', exists: true })).toMatch(/already exists/i);
  });

  test('neutralizes HTML/script in the var name', () => {
    const h = generateIntakeForm({ varName: '</script><b>', nonce: 'n', exists: false });
    expect(h).not.toContain('</script><b>');
    expect(h).toContain('&lt;/script&gt;&lt;b&gt;');
  });

  test('shows a saving state and renders a failed-save error (with retry)', () => {
    expect(html).toContain('Saving');
    expect(html).toContain('Could not save');
    // surfaces the server error message and re-enables the button for retry
    expect(html).toContain('b.error');
    expect(html).toContain('btn.disabled = false');
  });
});
