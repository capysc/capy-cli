import { describe, test, expect } from 'bun:test';
import { isBuildTime, isRuntime, classify } from '../../src/deploy/classify';

describe('classify — build-time vs runtime', () => {
  test('VITE_*, NEXT_PUBLIC_*, PUBLIC_*, REACT_APP_* are build-time', () => {
    expect(isBuildTime('VITE_API_URL')).toBe(true);
    expect(isBuildTime('NEXT_PUBLIC_KEY')).toBe(true);
    expect(isBuildTime('PUBLIC_FOO')).toBe(true);
    expect(isBuildTime('REACT_APP_BAR')).toBe(true);
  });

  test('runtime is the complement', () => {
    expect(isRuntime('SUPABASE_URL')).toBe(true);
    expect(isRuntime('STRIPE_SECRET_KEY')).toBe(true);
    expect(isRuntime('VITE_FOO')).toBe(false);
    expect(isRuntime('NEXT_PUBLIC_X')).toBe(false);
  });

  test('lookalikes that are NOT prefixes stay runtime', () => {
    expect(isBuildTime('MY_VITE_VAR')).toBe(false);   // VITE_ not at start
    expect(isBuildTime('NEXTPUBLIC')).toBe(false);     // missing underscore
    expect(isBuildTime('PUBLIC')).toBe(false);         // no trailing _
  });

  test('classify sorts each bucket alphabetically', () => {
    const r = classify([
      'STRIPE_KEY',
      'VITE_URL',
      'DATABASE_URL',
      'NEXT_PUBLIC_X',
      'A_VAR',
    ]);
    expect(r.buildTime).toEqual(['NEXT_PUBLIC_X', 'VITE_URL']);
    expect(r.runtime).toEqual(['A_VAR', 'DATABASE_URL', 'STRIPE_KEY']);
  });

  test('empty input', () => {
    expect(classify([])).toEqual({ buildTime: [], runtime: [] });
  });
});
