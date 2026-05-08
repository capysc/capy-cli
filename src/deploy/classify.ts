/**
 * Var classification for `capy deploy`.
 *
 * Build-time vars get inlined into a public bundle (Vite, Next, webpack).
 * Runtime vars must stay vendor-side (Worker secrets, Vercel env, fly secrets).
 * Misclassifying a runtime secret as build-time = leaking it into JS the
 * browser downloads. Treat the boundary as load-bearing.
 */

const BUILD_TIME_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_', 'REACT_APP_'];

/** True when the var name's prefix marks it as a build-time public value. */
export function isBuildTime(name: string): boolean {
  return BUILD_TIME_PREFIXES.some((p) => name.startsWith(p));
}

export function isRuntime(name: string): boolean {
  return !isBuildTime(name);
}

export interface Classification {
  buildTime: string[];
  runtime: string[];
}

/** Sort var names into build-time vs runtime buckets, alphabetically. */
export function classify(names: string[]): Classification {
  const buildTime: string[] = [];
  const runtime: string[] = [];
  for (const n of names) {
    if (isBuildTime(n)) buildTime.push(n);
    else runtime.push(n);
  }
  buildTime.sort();
  runtime.sort();
  return { buildTime, runtime };
}
