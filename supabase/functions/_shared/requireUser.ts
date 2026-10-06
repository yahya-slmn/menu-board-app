// Shared sign-in check for every Edge Function that spends money (AI calls, image generation). Added 2026-10-06.
//
// The platform's JWT check (verify_jwt) lets the app's PUBLIC publishable key through, so on its own anyone holding the
// key (it ships inside the app) could call these functions without logging in. Each function therefore calls
// requireUser(req) FIRST, before reading the body or touching an API key:
//
//   const denied = await requireUser(req);
//   if (denied) return denied;
//
// It reads `Authorization: Bearer <token>` and asks this project's Auth server who the token belongs to
// (auth.getUser). No token, an API key instead of a session, an expired / revoked session or any error -> 401. If the
// Auth server can't be reached the call is still refused (503): this check never lets a call through on a failure.
//
// The app's signed-in client (lib/supabaseClient.js) sends the session token on every functions.invoke call.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// null = a signed-in user; otherwise the Response to send back as it is.
export async function requireUser(req: Request): Promise<Response | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // No session, or an API key (sb_publishable_ / sb_secret_) where a session token should be.
  if (!token || token.startsWith("sb_")) return deny(401, "Sign in required");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return deny(503, "Server misconfigured: can't check the sign-in");

  try {
    const auth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await auth.auth.getUser(token);
    if (error) {
      // A 5xx (or no status: the request itself failed) means Auth couldn't answer, not that the token is bad.
      const status = (error as { status?: number }).status;
      if (!status || status >= 500) return deny(503, "Couldn't check the sign-in, please try again");
      return deny(401, "Sign in required");
    }
    if (!data?.user) return deny(401, "Sign in required");
    return null;
  } catch {
    return deny(503, "Couldn't check the sign-in, please try again");
  }
}
