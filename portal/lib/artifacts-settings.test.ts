/**
 * Tests for artifacts-settings (pure logic): what the settings API reveals,
 * how a form submission merges, and when the capability gets its values.
 *
 * Run: node --test --experimental-strip-types lib/artifacts-settings.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyUpdate, capabilityVarsOf, viewOf, type ArtifactsSettings } from "./artifacts-settings.ts";

const FULL: ArtifactsSettings = {
  origin: "https://artifacts.example.com",
  password: "pw-secret",
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "fedcba9876543210fedcba9876543210",
  secretAccessKey: "0123456789abcdef".repeat(4),
};

function ok(r: ReturnType<typeof applyUpdate>): ArtifactsSettings {
  assert.ok("settings" in r, "error" in r ? r.error : "");
  return r.settings;
}

function err(r: ReturnType<typeof applyUpdate>): string {
  assert.ok("error" in r, "expected an error");
  return r.error;
}

test("the view never carries the password or the R2 secret", () => {
  const view = viewOf(FULL);
  assert.deepEqual(view, {
    origin: FULL.origin,
    accountId: FULL.accountId,
    accessKeyId: FULL.accessKeyId,
    passwordSet: true,
    secretAccessKeySet: true,
    configured: true,
  });
  assert.ok(!JSON.stringify(view).includes("pw-secret"));
  assert.ok(!JSON.stringify(view).includes("r2-secret"));
});

test("an empty store is unconfigured", () => {
  assert.deepEqual(viewOf(null), {
    origin: "",
    accountId: "",
    accessKeyId: "",
    passwordSet: false,
    secretAccessKeySet: false,
    configured: false,
  });
});

test("a first save needs all five values", () => {
  assert.equal(ok(applyUpdate(null, FULL)).password, "pw-secret");
  assert.match(err(applyUpdate(null, { ...FULL, secretAccessKey: "" })), /Missing: secretAccessKey/);
});

test("blank secrets keep the stored ones, so the form saves without retyping them", () => {
  const saved = ok(applyUpdate(FULL, { ...FULL, password: "", secretAccessKey: "  ", accessKeyId: "a".repeat(32) }));
  assert.equal(saved.password, "pw-secret");
  assert.equal(saved.secretAccessKey, FULL.secretAccessKey);
  assert.equal(saved.accessKeyId, "a".repeat(32));
});

test("a new secret replaces the stored one", () => {
  assert.equal(ok(applyUpdate(FULL, { ...FULL, password: "rotated" })).password, "rotated");
});

test("the origin must be a bare https address, stored without a trailing slash", () => {
  assert.equal(ok(applyUpdate(null, { ...FULL, origin: "https://artifacts.example.com/" })).origin, FULL.origin);
  assert.match(err(applyUpdate(null, { ...FULL, origin: "http://artifacts.example.com" })), /https/);
  assert.match(err(applyUpdate(null, { ...FULL, origin: "https://artifacts.example.com/shared" })), /no path/);
  assert.match(err(applyUpdate(null, { ...FULL, origin: "artifacts.example.com" })), /must be a URL/);
});

test("the account ID must look like one", () => {
  assert.match(err(applyUpdate(null, { ...FULL, accountId: "my-account" })), /32 hex/);
});

test("the R2 credentials must be the S3 pair, not the API token", () => {
  const token = "cfat_" + "x".repeat(48);
  assert.match(err(applyUpdate(null, { ...FULL, accessKeyId: token })), /access key ID is 32 hex/);
  assert.match(err(applyUpdate(null, { ...FULL, secretAccessKey: token })), /secret access key is 64 hex/);
});

test("values are trimmed and non-strings ignored", () => {
  const saved = ok(applyUpdate(FULL, { ...FULL, accessKeyId: `  ${FULL.accessKeyId}  `, password: 42 }));
  assert.equal(saved.accessKeyId, FULL.accessKeyId);
  assert.equal(saved.password, "pw-secret");
});

test("the capability gets its values only once setup is complete", () => {
  assert.deepEqual(capabilityVarsOf(FULL), {
    ARTIFACTS_ORIGIN: FULL.origin,
    ARTIFACTS_PASSWORD: FULL.password,
    ARTIFACTS_R2_ACCOUNT_ID: FULL.accountId,
    ARTIFACTS_R2_ACCESS_KEY_ID: FULL.accessKeyId,
    ARTIFACTS_R2_SECRET_ACCESS_KEY: FULL.secretAccessKey,
  });
  assert.deepEqual(capabilityVarsOf({ ...FULL, password: "" }), {});
  assert.deepEqual(capabilityVarsOf(null), {});
});
