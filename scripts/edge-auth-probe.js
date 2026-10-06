#!/usr/bin/env node
// Edge Function sign-in probe (2026-10-06): does each function refuse a call without a signed-in user, and still work
// for one? Every call sends an EMPTY body ({}), so a function that lets the call in stops at its own first input check
// ("Missing items array" ...) -- no AI call can run and nothing is written.
//
//   cd ~/menu-board && node scripts/edge-auth-probe.js                       # all of them; asks for your login
//   cd ~/menu-board && node scripts/edge-auth-probe.js estimate-density      # just these
//   cd ~/menu-board && node scripts/edge-auth-probe.js --no-login            # only the three calls that need no login
//
// Per function:            expected
//   no credentials          401  (the platform's own check)
//   publishable key only    401  (the shared requireUser check; before 2026-10-06 this got in)
//   forged token            401  (an unsigned token that only CLAIMS to be a signed-in user)
//   your real session       200 with the function's own "Missing ..." message = past the check, stopped before any AI
// Functions deleted on purpose are checked to answer 404. Prints PASS / FAIL; writes nothing.
const { supabase, signIn } = require('./script-auth');

const FUNCTIONS = ['extract-recipe', 'translate-recipe', 'estimate-calories', 'estimate-am-snack-style', 'suggest-dish-ingredients',
  'generate-dish-recipes', 'extract-menu-dishes', 'generate-dish-image', 'generate-menu-dishes', 'estimate-staff-main-attributes',
  'estimate-density'];
const DELETED = ['allergens-from-ingredients', 'generate-dough-shape-image'];

const args = process.argv.slice(2);
const noLogin = args.includes('--no-login');
const picked = args.filter((a) => !a.startsWith('--'));
const unknown = picked.filter((f) => !FUNCTIONS.includes(f) && !DELETED.includes(f));
if (unknown.length) { console.error(`Unknown function(s): ${unknown.join(', ')}`); process.exit(2); }
const live = picked.length ? picked.filter((f) => FUNCTIONS.includes(f)) : FUNCTIONS;
const gone = picked.length ? picked.filter((f) => DELETED.includes(f)) : DELETED;

const KEY = supabase.supabaseKey;
const URL = `${supabase.supabaseUrl}/functions/v1`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FORGED = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'authenticated', sub: '00000000-0000-0000-0000-000000000000',
  aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${'x'.repeat(43)}`;

async function call(slug, headers) {
  try {
    const res = await fetch(`${URL}/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}', signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let message = text;
    try { const j = JSON.parse(text); message = j.error || j.message || j.msg || text; } catch { /* not JSON */ }
    return { status: res.status, message: String(message).slice(0, 70) };
  } catch (e) {
    return { status: 'ERR', message: e.message };
  }
}
const isSignInRefusal = (m) => /sign in required/i.test(m);

(async () => {
  let session = null;
  if (!noLogin) {
    await signIn();
    const { data } = await supabase.auth.getSession();
    session = data.session && data.session.access_token;
  }
  const rows = [];
  let failures = 0;
  const judge = (ok) => { if (!ok) failures++; return ok ? 'ok' : 'FAIL'; };
  for (const slug of live) {
    const none = await call(slug, {});
    const pub = await call(slug, { apikey: KEY, Authorization: `Bearer ${KEY}` });
    const forged = await call(slug, { apikey: KEY, Authorization: `Bearer ${FORGED}` });
    const row = [slug,
      `${none.status} ${judge(none.status === 401)}`,
      `${pub.status} ${judge(pub.status === 401)}`,
      `${forged.status} ${judge(forged.status === 401)}`];
    let note = pub.status === 401 ? '' : `publishable: "${pub.message}"`;
    if (session) {
      const me = await call(slug, { apikey: KEY, Authorization: `Bearer ${session}` });
      row.push(`${me.status} ${judge(me.status === 200 && !isSignInRefusal(me.message))}`);
      note = note || `signed in: "${me.message}"`;
    } else row.push('(skipped)');
    row.push(note);
    rows.push(row);
  }
  for (const slug of gone) {
    const r = await call(slug, { apikey: KEY, Authorization: `Bearer ${KEY}` });
    rows.push([slug, '', `${r.status} ${judge(r.status === 404)}`, '', '', 'deleted on purpose: expected 404']);
  }
  const head = ['function', 'no credentials', 'publishable key', 'forged token', 'signed in', 'note'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(width[i]))).join('  ');
  console.log(`\n${fmt(head)}\n${width.map((w) => '-'.repeat(w)).join('  ')}`);
  rows.forEach((r) => console.log(fmt(r)));
  console.log(failures ? `\nFAIL -- ${failures} call(s) not as expected.` : `\nPASS${noLogin ? ' (the signed-in call was skipped: --no-login)' : ''}.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
