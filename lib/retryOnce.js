// Run an async step; if it fails with one of the given error codes, wait and run it ONE more time. Any other error, or
// a second failure, is thrown unchanged -- the caller shows it exactly as before.
//
// Used at sign-in (2026-10-06): right after signInWithPassword, loading the reference lists sometimes fails with
// PGRST303 "JWT issued at future" -- the database's clock is a moment behind the Auth server that just issued the
// token (both are Supabase's servers; the Mac's clock plays no part). A second later the same token is accepted.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryOnce(fn, { codes = [], delayMs = 1000, sleep = wait, onRetry } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!err || !codes.includes(err.code)) throw err;
    if (onRetry) onRetry(err);
    await sleep(delayMs);
    return fn();
  }
}

module.exports = { retryOnce };
