import { describe, expect, it, vi } from "vitest";
import { TokenCard } from "./TokenCard";
import { flush, render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchTokens: vi.fn(),
}));

import { fetchTokens } from "../../api/client";

const fetchTok = vi.mocked(fetchTokens);

function tokens(): import("../../api/types").TokensResponse {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    tokens: i === 29 ? 1_500_000 : i % 3 === 0 ? 0 : 100_000 * (i + 1),
  }));
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: `2026-09-29T${String(i).padStart(2, "0")}`,
    tokens: i === 23 ? 1_500_000 : i % 4 === 0 ? 0 : 10_000 * (i + 1),
  }));
  return {
    fleet: { today: 1_500_000, week: 9_000_000, month: 40_000_000, all: 100_000_000 },
    heads: [
      {
        id: "gx10-91",
        name: "GX10 91",
        today: 1_000_000,
        week: 6_000_000,
        month: 25_000_000,
        all: 60_000_000,
        daily: daily.map((d, i) => ({ ...d, tokens: i === 29 ? 1_000_000 : Math.round(d.tokens * 0.6) })),
        hourly: hourly.map((h, i) => ({ ...h, tokens: i === 23 ? 1_000_000 : Math.round(h.tokens * 0.6) })),
      },
      {
        id: "gx10-95",
        name: "GX10 95",
        today: 500_000,
        week: 3_000_000,
        month: 15_000_000,
        all: 40_000_000,
        daily: daily.map((d, i) => ({ ...d, tokens: i === 29 ? 500_000 : Math.round(d.tokens * 0.4) })),
        hourly: hourly.map((h, i) => ({ ...h, tokens: i === 23 ? 500_000 : Math.round(h.tokens * 0.4) })),
      },
    ],
    daily,
    hourly,
  };
}

describe("TokenCard", () => {
  it("shows fleet + per-head tokens for the selected window", async () => {
    fetchTok.mockResolvedValue(tokens());
    const { container } = render(<TokenCard />);
    await flush();
    expect(container.textContent).toContain("Tokens generated");
    expect(container.textContent).toContain("1.50M");
    expect(container.textContent).toContain("GX10 91");
    expect(container.textContent).toContain("1.00M");
    expect(container.textContent).toContain("GX10 95");
    expect(container.textContent).toContain("500.0k");

    const all = [...container.querySelectorAll("button")].find((b) => b.textContent === "All");
    all?.click();
    await flush();
    expect(container.textContent).toContain("100.00M");
    expect(container.textContent).toContain("60.00M");
  });

  it("switches the chart between hourly (Day) and daily (Week) bars", async () => {
    fetchTok.mockResolvedValue(tokens());
    const { container } = render(<TokenCard />);
    await flush();
    const bars = () => [...container.querySelectorAll('[aria-label*="tokens generated per"] > span')];
    expect(bars().length).toBe(24); // Day window: 24 hourly bars by default

    const week = [...container.querySelectorAll("button")].find((b) => b.textContent === "Week");
    week?.click();
    await flush();
    expect(bars().length).toBe(30); // Week window: 30 daily bars
  });

  it("toggles stacked per-head bars and lists heads in the tooltip", async () => {
    fetchTok.mockResolvedValue(tokens());
    const { container } = render(<TokenCard />);
    await flush();
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent === "Combined");
    toggle?.click();
    await flush();
    // Each hourly column now stacks one segment per head.
    const columns = [...container.querySelectorAll('[aria-label*="tokens generated per"] > span')];
    expect(columns.length).toBe(24);
    const segments = columns.flatMap((c) => [...c.children]);
    expect(segments.length).toBe(24 * 2);
    const last = columns[columns.length - 1] as HTMLElement;
    expect(last.title).toContain("GX10 91: 1.00M");
    expect(last.title).toContain("GX10 95: 500.0k");
  });

  it("hides itself while no data has loaded", async () => {
    fetchTok.mockRejectedValue(new Error("not running"));
    const { container } = render(<TokenCard />);
    await flush();
    expect(container.textContent).toBe("");
  });
});
