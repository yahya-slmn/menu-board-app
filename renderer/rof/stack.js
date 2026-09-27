// Layered tray: a cross-section of the stack, to scale -- each layer a band in its colour, a centimetre ruler, the
// tray's rim, and (after L4) the estimated height after the bake as a dashed outline. A 3D side view can't show this:
// the tray wall hides a stack a couple of centimetres tall, and the sheets are surfaces with no body to cut through.
// Pure: returns an SVG string (renderer.js puts it on the stage).
//
// desc: { layers: [{ name, heightCm, color, note }] (bottom first; note e.g. "measured"), rimCm (the tray's usable
//         height), finalCm (optional: estimated total after the bake), title (default CROSS-SECTION) }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => `${Math.round(v * 100) / 100}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function stackSvg({ layers = [], rimCm = 0, finalCm = null, title = 'CROSS-SECTION' } = {}) {
  const W = 236, H = 158, x0 = 30, x1 = 104, yFloor = 136, yTop = 22;
  const total = layers.reduce((s, l) => s + Math.max(0, l.heightCm || 0), 0);
  const maxH = Math.max(rimCm || 0, total, finalCm || 0, 0.5) * 1.08;
  const k = (yFloor - yTop) / maxH;
  const y = (cm) => yFloor - cm * k;
  const parts = [];
  // Ruler: a tick every 0.5 cm (every 1 cm when tall), labelled every whole cm.
  const step = maxH > 6 ? 1 : 0.5;
  for (let v = 0; v <= maxH + 1e-9; v += step) {
    const yy = y(v), whole = Math.abs(v - Math.round(v)) < 1e-9;
    parts.push(`<line x1="${x0 - (whole ? 7 : 4)}" y1="${yy}" x2="${x0}" y2="${yy}" stroke="rgba(230,238,230,.55)" stroke-width="1"/>`);
    if (whole) parts.push(`<text x="${x0 - 9}" y="${yy + 3.5}" text-anchor="end" font-size="9.5" fill="rgba(230,238,230,.75)">${v}</text>`);
  }
  parts.push(`<text x="${x0 - 9}" y="11" text-anchor="end" font-size="9" fill="rgba(230,238,230,.6)">cm</text>`);
  // The layers, bottom up, each labelled on the right with where its top is.
  let at = 0;
  const labels = [];
  layers.forEach((l) => {
    const h = Math.max(0, l.heightCm || 0);
    if (h <= 0) return;
    const yb = y(at), yt = y(at + h);
    parts.push(`<rect x="${x0}" y="${yt}" width="${x1 - x0}" height="${Math.max(0.8, yb - yt)}" fill="${esc(l.color || '#e6d2a4')}" stroke="rgba(0,0,0,.25)" stroke-width="0.6"/>`);
    at += h;
    labels.push({ y: (yb + yt) / 2, text: `${clip(l.name || 'Layer', 14)}`, sub: `to ${fmt(at)} cm${l.note ? ` · ${l.note}` : ''}` });
  });
  // Labels never overlap: each at least 20 px below the one above it (placed top down); if that runs them off the
  // bottom, the whole column moves up (never above the title).
  let last = -Infinity;
  labels.reverse().forEach((lb) => { lb.ty = Math.max(lb.y, last + 20); last = lb.ty; });
  const over = labels.length ? labels[labels.length - 1].ty - (yFloor + 4) : 0;
  if (over > 0) labels.forEach((lb) => { lb.ty = Math.max(yTop + 4, lb.ty - over); });
  labels.forEach((lb) => {
    const yy = lb.ty;
    parts.push(`<line x1="${x1 + 2}" y1="${lb.y}" x2="${x1 + 8}" y2="${yy}" stroke="rgba(230,238,230,.45)" stroke-width="0.8"/>`);
    parts.push(`<text x="${x1 + 11}" y="${yy - 1}" font-size="10" font-weight="600" fill="#eef3ee">${esc(lb.text)}</text>`);
    parts.push(`<text x="${x1 + 11}" y="${yy + 9}" font-size="9" fill="rgba(230,238,230,.72)">${esc(lb.sub)}</text>`);
  });
  // Tray: floor and walls up to the rim, the rim as a dashed line.
  if (rimCm > 0) {
    const yr = y(rimCm);
    parts.push(`<path d="M${x0 - 1} ${yr} V${yFloor + 1} H${x1 + 1} V${yr}" fill="none" stroke="rgba(210,218,214,.85)" stroke-width="1.6"/>`);
    parts.push(`<line x1="${x0 - 1}" y1="${yr}" x2="${x1 + 1}" y2="${yr}" stroke="rgba(210,218,214,.8)" stroke-width="1" stroke-dasharray="3 2"/>`);
    parts.push(`<text x="${x0 + 3}" y="${yr - 3}" font-size="9" fill="rgba(230,238,230,.72)">rim ${fmt(rimCm)}</text>`);
  }
  // After the bake (estimate): a dashed outline of the stack's new top.
  if (finalCm > 0 && Math.abs(finalCm - total) > 0.005) {
    const yf = y(finalCm);
    parts.push(`<line x1="${x0}" y1="${yf}" x2="${x1}" y2="${yf}" stroke="#f3c969" stroke-width="1.2" stroke-dasharray="4 2"/>`);
    parts.push(`<line x1="${x0}" y1="${H - 5}" x2="${x0 + 14}" y2="${H - 5}" stroke="#f3c969" stroke-width="1.2" stroke-dasharray="4 2"/>`);
    parts.push(`<text x="${x0 + 18}" y="${H - 2}" font-size="9" fill="rgba(230,238,230,.8)">after the bake ≈ ${fmt(finalCm)} cm (est.)</text>`);
  }
  const summary = layers.filter(l => l.heightCm > 0).map(l => `${l.name} ${fmt(l.heightCm)} cm`).join(', ');
  const aria = `Cross-section: ${summary}; ${fmt(total)} cm in all${rimCm > 0 ? `, tray rim at ${fmt(rimCm)} cm` : ''}${finalCm > 0 ? `, about ${fmt(finalCm)} cm after the bake` : ''}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">
    <text x="${x0 + 4}" y="11" font-size="10" font-weight="600" letter-spacing=".06em" fill="rgba(230,238,230,.85)">${esc(title)}</text>
    ${parts.join('')}
  </svg>`;
}
