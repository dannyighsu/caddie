import { Suspense } from "react";
import { agentName } from "@/lib/agent-name";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/agent-icon.png" alt={agentName()} className="h-16 w-16 mb-3" />
          <h1 className="text-lg font-semibold text-ink">{agentName()}</h1>
          <p className="text-sm text-ink-faint mt-0.5">Sign in to continue</p>
        </div>
        <div className="bg-surface border border-line rounded-2xl shadow-sm p-6">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
