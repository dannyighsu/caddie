/**
 * Tests for rag-files (pure logic): mirror paths and rendering, what gets
 * indexed, sync planning, and purge targets.
 *
 * Run: node --test --experimental-strip-types lib/rag-files.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RAG_MODEL_NAME,
  channelOf,
  conversationTitle,
  emptyManifest,
  isExcludedDir,
  isIndexableFile,
  messageRelPath,
  parseMessageRelPath,
  planSync,
  rebuildReason,
  renderMessageFile,
  resolvePurgeTarget,
} from "./rag-files.ts";
import type { Message } from "./db.ts";

const ID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const WS = "/home/me/.caddie";

test("channelOf reads the external id's namespace; portal chats have none", () => {
  assert.equal(channelOf("email:18a2f"), "email");
  assert.equal(channelOf("slack:C123:1700000000.1"), "slack");
  assert.equal(channelOf("telegram:42"), "telegram");
  assert.equal(channelOf(null), "portal");
  assert.equal(channelOf("fax:1"), "other");
});

test("message paths are per conversation and seq, and round-trip", () => {
  const rel = messageRelPath({ id: ID, external_id: "email:abc" }, 7);
  assert.equal(rel, `conversations/email/${ID}/0007.md`);
  assert.deepEqual(parseMessageRelPath(rel), { conversationId: ID, seq: 7 });
  assert.equal(parseMessageRelPath("config/preferences.md"), null);
  assert.equal(parseMessageRelPath(`conversations/email/${ID}/notes.md`), null);
});

test("conversationTitle is one line and falls back to the first user message", () => {
  assert.equal(conversationTitle({ title: "Re: venue\nsecond line", messages: [] }), "Re: venue");
  const messages: Message[] = [
    { role: "assistant", content: "hi", timestamp: "" },
    { role: "user", content: "  Holiday party   options\nmore", timestamp: "" },
  ];
  assert.equal(conversationTitle({ title: null, messages }), "Holiday party options");
});

test("renderMessageFile carries the thread title, sender and full text", () => {
  const long = "x".repeat(200_000);
  const msg: Message = { role: "user", content: long, timestamp: "2026-08-12T17:04:11.000Z", sender: { kind: "guest" } };
  const out = renderMessageFile({ id: ID, external_id: "email:abc", title: 'Re: "Venue" options', messages: [msg] }, 2, msg, "Guest");
  assert.match(out, /^---\ntitle: "Re: \\"Venue\\" options"\n/);
  assert.match(out, /\nseq: 2\n/);
  assert.match(out, /\n# Re: "Venue" options\n/);
  assert.match(out, /\*\*\[Guest\] 2026-08-12 17:04 UTC\*\*/);
  assert.ok(out.includes(long), "no truncation");
});

test("excluded directories: mounts, repo links, dot-dirs and run artifacts", () => {
  for (const d of ["mounts", "mounts/caddie/src", "jobs", "tickets", ".rag", ".claude/skills", "state/.cache", "runs/2026-09/29_tuesday/artifacts", "runs/2026-09/29_tuesday/artifacts/email-1", "node_modules"]) {
    assert.equal(isExcludedDir(d), true, d);
  }
  for (const d of ["conversations/email", "config", "state", "runs/2026-09/29_tuesday", "notes"]) {
    assert.equal(isExcludedDir(d), false, d);
  }
});

test("indexable files: supported extension, within size, outside excluded dirs", () => {
  assert.equal(isIndexableFile("config/preferences.md", 100), true);
  assert.equal(isIndexableFile("notes.TXT", 100), true);
  assert.equal(isIndexableFile(`conversations/email/${ID}/0001.md`, 100), true);
  assert.equal(isIndexableFile("runs/2026-09/29_tuesday/run-record.jsonl", 100), false, "unsupported type");
  assert.equal(isIndexableFile("runs/2026-09/29_tuesday/artifacts/email-1/quote.pdf", 100), false, "attachments are out of scope");
  assert.equal(isIndexableFile("mounts/repo/README.md", 100), false);
  assert.equal(isIndexableFile(".DS_Store", 100), false);
  assert.equal(isIndexableFile("x.md.123.abc.tmp", 100), false, "mirror temp files are never picked up");
  assert.equal(isIndexableFile("big.pdf", 11 * 1024 * 1024), false);
});

