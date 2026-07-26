/**
 * Gmail OAuth client (control-plane).
 *
 * Mirrors the proven auth pattern in harness/mcp-servers/google-gmail.mjs: build
 * an OAuth2 client from GOOGLE_CLIENT_ID/SECRET (already in northstar/.env.local)
 * and load the SAME shared token file that Buri's Calendar + Gmail MCP already
 * use. That token is already authorized against the Gmail account we're
 * migrating to, so there is no new account/consent here — only the scope must be
 * gmail.modify (re-run `make google-auth`).
 *
 * This lives in northstar (not the harness MCP) because the email transport is
 * control-plane library code: the scheduler, control API, notification-channels
 * and the inbound poller all call it in-process, and none of them can drive a
 * per-run stdio MCP server.
 */

import { google, type gmail_v1 } from "googleapis";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Shared token file. Defaults to the harness credentials file that Calendar and
 * the read-only Gmail MCP already use, resolved relative to northstar's cwd
 * (the repo root is one level up). Override with GOOGLE_TOKENS_FILE.
 */
export function tokensFilePath(): string {
  return (
    process.env.GOOGLE_TOKENS_FILE ??
    resolve(process.cwd(), "..", "harness", "credentials", "google-calendar-tokens.json")
  );
}

/** True when Google creds + a token file are present (gate for isEmailConfigured). */
export function isGmailConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    existsSync(tokensFilePath())
  );
}

let cachedGmail: gmail_v1.Gmail | null = null;

/** Build (and cache) an authenticated Gmail API client for userId "me". */
export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  if (cachedGmail) return cachedGmail;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for Gmail transport");
  }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth2callback";
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const file = tokensFilePath();
  const tokens = JSON.parse(await readFile(file, "utf-8"));
  oauth2Client.setCredentials(tokens);

  // Persist refreshed access tokens back to the shared file, exactly like the
  // MCP servers do, so Calendar and email stay in sync on one refresh token.
  oauth2Client.on("tokens", async (next) => {
    if (!next.access_token) return;
    try {
      await writeFile(
        file,
        JSON.stringify(
          {
            access_token: next.access_token,
            refresh_token: next.refresh_token ?? tokens.refresh_token,
            expiry_date: next.expiry_date ?? tokens.expiry_date,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error("[Gmail] Failed to persist refreshed tokens:", err);
    }
  });

  cachedGmail = google.gmail({ version: "v1", auth: oauth2Client });
  return cachedGmail;
}

let cachedSelfAddress: string | null = null;

/**
 * The Gmail account's own address (the send/receive identity). Prefers
 * GMAIL_ADDRESS, else reads it once from the authenticated profile.
 */
export async function getSelfAddress(): Promise<string> {
  if (process.env.GMAIL_ADDRESS) return process.env.GMAIL_ADDRESS.toLowerCase();
  if (cachedSelfAddress) return cachedSelfAddress;
  const gmail = await getGmailClient();
  const profile = await gmail.users.getProfile({ userId: "me" });
  cachedSelfAddress = (profile.data.emailAddress ?? "").toLowerCase();
  return cachedSelfAddress;
}
