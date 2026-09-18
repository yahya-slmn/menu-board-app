// Pure(ish) orchestration for the Dough Shapes catalog -- pulled out of main.js's IPC handler so
// the exact same real save path (generate 9 photos, upload, insert dough_shapes +
// dough_shape_photos, all-or-nothing) is reachable both from the app's own "Add Dough Shape"
// button AND from a direct Node call, without maintaining two copies of this logic. `onProgress`/
// `isCancelled` replace the IPC handler's own e.sender.send/token-comparison so this has no
// Electron dependency at all -- same "pure helper, main.js orchestrates" split as
// lib/recipeGenerator.js.
const { supabase, supaFail } = require('./supabaseClient');
const { generateDoughShapeImage } = require('./generateDoughShapeImage');

const DOUGH_SHAPE_STAGES = ['raw', 'baked', 'cut'];
const DOUGH_SHAPE_VARIATIONS_PER_STAGE = 3;
const DOUGH_SHAPE_PHOTOS_BUCKET = 'dough-shape-photos';

async function uploadDoughShapePhoto(base64, ext) {
  const path = `${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage.from(DOUGH_SHAPE_PHOTOS_BUCKET).upload(path, buffer, { contentType });
  if (error) throw supaFail('uploadDoughShapePhoto', error);
  return path;
}

async function deleteDoughShapePhotoFile(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(DOUGH_SHAPE_PHOTOS_BUCKET).remove([path]);
  if (error) console.error('[supabase] deleteDoughShapePhotoFile failed (non-fatal):', error.message);
}

// Real bug, found by actually running this at full 9-way concurrency, not a hypothetical: OpenAI
// rate-limits gpt-image-2 at 5 requests/minute for this account, and firing all 9 stage/variation
// calls at the same instant blew straight through that (confirmed: "Limit 5, Used 5, Requested 1"
// on the 6th simultaneous call). A concurrency cap alone doesn't fully fix it either -- each call
// itself takes ~140-150s, so even a modest cap can still stack multiple calls' STARTS within one
// rolling minute -- so this combines a cap with retry-on-429 (a fixed backoff, not exponential:
// the error message itself already reports a short "try again in Ns" wait, so a short fixed delay
// converges fast without the long tail exponential backoff would add for an already-slow call).
const IMAGE_GEN_CONCURRENCY = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 20_000;
const RATE_LIMIT_MAX_RETRIES = 4;

function isRateLimitError(err) {
  return /rate limit/i.test(err?.message || '');
}

async function generateDoughShapeImageWithRetry(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateDoughShapeImage(args);
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= RATE_LIMIT_MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
    }
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once, returning results in the same
// settled shape Promise.allSettled would (never throws itself) -- a small hand-rolled pool since
// nothing in this app already pulls in a concurrency-limiting library for one call site.
async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { status: 'rejected', reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Generates the full 9-photo set (3 stages x 3 variations) for a brand-new shape, uploads each,
// and only inserts the dough_shapes row itself once every photo has succeeded -- a shape with an
// incomplete photo set is worse than no shape at all (the placement UI has nothing sane to fall
// back to for a missing stage), so this is all-or-nothing rather than a partial save.
async function createDoughShape({ name, unitWeightGrams, sizeCm, onProgress = () => {}, isCancelled = () => false }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) return { success: false, error: 'Name is required' };
  const weight = parseFloat(unitWeightGrams);
  const size = parseFloat(sizeCm);
  if (isNaN(weight) || weight <= 0) return { success: false, error: 'Unit weight must be a positive number' };
  if (isNaN(size) || size <= 0) return { success: false, error: 'Size must be a positive number' };

  const jobs = [];
  for (const stage of DOUGH_SHAPE_STAGES) {
    for (let variationIndex = 0; variationIndex < DOUGH_SHAPE_VARIATIONS_PER_STAGE; variationIndex++) {
      jobs.push({ stage, variationIndex });
    }
  }
  const total = jobs.length;
  let completed = 0;
  onProgress({ message: `Generating ${total} reference photos for "${trimmedName}"…`, current: 0, total });

  const results = await mapWithConcurrencyLimit(jobs, IMAGE_GEN_CONCURRENCY, async (job) => {
    const { b64, ext } = await generateDoughShapeImageWithRetry({ shapeName: trimmedName, stage: job.stage });
    if (isCancelled()) throw new Error('superseded');
    const photoPath = await uploadDoughShapePhoto(b64, ext);
    completed++;
    onProgress({ message: `Generated ${completed} of ${total} reference photos for "${trimmedName}"…`, current: completed, total });
    return { ...job, photoPath };
  });

  if (isCancelled()) return { success: false, cancelled: true };

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    // Clean up whatever DID upload successfully -- an orphaned photo in storage with no DB row
    // pointing at it is silent waste, never surfaced anywhere for her to notice and clean up
    // herself, unlike every other photo path in this app which is always reachable from a row.
    const succeeded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    await Promise.all(succeeded.map((s) => deleteDoughShapePhotoFile(s.photoPath)));
    return {
      success: false,
      error: `${failed.length} of ${total} photo(s) failed to generate: ${failed.map((r) => r.reason?.message).slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`,
    };
  }

  const photoResults = results.map((r) => r.value);

  const { data: inserted, error: insErr } = await supabase
    .from('dough_shapes')
    .insert({ name: trimmedName, unit_weight_grams: weight, size_cm: size })
    .select('id')
    .single();
  if (insErr) {
    await Promise.all(photoResults.map((p) => deleteDoughShapePhotoFile(p.photoPath)));
    if (insErr.code === '23505') return { success: false, error: `A dough shape named "${trimmedName}" already exists` };
    throw supaFail('createDoughShape: insert dough_shapes', insErr);
  }

  const { error: photosInsErr } = await supabase.from('dough_shape_photos').insert(
    photoResults.map((p) => ({
      dough_shape_id: inserted.id, stage: p.stage, variation_index: p.variationIndex, photo_path: p.photoPath,
    })),
  );
  if (photosInsErr) throw supaFail('createDoughShape: insert dough_shape_photos', photosInsErr);

  return { success: true, id: inserted.id };
}

async function listDoughShapes() {
  const { data: shapes, error: shapesErr } = await supabase.from('dough_shapes').select('*').order('name');
  if (shapesErr) throw supaFail('listDoughShapes', shapesErr);
  const { data: photos, error: photosErr } = await supabase.from('dough_shape_photos').select('*');
  if (photosErr) throw supaFail('listDoughShapes: load dough_shape_photos', photosErr);

  return shapes.map((shape) => {
    const byStage = { raw: [], baked: [], cut: [] };
    for (const p of photos.filter((p) => p.dough_shape_id === shape.id)) {
      (byStage[p.stage] || (byStage[p.stage] = [])).push(p);
    }
    for (const stage of DOUGH_SHAPE_STAGES) byStage[stage].sort((a, b) => a.variation_index - b.variation_index);
    return { ...shape, photosByStage: byStage };
  });
}

async function deleteDoughShape(id) {
  const { data: photos } = await supabase.from('dough_shape_photos').select('photo_path').eq('dough_shape_id', id);
  const { error } = await supabase.from('dough_shapes').delete().eq('id', id);
  if (error) throw supaFail('deleteDoughShape', error);
  await Promise.all((photos || []).map((p) => deleteDoughShapePhotoFile(p.photo_path)));
  return { success: true };
}

module.exports = {
  DOUGH_SHAPE_STAGES, DOUGH_SHAPE_VARIATIONS_PER_STAGE, DOUGH_SHAPE_PHOTOS_BUCKET,
  createDoughShape, listDoughShapes, deleteDoughShape,
  uploadDoughShapePhoto, deleteDoughShapePhotoFile,
};
