import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northstar",
  description: "Agent workflow gateway and control plane",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <a href="/" className="text-lg font-semibold tracking-tight">
            Northstar
          </a>
          <div className="flex items-center gap-4">
            <a href="/transcripts" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
              Traces
            </a>
            <a href="/settings" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
              Settings
            </a>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
