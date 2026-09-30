/**
 * Tests for inbound-email attachment handling (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/gmail/parts.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * Covers the three pure pieces — MIME-tree walking, the selection policy, and
 * filename sanitization. The download path is deliberately not covered here: it
 * is thin glue over the Gmail API and the filesystem, while these three carry
 * the judgment (what counts as a file vs. a body, what counts as content vs.
 * tracking chrome, and what a sender-supplied filename is allowed to become).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { gmail_v1 } from "googleapis";
import {
  extractParts,
  selectInboundImages,
  selectInboundFiles,
  safeAttachmentFileName,
  mimeFromFileName,
  type GmailPart,
} from "./parts.ts";

// --- Fixtures ---

type Part = gmail_v1.Schema$MessagePart;

function textPart(mimeType: string, data = "aGk="): Part {
  return { partId: "0", mimeType, filename: "", body: { size: 2, data } };
}

function filePart(over: Partial<Part> & { headers?: { name: string; value: string }[] }): Part {
  return {
    partId: "1",
    mimeType: "image/png",
    filename: "photo.png",
    body: { size: 50_000, attachmentId: "att-1" },
    ...over,
  };
}

/** A GmailPart as extractParts would produce it, for selection tests. */
function part(over: Partial<GmailPart> = {}): GmailPart {
  return {
    partId: "1",
    fileName: "photo.png",
    mimeType: "image/png",
    sizeBytes: 50_000,
    attachmentId: "att-1",
    inline: false,
    ...over,
  };
}

// --- extractParts ---

test("extractParts: a plain alternative body yields no files", () => {
  const payload: Part = {
    mimeType: "multipart/alternative",
    parts: [textPart("text/plain"), textPart("text/html")],
  };
  assert.deepEqual(extractParts(payload), []);
});

test("extractParts: finds an attached image alongside the body", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [textPart("text/plain"), textPart("text/html")] },
      filePart({}),
    ],
  };
  const found = extractParts(payload);
  assert.equal(found.length, 1);
  assert.equal(found[0].fileName, "photo.png");
  assert.equal(found[0].mimeType, "image/png");
  assert.equal(found[0].sizeBytes, 50_000);
  assert.equal(found[0].attachmentId, "att-1");
  assert.equal(found[0].inline, false);
});

test("extractParts: a Content-ID with no disposition counts as inline", () => {
  const payload: Part = {
    mimeType: "multipart/related",
    parts: [
      textPart("text/html"),
      filePart({ headers: [{ name: "Content-ID", value: "<ii_abc123>" }] }),
    ],
  };
  const [image] = extractParts(payload);
  assert.equal(image.inline, true);
});

test("extractParts: an explicit attachment disposition wins over a Content-ID", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [
      filePart({
        headers: [
          { name: "Content-ID", value: "<ii_abc123>" },
          { name: "Content-Disposition", value: 'attachment; filename="photo.png"' },
        ],
      }),
    ],
  };
  const [image] = extractParts(payload);
  assert.equal(image.inline, false);
});

test("extractParts: an inline disposition is honored", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [filePart({ headers: [{ name: "Content-Disposition", value: "inline" }] })],
  };
  assert.equal(extractParts(payload)[0].inline, true);
});

test("extractParts: a part with no bytes behind it is skipped", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [filePart({ body: { size: 0 } })],
  };
  assert.deepEqual(extractParts(payload), []);
});

test("extractParts: a NAMED text part is a file, not a body", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [
      textPart("text/plain"),
      filePart({ mimeType: "text/plain", filename: "notes.txt" }),
    ],
  };
  const found = extractParts(payload);
  assert.equal(found.length, 1);
  assert.equal(found[0].fileName, "notes.txt");
});

test("extractParts: walks arbitrarily nested containers", () => {
  const payload: Part = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/related",
        parts: [
          { mimeType: "multipart/alternative", parts: [textPart("text/plain")] },
          filePart({ partId: "a", filename: "deep.png" }),
        ],
      },
      filePart({ partId: "b", filename: "shallow.png" }),
    ],
  };
  assert.deepEqual(
    extractParts(payload).map((p) => p.fileName),
    ["deep.png", "shallow.png"],
  );
});

test("extractParts: an undefined payload is empty, not a throw", () => {
  assert.deepEqual(extractParts(undefined), []);
});

// --- selectInboundImages ---

