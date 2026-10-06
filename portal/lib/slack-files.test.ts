/**
 * Tests for inbound-Slack file handling (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/slack-files.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * Covers the selection policy and the notices it produces. The download path is
 * deliberately not covered here: it is thin glue over an authenticated fetch and
 * the filesystem, while the policy carries the judgment — what has bytes behind
 * it on Slack at all, and what a held-back file is told to the agent as.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileLabel,
  fileMimeType,
  selectInboundSlackFiles,
  unretrievedNotice,
  type SlackFile,
} from "./slack-files.ts";

function file(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: "F1",
    name: "screenshot.png",
    mimetype: "image/png",
    size: 50_000,
    mode: "hosted",
    url_private_download: "https://files.slack.com/F1/download",
    ...overrides,
  };
}

test("a hosted upload is fetched", () => {
  const { fetch, listOnly } = selectInboundSlackFiles([file()]);
  assert.equal(fetch.length, 1);
  assert.equal(listOnly.length, 0);
});

test("images are not size-filtered the way email images are", () => {
  // 200 bytes would be tracking chrome in an email; on Slack someone uploaded it.
  const { fetch } = selectInboundSlackFiles([file({ size: 200 })]);
  assert.equal(fetch.length, 1);
});

test("url_private is accepted when no download URL is given", () => {
  const { fetch } = selectInboundSlackFiles([
    file({ url_private_download: undefined, url_private: "https://files.slack.com/F1" }),
  ]);
  assert.equal(fetch.length, 1);
});

test("files with no bytes behind them are listed, not fetched", () => {
  const cases: [Partial<SlackFile>, string][] = [
    [{ mode: "tombstone" }, "deleted"],
    [{ mode: "hidden_by_limit" }, "file limit"],
    [{ is_external: true }, "external link"],
    [{ url_private_download: undefined, url_private: undefined }, "no download URL"],
  ];
  for (const [overrides, expected] of cases) {
    const { fetch, listOnly } = selectInboundSlackFiles([file(overrides)]);
    assert.equal(fetch.length, 0, JSON.stringify(overrides));
    assert.equal(listOnly.length, 1);
    assert.match(listOnly[0].reason, new RegExp(expected));
  }
});

test("an outsized file is listed with why", () => {
  const { fetch, listOnly } = selectInboundSlackFiles([file({ size: 100 * 1024 * 1024 })]);
  assert.equal(fetch.length, 0);
  assert.match(listOnly[0].reason, /too large/);
});

test("the per-message cap holds, and the overflow is still named", () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    file({ id: `F${i}`, name: `shot-${i}.png` }),
  );
  const { fetch, listOnly } = selectInboundSlackFiles(many);
  assert.equal(fetch.length, 10);
  assert.equal(listOnly.length, 4);
  assert.match(listOnly[0].reason, /per-message/);
});

test("the same file shared twice is fetched once", () => {
  const { fetch } = selectInboundSlackFiles([file(), file()]);
  assert.equal(fetch.length, 1);
});

test("files without an id are not collapsed into one another", () => {
  const { fetch } = selectInboundSlackFiles([
    file({ id: undefined }),
    file({ id: undefined, name: "other.png" }),
  ]);
  assert.equal(fetch.length, 2);
});

test("mime type falls back to the filename, never to Slack's filetype", () => {
  assert.equal(fileMimeType(file({ mimetype: undefined, filetype: "pdf", name: "a.pdf" })), "application/pdf");
  assert.equal(fileMimeType(file({ mimetype: undefined, name: "mystery" })), "application/octet-stream");
});

test("a file is labeled by name, then title, then id", () => {
  assert.equal(fileLabel(file()), "screenshot.png");
  assert.equal(fileLabel(file({ name: undefined, title: "Q3 deck" })), "Q3 deck");
  assert.equal(fileLabel(file({ name: undefined, title: undefined })), "F1");
});

test("a notice names the file, its type and size, and the reason", () => {
  const notice = unretrievedNotice(file({ name: "report.pdf", mimetype: "application/pdf", size: 2_200_000 }), "too large to download");
  assert.match(notice, /report\.pdf/);
  assert.match(notice, /application\/pdf/);
  assert.match(notice, /2\.1 MB/);
  assert.match(notice, /too large to download/);
});

test("a notice omits the size when Slack didn't report one", () => {
  assert.equal(
    unretrievedNotice(file({ size: undefined }), "deleted from Slack"),
    "[attachment not retrieved: screenshot.png (image/png) — deleted from Slack]",
  );
});
