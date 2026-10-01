import { useEffect, useState } from "react";
import { fetchPowerEnergy } from "../../api/client";
import type { PowerEnergyResponse } from "../../api/types";

type WindowKey = "today" | "week" | "month" | "all";

const WINDOWS: { key: WindowKey; label: string; title: string }[] = [
  { key: "today", label: "Day", title: "Energy used since 00:00 UTC" },
  { key: "week", label: "Week", title: "Rolling last 7 days" },
  { key: "month", label: "Month", title: "Rolling last 30 days" },
  { key: "all", label: "All", title: "Since metering began" },
];

/** Stacked-bar shades, one per head (first head = accent). */
const HEAD_SHADES = ["bg-accent/60", "bg-warning/70", "bg-success/70", "bg-danger/60"];

function fmtWh(wh: number): string {
  if (wh >= 1e6) return `${(wh / 1e6).toFixed(2)} MWh`;
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${Math.round(wh)} Wh`;
}

/**
 * Metered wall energy per head/cluster + fleet, by day / week / month /
 * all — same idiom as the Tokens card. Watts come from the smart plugs
 * (POWER_METER_URL) and are integrated server-side (EnergyRollup); a head's
 * energy includes its workers, since every machine burns watts.
 */
export function EnergyCard() {
  const [data, setData] = useState<PowerEnergyResponse | null>(null);
  const [win, setWin] = useState<WindowKey>("today");
  const [byHead, setByHead] = useState(false);
  /** Head id whose series the chart focuses on (null = fleet/stacked). */
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchPowerEnergy()
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
    <section className="panel p-3" aria-labelledby="energy-card-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="energy-card-title" className="text-xs font-semibold text-text-strong">
          Energy used
          <span className="ml-2 font-normal text-[10px] text-muted">wall-metered</span>
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
          <button
            type="button"
            onClick={() => {
              setFocus(null); // the mode toggle always takes over the chart
              setByHead((v) => !v);
            }}
            title={byHead ? "Show the fleet combined" : "Stack bars per head"}
            className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
              byHead
                ? "bg-accent text-white"
                : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
            }`}
          >
            {byHead ? "By head" : "Combined"}
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <button
          type="button"
          onClick={() => {
            setFocus(null);
            setByHead(false);
          }}
          title="Fleet combined — click a head to compare heads, again to chart it alone"
          className="text-left"
        >
          <div className="text-[10px] text-muted">Fleet</div>
          <strong className="font-tabular text-sm">{fmtWh(data.fleet[win])}</strong>
        </button>
        {heads.map((h) => {
          const focused = focus === h.id;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                // Ladder: combined -> by-head (first press), by-head -> this
                // head alone, solo -> back to by-head.
                if (!byHead && focus === null) {
                  setByHead(true);
                  return;
                }
                setFocus(focused ? null : h.id);
              }}
              title={`${h.name ?? h.id} — day ${fmtWh(h.today)} · week ${fmtWh(h.week)} · month ${fmtWh(h.month)} · all ${fmtWh(h.all)}\nClick once for all heads, again to chart this head alone`}
              className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                focused
                  ? "border-accent/60 bg-accent/15 text-text"
                  : "border-border bg-surface-elevated text-muted hover:bg-surface-hover"
              }`}
            >
              {h.name ?? h.id}{" "}
              <strong className="font-tabular text-text">{fmtWh(h[win])}</strong>
            </button>
          );
        })}
      </div>

      <div
        className="mt-3 flex h-12 items-end gap-px"
        aria-label={
          win === "today"
            ? "Fleet energy used per hour over the last 24 hours"
            : "Fleet energy used per day for the last 30 days"
        }
      >
        {(() => {
          const hourly = win === "today";
          const fleet = hourly ? (data.hourly ?? []) : (data.daily ?? []);
          if (fleet.length === 0) return null;
          const seriesOf = (h: (typeof data.heads)[number]) => (hourly ? h.hourly : h.daily) ?? [];
          const focusedIndex = focus != null ? data.heads.findIndex((h) => h.id === focus) : -1;
          const focusedHead = focusedIndex >= 0 ? data.heads[focusedIndex] : undefined;
          const stackHeads = byHead && !focusedHead ? data.heads : [];
          const valueAt = (i: number): number =>
            focusedHead
              ? seriesOf(focusedHead)[i]?.wh ?? 0
              : stackHeads.length > 0
                ? stackHeads.reduce((sum, h) => sum + (seriesOf(h)[i]?.wh ?? 0), 0)
                : fleet[i].wh;
          const max = Math.max(1, ...fleet.map((_, i) => valueAt(i)));
          return fleet.map((entry, i) => {
            const label = hourly
              ? new Date(`${(entry as { hour: string }).hour}:00:00Z`).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : new Date(`${(entry as { day: string }).day}T00:00:00Z`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });
            const key = hourly ? (entry as { hour: string }).hour : (entry as { day: string }).day;
            const total = valueAt(i);
            const title =
              total === 0
                ? `${label} — no data`
                : focusedHead
                  ? `${focusedHead.name ?? focusedHead.id} · ${label} · ${fmtWh(total)}`
                  : stackHeads.length > 0
                    ? `${label} · ${fmtWh(total)} — ${stackHeads
                        .map((h) => ({ name: h.name ?? h.id, wh: seriesOf(h)[i]?.wh ?? 0 }))
                        .filter((p) => p.wh > 0)
                        .map((p) => `${p.name}: ${fmtWh(p.wh)}`)
                        .join(", ")}`
                    : `${label} · ${fmtWh(total)}`;
            return (
              <span
                key={key}
                className="flex min-w-0 flex-1 flex-col-reverse justify-start"
                style={{ height: total === 0 ? 0 : `${Math.max(4, (total / max) * 100)}%` }}
                title={title}
              >
                {focusedHead ? (
                  <span className={`flex-1 ${HEAD_SHADES[focusedIndex % HEAD_SHADES.length]}`} />
                ) : stackHeads.length > 0 ? (
                  stackHeads.map((h, idx) => (
                    <span
                      key={h.id}
                      className={HEAD_SHADES[idx % HEAD_SHADES.length]}
                      style={{
                        height: total === 0 ? 0 : `${((seriesOf(h)[i]?.wh ?? 0) / Math.max(1, total)) * 100}%`,
                      }}
                    />
                  ))
                ) : (
                  <span className="flex-1 bg-accent/60" />
                )}
              </span>
            );
          });
        })()}
      </div>
    </section>
  );
}
