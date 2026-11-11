"use client";

import { useEffect, useState } from "react";

export interface OwnerOption {
  id: string;
  name: string;
}

/**
 * Selects which team member portal-initiated runs are attributed to.
 * Persisted in the `portal_owner` cookie, which the run endpoints read to build
 * the run identity. Every option is team-trust, so this is attribution only —
 * no privilege difference.
 *
 * The roster lives in server-side env, so `layout.tsx` reads it and passes the
 * options down; this component never touches the harness.
 */
export default function OwnerSelector({ options }: { options: OwnerOption[] }) {
  const defaultOwner = options[0]?.id ?? "";

  // Server and initial client render both use the default (no hydration
  // mismatch); the effect syncs to the persisted cookie after mount.
  const [owner, setOwner] = useState(defaultOwner);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const match = document.cookie.match(/(?:^|;\s*)portal_owner=([^;]+)/);
    const value = match?.[1];
    // Ignore a cookie naming someone no longer on the roster.
    if (value && options.some((o) => o.id === value)) setOwner(value);
  }, [options]);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setOwner(value);
    document.cookie = `portal_owner=${value}; path=/; max-age=31536000; samesite=lax`;
  }

  // With nobody configured there's nothing to attribute to, and with one member
  // there's nothing to choose — in both cases the control is just noise.
  if (options.length < 2) return null;

  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-ink-faint">Acting as</span>
      <select
        value={owner}
        onChange={handleChange}
        className="bg-surface-muted border border-line-strong rounded-md px-2 py-1 text-sm text-ink focus:outline-none focus:border-primary transition-colors"
        aria-label="Portal owner"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
