import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const PUBLIC_TOKEN_COOKIE = "public_token";

function isAuthenticated(request: NextRequest): boolean {
  const password = process.env.PUBLIC_PAGE_PASSWORD;
  if (!password) return false;
  return request.cookies.get(PUBLIC_TOKEN_COOKIE)?.value === password;
}

export async function GET(request: NextRequest) {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dataDir = path.join(process.cwd(), "../workspace/buri/outreach");
  let entries: unknown[] = [];

  try {
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(dataDir, file), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch {}
      }
    }
  } catch {
    // Directory doesn't exist yet — return empty
  }

  return NextResponse.json(entries);
}
