"use client";

import { useState, useRef, useCallback } from "react";
import { Sparkles, ChevronDown, ChevronUp, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { WNBAGame } from "@/types/wnba";

type Props = {
  game: WNBAGame;
  gameDate: string;
};

type Status = "idle" | "fetching" | "streaming" | "done" | "truncated" | "error";

// Session-scoped cache — only stores complete analyses
const wnbaAnalysisCache = new Map<string, string>();

function AnalysisText({ text }: { text: string }) {
  if (!text) return null;

  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      elements.push(
        <h3 key={key++} className="text-sm font-bold text-white mt-5 mb-2 first:mt-0">
          {line.slice(3)}
        </h3>
      );
    } else if (line.trim()) {
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const rendered = parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="text-gray-200 font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      );
      elements.push(
        <p key={key++} className="text-sm text-gray-300 leading-relaxed mb-1">
          {rendered}
        </p>
      );
    }
  }

  return <div>{elements}</div>;
}

export default function WNBAAnalysis({ game, gameDate }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>(
    wnbaAnalysisCache.has(game.id) ? "done" : "idle"
  );
  const [text, setText] = useState<string>(wnbaAnalysisCache.get(game.id) ?? "");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isCached = status === "done" && wnbaAnalysisCache.has(game.id);
  const isLoading = status === "fetching" || status === "streaming";

  const runAnalysis = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setStatus("fetching");
    setStatusMsg("Loading injury data from ESPN...");
    setText("");
    setError(null);

    try {
      const res = await fetch(`/api/wnba-analyze/${game.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, gameDate }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";
      let stopReason: string | undefined;

      setStatus("streaming");
      setStatusMsg("");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          try {
            const data = JSON.parse(payload) as {
              text?: string;
              status?: string;
              error?: string;
              done?: boolean;
              stopReason?: string;
            };

            if (data.error) throw new Error(data.error);
            if (data.status) setStatusMsg(data.status);
            if (data.text) {
              accumulated += data.text;
              setText(accumulated);
            }
            if (data.done) {
              stopReason = data.stopReason;
            }
          } catch (parseErr) {
            const msg = (parseErr as Error).message;
            if (!msg.includes("JSON")) throw parseErr;
          }
        }
      }

      if (stopReason === "max_tokens") {
        setStatus("truncated");
      } else {
        setStatus("done");
        if (accumulated.length > 100) {
          wnbaAnalysisCache.set(game.id, accumulated);
        }
      }
      setStatusMsg("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Analysis failed");
      setStatus("error");
    }
  }, [game, gameDate]);

  const handleClick = () => {
    if (!open) {
      setOpen(true);
      if (status === "idle") runAnalysis();
    } else {
      setOpen(false);
    }
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    wnbaAnalysisCache.delete(game.id);
    setStatus("idle");
    setText("");
    runAnalysis();
  };

  return (
    <div className="mt-2 border-t border-[#22252d] pt-2">
      <button
        onClick={handleClick}
        className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors w-full justify-between ${
          open
            ? "bg-[#1a1e30] text-blue-300"
            : "text-gray-500 hover:text-blue-300 hover:bg-[#1a1d2a]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          AI Analysis
          {isCached && (
            <span className="text-[10px] text-gray-600 ml-0.5">• cached</span>
          )}
          {status === "truncated" && (
            <span className="text-[10px] text-yellow-600 ml-0.5">• truncated</span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {(status === "done" || status === "truncated") && open && (
            <span
              role="button"
              onClick={handleRefresh}
              className="p-0.5 rounded hover:text-blue-400 text-gray-600 hover:bg-[#252a3a]"
              title="Re-run analysis"
            >
              <RefreshCw className="w-3 h-3" />
            </span>
          )}
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </span>
      </button>

      {open && (
        <div className="mt-2 bg-[#0e1016] border border-[#252840] rounded-xl px-4 py-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-blue-400 mb-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
              <span>{statusMsg || "Analyzing matchup..."}</span>
            </div>
          )}

          {status === "truncated" && (
            <div className="flex items-center gap-2 text-xs text-yellow-500 mb-3">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                Output was cut off.{" "}
                <button onClick={handleRefresh} className="underline hover:text-yellow-300">
                  Retry
                </button>
              </span>
            </div>
          )}

          {status === "error" && error && (
            <div className="flex items-start gap-2 text-xs text-red-400 mb-3">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">Analysis failed</p>
                <p className="text-gray-500 mt-0.5">{error}</p>
                <button onClick={handleRefresh} className="mt-1.5 underline hover:text-red-300">
                  Retry
                </button>
              </div>
            </div>
          )}

          {isLoading && !text && (
            <div className="flex flex-col gap-2.5">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="h-3 bg-[#1a1d24] rounded animate-pulse"
                  style={{ width: `${60 + (i % 4) * 10}%` }}
                />
              ))}
            </div>
          )}

          {text && <AnalysisText text={text} />}

          {status === "streaming" && text && (
            <span className="inline-block w-1.5 h-3.5 bg-blue-400 animate-pulse ml-0.5 rounded-sm align-middle" />
          )}
        </div>
      )}
    </div>
  );
}
