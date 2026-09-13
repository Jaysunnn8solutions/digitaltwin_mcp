import type { TwinContext } from "../twin/twin";
import { floorSvg, pickHeat } from "./floor";

/** A twin's floor plan with pick faces shaded by lines per week under its slotting. */
export function twinFloorSvg(ctx: TwinContext, width = 640): string {
  const lines = new Map(ctx.frequencies.map((f) => [f.sku.id, f.linesPerWeek]));
  return floorSvg(ctx.layout.spec, { width, layout: ctx.layout, heat: pickHeat(ctx.slotting, lines), heatLabel: "lines/week" });
}
