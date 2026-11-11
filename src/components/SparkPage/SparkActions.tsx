import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { powerCycleSpark, shutdownSpark, wakeSpark } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { openHermesUpdateDialog } from "../../hooks/useHermesUpdateDialog";
import { EditIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface SparkActionsProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
  /** A smart plug meters this Spark (POWER_METER_URL) — show power-cycle. */
  hasPowerPlug?: boolean;
  /** Classes for the button-cluster wrapper (controls responsive visibility). */
  className?: string;
}

/**
 * Work a shutdown would interrupt, from signals already in the snapshot:
 * in-flight LLM requests, a running ComfyUI job, a Hermes update.
 */
export function shutdownWarnings(spark: SparkSnapshot, t: TFunction): string[] {
  const out: string[] = [];
  const ports = spark.llmPorts ?? [];
  (spark.metrics.llm ?? []).forEach((l, i) => {
    if (!l?.available) return;
    const running = Math.round(l.requestsRunning ?? 0);
    const waiting = Math.round(l.requestsWaiting ?? 0);
    const busy = running + waiting > 0 ? running + waiting : (l.slotsActive ?? 0) > 0 ? (l.slotsActive ?? 0) : 0;
    if (busy > 0) {
      const port = ports[i];
      out.push(t("actions.requests", { count: busy, port: port != null ? t("actions.onPort", { port }) : "" }));
    }
  });
  const job = spark.metrics.comfy?.activeJob;
  if (job) out.push(t("actions.comfyJob", { name: job.title ? `: ${job.title}` : "" }));
  if (spark.hermes?.status === "running") out.push(t("actions.hermesRunningWarning"));
  return out;
}

/**
 * Update Hermes / Edit / Power action cluster.
 * Rendered twice: inline in the SparkHeader (desktop) and as a standalone row
 * just above "Resources" on mobile. Owning the shutdown dialog + transient
 * power message here keeps the two placements in sync.
 */
export function SparkActions({ spark, onEdit, hasPowerPlug = false, className }: SparkActionsProps) {
  const { t } = useTranslation("hardware");
  const powerLabels: Record<string, string> = { shutdownOk: t("actions.shutdownOk"), shutdownError: t("actions.shutdownError"), wakeOk: t("actions.wakeOk"), wakeError: t("actions.wakeError"), cycleOk: "Power cycling — back in a few minutes", cycleError: "Power cycle failed" };
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; kind: "shutdownOk" | "shutdownError" | "wakeOk" | "wakeError" | "cycleOk" | "cycleError"; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [cycleOpen, setCycleOpen] = useState(false);

  const hermes = spark.hermes;
  const hermesRunning = hermes?.status === "running";

  function handleHermesUpdate() {
    openHermesUpdateDialog({
      sparkId: spark.id,
      sparkName: spark.name,
      currentVersion: hermes?.version ?? null,
    });
  }

  async function handleShutdown() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await shutdownSpark(spark.id);
      setPowerMsg({ text: res.message || "", kind: "shutdownOk", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "", kind: "shutdownError",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({ text: res.message || "", kind: "wakeOk", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "", kind: "wakeError",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handlePowerCycle() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await powerCycleSpark(spark.id);
      const how =
        res.mode === "graceful"
          ? "graceful shutdown"
          : online
            ? "hard cut (unreachable)"
            : "power-on";
      setPowerMsg({
        text: `Power cycling via ${how} — back in a few minutes`,
        kind: "cycleOk",
        tone: "ok",
      });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Power cycle failed",
        kind: "cycleError",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 8000);
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`sp-flash ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text || powerLabels[powerMsg.kind]}
          </span>
        )}
        {hermesRunning && (
          <span
            className="sp-flash text-warning"
            title={t("actions.hermesHelp")}
          >
            <RotateIcon className="h-3.5 w-3.5 animate-spin" />
            {t("actions.updating")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="sp-flash max-w-[16rem] truncate text-danger"
            title={hermes.error || t("actions.hermesFailed")}
          >
            {t("actions.hermesFailed")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? t("actions.hermesRun", { behind: hermes.behindCommits ? ` (${t("actions.behind", { count: hermes.behindCommits })})` : "" })
                : t("actions.hermesOpen")
            }
            className={`btn ${hermes.updateAvailable === true ? "btn--warn" : ""}`}
          >
            <RotateIcon className="h-3.5 w-3.5" />
            {t("actions.update")}
            {hermes.version && <span className="sp-btn-sub mono">v{hermes.version.replace(/^v/i, "")}</span>}
            {hermes.updateAvailable === true && (
              <span
                className="sp-badge"
                title={
                  hermes.behindCommits != null
                    ? t("actions.behind", { count: hermes.behindCommits })
                    : t("actions.available")
                }
              >
                {hermes.behindCommits != null ? hermes.behindCommits : "!"}
              </span>
            )}
          </button>
        )}
        {onEdit && (
          <button type="button" onClick={onEdit} className="btn">
            <EditIcon className="h-3.5 w-3.5" />
            {t("actions.edit")}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => setShutdownOpen(true)}
            disabled={powerLoading}
            title={t("actions.shutdownHelp")}
            className="btn btn--danger"
          >
            <PowerOffIcon className="h-3.5 w-3.5" />
            {t("actions.shutdown")}
          </button>
        ) : spark.kind === "host" ? (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title={t("actions.wakeHelp")}
            className="btn"
          >
            <PowerOnIcon className="h-3.5 w-3.5" />
            {t("actions.wake")}
          </button>
        ) : hasPowerPlug ? (
          <button
            type="button"
            onClick={() => setCycleOpen(true)}
            disabled={powerLoading}
            title="Briefly cut and restore the plug's power — the node boots automatically"
            className="btn btn--warning"
          >
            <PowerOnIcon className="h-3.5 w-3.5" />
            Power on
          </button>
        ) : (
          <span
            className="sp-muted"
            title={t("actions.noWakeHelp")}
          >
            {t("actions.noWake")}
          </span>
        )}
        {online && hasPowerPlug && (
          <button
            type="button"
            onClick={() => setCycleOpen(true)}
            disabled={powerLoading}
            title="Graceful shutdown, then power-cycle the smart plug — hard cut if the machine is unreachable"
            className="btn btn--warning"
          >
            <RotateIcon className="h-3.5 w-3.5" />
            Power cycle
          </button>
        )}
      </div>

      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={t("actions.shutdownTitle", { name: spark.name })}
        description={t("actions.shutdownConfirm", { name: spark.name })}
        confirmLabel={t("actions.shutdown")}
        warnings={shutdownWarnings(spark, t)}
      />

      <ConfirmShutdownDialog
        open={cycleOpen}
        onClose={() => setCycleOpen(false)}
        onConfirm={handlePowerCycle}
        requirePhrase={null}
        title={online ? `Power cycle ${spark.name}` : `Power on ${spark.name}`}
        description={
          online
            ? `Reboot ${spark.name} through its smart plug? It shuts down gracefully first, then the plug cuts power for ~10 s and the node boots again. Anything unsaved or running is lost if the machine is hung and gets the hard cut.`
            : `${spark.name} is offline. The plug briefly cuts and restores power (~10 s) and the node boots automatically.`
        }
        confirmLabel={online ? "Power cycle" : "Power on"}
      />
    </>
  );
}