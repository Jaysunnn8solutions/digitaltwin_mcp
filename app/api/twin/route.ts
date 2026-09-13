import { z, ZodError } from "zod";
import { UnknownIdError } from "@/lib/data/load";
import { LIMITS, LimitError, formatBytes } from "@/lib/layout/limits";
import { layoutSpecSchema } from "@/lib/layout/spec";
import { twinFloorSvg } from "@/lib/render/twin-floor";
import { replicate } from "@/lib/twin/replicate";
import { buildTwin } from "@/lib/twin/twin";

/** A few short runs on a small building; well inside Hobby's limit. */
export const maxDuration = 30;

const schema = z
  .object({
    layout: layoutSpecSchema,
    dc: z.enum(["dc-east", "dc-west"]).default("dc-east"),
    startWeek: z.number().int().min(1).max(52).default(36),
    days: z.number().int().min(1).max(28).default(10),
    runs: z.number().int().min(1).max(5).default(2),
    slotting: z.enum(["current", "optimized"]).default("current"),
  })
  .strict();

/**
 * Simulate an imported layout. Stateless: the spec arrives in the request,
 * the answer goes back, and nothing is kept.
 */
export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > LIMITS.specJson + 16_000) {
    return Response.json({ error: `The request is over the ${formatBytes(LIMITS.specJson)} limit for a layout spec.` }, { status: 413 });
  }
  try {
    const raw = await request.text();
    if (raw.length > LIMITS.specJson + 16_000) return Response.json({ error: `The request is over the ${formatBytes(LIMITS.specJson)} limit for a layout spec.` }, { status: 413 });
    const body = schema.parse(JSON.parse(raw));
    const ctx = await buildTwin(body.dc, body.startWeek, { layout: body.layout, slotting: body.slotting });
    const rep = replicate(ctx, body.days, body.runs);
    return Response.json(
      {
        kpis: rep.mean,
        worst: rep.worst,
        bottleneck: rep.bottleneck,
        svg: twinFloorSvg(ctx, 900),
        layout: { pickFaces: ctx.layout.pick.length, reservePositions: ctx.layout.reserve.length, pickAisles: ctx.layout.pickAisles.length, feetPerLine: ctx.slotEval.feetPerLine, bendReachShare: ctx.slotEval.bendReachShare },
        crew: ctx.workers.length,
        changes: ctx.changes,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof ZodError) return Response.json({ error: "Invalid request", issues: err.issues.slice(0, 10) }, { status: 400 });
    if (err instanceof SyntaxError) return Response.json({ error: "Body must be JSON" }, { status: 400 });
    if (err instanceof LimitError || err instanceof UnknownIdError) return Response.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
