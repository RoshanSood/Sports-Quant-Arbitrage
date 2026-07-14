import { NextRequest, NextResponse } from "next/server";
import { todayDateStr } from "@/lib/props/config";
import { runProps } from "@/lib/props/ingest";
import { isRunning } from "@/lib/props/store";
import { isAuthorized } from "@/lib/adminAuth";

// Manual/admin recomputation (manual §24 admin/recompute). Auth via CRON_SECRET
// bearer or the app admin password; running guard; fire-and-forget. The client
// normally lets /bootstrap auto-trigger instead of calling this directly.

export async function POST(request: NextRequest) {
  let body: { date?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    // body optional
  }

  if (!isAuthorized(request, body.password)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = body.date ?? todayDateStr();
  if (isRunning(date)) {
    return NextResponse.json({ status: "already-running", date });
  }

  runProps(date).catch((e) => console.error(`[props/run] ${date} failed:`, e));
  return NextResponse.json({ status: "started", date });
}