test("planSync ingests new, changed and failed files and removes vanished ones", () => {
  const manifest = {
    files: {
      "same.md": { sha256: "a", size: 1 },
      "changed.md": { sha256: "b", size: 1 },
      "gone.md": { sha256: "c", size: 1 },
      "failed.md": { sha256: "d", size: 1 },
    },
    failures: ["failed.md"],
  };
  const onDisk = new Map([
    ["same.md", { sha256: "a", size: 1 }],
    ["changed.md", { sha256: "B", size: 1 }],
    ["failed.md", { sha256: "d", size: 1 }],
    ["new.md", { sha256: "e", size: 1 }],
  ]);
  assert.deepEqual(planSync(manifest, onDisk), {
    ingest: ["changed.md", "failed.md", "new.md"],
    remove: ["gone.md"],
  });
});

test("rebuildReason flags a model change or a moved workspace", () => {
  assert.equal(rebuildReason(emptyManifest(WS), WS), null);
  assert.match(rebuildReason({ ...emptyManifest(WS), model: "other/model" }, WS) ?? "", /other\/model/);
  assert.match(rebuildReason(emptyManifest("/old/place"), WS) ?? "", /\/old\/place/);
  assert.equal(emptyManifest(WS).model, RAG_MODEL_NAME);
});

test("purge: a team run can target the current message, a message file or another file", () => {
  const cur = { conversationId: ID, seq: 3 };
  assert.deepEqual(resolvePurgeTarget({ trustTier: "team", currentMessage: cur, current: true }, WS), { kind: "message", ...cur });
  assert.deepEqual(
    resolvePurgeTarget({ trustTier: "team", path: `${WS}/conversations/email/${ID}/0001.md` }, WS),
    { kind: "message", conversationId: ID, seq: 1 }
  );
  assert.deepEqual(resolvePurgeTarget({ trustTier: "team", path: "state/scratch.md" }, WS), { kind: "file", rel: "state/scratch.md" });
});

test("purge: refuses escapes, protected areas and ambiguous requests", () => {
  const err = (r: ReturnType<typeof resolvePurgeTarget>) => ("error" in r ? r.error : "");
  assert.match(err(resolvePurgeTarget({ trustTier: "team", path: "../other/secret.md" }, WS)), /outside your workspace/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team", path: "/etc/passwd" }, WS)), /outside your workspace/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team", path: "config/preferences.md" }, WS)), /can't be purged/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team", path: "mounts/caddie/README.md" }, WS)), /can't be purged/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team", path: `conversations/email/${ID}/x.md` }, WS)), /isn't a message file/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team" }, WS)), /exactly one/);
  assert.match(err(resolvePurgeTarget({ trustTier: "team", current: true }, WS)), /no current message/);
});

test("purge: a guest run can only remove the message it's handling", () => {
  const cur = { conversationId: ID, seq: 3 };
  assert.deepEqual(resolvePurgeTarget({ trustTier: "guest", currentMessage: cur, current: true }, WS), { kind: "message", ...cur });
  // The same message by path is fine; any other message or file is not.
  assert.deepEqual(
    resolvePurgeTarget({ trustTier: "guest", currentMessage: cur, path: `conversations/email/${ID}/0003.md` }, WS),
    { kind: "message", ...cur }
  );
  for (const path of [`conversations/email/${ID}/0002.md`, "state/job.md"]) {
    const r = resolvePurgeTarget({ trustTier: "guest", currentMessage: cur, path }, WS);
    assert.ok("error" in r && /only purge the message you're handling/.test(r.error), path);
  }
  // No tier (or anything but team) is treated as guest.
  const r = resolvePurgeTarget({ trustTier: "", currentMessage: cur, path: "state/job.md" }, WS);
  assert.ok("error" in r);
});
