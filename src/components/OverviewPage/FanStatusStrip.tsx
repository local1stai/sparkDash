import { useMemo } from "react";
import { FAN_SERIES_ID } from "../../constants";
import type { FleetFanStatus } from "../../api/types";
import { useTimedMetricsHistory } from "../../hooks/metricsStore";
import { Sparkline } from "../ui/Sparkline";

/**
 * Fan RPM trend window. The default sparkline tail (30 samples) is tuned for
 * the 2 s WS poll; the fan daemon polls every ~5 s, so that would show under
 * three minutes. Window the timed series instead — 30 minutes of trend.
 */
const FAN_SPARKLINE_WINDOW_MS = 30 * 60_000;

function num(value: number | null): string {
  return value == null ? "—" : String(Math.round(value));
}

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

/** Overview strip for a shared rack fan driven by an external fan daemon. */
export function FanStatusStrip({ fan }: { fan: FleetFanStatus }) {
  const series = useTimedMetricsHistory(FAN_SERIES_ID, "rpm");
  const lastAt = series.length > 0 ? series[series.length - 1].at : 0;
  const rpmTrend = useMemo(
    () => series.filter((s) => s.at >= lastAt - FAN_SPARKLINE_WINDOW_MS).map((s) => s.value),
    [series, lastAt]
  );
  const critical = fan.failsafe || fan.fanOk === false;
  // Controller readback is the ground truth; fall back to the last command,
  // then to the curve's target. The target is only surfaced when it disagrees
  // with what the fan is actually doing (deadband drift or a stuck send).
  const dutyNow = fan.pwmPercent ?? fan.fanPctSent ?? fan.fanPctTarget;
  const targetNote =
    dutyNow != null && fan.fanPctTarget != null && Math.round(dutyNow) !== Math.round(fan.fanPctTarget)
      ? pct(fan.fanPctTarget)
      : null;
  const dotClass =
    !fan.online || critical
      ? "bg-danger"
      : fan.mode === "hold"
        ? "bg-warning"
        : "bg-success dot-glow-success";
  const badgeTone =
    fan.mode === "FAILSAFE"
      ? "bg-danger/15 text-danger"
      : fan.mode === "hold"
        ? "bg-warning/15 text-warning"
        : "bg-accent/15 text-accent";

  return (
    <section className="panel p-3" aria-labelledby="fleet-fan-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="fleet-fan-title"
          className="flex items-center gap-2 text-xs font-semibold text-text-strong"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
          Fleet Fan
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeTone}`}
          >
            {fan.mode ?? "offline"}
          </span>
        </h2>
        <span className="text-[10px] text-muted">Shared rack fan · one channel for all units</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <div>
            <div className="text-[10px] text-muted">RPM</div>
            <strong className="font-tabular text-sm">{num(fan.rpm)}</strong>
          </div>
          <Sparkline data={rpmTrend} width={160} height={28} />
        </div>
        <div>
          <div className="text-[10px] text-muted">Duty</div>
          <strong className="font-tabular text-sm">{pct(dutyNow)}</strong>
          {targetNote != null && (
            <span className="ml-1 text-[10px] text-muted">(target {targetNote})</span>
          )}
        </div>
      </div>
      {fan.failsafe && (
        <p className="mt-2 text-xs text-danger">
          Failsafe engaged — fan forced to a safe duty cycle.
        </p>
      )}
      {!fan.failsafe && fan.online && fan.fanOk === false && (
        <p className="mt-2 text-xs text-danger">
          Fan controller fault — the last command may not have been applied.
        </p>
      )}
      {fan.online && fan.mode === "hold" && (
        <p className="mt-2 text-xs text-warning">
          Hold — keeping the last fan decision while the metrics source is unreachable.
        </p>
      )}
      {!fan.online && (
        <p className="mt-2 text-xs text-warning">
          Fan daemon unreachable: {fan.error ?? "unknown error"}
        </p>
      )}
    </section>
  );
}
