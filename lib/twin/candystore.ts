/**
 * The link to candystore_mcp. Its market model decides how many retail dollars
 * of each candy category every store sells and which center supplies it; this
 * twin turns those dollars into pallets, lines, labor and trucks.
 *
 * The committed data/network.json is a snapshot of the baseline, refreshed by
 * `npm run pipeline`. Tools that take a candystore scenario (stores added or
 * closed) call the live API instead, so the twin can answer "what does that
 * expansion do to the Norcross floor" without a redeploy.
 */

import type { Network, NetworkDc, NetworkStore } from "./types";

export const CANDYSTORE_URL = process.env.CANDYSTORE_URL || "https://candystore-mcp.vercel.app";

export interface CandystoreScenario {
  add?: Array<{ type: "general" | "specialty"; lon: number; lat: number; size?: number; segments?: string[]; name?: string; dc?: string }>;
  remove?: string[];
}

interface StaticResponse {
  stores: Array<{ id: string; name: string; type: "general" | "specialty"; lon: number; lat: number; segments: string[]; dc?: string }>;
  dcs: Array<{ id: string; name: string; lon: number; lat: number; capacity: Record<string, number> }>;
  manifest: { segments: Array<{ id: string; label: string }> };
}

interface MarketResponse {
  stores: Array<{ id: string; name: string; type: "general" | "specialty"; dc: string; segments: string[]; revenueBy: Record<string, number> }>;
  dcs: Array<{ id: string; name: string; weeklyDemand: Record<string, number>; capacity: Record<string, number>; stores: string[] }>;
}

async function getJson<T>(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`candystore ${new URL(url).pathname} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Combine candystore's static inputs and a market run into the twin's network shape. */
export function toNetwork(stat: StaticResponse, market: MarketResponse, scenario: CandystoreScenario, source: string): Network {
  const staticStores = new Map(stat.stores.map((s) => [s.id, s]));
  const staticDcs = new Map(stat.dcs.map((d) => [d.id, d]));

  const stores: NetworkStore[] = market.stores.map((s) => {
    // Proposed stores come back as new-<index> with no coordinates, so take
    // them from the scenario that created them.
    const known = staticStores.get(s.id);
    const added = s.id.startsWith("new-") ? scenario.add?.[Number(s.id.slice(4))] : undefined;
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      dc: s.dc,
      lon: known?.lon ?? added?.lon ?? 0,
      lat: known?.lat ?? added?.lat ?? 0,
      segments: s.segments,
      revenueBy: Object.fromEntries(Object.entries(s.revenueBy).map(([k, v]) => [k, round(v)])),
    };
  });

  const dcs: NetworkDc[] = market.dcs.map((d) => {
    const st = staticDcs.get(d.id);
    return {
      id: d.id,
      name: d.name,
      lon: st?.lon ?? 0,
      lat: st?.lat ?? 0,
      capacity: d.capacity,
      weeklyDemand: Object.fromEntries(Object.entries(d.weeklyDemand).map(([k, v]) => [k, round(v)])),
      stores: d.stores,
    };
  });

  return {
    source,
    fetchedAt: new Date().toISOString(),
    scenario: scenario as Record<string, unknown>,
    dcs,
    stores,
    segments: stat.manifest.segments,
  };
}

/**
 * Fetch the network for a candystore scenario from the live API. Throws with
 * candystore's own message when it rejects the scenario (an unknown store id,
 * a location outside the region), so the tool can pass that on.
 */
export async function fetchNetwork(scenario: CandystoreScenario = {}, baseUrl = CANDYSTORE_URL, timeoutMs = 20_000): Promise<Network> {
  const [stat, market] = await Promise.all([
    getJson<StaticResponse>(`${baseUrl}/api/static`, undefined, timeoutMs),
    getJson<MarketResponse>(
      `${baseUrl}/api/market`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ add: scenario.add ?? [], remove: scenario.remove ?? [] }) },
      timeoutMs
    ),
  ]);
  return toNetwork(stat, market, scenario, `${baseUrl}/api/market`);
}
