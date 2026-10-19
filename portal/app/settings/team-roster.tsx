"use client";

import { useState, useEffect } from "react";

interface Member {
  id: string;
  name: string;
  emails: string[];
  slackId?: string;
  telegramId?: string;
  isOwner: boolean;
}

interface Draft {
  id: string;
  name: string;
  emails: string;
  slackId: string;
  telegramId: string;
}

const EMPTY: Draft = { id: "", name: "", emails: "", slackId: "", telegramId: "" };

const INPUT =
  "w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors";
const PRIMARY =
  "px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const SECONDARY =
  "px-3 py-1.5 text-ink-soft border border-line-strong rounded-lg text-sm hover:bg-surface-muted transition-colors";
const DANGER =
  "px-3 py-1.5 text-bad border border-bad/40 rounded-lg text-sm hover:bg-bad-soft transition-colors";

function toBody(d: Draft) {
  return {
    id: d.id.trim() || undefined,
    name: d.name,
    emails: d.emails.split(",").map((e) => e.trim()).filter(Boolean),
    slackId: d.slackId,
    telegramId: d.telegramId,
  };
}

function toDraft(m: Member): Draft {
  return {
    id: m.id,
    name: m.name,
    emails: m.emails.join(", "),
    slackId: m.slackId ?? "",
    telegramId: m.telegramId ?? "",
  };
}

async function send(method: string, body?: unknown, query = ""): Promise<{ members?: Member[]; error?: string }> {
  const res = await fetch(`/api/settings/team${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** The fields for one member. The id is only editable while adding. */
function MemberFields({ draft, onChange, isNew }: { draft: Draft; onChange: (d: Draft) => void; isNew: boolean }) {
  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [key]: e.target.value });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-medium text-ink-soft mb-1">Name</label>
        <input value={draft.name} onChange={set("name")} placeholder="Alex" className={INPUT} />
      </div>
      {isNew && (
        <div>
          <label className="block text-xs font-medium text-ink-soft mb-1">
            Id (optional — defaults to the name; can&apos;t change later)
          </label>
          <input value={draft.id} onChange={set("id")} placeholder="alex" className={INPUT} />
        </div>
      )}
      <div className="sm:col-span-2">
        <label className="block text-xs font-medium text-ink-soft mb-1">
          Emails (comma-separated; the first is used for calendar invites)
        </label>
        <input value={draft.emails} onChange={set("emails")} placeholder="alex@example.com" className={INPUT} />
      </div>
      <div>
        <label className="block text-xs font-medium text-ink-soft mb-1">Slack user id (optional)</label>
        <input value={draft.slackId} onChange={set("slackId")} placeholder="U0123456789" className={INPUT} />
      </div>
      <div>
        <label className="block text-xs font-medium text-ink-soft mb-1">Telegram user id (optional)</label>
        <input value={draft.telegramId} onChange={set("telegramId")} placeholder="123456789" className={INPUT} />
      </div>
    </div>
  );
}

/** Roster editor for /settings. */
export function TeamRoster() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings/team")
      .then((r) => r.json())
      .then((data) => {
        setMembers(data.members ?? []);
        setLoaded(true);
      });
  }, []);

  async function run(method: string, body?: unknown, query = ""): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const data = await send(method, body, query);
      if (data.error) {
        setError(data.error);
        return false;
      }
      if (data.members) setMembers(data.members);
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (await run("POST", toBody(newDraft))) setNewDraft(EMPTY);
  }

  async function handleSave(id: string) {
    if (await run("PATCH", { ...toBody(editDraft), id })) setEditing(null);
  }

  async function handleRemove(m: Member) {
    await run("DELETE", undefined, `?id=${encodeURIComponent(m.id)}`);
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Team</h2>
      <p className="text-sm text-ink-soft">
        The people this agent serves. A message from an address or account listed here gets team
        trust; everyone else is a guest. The owner receives failure alerts and is who portal runs
        are attributed to by default.
      </p>

      {error && <p className="text-sm text-bad">{error}</p>}

      {!loaded ? (
        <p className="text-ink-faint text-sm">Loading...</p>
      ) : (
        <div className="space-y-3">
          {members.map((m) => (
            <div key={m.id} className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-3">
              {editing === m.id ? (
                <>
                  <MemberFields draft={editDraft} onChange={setEditDraft} isNew={false} />
                  <div className="flex gap-3">
                    <button onClick={() => handleSave(m.id)} disabled={busy || !editDraft.name.trim()} className={PRIMARY}>
                      Save
                    </button>
                    <button onClick={() => setEditing(null)} className={SECONDARY}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <p className="font-medium">
                      {m.name} <span className="text-ink-faint font-mono text-xs">{m.id}</span>
                      {m.isOwner && (
                        <span className="ml-2 text-xs text-primary bg-primary-soft rounded px-1.5 py-0.5">owner</span>
                      )}
                    </p>
                    <p className="text-sm text-ink-soft break-all">
                      {m.emails.length ? m.emails.join(", ") : "No email"}
                    </p>
                    {(m.slackId || m.telegramId) && (
                      <p className="text-xs text-ink-faint">
                        {m.slackId && `Slack ${m.slackId}`}
                        {m.slackId && m.telegramId && " · "}
                        {m.telegramId && `Telegram ${m.telegramId}`}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setEditing(m.id);
                        setEditDraft(toDraft(m));
                      }}
                      className={SECONDARY}
                    >
                      Edit
                    </button>
                    {!m.isOwner && (
                      <>
                        <button onClick={() => run("PATCH", { id: m.id, makeOwner: true })} disabled={busy} className={SECONDARY}>
                          Make owner
                        </button>
                        <button onClick={() => handleRemove(m)} disabled={busy} className={DANGER}>
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          <div className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-4">
            <p className="text-sm font-medium">Add a member</p>
            <MemberFields draft={newDraft} onChange={setNewDraft} isNew />
            <button onClick={handleAdd} disabled={busy || !newDraft.name.trim()} className={PRIMARY}>
              Add
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Shown on the dashboard while the roster is empty: add the owner. */
export function FirstRunTeam() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAdd() {
    setBusy(true);
    setError(null);
    try {
      const data = await send("POST", { ...toBody(draft), isOwner: true });
      if (data.error) setError(data.error);
      else window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-line bg-surface rounded-xl p-6 shadow-sm space-y-4">
      <h2 className="text-xl font-semibold">Add the owner</h2>
      <p className="text-sm text-ink-soft">
        No one is on the team yet, so every message is treated as coming from a guest. Add yourself
        as the owner: you&apos;ll get failure alerts, and portal runs are attributed to you. Add
        everyone else from Settings.
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <MemberFields draft={draft} onChange={setDraft} isNew />
      <button onClick={handleAdd} disabled={busy || !draft.name.trim()} className={PRIMARY}>
        {busy ? "Adding..." : "Add owner"}
      </button>
    </section>
  );
}
