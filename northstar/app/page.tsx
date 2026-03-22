import Link from "next/link";

interface Workflow {
  id: string;
  name: string;
  capabilities: string[];
  maxTurns?: number;
}

interface Conversation {
  id: string;
  workflow_id: string;
  title: string | null;
  messages: { role: string; content: string }[];
  created_at: string;
  updated_at: string;
}

async function getWorkflows(): Promise<Workflow[]> {
  const { listWorkflows } = await import("@/lib/harness");
  return listWorkflows();
}

async function getConversations(): Promise<Conversation[]> {
  try {
    const { listConversations } = await import("@/lib/db");
    return await listConversations(undefined, 10);
  } catch {
    return []; // DB not ready yet
  }
}

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [workflows, conversations] = await Promise.all([
    getWorkflows(),
    getConversations(),
  ]);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-xl font-semibold mb-4">Workflows</h2>
        {workflows.length === 0 ? (
          <p className="text-gray-500">No workflows found.</p>
        ) : (
          <div className="grid gap-4">
            {workflows.map((wf) => (
              <Link
                key={wf.id}
                href={`/workflows/${wf.id}`}
                className="block border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{wf.name}</h3>
                    <p className="text-sm text-gray-400 mt-1">
                      {wf.capabilities.join(", ")} · max{" "}
                      {wf.maxTurns ?? 20} turns
                    </p>
                  </div>
                  <span className="text-sm text-gray-500">{wf.id}</span>
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
                href={`/workflows/${conv.workflow_id}`}
                className="block border border-gray-800 rounded-lg p-3 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{conv.workflow_id}</span>
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
