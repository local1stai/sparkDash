import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetStore,
  getMetricHistorySamples,
  ingestFanSnapshot,
  ingestSnapshots,
} from "./metricsStore";
import { makeSpark } from "../testing/fixtures";
import type { FleetFanStatus } from "../api/types";

describe("metricsStore timestamp contract", () => {
  beforeEach(_resetStore);

  it.each([1_000, 2_000, 5_000])("preserves a %sms source cadence", (interval) => {
    const spark = makeSpark();
    ingestSnapshots([spark], 10_000);
    spark.metrics.gpu!.usage = 50;
    ingestSnapshots([spark], 10_000 + interval);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 10_000, value: 42 },
      { at: 10_000 + interval, value: 50 },
    ]);
  });

  it("replaces duplicate frames and retains real disconnect gaps", () => {
    const spark = makeSpark();
    ingestSnapshots([spark], 1_000);
    spark.metrics.gpu!.usage = 55;
    ingestSnapshots([spark], 1_000);
    spark.metrics.gpu!.usage = 60;
    ingestSnapshots([spark], 61_000);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 1_000, value: 55 },
      { at: 61_000, value: 60 },
    ]);
  });

  it("ignores out-of-order frames instead of rewinding chart time", () => {
    const spark = makeSpark();
    ingestSnapshots([spark], 5_000);
    spark.metrics.gpu!.usage = 99;
    ingestSnapshots([spark], 4_000);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 5_000, value: 42 },
    ]);
  });
});

function makeFan(overrides: Partial<FleetFanStatus> = {}): FleetFanStatus {
  return {
    online: true,
    mode: "auto",
    failsafe: false,
    fanOk: true,
    sparksOnline: 8,
    fanPctTarget: 35,
    fanPctSent: 37,
    rpm: 1200,
    pwmPercent: 37,
    ts: "2026-09-25 09:38:47",
    cycle: 11995,
    fetchedAt: 0,
    error: null,
    ...overrides,
  };
}

describe("ingestFanSnapshot", () => {
  beforeEach(_resetStore);

  it("appends only online, non-zero RPM samples under the reserved fan id", () => {
    ingestFanSnapshot(makeFan({ rpm: 1200 }), 1_000);
    ingestFanSnapshot(makeFan({ rpm: 0 }), 2_000); // parked fan — no fake floor
    ingestFanSnapshot(makeFan({ online: false, rpm: 1200 }), 3_000);
    ingestFanSnapshot(null, 4_000);
    expect(getMetricHistorySamples("__fan__", "rpm")).toEqual([{ at: 1_000, value: 1200 }]);
  });
});
