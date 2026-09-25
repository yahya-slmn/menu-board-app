// Supabase Edge Function: fdc-food
//
// USDA FoodData Central (FDC) proxy for the Nutrition Review feature. Same trust boundary as the
// Anthropic / OpenAI functions: the FDC API key lives here as a Supabase secret and never ships
// inside the Electron app; only a signed-in user's session can call it (platform JWT verification
// plus the role check in isSignedInUser). No AI here -- every number is USDA's own.
//
// Two actions, both POST { action, ... }:
//   search  { query, dataTypes?, pageSize? } -> { foods: [candidate], totalHits, rateLimitRemaining }
//   details { fdcIds: [n...] }              -> { foods: [food], rateLimitRemaining }
// A candidate / food carries its nutrients as [{ id, name, unit, value }] per 100 g (FDC's own
// nutrient ids: 1008 Energy kcal, 1003 Protein, ...); picking the core panel out of that list is
// the app's job (lib/nutritionPanel.js), so this function stays a thin, trimmed pass-through.
//
// FDC's limit is 1,000 requests / hour / key; above it FDC answers 429 and this returns a readable
// error. `rateLimitRemaining` is FDC's own X-RateLimit-Remaining header, passed on for the UI.
//
// Deploy: supabase functions deploy fdc-food --use-api
// Requires the FDC_API_KEY secret (`supabase secrets set FDC_API_KEY=...`).

const FDC_API_KEY = Deno.env.get("FDC_API_KEY");
const FDC_BASE = "https://api.nal.usda.gov/fdc/v1";

// Branded is deliberately not the default (commercial products, very noisy for school dishes), but
// the caller may ask for it. "Experimental" is never allowed.
const ALLOWED_DATA_TYPES = ["Survey (FNDDS)", "SR Legacy", "Foundation", "Branded"];
const DEFAULT_DATA_TYPES = ["Survey (FNDDS)", "SR Legacy", "Foundation"];
const MAX_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 200;
const MAX_DETAIL_IDS = 20;
const FDC_TIMEOUT_MS = 20_000;

interface Nutrient { id: number; name: string; unit: string; value: number }

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function fdcFetch(path: string, init: RequestInit = {}) {
  const url = `${FDC_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(FDC_API_KEY!)}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(FDC_TIMEOUT_MS),
  });
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const rateLimitRemaining = remaining == null ? null : Number(remaining);
  if (res.status === 429) {
    throw new Error("USDA FoodData Central's limit of 1,000 requests an hour is used up -- try again within the hour.");
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`USDA FoodData Central answered ${res.status}: ${text}`);
  }
  return { json: await res.json(), rateLimitRemaining };
}

// Search results: nutrients are { nutrientId, nutrientName, unitName, value } per 100 g.
function searchNutrients(list: any[] = []): Nutrient[] {
  return list
    .filter((n) => typeof n?.nutrientId === "number" && typeof n?.value === "number")
    .map((n) => ({ id: n.nutrientId, name: n.nutrientName, unit: n.unitName, value: n.value }));
}

// Details: nutrients are { nutrient: { id, name, unitName }, amount } per 100 g.
function detailNutrients(list: any[] = []): Nutrient[] {
  return list
    .filter((n) => typeof n?.nutrient?.id === "number" && typeof n?.amount === "number")
    .map((n) => ({ id: n.nutrient.id, name: n.nutrient.name, unit: n.nutrient.unitName, value: n.amount }));
}

function trimCandidate(f: any) {
  return {
    fdcId: f.fdcId,
    dataType: f.dataType,
    description: f.description,
    foodCategory: f.foodCategory ?? null,
    // FNDDS: 8-digit food code, stable across releases (fdcIds are not). SR Legacy: NDB number.
    foodCode: f.foodCode ?? (f.ndbNumber != null ? String(f.ndbNumber) : null),
    additionalDescriptions: f.additionalDescriptions ?? null,
    publishedDate: f.publishedDate ?? null,
    brandOwner: f.brandOwner ?? null,
    nutrients: searchNutrients(f.foodNutrients),
  };
}

function trimFood(f: any) {
  return {
    fdcId: f.fdcId,
    dataType: f.dataType,
    description: f.description,
    foodCategory: f.wweiaFoodCategory?.wweiaFoodCategoryDescription ?? f.foodCategory?.description ?? null,
    foodCode: f.foodCode ?? (f.ndbNumber != null ? String(f.ndbNumber) : null),
    publicationDate: f.publicationDate ?? null,
    nutrients: detailNutrients(f.foodNutrients),
    portions: (f.foodPortions || []).map((p: any) => ({
      description: p.portionDescription || [p.amount, p.modifier].filter(Boolean).join(" ") || null,
      gramWeight: p.gramWeight ?? null,
    })),
  };
}

// The platform has already verified the JWT's signature; this only reads its role. The app's public
// anon key is itself a valid JWT, so without this anyone holding it could spend the shared hourly
// USDA quota. Only a signed-in user's session (role "authenticated") gets through.
function isSignedInUser(req: Request): boolean {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "authenticated";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ success: false, error: "Method not allowed" });
  if (!isSignedInUser(req)) return ok({ success: false, error: "Sign in to search USDA FoodData Central" });
  if (!FDC_API_KEY) return ok({ success: false, error: "Server misconfigured: FDC_API_KEY not set" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  try {
    if (body?.action === "search") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return ok({ success: false, error: "Missing search query" });
      if (query.length > MAX_QUERY_LENGTH) return ok({ success: false, error: `Search query exceeds ${MAX_QUERY_LENGTH} characters` });
      const dataTypes = Array.isArray(body.dataTypes) && body.dataTypes.length ? body.dataTypes : DEFAULT_DATA_TYPES;
      if (!dataTypes.every((t: unknown) => typeof t === "string" && ALLOWED_DATA_TYPES.includes(t))) {
        return ok({ success: false, error: `dataTypes must be among: ${ALLOWED_DATA_TYPES.join(", ")}` });
      }
      const pageSize = Math.min(Math.max(Number(body.pageSize) || 10, 1), MAX_PAGE_SIZE);
      const { json, rateLimitRemaining } = await fdcFetch("/foods/search", {
        method: "POST",
        body: JSON.stringify({ query, dataType: dataTypes, pageSize, pageNumber: 1 }),
      });
      return ok({
        success: true,
        data: { foods: (json.foods || []).map(trimCandidate), totalHits: json.totalHits ?? 0, rateLimitRemaining },
      });
    }

    if (body?.action === "details") {
      const ids = body.fdcIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DETAIL_IDS || !ids.every((n: unknown) => Number.isInteger(n) && (n as number) > 0)) {
        return ok({ success: false, error: `fdcIds must be 1-${MAX_DETAIL_IDS} positive integers` });
      }
      const { json, rateLimitRemaining } = await fdcFetch("/foods", {
        method: "POST",
        body: JSON.stringify({ fdcIds: ids, format: "full" }),
      });
      return ok({ success: true, data: { foods: (json || []).map(trimFood), rateLimitRemaining } });
    }

    return ok({ success: false, error: "Unknown action (expected search or details)" });
  } catch (err) {
    console.error("[fdc-food] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
