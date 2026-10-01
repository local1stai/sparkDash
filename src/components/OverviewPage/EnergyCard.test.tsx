import { describe, expect, it, vi } from "vitest";
import { EnergyCard } from "./EnergyCard";
import { flush, render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchPowerEnergy: vi.fn(),
}));

import { fetchPowerEnergy } from "../../api/client";

const fetchEnergy = vi.mocked(fetchPowerEnergy);

function energy(): import("../../api/types").PowerEnergyResponse {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, "0")}`,
    wh: i === 29 ? 9600 : i % 3 === 0 ? 0 : 400 * (i + 1),
  }));
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: `2026-10-01T${String(i).padStart(2, "0")}`,
    wh: i === 23 ? 400 : i % 4 === 0 ? 0 : 20 * (i + 1),
  }));
  return {
    unit: "Wh",
    fleet: { today: 9600, week: 67_200, month: 288_000, all: 576_000 },
    heads: [
      {
        id: "gx10-91",
        name: "GX10 91",
        today: 4800,
        week: 33_600,
        month: 144_000,
        all: 288_000,
        daily: daily.map((d, i) => ({ ...d, wh: i === 29 ? 4800 : Math.round(d.wh * 0.5) })),
        hourly: hourly.map((h, i) => ({ ...h, wh: i === 23 ? 200 : Math.round(h.wh * 0.5) })),
      },
      {
        id: "gx10-95",
        name: "GX10 95",
        today: 4800,
        week: 33_600,
        month: 144_000,
        all: 288_000,
        daily: daily.map((d, i) => ({ ...d, wh: i === 29 ? 4800 : Math.round(d.wh * 0.5) })),
        hourly: hourly.map((h, i) => ({ ...h, wh: i === 23 ? 200 : Math.round(h.wh * 0.5) })),
      },
    ],
    daily,
    hourly,
  };
}

describe("EnergyCard", () => {
  it("shows fleet + per-head energy for the selected window", async () => {
    fetchEnergy.mockResolvedValue(energy());
    const { container } = render(<EnergyCard />);
    await flush();
    expect(container.textContent).toContain("Energy used");
    expect(container.textContent).toContain("wall-metered");
    expect(container.textContent).toContain("9.60 kWh");
    expect(container.textContent).toContain("GX10 91");
    expect(container.textContent).toContain("4.80 kWh");

    const all = [...container.querySelectorAll("button")].find((b) => b.textContent === "All");
    all?.click();
    await flush();
    expect(container.textContent).toContain("576.00 kWh");
  });

  it("head chips ladder: combined -> by-head -> solo", async () => {
    fetchEnergy.mockResolvedValue(energy());
    const { container } = render(<EnergyCard />);
    await flush();
    const chip = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("GX10 95")
    );
    const lastTitle = () => {
      const cols = [
        ...container.querySelectorAll('[aria-label*="energy used per"] > span'),
      ] as HTMLElement[];
      return cols[cols.length - 1].title;
    };

    chip?.click(); // combined -> stacked
    await flush();
    expect(lastTitle()).toContain("GX10 91:");
    expect(lastTitle()).toContain("GX10 95:");

    chip?.click(); // stacked -> solo
    await flush();
    expect(lastTitle()).toContain("GX10 95 ·");
    expect(lastTitle()).not.toContain("GX10 91:");
  });

  it("switches hourly/daily bars with the window", async () => {
    fetchEnergy.mockResolvedValue(energy());
    const { container } = render(<EnergyCard />);
    await flush();
    const bars = () => [...container.querySelectorAll('[aria-label*="energy used per"] > span')];
    expect(bars().length).toBe(24); // Day default: hourly
    const week = [...container.querySelectorAll("button")].find((b) => b.textContent === "Week");
    week?.click();
    await flush();
    expect(bars().length).toBe(30); // Week: daily
  });

  it("hides itself while no data has loaded", async () => {
    fetchEnergy.mockRejectedValue(new Error("not running"));
    const { container } = render(<EnergyCard />);
    await flush();
    expect(container.textContent).toBe("");
  });
});
