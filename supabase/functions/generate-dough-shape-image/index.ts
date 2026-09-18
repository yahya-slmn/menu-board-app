// Supabase Edge Function: generate-dough-shape-image
//
// Backs Recipe on Fire's pivot away from a 3D parametric render toward real, AI-generated
// reference photos used as draggable 2D sprites (the chef explicitly rejected the 3D/game-like
// look). Given a dough shape's name and which stage it's for (raw/baked/cut), generates ONE
// isolated, top-down reference photo via OpenAI's Images API -- same provider/model/quality as
// generate-dish-image, but a DELIBERATELY DIFFERENT prompt and framing, not a reuse of that
// function's prompt: that one is tuned for a plated, 45-degree finished-dish shot meant to be
// looked at as a photo in its own right; this one needs a single isolated object, shot from
// directly above, on a transparent background, specifically so main.js can composite it as a
// sprite on top of a drawn tray background without a mismatched rectangle of table/plate showing
// around it. Same "network call only, main.js does the DB/storage work" split every other Edge
// Function wrapper in this app follows -- this function never touches Supabase Storage itself.
//
// Same OpenAI trust boundary as generate-dish-image (its own OPENAI_API_KEY secret, this app's
// only OpenAI-backed calls) -- no nut/sesame restriction language here, unlike that function:
// a dough shape is a generic reference (a round ball, a baguette), not tied to any specific
// dish's ingredient list, so there is nothing dish-specific to restrict.
//
// One image per call, same reasoning as generate-dish-image (OpenAI's Images API has no
// multi-prompt batch primitive) -- main.js fires several of these concurrently (Promise.allSettled)
// to build a shape's full set of stage x variation images without waiting on each one
// sequentially (a single call is a real, measured ~138s).
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the OPENAI_API_KEY secret to be set (`supabase secrets set OPENAI_API_KEY=...`).

import OpenAI from "npm:openai";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const MAX_NAME_LENGTH = 100;
const VALID_STAGES = ["raw", "baked", "cut"];

interface RequestBody {
  shapeName?: string;
  stage?: string;
  sizeCm?: number;
}

// Per-stage description of what the photo should actually show -- the shape/texture/color a real
// piece of dough has at that point, not just a generic "food photo" instruction. "cut" shows a
// PORTIONED/SLICED piece of the BAKED version (a cross-section or a cut portion sitting alone),
// since that's what a chef cutting baked dough into portions actually produces.
const STAGE_DESCRIPTIONS: Record<string, string> = {
  raw: "in its RAW, unbaked state -- pale, soft, matte dough surface, visible light dusting of flour, no browning or crust of any kind, exactly as it would look freshly shaped and placed on a tray before going into an oven.",
  baked: "in its FULLY BAKED state -- a real golden-brown, appetizingly baked crust with natural surface texture (cracks, blisters, flour dusting where appropriate), realistic oven-baked color variation, exactly as it would look fresh out of the oven.",
  cut: "as a single CUT/PORTIONED piece of the fully baked version -- sliced or divided so the cut face/cross-section is at least partly visible (crumb texture, any visible internal structure), showing what one finished, portioned piece of this looks like, not the whole uncut piece.",
};

// Deliberately NOT the same composition as generate-dish-image's own plated/45-degree-angle food
// photo -- this needs to composite cleanly as a draggable sprite: a SINGLE isolated piece, shot
// directly from above (a true top-down/bird's-eye view, not an angle), on nothing but a
// transparent background (no plate, no table, no props, no shadow-casting surface) so it can be
// scaled and placed anywhere on a drawn tray without a mismatched background rectangle showing
// around it. Real photography, explicitly not a render/illustration, for the same reason the
// chef rejected the 3D parametric look in the first place.
function buildPrompt(shapeName: string, stage: string): string {
  const stageDescription = STAGE_DESCRIPTIONS[stage];
  return `A real, high-resolution photograph of a single "${shapeName}" bread/dough piece, ${stageDescription}

Composition requirements, all mandatory: shoot from DIRECTLY ABOVE (a true top-down/bird's-eye view looking straight down at the piece, not an angled shot), showing exactly ONE isolated piece centered in frame with nothing else in the shot -- no plate, no tray, no table surface, no other food, no hands, no utensils, no text, no logos. The background must be fully transparent/empty, not a solid color surface, so this piece can be composited as a standalone cutout image. This must look like a real photograph of a real, physical piece of dough/bread -- natural, slightly irregular hand-shaped texture and asymmetry, not a computer-generated render, illustration, cartoon, or perfectly symmetrical/synthetic-looking object.`;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return ok({ success: false, error: "Method not allowed" });
  }
  if (!OPENAI_API_KEY) {
    return ok({ success: false, error: "Server misconfigured: OPENAI_API_KEY not set" });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const shapeName = (body.shapeName || "").trim();
  if (!shapeName) {
    return ok({ success: false, error: "Missing shapeName" });
  }
  if (shapeName.length > MAX_NAME_LENGTH) {
    return ok({ success: false, error: `shapeName exceeds ${MAX_NAME_LENGTH} characters` });
  }
  const stage = (body.stage || "").trim();
  if (!VALID_STAGES.includes(stage)) {
    return ok({ success: false, error: `stage must be one of: ${VALID_STAGES.join(", ")}` });
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await client.images.generate({
      model: "gpt-image-2",
      prompt: buildPrompt(shapeName, stage),
      size: "1024x1024",
      quality: "high",
      // Transparent background is what lets this composite as a sprite with no mismatched
      // rectangle around it -- requires png/webp output, which this already uses.
      background: "transparent",
      output_format: "png",
      n: 1,
    });

    const image = response.data?.[0];
    if (!image?.b64_json) {
      return ok({ success: false, error: "No image data returned" });
    }
    return ok({ success: true, data: { b64: image.b64_json, ext: "png" } });
  } catch (err) {
    console.error("[generate-dough-shape-image] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
