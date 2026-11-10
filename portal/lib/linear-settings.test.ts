/**
 * Tests for linear-settings (pure logic): what the settings API reveals, how a
 * form submission merges, the URLs the install uses, and the OAuth state check.
 *
 * Run: node --test --experimental-strip-types lib/linear-settings.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OAUTH_STATE_TTL_MS,
  applyUpdate,
  authorizeUrl,
  pendingMatches,
  redirectUriFor,
  viewOf,
  webhookUrlFor,
  type LinearSettings,
} from "./linear-settings.ts";

const INSTALL = {
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: 0,
  appUserId: "app-user",
  organizationId: "org",
  organizationName: "Acme",
  connectedAt: "2026-11-09T00:00:00.000Z",
};

const FULL: LinearSettings = {
  clientId: "client-id",
  clientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  installation: INSTALL,
};

const URLS = { publicUrl: "https://box.tail.ts.net/", requestOrigin: "http://localhost:3000" };

function ok(r: ReturnType<typeof applyUpdate>): LinearSettings {
  assert.ok("settings" in r, "error" in r ? r.error : "");
  return r.settings;
}

test("the view never carries a secret or a token", () => {
  const json = JSON.stringify(viewOf(FULL, URLS));
  for (const secret of ["client-secret", "webhook-secret", "access-secret", "refresh-secret"]) {
    assert.ok(!json.includes(secret), `view leaked ${secret}`);
  }
  const v = viewOf(FULL, URLS);
  assert.equal(v.clientSecretSet, true);
  assert.equal(v.webhookSecretSet, true);
  assert.equal(v.configured, true);
  assert.equal(v.connected?.organizationName, "Acme");
});

test("the view of nothing stored is unconfigured and unconnected", () => {
  const v = viewOf(null, URLS);
  assert.equal(v.configured, false);
  assert.equal(v.connected, null);
  assert.equal(v.clientId, "");
});

test("URLs use the public origin when there is one", () => {
  assert.equal(redirectUriFor(URLS.publicUrl, URLS.requestOrigin), "https://box.tail.ts.net/api/chat/plugins/linear/oauth_redirect");
  assert.equal(webhookUrlFor(URLS.publicUrl), "https://box.tail.ts.net/api/chat/plugins/linear/webhook");
});

test("without PUBLIC_URL the redirect falls back to the portal's origin and there's no webhook URL", () => {
  assert.equal(redirectUriFor(undefined, "http://localhost:3000"), "http://localhost:3000/api/chat/plugins/linear/oauth_redirect");
  assert.equal(webhookUrlFor(undefined), null);
  assert.equal(webhookUrlFor("not a url"), null);
});

test("a blank secret keeps the stored one", () => {
  const s = ok(applyUpdate(FULL, { clientId: "client-id", clientSecret: "", webhookSecret: "  " }));
  assert.equal(s.clientSecret, "client-secret");
  assert.equal(s.webhookSecret, "webhook-secret");
  assert.deepEqual(s.installation, INSTALL);
});

test("a new secret replaces the stored one and keeps the install", () => {
  const s = ok(applyUpdate(FULL, { clientId: "client-id", webhookSecret: "rotated" }));
  assert.equal(s.webhookSecret, "rotated");
  assert.deepEqual(s.installation, INSTALL);
});

test("changing the client ID drops the install, whose tokens belong to the old app", () => {
  const s = ok(applyUpdate(FULL, { clientId: "other-app" }));
  assert.equal(s.clientId, "other-app");
  assert.equal(s.installation, undefined);
});

test("every field is required on first save", () => {
  const r = applyUpdate(null, { clientId: "id", clientSecret: "secret" });
  assert.ok("error" in r);
  assert.match(r.error, /webhook signing secret/);
});

test("the authorize URL installs as the app with the agent scopes", () => {
  const url = new URL(authorizeUrl({ clientId: "cid", redirectUri: "https://x/cb", state: "st" }));
  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x/cb");
  assert.equal(url.searchParams.get("state"), "st");
  const scopes = url.searchParams.get("scope")!.split(",");
  for (const s of ["read", "write", "app:mentionable", "app:assignable"]) assert.ok(scopes.includes(s), s);
});

test("the OAuth state must match and be fresh", () => {
  const pending = { state: "abc", redirectUri: "r", returnTo: "http://localhost:3000", createdAt: 1_000 };
  assert.equal(pendingMatches(pending, "abc", 1_000 + 1), true);
  assert.equal(pendingMatches(pending, "abd", 1_000 + 1), false);
  assert.equal(pendingMatches(pending, null, 1_000 + 1), false);
  assert.equal(pendingMatches(null, "abc", 1_000 + 1), false);
  assert.equal(pendingMatches(pending, "abc", 1_000 + OAUTH_STATE_TTL_MS + 1), false);
});
