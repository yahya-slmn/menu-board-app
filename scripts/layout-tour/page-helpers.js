// Page-side helpers for the layout tour (injected at dom-ready as window.__t). metrics() is what run.js judges:
// #main's width, its own scrollbar's width, horizontal / vertical overflow, and every visible scroll container that
// is wider than its box (hScrollers; #main itself is reported separately).
window.__t = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  async until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await this.sleep(60); } throw new Error('timeout waiting: ' + fn); },
  btn(text, root = document) { return [...root.querySelectorAll('button')].find(b => b.offsetParent && b.textContent.trim().replace(/\s+/g, ' ').startsWith(text)); },
  async click(text) { const b = await this.until(() => this.btn(text)); if (b.disabled) throw new Error('disabled: ' + text); b.click(); await this.sleep(400); },
  desc(el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''); },
  metrics() {
    const m = document.getElementById('main');
    const r = { mainW: m.clientWidth, vbar: m.offsetWidth - m.clientWidth - 0, hOverflowMain: m.scrollWidth - m.clientWidth, vOverflowMain: m.scrollHeight - m.clientHeight, docH: document.documentElement.scrollWidth - innerWidth };
    const hs = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) hs.push(this.desc(el) + ' +' + (el.scrollWidth - el.clientWidth));
    }
    r.hScrollers = hs.filter(s => !s.startsWith('main#main'));
    return r;
  },
};
