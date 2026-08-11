import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  HANDOFF_EVENT_MARKER,
  HANDOFF_EVENT_TYPE,
  classifyHandoffLocation,
  emitHandoffUrlEvent,
  type HandoffUrlEvent,
} from '../../src/ui/handoffEvent';

describe('classifyHandoffLocation', () => {
  test('127.0.0.1, localhost and ::1 are loopback', () => {
    expect(classifyHandoffLocation('http://127.0.0.1:4123/?n=abc')).toBe('loopback');
    expect(classifyHandoffLocation('http://localhost:4123/callback')).toBe('loopback');
    expect(classifyHandoffLocation('http://[::1]:4123/')).toBe('loopback');
  });

  test('any other origin is hosted', () => {
    expect(classifyHandoffLocation('https://keep.capy.sc/flow/device-key?c=1')).toBe('hosted');
    expect(classifyHandoffLocation('https://auth.example.test/authorize')).toBe('hosted');
    expect(classifyHandoffLocation('https://dashboard.stripe.com/oauth/authorize')).toBe('hosted');
  });

  test('a malformed URL is classified hosted (the more cautious default)', () => {
    expect(classifyHandoffLocation('not a url')).toBe('hosted');
  });
});

describe('emitHandoffUrlEvent', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  test('writes one marker-prefixed, newline-terminated JSON line to stdout when not a TTY', () => {
    process.stdout.isTTY = undefined as unknown as true; // spawned-process shape: isTTY is undefined, not false
    const writes: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    try {
      emitHandoffUrlEvent('http://127.0.0.1:9999/?n=deadbeef', 'edit');
    } finally {
      spy.mockRestore();
    }

    expect(writes.length).toBe(1);
    const line = writes[0];
    expect(line.startsWith(HANDOFF_EVENT_MARKER)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);

    const json = line.slice(HANDOFF_EVENT_MARKER.length, -1);
    const parsed = JSON.parse(json) as HandoffUrlEvent;
    expect(parsed.v).toBe(1);
    expect(parsed.event).toBe(HANDOFF_EVENT_TYPE);
    expect(parsed.url).toBe('http://127.0.0.1:9999/?n=deadbeef');
    expect(parsed.flow).toBe('edit');
    expect(parsed.location).toBe('loopback');
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  test('classifies a hosted URL correctly inside the emitted event', () => {
    process.stdout.isTTY = undefined as unknown as true;
    const writes: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    try {
      emitHandoffUrlEvent('https://keep.capy.sc/flow/device-key?c=abc', 'enroll');
    } finally {
      spy.mockRestore();
    }

    const parsed = JSON.parse(writes[0].slice(HANDOFF_EVENT_MARKER.length, -1)) as HandoffUrlEvent;
    expect(parsed.location).toBe('hosted');
    expect(parsed.flow).toBe('enroll');
  });

  test('emits nothing when stdout is a real TTY — a human terminal gets zero new bytes', () => {
    process.stdout.isTTY = true;
    const spy = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);

    try {
      emitHandoffUrlEvent('http://127.0.0.1:9999/?n=deadbeef', 'edit');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('the marker never collides with ordinary human-facing output', () => {
    // Nothing this CLI prints for a person should start a line with the
    // marker — that is the whole point of using a fixed sentinel rather than
    // trying JSON.parse on every stdout line. Spot-check the literal itself
    // rather than the entire corpus of human copy.
    expect(HANDOFF_EVENT_MARKER).toBe('CAPY_EVENT_V1 ');
    expect(HANDOFF_EVENT_MARKER.endsWith(' ')).toBe(true);
  });
});
