/** What the portal, alerts and emails call the agent (`AGENT_NAME`). Server-only. */
export function agentName(): string {
  return process.env.AGENT_NAME || "Caddie";
}