test("selectInboundImages: drops a tracking pixel", () => {
  const parts = [part({ sizeBytes: 43, fileName: "pixel.gif", mimeType: "image/gif" })];
  assert.deepEqual(selectInboundImages(parts), []);
});

test("selectInboundImages: drops a signature logo but keeps a screenshot", () => {
  const parts = [
    part({ partId: "1", fileName: "logo.png", sizeBytes: 4_000 }),
    part({ partId: "2", fileName: "screenshot.png", sizeBytes: 240_000 }),
  ];
  assert.deepEqual(
    selectInboundImages(parts).map((p) => p.fileName),
    ["screenshot.png"],
  );
});

test("selectInboundImages: drops SVG, which is markup rather than a viewable image", () => {
  const parts = [part({ mimeType: "image/svg+xml", sizeBytes: 90_000 })];
  assert.deepEqual(selectInboundImages(parts), []);
});

test("selectInboundImages: drops non-images", () => {
  const parts = [
    part({ mimeType: "application/pdf", fileName: "report.pdf", sizeBytes: 900_000 }),
    part({ mimeType: "application/zip", fileName: "bundle.zip", sizeBytes: 900_000 }),
  ];
  assert.deepEqual(selectInboundImages(parts), []);
});

test("selectInboundImages: drops an oversized image", () => {
  const parts = [part({ sizeBytes: 11 * 1024 * 1024 })];
  assert.deepEqual(selectInboundImages(parts), []);
});

test("selectInboundImages: matches mime type case-insensitively", () => {
  const parts = [part({ mimeType: "IMAGE/PNG", sizeBytes: 90_000 })];
  assert.equal(selectInboundImages(parts).length, 1);
});

test("selectInboundImages: keeps inline images — a pasted screenshot is content", () => {
  const parts = [part({ inline: true, sizeBytes: 200_000 })];
  assert.equal(selectInboundImages(parts).length, 1);
});

test("selectInboundImages: over the cap, keeps the largest in document order", () => {
  const sizes = [10_000, 900_000, 20_000, 800_000, 30_000, 700_000, 600_000];
  const parts = sizes.map((sizeBytes, i) =>
    part({ partId: String(i), fileName: `img-${i}.png`, sizeBytes }),
  );
  const selected = selectInboundImages(parts);
  assert.equal(selected.length, 5);
  // The five largest: 900k, 800k, 700k, 600k, 30k — reported in message order.
  assert.deepEqual(
    selected.map((p) => p.fileName),
    ["img-1.png", "img-3.png", "img-4.png", "img-5.png", "img-6.png"],
  );
});

test("selectInboundImages: at or below the cap, everything eligible survives in order", () => {
  const parts = [0, 1, 2].map((i) =>
    part({ partId: String(i), fileName: `img-${i}.png`, sizeBytes: 100_000 + i }),
  );
  assert.deepEqual(
    selectInboundImages(parts).map((p) => p.fileName),
    ["img-0.png", "img-1.png", "img-2.png"],
  );
});

// --- selectInboundFiles ---

test("selectInboundFiles: keeps a PDF — the case that used to vanish entirely", () => {
  const parts = [part({ mimeType: "application/pdf", fileName: "proposal.pdf", sizeBytes: 900_000 })];
  const { fetch, listOnly } = selectInboundFiles(parts);
  assert.deepEqual(fetch.map((p) => p.fileName), ["proposal.pdf"]);
  assert.deepEqual(listOnly, []);
});

test("selectInboundFiles: keeps a small file — size is no signal for documents", () => {
  const parts = [part({ mimeType: "text/calendar", fileName: "invite.ics", sizeBytes: 900 })];
  assert.equal(selectInboundFiles(parts).fetch.length, 1);
});

test("selectInboundFiles: leaves every image to selectInboundImages", () => {
  const parts = [
    part({ mimeType: "image/png", sizeBytes: 200_000 }),
    part({ mimeType: "image/gif", sizeBytes: 43 }),
    part({ mimeType: "image/svg+xml", sizeBytes: 90_000 }),
  ];
  assert.deepEqual(selectInboundFiles(parts), { fetch: [], listOnly: [] });
});

test("selectInboundFiles: drops signatures, which nobody attached on purpose", () => {
  const parts = [
    part({ mimeType: "application/pkcs7-signature", fileName: "smime.p7s", sizeBytes: 4_000 }),
    part({ mimeType: "application/pgp-signature", fileName: "signature.asc", sizeBytes: 800 }),
  ];
  assert.deepEqual(selectInboundFiles(parts), { fetch: [], listOnly: [] });
});

