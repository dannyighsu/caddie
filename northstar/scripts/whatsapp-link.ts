/**
 * WhatsApp Baileys Pairing Script
 *
 * Connects to WhatsApp and displays QR codes for device linking.
 * Run via `make whatsapp-link`. Exits once pairing is complete.
 * Auth is saved to .baileys-auth/ so the main server can reuse it.
 */

import { enableQR, startBaileys } from "../lib/baileys";

enableQR();

console.log("[WhatsApp Link] Starting pairing flow...");
console.log("[WhatsApp Link] Scan the QR code with WhatsApp > Settings > Linked Devices > Link a Device");
console.log("[WhatsApp Link] Press Ctrl+C to exit after pairing succeeds.\n");

startBaileys(async () => {
  // No-op handler — we're just pairing, not processing messages
}).catch((err) => {
  console.error("[WhatsApp Link] Failed:", err);
  process.exit(1);
});
