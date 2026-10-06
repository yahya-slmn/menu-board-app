// Sign-in for scripts that call Edge Functions directly with fetch (the prompt trials). Since 2026-10-06 every
// AI function refuses a call without a signed-in user (supabase/functions/_shared/requireUser.ts): the public
// publishable key alone gets a 401. So these scripts sign in first and send the SESSION token.
//   const { signIn, functionHeaders } = require('./script-auth');
//   await signIn();                                    // asks for the Menu Board login (run it in a normal Terminal)
//   fetch(url, { method: 'POST', headers: await functionHeaders(), body })
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
function loginDomain() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  return src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/)[1];
}
async function signIn() {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (error) { console.error('Sign-in failed:', error.message); process.exit(1); }
  return id;
}
// Headers for a direct function call. getSession() renews the token when it has expired, so a trial that runs for
// more than an hour keeps working.
async function functionHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  if (!token) throw new Error('Not signed in: call signIn() first');
  return { 'Content-Type': 'application/json', apikey: supabase.supabaseKey, Authorization: `Bearer ${token}` };
}

module.exports = { supabase, ask, signIn, functionHeaders };
