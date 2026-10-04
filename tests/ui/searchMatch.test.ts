import { describe, test, expect } from 'bun:test';
import { normalizeQuery, textMatches, filterByQuery } from '../../src/ui/searchMatch';

describe('searchMatch — the one rule shared by capy secrets and the pickers', () => {
  test('normalizeQuery trims and lowercases', () => {
    expect(normalizeQuery('  AbC ')).toBe('abc');
    expect(normalizeQuery('   ')).toBe('');
  });

  test('textMatches is a case-insensitive substring test', () => {
    expect(textMatches('Billing-API', 'ing-a')).toBe(true);
    expect(textMatches('Billing-API', 'api')).toBe(true);
    expect(textMatches('Billing-API', 'apix')).toBe(false);
    expect(textMatches('anything', '')).toBe(true);
  });

  test('textMatches is not a prefix or fuzzy match', () => {
    expect(textMatches('alpha', 'lph')).toBe(true);
    expect(textMatches('alpha', 'ap')).toBe(false);
  });

  test('filterByQuery keeps order and returns everything for a blank query', () => {
    const items = ['Zeta', 'alpha', 'Beta'];
    expect(filterByQuery(items, '', (s) => s)).toEqual(items);
    expect(filterByQuery(items, '   ', (s) => s)).toEqual(items);
    expect(filterByQuery(items, ' ET ', (s) => s)).toEqual(['Zeta', 'Beta']);
    expect(filterByQuery(items, 'nope', (s) => s)).toEqual([]);
  });

  test('filterByQuery does not change its input', () => {
    const items = Object.freeze(['a', 'b']);
    expect(() => filterByQuery(items, 'a', (s) => s)).not.toThrow();
  });
});
