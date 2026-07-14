import { NextRequest, NextResponse } from "next/server";
import { getAgents, updateAgent } from "@/lib/arbitrage/agentStore";
import type { Agent } from "@/types/arbitrage";

export async function GET() {
  try {
    const agents = await getAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    return NextResponse.json({ agents: [], error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: string } & Partial<Agent>;
    if (!body.id) {
      return NextResponse.json({ error: "Missing agent id" }, { status: 400 });
    }
    const { id, ...partial } = body;

    // Validate edge thresholds if provided.
    const agents = await getAgents();
    const existing = agents.find((a) => a.id === id);
    if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const minEdge = partial.minEdge ?? existing.minEdge;
    const maxEdge = partial.maxEdge ?? existing.maxEdge;
    if (!(minEdge >= 0 && minEdge <= maxEdge && maxEdge <= 1)) {
      return NextResponse.json({ error: "Invalid edges: require 0 <= minEdge <= maxEdge <= 1" }, { status: 400 });
    }

    const updated = await updateAgent(id, partial);
    return NextResponse.json({ ok: true, agent: updated });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
