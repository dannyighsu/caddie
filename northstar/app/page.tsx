import Link from "next/link";

interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  maxTurns?: number;
  mode?: "conversational" | "triggered";
}

interface Conversation {
  id: string;
  agent_id: string;
  title: string | null;
  messages: { role: string; content: string }[];
  created_at: string;
  updated_at: string;
}

async function getAgents(): Promise<Agent[]> {
  const { listAgents } = await import("@/lib/harness");
  return listAgents();
}

async function getConversations(): Promise<Conversation[]> {
  try {
    const { listConversations } = await import("@/lib/db");
    return await listConversations(undefined, 10);
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [agents, conversations] = await Promise.all([
    getAgents(),
    getConversations(),
  ]);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="flex items-center gap-2 text-xl font-semibold mb-4">
          <span className="h-4 w-1.5 rounded-full bg-accent" />
          Agents
        </h2>
        {agents.length === 0 ? (
          <p className="text-ink-faint">No agents found.</p>
        ) : (
          <div className="grid gap-4">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="block border border-line bg-surface rounded-xl p-4 shadow-sm hover:border-primary hover:shadow-md transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-ink">{agent.name}</h3>
                    <p className="text-sm text-ink-soft mt-1">
                      {agent.capabilities.join(", ")}
                      {" · "}max {agent.maxTurns ?? 20} turns
                      {agent.mode === "triggered" && " · triggered"}
                    </p>
                  </div>
                  <span className="text-xs font-mono text-primary bg-primary-soft rounded-md px-2 py-1">{agent.id}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-xl font-semibold mb-4">
          <span className="h-4 w-1.5 rounded-full bg-accent" />
          Recent Conversations
        </h2>
        {conversations.length === 0 ? (
          <p className="text-ink-faint">No conversations yet.</p>
        ) : (
          <div className="space-y-2">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/agents/${conv.agent_id}`}
                className="block border border-line bg-surface rounded-xl p-3 shadow-sm hover:border-primary hover:shadow-md transition-all"
              >
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-ink">{conv.agent_id}</span>
                    <span className="text-ink-soft truncate max-w-md">
                      {conv.title || "Untitled"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-ink-faint">
                    <span>{conv.messages.length} msgs</span>
                    <span>
                      {new Date(conv.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
