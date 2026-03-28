import { checkAllCapabilities } from "@/lib/health";
import { NextResponse } from "next/server";

export async function GET() {
  const results = await checkAllCapabilities();
  return NextResponse.json(results);
}
