import { NextRequest, NextResponse } from "next/server";

const PUBLIC_TOKEN_COOKIE = "public_token";

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const expected = process.env.PUBLIC_PAGE_PASSWORD;

  if (!expected || password !== expected) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(PUBLIC_TOKEN_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // No maxAge — session cookie; persists until browser close
  });
  return response;
}
