import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { WNBA_ANALYSIS_SYSTEM_PROMPT, buildWNBAAnalysisPrompt, WNBAAnalysisRequest } from "@/lib/wnbaAnalysis";

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

  let body: WNBAAnalysisRequest;
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

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "web-search-2025-03-05" },
  });
  const userPrompt = buildWNBAAnalysisPrompt(game, gameDate);
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
          max_tokens: 4000,
          system: [
            {
              type: "text",
              text: WNBA_ANALYSIS_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" }, // Cache stable system prompt across all WNBA analyses
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

        stream.on("text", (text) => {
          enqueue({ text });
        });

        stream.on("streamEvent", (event) => {
          if (
            event.type === "content_block_start" &&
            "content_block" in event &&
            (event.content_block as { type: string }).type === "server_tool_use"
          ) {
            enqueue({ status: "Searching ESPN, HerHoopStats, StatMuse..." });
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
