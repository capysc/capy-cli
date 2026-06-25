import { describe, test, expect } from 'bun:test';
import { generateIntakeForm } from '../../src/ui/intakePage';

describe('generateIntakeForm (multi-variable)', () => {
  const html = generateIntakeForm({
    vars: [{ name: 'STRIPE_SECRET_KEY' }, { name: 'STRIPE_PRICE_ID' }],
    nonce: 'abc123',
  });

  test('pre-seeds every suggested name and embeds the nonce', () => {
    expect(html).toContain('STRIPE_SECRET_KEY');
    expect(html).toContain('STRIPE_PRICE_ID');
    expect(html).toContain('abc123');
  });

  test('is a key/value editor (name input + multiline value) that posts {nonce, vars} to /submit', () => {
    expect(html).toContain("createElement('input')"); // editable name field per row
    expect(html).toContain("createElement('textarea')"); // multiline value field per row
    expect(html).toContain("fetch('/submit'");
    expect(html).toContain('nonce: NONCE');
    expect(html).toContain('vars'); // posts an array of {name, value}
  });

  test('only user-added rows are removable; suggested rows can be edited but not removed', () => {
    expect(html).toContain('addRow(s, false)'); // suggested → not removable
    expect(html).toContain("document.getElementById('add').onclick = () => addRow({}, true)"); // added → removable
    expect(html).toContain('if (removable)'); // the remove button is only built for removable rows
    expect(html).toContain('row.remove()');
  });

  test('assures the values never reach the AI', () => {
    expect(html).toMatch(/never (pass|passes|leave).*(AI|plaintext)/i);
  });

  test('renders fine with zero suggested names (one empty row)', () => {
    const empty = generateIntakeForm({ vars: [], nonce: 'n' });
    expect(empty).toContain('SUGGESTED = []');
    expect(empty).toContain('if (SUGGESTED.length === 0) addRow({}, false)');
  });

  test('neutralizes script-injection in a suggested name (escaped in the embedded JS array)', () => {
    const h = generateIntakeForm({ vars: [{ name: '</script><b>' }], nonce: 'n' });
    expect(h).not.toContain('</script><b>');
    expect(h).toContain('\\u003c/script>\\u003cb>');
  });

  describe('per-variable "where to find this" link', () => {
    test('embeds an http(s) helpUrl so the row can render a link', () => {
      const h = generateIntakeForm({
        vars: [{ name: 'STRIPE_SECRET_KEY', helpUrl: 'https://dashboard.stripe.com/apikeys' }],
        nonce: 'n',
      });
      expect(h).toContain('https://dashboard.stripe.com/apikeys');
      expect(h).toContain('where to find this');
    });

    test('drops a javascript:/non-http URL (never renders it as a clickable href)', () => {
      const h = generateIntakeForm({
        vars: [
          { name: 'A', helpUrl: 'javascript:alert(1)' },
          { name: 'B', helpUrl: 'data:text/html,<script>x</script>' },
        ],
        nonce: 'n',
      });
      expect(h).not.toContain('javascript:alert');
      expect(h).not.toContain('data:text/html');
    });
  });

  test('shows a saving state and renders a failed-save error (with retry)', () => {
    expect(html).toContain('Saving');
    expect(html).toContain('Could not save');
    expect(html).toContain('b.error');
    expect(html).toContain('submitBtn.disabled = false');
  });
});
