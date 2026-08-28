import { newSessionId } from "./ids.js";

export interface ResolvedRunContext {
  sessionId: string;
  parentRunId?: string;
  rootRunId: string;
  agentName?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Resolve native FlowPeek correlation metadata without creating a task/session manager. */
export function resolveRunContext(opts: {
  runId: string;
  sessionId?: string;
  agentName?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedRunContext {
  const env = opts.env || process.env;
  const incomingSession = nonEmpty(env.FLOWPEEK_SESSION_ID);
  const sessionId = nonEmpty(opts.sessionId) || incomingSession || newSessionId();
  const incomingParent = nonEmpty(env.FLOWPEEK_RUN_ID);
  const linked = Boolean(incomingParent && incomingSession && incomingSession === sessionId);
  const parentRunId = linked ? incomingParent : undefined;
  const rootRunId = parentRunId
    ? nonEmpty(env.FLOWPEEK_ROOT_RUN_ID) || parentRunId
    : opts.runId;
  const agentName = nonEmpty(opts.agentName) || nonEmpty(env.FLOWPEEK_AGENT_NAME);
  return { sessionId, parentRunId, rootRunId, agentName };
}

export function childEnvForContext(
  env: NodeJS.ProcessEnv,
  runId: string,
  context: ResolvedRunContext,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    FLOWPEEK_RUN_ID: runId,
    FLOWPEEK_SESSION_ID: context.sessionId,
    FLOWPEEK_ROOT_RUN_ID: context.rootRunId,
  };
  if (context.agentName) out.FLOWPEEK_AGENT_NAME = context.agentName;
  else delete out.FLOWPEEK_AGENT_NAME;
  return out;
}
