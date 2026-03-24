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
        <h2 className="text-xl font-semibold mb-4">Agents</h2>
        {agents.length === 0 ? (
          <p className="text-gray-500">No agents found.</p>
        ) : (
          <div className="grid gap-4">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="block border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{agent.name}</h3>
                    <p className="text-sm text-gray-400 mt-1">
                      {agent.capabilities.join(", ")}
                      {" · "}max {agent.maxTurns ?? 20} turns
                      {agent.mode === "triggered" && " · triggered"}
                    </p>
                  </div>
                  <span className="text-sm text-gray-500">{agent.id}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-4">Recent Conversations</h2>
        {conversations.length === 0 ? (
          <p className="text-gray-500">No conversations yet.</p>
        ) : (
          <div className="space-y-2">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/agents/${conv.agent_id}`}
                className="block border border-gray-800 rounded-lg p-3 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{conv.agent_id}</span>
                    <span className="text-gray-400 truncate max-w-md">
                      {conv.title || "Untitled"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-gray-500">
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
