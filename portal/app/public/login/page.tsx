"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/public/outreach";

  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/public/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push(next);
    } else {
      setError("Incorrect password.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-ink-soft mb-1">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
          placeholder="Enter password"
        />
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <button
        type="submit"
        disabled={loading || !password}
        className="w-full bg-primary text-white font-medium text-sm py-2.5 rounded-lg hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/buri-icon.png" alt="Buri" className="h-16 w-16 mb-3" />
          <h1 className="text-lg font-semibold text-ink">Buri Agent Portal</h1>
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
