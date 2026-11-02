/**
 * Borrowing process-global state for one test (CAP-703): `process.env` and the `isTTY` flags of stdin and
 * stdout. These are third-party objects that only offer in-place mutation, so the mutation is confined here,
 * each helper puts back exactly what it found, and every test body stays free of it.
 *
 * `isTTY` is restored from its ORIGINAL property descriptor, defined writable and configurable (a CI run once
 * failed on a test that left it read-only): when there was none, it goes back to an ordinary `undefined`.
 */

type TtyTarget = NodeJS.ReadStream | NodeJS.WriteStream;

function setTty(stream: TtyTarget, descriptor: PropertyDescriptor): void {
  Object.defineProperty(stream, 'isTTY', descriptor);
}

/** Runs `fn` with `process.stdin.isTTY` and / or `process.stdout.isTTY` forced to `true`. */
export async function withTty<T>(which: { readonly stdin?: boolean; readonly stdout?: boolean }, fn: () => Promise<T>): Promise<T> {
  const streams: ReadonlyArray<readonly [TtyTarget, PropertyDescriptor | undefined]> = [
    ...(which.stdin === true ? ([[process.stdin, Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')]] as const) : []),
    ...(which.stdout === true ? ([[process.stdout, Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')]] as const) : []),
  ];
  streams.forEach(([stream]) => setTty(stream, { value: true, writable: true, configurable: true }));
  try {
    return await fn();
  } finally {
    streams.forEach(([stream, original]) => setTty(stream, original ?? { value: undefined, writable: true, configurable: true }));
  }
}

/** Runs `fn` with these environment variables set (`undefined` removes one), then puts every one back as it was. */
export async function withEnv<T>(vars: Readonly<Record<string, string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.entries(vars).map(([key]) => [key, process.env[key]] as const);
  const apply = (entries: ReadonlyArray<readonly [string, string | undefined]>): void =>
    entries.forEach(([key, value]) => (value === undefined ? Reflect.deleteProperty(process.env, key) : Reflect.set(process.env, key, value)));
  apply(Object.entries(vars));
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}
