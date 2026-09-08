/** One bounded local path for device authentication and usable runtime key access. */
import {
  AuthenticationExecutorError,
  executeLocalFlowAuthentication,
  type FlowAuthenticationOptions,
} from './flowAuthenticateCommand';
import {
  executeLocalFlowPair,
  PairExecutorError,
  type FlowPairOptions,
} from './flowPairCommand';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FlowReadinessOptions {
  readonly flowId: string;
  readonly authenticationFlowId: string;
  readonly expectedUserId: string;
  readonly serviceOrigin: string;
  readonly runtimeOnly: boolean;
  readonly continuationTool: 'capy_onboard' | 'capy_pair';
}

type ReadinessResult =
  | { readonly ok: true; readonly flow_id: string; readonly authentication_flow_id: string; readonly stage: 'approval_pending'; readonly handoff: unknown; readonly continuation: { readonly tool: 'capy_onboard' | 'capy_pair'; readonly args: Readonly<Record<string, unknown>> } }
  | { readonly ok: true; readonly flow_id: string; readonly authentication_flow_id: string; readonly stage: 'pairing_pending' | 'paired'; readonly continuation: { readonly tool: 'capy_onboard' | 'capy_pair'; readonly args: { readonly flow_id: string } } };

export interface FlowReadinessDependencies {
  readonly authenticate: (flowId: string, options: FlowAuthenticationOptions) => ReturnType<typeof executeLocalFlowAuthentication>;
  readonly pair: (flowId: string, options: FlowPairOptions) => ReturnType<typeof executeLocalFlowPair>;
}

const localDependencies: FlowReadinessDependencies = {
  authenticate: executeLocalFlowAuthentication,
  pair: executeLocalFlowPair,
};

function authenticationOptions(options: FlowReadinessOptions): FlowAuthenticationOptions {
  return { expectedUserId: options.expectedUserId, serviceOrigin: options.serviceOrigin };
}

function pairingOptions(options: FlowReadinessOptions): FlowPairOptions {
  return {
    expectedUserId: options.expectedUserId,
    serviceOrigin: options.serviceOrigin,
    runtimeOnly: options.runtimeOnly,
  };
}

function continuation(options: FlowReadinessOptions, handoff?: unknown) {
  return {
    tool: options.continuationTool,
    args: {
      flow_id: options.flowId,
      ...(handoff === undefined ? {} : { authentication_handoff: handoff }),
    },
  } as const;
}

function validate(options: FlowReadinessOptions): void {
  if (!UUID.test(options.flowId) || !UUID.test(options.authenticationFlowId)
    || !/^user_[A-Za-z0-9]+$/.test(options.expectedUserId)
    || !['capy_onboard', 'capy_pair'].includes(options.continuationTool)) {
    throw new PairExecutorError('READINESS_ARGUMENT_INVALID');
  }
  const origin = new URL(options.serviceOrigin);
  const localHttp = origin.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.hostname.endsWith('.ts.net'));
  if (origin.origin !== options.serviceOrigin || (origin.protocol !== 'https:' && !localHttp)) {
    throw new PairExecutorError('READINESS_ARGUMENT_INVALID');
  }
  if (options.runtimeOnly !== (options.continuationTool === 'capy_pair')) throw new PairExecutorError('READINESS_ARGUMENT_INVALID');
}

/** Auth alone is never presented as ready: successful auth immediately enters the pairing executor. */
export async function executeFlowReadiness(
  options: FlowReadinessOptions,
  dependencies: FlowReadinessDependencies = localDependencies,
): Promise<ReadinessResult> {
  validate(options);
  const pairing = await (async () => {
    try { return await dependencies.pair(options.flowId, pairingOptions(options)); }
    catch (error) {
      if (error instanceof PairExecutorError && error.code === 'PAIR_AUTHENTICATION_REQUIRED') return null;
      throw error;
    }
  })();
  if (pairing) {
    return {
      ok: true, flow_id: options.flowId, authentication_flow_id: options.authenticationFlowId,
      stage: pairing.stage, continuation: continuation(options),
    };
  }
  const authentication = await dependencies.authenticate(options.authenticationFlowId, authenticationOptions(options));
  if (authentication.stage === 'approval_pending') {
    return {
      ok: true, flow_id: options.flowId, authentication_flow_id: options.authenticationFlowId,
      stage: 'approval_pending', handoff: authentication.handoff,
      continuation: continuation(options, authentication.handoff),
    };
  }
  const paired = await dependencies.pair(options.flowId, pairingOptions(options));
  return {
    ok: true, flow_id: options.flowId, authentication_flow_id: options.authenticationFlowId,
    stage: paired.stage,
    continuation: continuation(options),
  };
}

export async function runFlowReadinessCommand(options: FlowReadinessOptions): Promise<number> {
  try {
    console.log(JSON.stringify(await executeFlowReadiness(options)));
    return 0;
  } catch (error) {
    const code = error instanceof AuthenticationExecutorError || error instanceof PairExecutorError
      ? error.code : 'READINESS_EXECUTOR_FAILED';
    console.log(JSON.stringify({ ok: false, flow_id: options.flowId, code }));
    return 1;
  }
}
