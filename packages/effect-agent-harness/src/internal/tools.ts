import type { AgUiSchema } from "effect/ai";
import type * as Agent from "../Agent.ts";

/**
 * The first client tool named like one of the agent's own tools or subagents, if any. A call to that name would
 * be ambiguous, so a run refuses such an input: the loop and the runners with `FrontendToolConflict`, before
 * anything is stored, and `Runner.toAgUiServerAgent` with a 400.
 */
export const conflictingTool = (
  agent: Agent.Agent<any, any>,
  tools: AgUiSchema.RunAgentInput["tools"],
): string | undefined => {
  // `define` checked that every subagent has a name.
  const own = new Set([...Object.keys(agent.toolkit.tools), ...(agent.subagents?.agents ?? []).map((c) => c.name)]);
  return tools.find((tool) => own.has(tool.name))?.name;
};
