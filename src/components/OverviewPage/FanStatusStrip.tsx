import { useMemo } from "react";
import { FAN_SERIES_ID } from "../../constants";
import type { FleetFanStatus, FleetPowerStatus, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
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

/**
 * Fleet services card: the shared rack fan (FAN_STATUS_URL) and the fleet
 * power meter (POWER_METER_URL) share one panel — they describe the same
 * rack. Either half renders alone when only one daemon is configured.
 */
export function FanStatusStrip({
  fan = null,
  power = null,
  sparks = [],
}: {
  fan?: FleetFanStatus | null;
  power?: FleetPowerStatus | null;
  /** Fleet list — used to group plug watts by head/worker cluster. */
  sparks?: SparkSnapshot[];
}) {
  const series = useTimedMetricsHistory(FAN_SERIES_ID, "rpm");
  const lastAt = series.length > 0 ? series[series.length - 1].at : 0;
  const rpmTrend = useMemo(
    () => series.filter((s) => s.at >= lastAt - FAN_SPARKLINE_WINDOW_MS).map((s) => s.value),
    [series, lastAt]
  );

  const critical = fan != null && (fan.failsafe || fan.fanOk === false);
  // Controller readback is the ground truth; fall back to the last command,
  // then to the curve's target. The target is only surfaced when it disagrees
  // with what the fan is actually doing (deadband drift or a stuck send).
  const dutyNow = fan ? fan.pwmPercent ?? fan.fanPctSent ?? fan.fanPctTarget : null;
  const targetNote =
    fan && dutyNow != null && fan.fanPctTarget != null && Math.round(dutyNow) !== Math.round(fan.fanPctTarget)
      ? pct(fan.fanPctTarget)
      : null;

  const plugIds = power ? Object.keys(power.plugs) : [];
  const plugsOn = plugIds.filter((id) => power?.plugs[id]?.relayOn === true).length;
  const anyCycling = plugIds.some((id) => power?.plugs[id]?.cycling === true);

  // Per-cluster wall watts: each head plus its workers (workerHeadId), with
  // orphaned workers lumped into an "Ungrouped" bucket. Only rendered when
  // the fleet actually uses head/worker grouping.
  const clusters = useMemo(() => {
    if (!power?.online || sparks.length === 0) return [];
    const known = new Set(sparks.map((s) => s.id));
    const sum = (
      ids: string[],
      sel: (p: { watts: number | null; kwhToday: number | null; kwhMonth: number | null }) => number | null
    ): number | null => {
      const vals = ids
        .map((id) => (power.plugs[id] ? sel(power.plugs[id]) : null))
        .filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const summarize = (ids: string[], members: SparkSnapshot[]) => {
      const watts = sum(ids, (p) => p.watts);
      return {
        watts: watts != null ? Math.round(watts) : null,
        kwhToday: sum(ids, (p) => p.kwhToday),
        kwhMonth: sum(ids, (p) => p.kwhMonth),
        members: members.map(
          (m) =>
            `${m.name ?? m.id}: ${power.plugs[m.id]?.watts ?? "?"} W · ${
              power.plugs[m.id]?.kwhToday ?? "?"
            } kWh today`
        ),
      };
    };
    const groups: {
      key: string;
      name: string;
      watts: number | null;
      kwhToday: number | null;
      kwhMonth: number | null;
      members: string[];
    }[] = [];
    const orphanWorkers = sparks.filter(
      (s) => resolveSparkRole(s) === "worker" && (!s.workerHeadId || !known.has(s.workerHeadId))
    );
    for (const head of sparks.filter((s) => resolveSparkRole(s) !== "worker")) {
      const members = [
        head,
        ...sparks.filter((s) => s.workerHeadId === head.id && resolveSparkRole(s) === "worker"),
      ];
      groups.push({ key: head.id, name: head.name ?? head.id, ...summarize(members.map((m) => m.id), members) });
    }
    if (orphanWorkers.length > 0) {
      groups.push({
        key: "__ungrouped__",
        name: "Ungrouped",
        ...summarize(orphanWorkers.map((m) => m.id), orphanWorkers),
      });
    }
    const hasGrouping =
      groups.some((g) => g.key !== "__ungrouped__") && sparks.some((s) => s.workerHeadId);
    return hasGrouping ? groups : [];
  }, [power, sparks]);

  return (
    <section className="panel p-3" aria-labelledby="fleet-fan-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="fleet-fan-title"
          className="flex items-center gap-2 text-xs font-semibold text-text-strong"
        >
          {fan && (
            <>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  !fan.online || critical
                    ? "bg-danger"
                    : fan.mode === "hold"
                      ? "bg-warning"
                      : "bg-success dot-glow-success"
                }`}
                aria-hidden="true"
              />
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                {fan.mode ?? "offline"}
              </span>
            </>
          )}
          {fan ? "Fleet Fan" : "Fleet Power"}
        </h2>
        <span className="text-[10px] text-muted">
          {fan && power
            ? "Shared rack fan · wall-metered plugs"
            : fan
              ? "Shared rack fan · one channel for all units"
              : "Wall-metered at the smart plugs"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        {fan && (
          <>
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
          </>
        )}        {power && (
          <>
            <div>
              <div className="text-[10px] text-muted">Fleet power</div>
              <strong className="font-tabular text-sm">
                {power.online && power.totalWatts != null ? `${Math.round(power.totalWatts)} W` : "—"}
              </strong>
            </div>
            <div>
              <div className="text-[10px] text-muted">Today</div>
              <strong className="font-tabular text-sm">
                {power.online && power.kwhToday != null ? `${power.kwhToday.toFixed(2)} kWh` : "—"}
              </strong>
            </div>
            <div>
              <div className="text-[10px] text-muted">This month</div>
              <strong className="font-tabular text-sm">
                {power.online && power.kwhMonth != null ? `${power.kwhMonth.toFixed(2)} kWh` : "—"}
              </strong>
            </div>
            <div>
              <div className="text-[10px] text-muted">Plugs on</div>
              <strong className="font-tabular text-sm">
                {power.online ? `${plugsOn}/${plugIds.length}` : "—"}
              </strong>
            </div>
            {clusters.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {clusters.map((c) => (
                  <span
                    key={c.key}
                    title={c.members.join(" · ")}
                    className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-muted"
                  >
                    {c.name}{" "}
                    <strong className="font-tabular text-text">
                      {c.watts != null ? `${c.watts} W` : "—"}
                    </strong>
                    {c.kwhToday != null && (
                      <>
                        {" · "}
                        <strong className="font-tabular text-text">{c.kwhToday.toFixed(2)}</strong> today
                      </>
                    )}
                    {c.kwhMonth != null && (
                      <>
                        {" · "}
                        <strong className="font-tabular text-text">{c.kwhMonth.toFixed(2)}</strong> month
                      </>
                    )}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

      </div>

      {anyCycling && (
        <p className="mt-2 text-xs text-warning">A plug is power-cycling its Spark…</p>
      )}
      {power && !power.online && (
        <p className="mt-2 text-xs text-warning">
          Power meter unreachable: {power.error ?? "unknown error"}
        </p>
      )}
      {fan && fan.failsafe && (
        <p className="mt-2 text-xs text-danger">
          Failsafe engaged — fan forced to a safe duty cycle.
        </p>
      )}
      {fan && !fan.failsafe && fan.online && fan.fanOk === false && (
        <p className="mt-2 text-xs text-danger">
          Fan controller fault — the last command may not have been applied.
        </p>
      )}
      {fan && fan.online && fan.mode === "hold" && (
        <p className="mt-2 text-xs text-warning">
          Hold — keeping the last fan decision while the metrics source is unreachable.
        </p>
      )}
      {fan && !fan.online && (
        <p className="mt-2 text-xs text-warning">
          Fan daemon unreachable: {fan.error ?? "unknown error"}
        </p>
      )}
    </section>
  );
}