test("selectInboundFiles: an oversized file is listed, not dropped", () => {
  const parts = [part({ mimeType: "application/zip", fileName: "huge.zip", sizeBytes: 30 * 1024 * 1024 })];
  const { fetch, listOnly } = selectInboundFiles(parts);
  assert.deepEqual(fetch, []);
  assert.deepEqual(listOnly.map((p) => p.fileName), ["huge.zip"]);
});

test("selectInboundFiles: past the per-message cap, the rest are listed in order", () => {
  const parts = Array.from({ length: 12 }, (_, i) =>
    part({ partId: String(i), mimeType: "application/pdf", fileName: `doc-${i}.pdf` }),
  );
  const { fetch, listOnly } = selectInboundFiles(parts);
  assert.equal(fetch.length, 10);
  assert.deepEqual(listOnly.map((p) => p.fileName), ["doc-10.pdf", "doc-11.pdf"]);
});

// --- safeAttachmentFileName ---

test("safeAttachmentFileName: prefixes the message id so thread-mates don't collide", () => {
  assert.equal(safeAttachmentFileName(part({ fileName: "photo.png" }), "msg1", 0), "msg1-photo.png");
});

test("safeAttachmentFileName: strips directory components from a traversal attempt", () => {
  const name = safeAttachmentFileName(part({ fileName: "../../etc/passwd" }), "msg1", 0);
  assert.equal(name, "msg1-passwd.png");
  assert.ok(!name.includes("/"), "no path separator survives");
  assert.ok(!name.includes(".."), "no parent-directory hop survives");
});

test("safeAttachmentFileName: strips a Windows-style path too", () => {
  const name = safeAttachmentFileName(part({ fileName: "C:\\Users\\me\\photo.png" }), "msg1", 0);
  assert.equal(name, "msg1-photo.png");
});

test("safeAttachmentFileName: replaces spaces and unicode with dashes", () => {
  assert.equal(
    safeAttachmentFileName(part({ fileName: "my vacation ☀.jpg", mimeType: "image/jpeg" }), "m", 0),
    "m-my-vacation--.jpg",
  );
});

test("safeAttachmentFileName: an unnamed part gets a positional name and a mime extension", () => {
  assert.equal(
    safeAttachmentFileName(part({ fileName: "", mimeType: "image/jpeg" }), "msg1", 2),
    "msg1-image-3.jpg",
  );
});

test("safeAttachmentFileName: a name reduced to nothing falls back rather than emptying", () => {
  assert.equal(safeAttachmentFileName(part({ fileName: "..." }), "msg1", 0), "msg1-image-1.png");
});

test("safeAttachmentFileName: an extensionless name gains one from the mime type", () => {
  assert.equal(
    safeAttachmentFileName(part({ fileName: "scan", mimeType: "image/webp" }), "msg1", 0),
    "msg1-scan.webp",
  );
});

test("safeAttachmentFileName: an unknown image mime still yields a bounded name", () => {
  const name = safeAttachmentFileName(part({ fileName: "", mimeType: "image/x-weird" }), "msg1", 0);
  assert.equal(name, "msg1-image-1.img");
});

test("safeAttachmentFileName: a long name is truncated but keeps an extension", () => {
  const name = safeAttachmentFileName(part({ fileName: "a".repeat(500) + ".png" }), "msg1", 0);
  // Prefix + the 64-char cap + a re-appended extension, since truncation ate the original.
  assert.ok(name.length <= "msg1-".length + 64 + ".png".length, `bounded, got ${name.length}`);
  assert.ok(name.endsWith(".png"), `keeps an extension, got ${name}`);
});

test("safeAttachmentFileName: an unnamed document gets a file- name and its extension", () => {
  assert.equal(
    safeAttachmentFileName(part({ fileName: "", mimeType: "application/pdf" }), "msg1", 0),
    "msg1-file-1.pdf",
  );
});

test("safeAttachmentFileName: an unknown non-image mime falls back to .bin", () => {
  assert.equal(
    safeAttachmentFileName(part({ fileName: "", mimeType: "application/x-weird" }), "msg1", 1),
    "msg1-file-2.bin",
  );
});

// --- mimeFromFileName ---

test("mimeFromFileName: recognizes a saved PDF, so it isn't mistaken for an image", () => {
  assert.equal(mimeFromFileName("msg1-proposal.pdf"), "application/pdf");
  assert.equal(mimeFromFileName("msg1-scan.png"), "image/png");
});
