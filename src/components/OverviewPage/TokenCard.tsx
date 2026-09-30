import { useEffect, useState } from "react";
import { fetchTokens } from "../../api/client";
import type { TokensResponse } from "../../api/types";

type WindowKey = "today" | "week" | "month" | "all";

const WINDOWS: { key: WindowKey; label: string; title: string }[] = [
  { key: "today", label: "Day", title: "Tokens generated since 00:00 UTC" },
  { key: "week", label: "Week", title: "Rolling last 7 days" },
  { key: "month", label: "Month", title: "Rolling last 30 days" },
  { key: "all", label: "All", title: "Since metering began" },
];

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Tokens generated per head + fleet, by day / week / month / all time.
 * Exact counts: the LLM engines' cumulative counters, delta-tracked
 * server-side (TokenRollup). Heads serve the API, so a head's tokens are
 * its cluster's tokens.
 */
export function TokenCard() {
  const [data, setData] = useState<TokensResponse | null>(null);
  const [win, setWin] = useState<WindowKey>("today");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTokens()
        .then((next) => {
          if (!cancelled) setData(next);
        })
        .catch(() => {
          /* keep the last good data; the card hides itself until first load */
        });
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const heads = [...data.heads].sort((a, b) => b[win] - a[win]);

  return (
    <section className="panel p-3" aria-labelledby="token-card-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="token-card-title" className="text-xs font-semibold text-text-strong">
          Tokens generated
        </h2>
        <div className="flex gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              title={w.title}
              className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
                win === w.key
                  ? "bg-accent text-white"
                  : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-[10px] text-muted">Fleet</div>
          <strong className="font-tabular text-sm">{fmt(data.fleet[win])}</strong>
        </div>
        {heads.map((h) => (
          <span
            key={h.id}
            title={`${h.name ?? h.id} — day ${fmt(h.today)} · week ${fmt(h.week)} · month ${fmt(h.month)} · all ${fmt(h.all)}`}
            className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-muted"
          >
            {h.name ?? h.id}{" "}
            <strong className="font-tabular text-text">{fmt(h[win])}</strong>
          </span>
        ))}
      </div>
      {heads.length === 0 && (
        <p className="mt-2 text-[10px] text-muted">
          No LLM token counters observed yet — heads appear once their engines serve requests.
        </p>
      )}
    </section>
  );
}
