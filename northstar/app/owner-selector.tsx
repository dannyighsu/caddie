"use client";

import { useEffect, useState } from "react";

const OWNERS = ["danny", "betty"] as const;
type Owner = (typeof OWNERS)[number];
const LABELS: Record<Owner, string> = { danny: "Danny", betty: "Betty" };
const DEFAULT_OWNER: Owner = "danny";

function readOwnerCookie(): Owner {
  if (typeof document === "undefined") return DEFAULT_OWNER;
  const match = document.cookie.match(/(?:^|;\s*)portal_owner=([^;]+)/);
  const value = match?.[1];
  return OWNERS.includes(value as Owner) ? (value as Owner) : DEFAULT_OWNER;
}

/**
 * Selects which household member portal-initiated runs are attributed to.
 * Persisted in the `portal_owner` cookie, which the run endpoints read to build
 * the run identity. Both options are household-trust, so this is attribution
 * only — no privilege difference.
 */
export default function OwnerSelector() {
  // Server and initial client render both use DEFAULT_OWNER (no hydration
  // mismatch); the effect syncs to the persisted cookie after mount.
  const [owner, setOwner] = useState<Owner>(DEFAULT_OWNER);

  useEffect(() => {
    setOwner(readOwnerCookie());
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as Owner;
    setOwner(value);
    document.cookie = `portal_owner=${value}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-ink-faint">Acting as</span>
      <select
        value={owner}
        onChange={handleChange}
        className="bg-surface-muted border border-line-strong rounded-md px-2 py-1 text-sm text-ink focus:outline-none focus:border-primary transition-colors"
        aria-label="Portal owner"
      >
        {OWNERS.map((o) => (
          <option key={o} value={o}>
            {LABELS[o]}
          </option>
        ))}
      </select>
    </label>
  );
}
