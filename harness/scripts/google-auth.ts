/**
 * Google OAuth Setup (Calendar + Gmail)
 *
 * One-time script to authorize the harness with Google Calendar and Gmail.
 * Opens a browser for OAuth consent and saves tokens to credentials/.
 *
 * Prerequisites:
 *   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env or .env
 *   - Google Cloud project with Calendar API and Gmail API enabled
 *   - OAuth 2.0 credentials (Desktop app type)
 *
 * Usage:
 *   cd harness && npx tsx scripts/google-auth.ts
 */

import { google } from "googleapis";
import { createServer } from "http";
import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");
const TOKENS_PATH = resolve(harnessRoot, "credentials/google-calendar-tokens.json");
const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.");
    console.error("Set them in your environment or in harness/.env");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    prompt: "consent",
  });

  console.log("Opening browser for Google Calendar authorization...\n");
  console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);

  // Open browser
  const { exec } = await import("child_process");
  exec(`open "${authUrl}"`);

  // Start temporary server to receive callback
  return new Promise<void>((resolvePromise) => {
    const server = createServer(async (req, res) => {
      if (!req.url?.startsWith("/oauth2callback")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        await mkdir(dirname(TOKENS_PATH), { recursive: true });
        await writeFile(
          TOKENS_PATH,
          JSON.stringify(
            {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              expiry_date: tokens.expiry_date,
            },
            null,
            2
          )
        );

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");

        console.log("Tokens saved to credentials/google-calendar-tokens.json");
        console.log("Google Calendar + Gmail are now configured.");

        server.close();
        resolvePromise();
      } catch (err) {
        console.error("Token exchange failed:", err);
        res.writeHead(500);
        res.end("Token exchange failed");
        server.close();
        process.exit(1);
      }
    });

    server.listen(PORT, () => {
      console.log(`Waiting for OAuth callback on port ${PORT}...`);
    });
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
