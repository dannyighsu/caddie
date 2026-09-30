/**
 * Tests for htmlToText (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/gmail/html-text.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * This runs on both sides of the channel — reading HTML-only inbound mail, and
 * building the text/plain alternative for outbound HTML — so the cases below
 * lean on what a text-only recipient would otherwise lose: link destinations,
 * list structure, and correctly-ordered entity decoding.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "./html-text.ts";

test("returns empty string for empty input", () => {
  assert.equal(htmlToText(undefined), "");
  assert.equal(htmlToText(""), "");
});

test("keeps the link destination alongside the anchor text", () => {
  assert.equal(
    htmlToText('<p>See <a href="https://example.com/doc">the doc</a>.</p>'),
    "See the doc (https://example.com/doc).",
  );
});

test("does not duplicate a URL that is its own anchor text", () => {
  assert.equal(
    htmlToText('<a href="https://example.com">https://example.com</a>'),
    "https://example.com",
  );
});

test("keeps the href when the anchor has no text", () => {
  assert.equal(htmlToText('<a href="https://example.com"></a>'), "https://example.com");
});

test("handles anchors with attributes on either side of href", () => {
  assert.equal(
    htmlToText('<a class="x" href="https://e.co" style="color:red">hi</a>'),
    "hi (https://e.co)",
  );
});

test("strips tags inside anchor text", () => {
  assert.equal(
    htmlToText('<a href="https://e.co">the <strong>big</strong> doc</a>'),
    "the big doc (https://e.co)",
  );
});

test("renders list items as bullets on their own lines", () => {
  assert.equal(
    htmlToText("<ul><li>one</li><li>two</li><li>three</li></ul>"),
    "- one\n- two\n- three",
  );
});

test("does not put blank lines between list items", () => {
  assert.ok(!htmlToText("<ul><li>a</li><li>b</li></ul>").includes("\n\n"));
});

test("drops style, script and head content entirely", () => {
  assert.equal(
    htmlToText("<style>p{color:red}</style><script>alert(1)</script><p>body</p>"),
    "body",
  );
});

test("converts <br> to newlines", () => {
  assert.equal(htmlToText("a<br>b<br/>c"), "a\nb\nc");
});

test("decodes entities without double-decoding", () => {
  assert.equal(htmlToText("<p>a &amp; b</p>"), "a & b");
  // The escaped form of "&lt;" must survive as literal text, not become "<".
  assert.equal(htmlToText("<p>&amp;lt;</p>"), "&lt;");
  assert.equal(htmlToText("<p>&lt;tag&gt;</p>"), "<tag>");
  assert.equal(htmlToText("<p>it&#39;s &quot;quoted&quot;</p>"), "it's \"quoted\"");
});

test("collapses runs of blank lines and trims", () => {
  assert.equal(htmlToText("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
});

test("separates block elements with newlines", () => {
  assert.equal(htmlToText("<h1>Title</h1><p>Body</p>"), "Title\nBody");
});

test("leaves plain text untouched", () => {
  assert.equal(htmlToText("just words"), "just words");
});

test("output never contains angle-bracketed tags", () => {
  const samples = [
    '<div style="font-family:sans-serif"><h2>Hi</h2><ul><li>x</li></ul></div>',
    "<table><tr><td>a</td><td>b</td></tr></table>",
    "<blockquote><p>quoted</p></blockquote>",
  ];
  for (const s of samples) {
    assert.ok(!/<[a-z/][^>]*>/i.test(htmlToText(s)), `tags survived in: ${s}`);
  }
});

test("indented, pretty-printed HTML produces no whitespace-only lines", () => {
  const out = htmlToText(`<div style="font-family:sans-serif">
      <h2>Weekly digest</h2>
      <ul>
        <li>Dentist <strong>Thursday 3pm</strong></li>
        <li>Renew the <a href="https://dmv.example.com/renew">registration</a></li>
      </ul>
    </div>`);
  // Blank line after the heading is intentional — a block boundary reads as one
  // in plain text. Blank lines *between* the bullets would not be.
  assert.equal(
    out,
    "Weekly digest\n\n- Dentist Thursday 3pm\n- Renew the registration (https://dmv.example.com/renew)",
  );
  assert.ok(!/^[ \t]+$/m.test(out), "found a whitespace-only line");
});

test("preserves meaningful spaces between inline elements", () => {
  assert.equal(htmlToText("<p><strong>big</strong> <em>doc</em></p>"), "big doc");
  assert.equal(htmlToText('<p>See <a href="https://e.co">this</a> now</p>'), "See this (https://e.co) now");
});

test("renders table rows with cell separators", () => {
  assert.equal(
    htmlToText("<table><tr><th>Item</th><th>Due</th></tr><tr><td>Rent</td><td>Sep 1</td></tr></table>"),
    "Item | Due\nRent | Sep 1",
  );
});

test("no line begins or ends with stray whitespace", () => {
  const out = htmlToText(`<div>
      <p>  padded  </p>
      <ul>  <li>  a  </li>  </ul>
    </div>`);
  for (const line of out.split("\n")) assert.equal(line, line.trim(), `untrimmed: ${JSON.stringify(line)}`);
});
