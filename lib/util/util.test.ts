import { describe, expect, it } from "vitest";
import { MinHeap } from "./heap";
import { mean, normalQuantile, poisson, quantile, seededRandom, substream } from "./random";

describe("MinHeap", () => {
  it("pops in key order and first-in first-out on ties", () => {
    const h = new MinHeap<string>();
    h.push(5, "e");
    h.push(1, "a1");
    h.push(3, "c");
    h.push(1, "a2");
    h.push(1, "a3");
    const out: string[] = [];
    while (h.size) out.push(h.pop()!.value);
    expect(out).toEqual(["a1", "a2", "a3", "c", "e"]);
  });
});

describe("random", () => {
  it("is reproducible for a seed and independent across substreams", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(substream(7, "x")()).not.toEqual(substream(7, "y")());
  });

  it("draws Poisson with the right mean on both sides of the normal switch", () => {
    const rng = seededRandom(1);
    for (const lambda of [0.3, 4, 60]) {
      const xs = Array.from({ length: 20000 }, () => poisson(rng, lambda));
      expect(mean(xs)).toBeCloseTo(lambda, lambda < 1 ? 1 : 0);
    }
  });

  it("inverts the normal CDF", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 4);
  });

  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.9)).toBe(0);
  });
});
