/**
 * Public Access Gate
 *
 * When a request comes in via the public URL (Tailscale Funnel, ngrok, etc.),
 * only allow webhook endpoints through. All other routes are blocked from
 * external access — they're only reachable via localhost.
 */

import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PUBLIC_PATHS = [
  "/api/email/webhook",
  "/api/whatsapp/webhook",
];

export function middleware(request: NextRequest) {
  const publicHost = process.env.PUBLIC_URL
    ? new URL(process.env.PUBLIC_URL).host
    : null;

  if (!publicHost) return NextResponse.next();

  const requestHost = request.headers.get("host") ?? "";
  const isPublic = requestHost === publicHost;

  if (!isPublic) return NextResponse.next();

  // Public request — only allow webhook paths
  const path = request.nextUrl.pathname;
  if (ALLOWED_PUBLIC_PATHS.some((allowed) => path.startsWith(allowed))) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const config = {
  matcher: "/api/:path*",
};
