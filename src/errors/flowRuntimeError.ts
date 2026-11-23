export class FlowRuntimeError extends Error {
  readonly name = 'FlowRuntimeError';
  constructor(readonly code: string) { super(code); }
}
