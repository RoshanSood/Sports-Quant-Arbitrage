import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt, AnalysisRequest } from "@/lib/mlbAnalysis";
import { fetchGameInjuryReport } from "@/lib/mlbInjuries";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params;

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: AnalysisRequest;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { game, gameDate } = body;
  if (!game || game.id !== gameId) {
    return new Response(
      JSON.stringify({ error: "Game data missing or mismatched" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Use web-search-2025-03-05 (beta) — more reliable than 20260209 which uses
  // dynamic filtering via code execution and times out frequently
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "web-search-2025-03-05" },
  });

  // Fetch injury report from ESPN before calling Claude — reduces web search dependency
  const injuries = await fetchGameInjuryReport(gameId);

  const userPrompt = buildAnalysisPrompt(game, gameDate, injuries);
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const streamParams: any = {
          model: MODEL,
          max_tokens: 4000,           // Increased from 2000 — analysis was being truncated
          system: [
            {
              type: "text",
              text: ANALYSIS_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" }, // Cache stable system prompt
            },
          ],
          tools: [
            {
              type: "web_search_20250305", // Older version — avoids dynamic-filtering code-execution timeouts
              name: "web_search",
            },
          ],
          messages: [{ role: "user", content: userPrompt }],
        };

        const stream = client.messages.stream(streamParams);

        // Forward only text deltas — web search runs server-side on Anthropic's infra
        stream.on("text", (text) => {
          enqueue({ text });
        });

        // Notify client when web search is in progress
        stream.on("streamEvent", (event) => {
          if (
            event.type === "content_block_start" &&
            "content_block" in event &&
            (event.content_block as { type: string }).type === "server_tool_use"
          ) {
            enqueue({ status: "Searching the web for current stats and news..." });
          }
        });

        const finalMsg = await stream.finalMessage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usage = finalMsg.usage as any;

        enqueue({
          done: true,
          stopReason: finalMsg.stop_reason,
          usage: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
          },
        });
      } catch (err) {
        enqueue({ error: err instanceof Error ? err.message : "Analysis failed" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
