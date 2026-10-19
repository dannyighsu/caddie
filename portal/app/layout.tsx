import type { Metadata } from "next";
import "./globals.css";
import OwnerSelector from "./owner-selector";
import { connection } from "next/server";
import { getTeamRoster } from "@/lib/team";
import { agentName } from "@/lib/agent-name";

export function generateMetadata(): Metadata {
  return { title: agentName(), description: "Agent control plane" };
}

/** The owner selector's choices. Empty if the roster can't be read right now. */
async function ownerOptions(): Promise<{ id: string; name: string }[]> {
  // Read per request, never baked in at build: the roster changes from /settings.
  await connection();
  try {
    return (await getTeamRoster()).map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const options = await ownerOptions();
  return (
    <html lang="en">
      <body className="bg-canvas text-ink min-h-screen">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur px-6 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-ink">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/agent-icon.png" alt={agentName()} className="h-8 w-8" />
            {agentName()}
          </a>
          <div className="flex items-center gap-3">
            <OwnerSelector options={options} />
            <span className="h-5 w-px bg-line" />
            <a href="/runs" className="text-sm text-ink-soft hover:text-primary hover:bg-primary-soft rounded-md px-3 py-1.5 transition-colors">
              Runs
            </a>
            <a href="/transcripts" className="text-sm text-ink-soft hover:text-primary hover:bg-primary-soft rounded-md px-3 py-1.5 transition-colors">
              Traces
            </a>
            <a href="/settings" className="text-sm text-ink-soft hover:text-primary hover:bg-primary-soft rounded-md px-3 py-1.5 transition-colors">
              Settings
            </a>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
