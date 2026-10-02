"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
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
