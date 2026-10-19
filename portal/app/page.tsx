import Link from "next/link";
import { getPortalStats, isStatsRange, type PortalStats, type StatsRange } from "@/lib/stats";
import { DEFAULT_MAX_TURNS, type AgentConfig } from "@ignis/harness";
import { agentName } from "@/lib/agent-name";
import { FirstRunTeam } from "./settings/team-roster";

interface Conversation {
  id: string;
  title: string | null;
  messages: { role: string; content: string }[];
  created_at: string;
  updated_at: string;
}

async function getAgent(): Promise<AgentConfig | null> {
  try {
    const { getAgentConfig } = await import("@/lib/harness");
    return await getAgentConfig();
  } catch {
    return null;
  }
}

/** Null when the roster couldn't be read — don't offer the first-run form then. */
async function getTeamSize(): Promise<number | null> {
  try {
    const { getTeamRoster } = await import("@/lib/team");
    return (await getTeamRoster()).length;
  } catch {
    return null;
  }
}

async function getConversations(): Promise<Conversation[]> {
  try {
    const { listConversations } = await import("@/lib/db");
    return await listConversations(10);
  } catch {
    return [];
  }
}

async function getStats(range: StatsRange): Promise<PortalStats | null> {
  try {
    return await getPortalStats(range);
  } catch {
    return null;
  }
}

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  slack: "Slack",
  telegram: "Telegram",
};

/** Compact for large token counts (1.2M); plain locale for small counts. */
function formatCount(n: number): string {
  return n >= 10_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
    : n.toLocaleString("en-US");
}

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "bad";
}) {
  return (
    <div className="border border-line bg-surface rounded-xl p-4 shadow-sm">
      <div
        className={`text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-bad" : "text-ink"}`}
      >
        {value}
      </div>
      <div className="text-xs text-ink-faint mt-1">{label}</div>
    </div>
  );
}

function RangeToggle({ active }: { active: StatsRange }) {
  const options: { value: StatsRange; label: string }[] = [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
  ];
  return (
    <div className="flex items-center gap-1 text-xs">
      {options.map((o) => (
        <Link
          key={o.value}
          href={`/?range=${o.value}`}
          scroll={false}
          className={`px-2.5 py-1 rounded-md border transition-colors ${
            o.value === active
              ? "border-primary bg-primary-soft text-primary font-medium"
              : "border-line text-ink-soft hover:border-line-strong"
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range: StatsRange = isStatsRange(rangeParam) ? rangeParam : "24h";

  const [agent, conversations, stats, teamSize] = await Promise.all([
    getAgent(),
    getConversations(),
    getStats(range),
    getTeamSize(),
  ]);

  return (
    <div className="space-y-10">
      {teamSize === 0 && <FirstRunTeam />}
      {stats && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <span className="h-4 w-1.5 rounded-full bg-accent" />
              Overview
              <span className="text-sm font-normal text-ink-faint">
                {range === "24h" ? "past 24 hours" : "past 7 days"}
              </span>
            </h2>
            <RangeToggle active={range} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {stats.messagesByChannel.map((c) => (
              <StatTile
                key={c.channel}
                label={`${channelLabel(c.channel)} messages`}
                value={formatCount(c.count)}
              />
            ))}
            <StatTile label="Runs" value={formatCount(stats.runs)} />
            <StatTile
              label="Failed runs"
              value={formatCount(stats.failed)}
              tone={stats.failed > 0 ? "bad" : "default"}
            />
            <StatTile
              label="Tokens spent"
              value={stats.tokens == null ? "—" : formatCount(stats.tokens)}
            />
          </div>
        </section>
      )}

      <section>
        <h2 className="flex items-center gap-2 text-xl font-semibold mb-4">
          <span className="h-4 w-1.5 rounded-full bg-accent" />
          Agent
        </h2>
        {!agent ? (
          <p className="text-ink-faint">No agent.json found.</p>
        ) : (
          <Link
            href="/agent"
            className="block border border-line bg-surface rounded-xl p-4 shadow-sm hover:border-primary hover:shadow-md transition-all"
          >
            <h3 className="font-semibold text-ink">{agentName()}</h3>
            <p className="text-sm text-ink-soft mt-1">
              {agent.capabilities.join(", ")}
              {" · "}max {agent.maxTurns ?? DEFAULT_MAX_TURNS} turns
            </p>
          </Link>
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
                href="/agent"
                className="block border border-line bg-surface rounded-xl p-3 shadow-sm hover:border-primary hover:shadow-md transition-all"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-soft truncate max-w-md">
                    {conv.title || "Untitled"}
                  </span>
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
