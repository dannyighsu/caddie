/**
 * Public Access Gate
 *
 * When a request comes in via the public URL (Tailscale Funnel, ngrok, etc.),
 * only allow webhook endpoints and password-gated /public/* pages through.
 * All other routes are only reachable via localhost.
 *
 * /public/* pages require a valid `public_token` cookie matching PUBLIC_PAGE_PASSWORD.
 * /public/login is always accessible so users can authenticate.
 */

import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PUBLIC_API_PATHS = [
  "/api/email/webhook",
  "/api/telegram/webhook",
  "/api/public/auth",
];

const PUBLIC_TOKEN_COOKIE = "public_token";

function isAuthenticated(request: NextRequest): boolean {
  const password = process.env.PUBLIC_PAGE_PASSWORD;
  if (!password) return false;
  const token = request.cookies.get(PUBLIC_TOKEN_COOKIE)?.value;
  return token === password;
}

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Password-gate /public/* regardless of host (works on both localhost and public URL)
  if (path.startsWith("/public/")) {
    if (path === "/public/login") return NextResponse.next();
    if (!isAuthenticated(request)) {
      const login = new URL("/public/login", request.url);
      login.searchParams.set("next", path);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  // Existing public host gate — block everything except allowed API paths
  const publicHost = process.env.PUBLIC_URL
    ? new URL(process.env.PUBLIC_URL).host
    : null;

  if (!publicHost) return NextResponse.next();

  const requestHost = request.headers.get("host") ?? "";
  const isPublicHost = requestHost === publicHost;

  if (!isPublicHost) return NextResponse.next();

  if (ALLOWED_PUBLIC_API_PATHS.some((allowed) => path.startsWith(allowed))) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const config = {
  matcher: ["/api/:path*", "/public/:path*"],
};
