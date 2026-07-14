import { NextResponse } from "next/server";
import { getHealth } from "@/lib/props/store";

// Detailed provider status for the admin/debug surface (manual §24).
export async function GET() {
  try {
    const health = await getHealth();
    return NextResponse.json({ health, providerConfigured: Boolean(process.env.SPORTSGAMEODDS_KEY) });
  } catch (error) {
    return NextResponse.json({ health: [], providerConfigured: false, error: String(error) }, { status: 500 });
  }
}
