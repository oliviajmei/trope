'use strict';

/* ============================================================
   Trope: build your life to be cohesive.
   Matching is 100% on-device (colour maths + an optional open
   image model). No AI service is ever called. Data lives in
   IndexedDB; optional sync goes to your own Firebase project.
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const list = a => a.length < 2 ? a.join('') : a.length === 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const ACCENTS = ['#6fa3ad', '#d9a3b8', '#eadfc7', '#98a7a9', '#9a78d6', '#386777'];

/* ---------------- storage ---------------- */
const store = {
  db: null,
  mem: {},
  async open() {
    try {
      await new Promise((res, rej) => {
        const r = indexedDB.open('trope', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    } catch { this.db = null; }
  },
  get(k) {
    if (!this.db) return Promise.resolve(this.mem[k]);
    return new Promise(res => {
      const q = this.db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
  },
  set(k, v) {
    if (!this.db) { this.mem[k] = v; return Promise.resolve(); }
    return new Promise(res => {
      const t = this.db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(v, k);
      t.oncomplete = t.onerror = () => res();
    });
  }
};

/* ---------------- state ---------------- */
const state = {
  profiles: [], activeId: null, smart: false, updated: 0,
  mlStatus: '',
  view: 'collect', filter: 'all', sel: new Set(),
  match: null,
  gift: { cat: 'Any', budget: 0, source: 'mine', seed: 1 },
  refocus: null
};
const newProfile = name => ({ id: uid(), name, images: [], groups: [] });
const prof = () => state.profiles.find(p => p.id === state.activeId);
let saveTimer;
const snapshot = () => ({ profiles: state.profiles, activeId: state.activeId, smart: state.smart, updated: state.updated });
const save = () => {
  state.updated = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.set('state', snapshot()); sync.schedule(); }, 250);
};

/* ---------------- colour maths ---------------- */
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
function rgb2lab([r, g, b]) {
  const f = v => { v /= 255; return v > .04045 ? Math.pow((v + .055) / 1.055, 2.4) : v / 12.92; };
  const R = f(r), G = f(g), B = f(b);
  const t = v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = t((R * .4124 + G * .3576 + B * .1805) / .95047);
  const y = t(R * .2126 + G * .7152 + B * .0722);
  const z = t((R * .0193 + G * .1192 + B * .9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labCache = new Map();
const lab = hex => { let v = labCache.get(hex); if (!v) { v = rgb2lab(hex2rgb(hex)); labCache.set(hex, v); } return v; };
const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const NAMES = [
  ['midnight navy', '#0b1226'], ['ink', '#0a0f1c'], ['deep indigo', '#2a2f66'], ['slate blue', '#3f5675'], ['cyanotype blue', '#1f4e79'],
  ['pale blue', '#b9cde8'], ['powder blue', '#a8c4e0'], ['periwinkle', '#8e9be0'], ['lavender', '#b9a8dc'], ['dusty mauve', '#a8809c'],
  ['orchid mist', '#c7a3c9'], ['rose dust', '#c99aa4'], ['blush', '#e8c6c8'], ['mulberry', '#6a3a55'], ['plum', '#4a2a4a'], ['wine', '#5a2236'],
  ['teal', '#2f6b72'], ['deep teal', '#123c43'], ['sea glass', '#9cc7bf'], ['sage', '#9caf94'], ['moss', '#55664a'], ['forest', '#1f3a2c'],
  ['olive', '#6f6a3a'], ['bone', '#efe7dc'], ['pearl', '#e9ecf2'], ['fog grey', '#aeb4bf'], ['ash', '#6d7380'], ['charcoal', '#2a2c33'],
  ['black', '#08080a'], ['cream', '#f3ead3'], ['butter', '#f0dc9a'], ['sand', '#cdb99a'], ['tan', '#a8845a'], ['terracotta', '#b5654a'],
  ['rust', '#8a4a2d'], ['clay', '#9c6b5a'], ['coral', '#e08a7a'], ['apricot', '#eab08a'], ['gold', '#c9a24a'], ['brass', '#a8893c'],
  ['crimson', '#8c1d2f'], ['red', '#c02a2a'], ['orange', '#d9772b'], ['mustard', '#c79a2a'], ['lime', '#a9c43a'], ['emerald', '#1f7a5a'],
  ['cobalt', '#2a4fd0'], ['sky', '#7db6e8'], ['white', '#fbfbfd'], ['silver', '#c4c8cf']
].map(([n, h]) => [n, lab(h)]);
const nameColor = hex => { const l = lab(hex); let best = NAMES[0], bd = 1e9; for (const n of NAMES) { const d = labDist(l, n[1]); if (d < bd) { bd = d; best = n; } } return best[0]; };

/* Greedy merge of near-identical colours into a small weighted palette. */
function mergePalette(cols, max = 6, thr = 14) {
  const sorted = cols.filter(c => c.w > 0).sort((a, b) => b.w - a.w);
  const out = [];
  for (const c of sorted) {
    const l = lab(c.hex);
    const hit = out.find(o => labDist(lab(o.hex), l) < thr);
    if (hit) hit.w += c.w; else out.push({ hex: c.hex, w: c.w });
  }
  const top = out.slice(0, max);
  const tot = top.reduce((a, c) => a + c.w, 0) || 1;
  return top.map(c => ({ hex: c.hex, w: c.w / tot }));
}

/* Read a canvas: dominant palette + mood stats. */
function analyze(src) {
  const W = 48, H = Math.max(1, Math.round(W * src.height / src.width));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  const buckets = new Map(); const Ls = [];
  let sA = 0, sB = 0, sC = 0, sL = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const [L, A, B] = rgb2lab([r, g, b]);
    Ls.push(L); sL += L; sA += A; sB += B; sC += Math.hypot(A, B); n++;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b; buckets.set(k, e);
  }
  n = n || 1;
  const cols = [...buckets.values()].map(e => {
    const rgb = [e.r / e.n, e.g / e.n, e.b / e.n];
    const [, A, B] = rgb2lab(rgb);
    return { hex: rgb2hex(rgb), w: e.n * (0.7 + clamp(Math.hypot(A, B) / 60)) };
  });
  const mean = sL / n;
  const sd = Math.sqrt(Ls.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return {
    palette: mergePalette(cols, 5, 12),
    stats: {
      l: clamp(mean / 100),
      s: clamp(sC / n / 55),
      warm: clamp((sB / n + .5 * sA / n) / 25, -1, 1),
      c: clamp(sd / 40)
    }
  };
}

/* ---------------- aesthetic maths ---------------- */
function traitsOf(st) {
  if (!st) return [];
  const t = [];
  if (st.l < .3) t.push('deep'); else if (st.l > .62) t.push('airy');
  if (st.s < .3) t.push('muted'); else if (st.s > .55) t.push('vivid');
  if (st.warm < -.25) t.push('cool'); else if (st.warm > .25) t.push('warm');
  if (st.c < .28) t.push('hazy'); else if (st.c > .5) t.push('crisp');
  return t;
}

function profileFrom(parts) {
  const tot = parts.reduce((a, x) => a + x.weight, 0) || 1;
  const cols = [], kw = {}, st = { l: 0, s: 0, warm: 0, c: 0 };
  let tw = 0, count = 0, emb = null;
  for (const part of parts) {
    const w = part.weight / tot;
    (part.kws || []).forEach(k => kw[k] = (kw[k] || 0) + w);
    if (!part.imgs.length) continue;
    const per = w / part.imgs.length;
    count += part.imgs.length;
    for (const im of part.imgs) {
      im.palette.forEach(c => cols.push({ hex: c.hex, w: c.w * per }));
      for (const k in st) st[k] += im.stats[k] * per;
      if (im.emb) { emb = emb || new Array(im.emb.length).fill(0); for (let i = 0; i < emb.length; i++) emb[i] += im.emb[i] * per; }
      tw += per;
    }
  }
  const keywords = Object.entries(kw).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  if (!tw) return { palette: [], stats: null, traits: [], keywords, count: 0, emb: null };
  for (const k in st) st[k] /= tw;
  return { palette: mergePalette(cols, 6), stats: st, traits: traitsOf(st), keywords, count, emb: emb && unit(emb) };
}
const imagesOf = (p, g) => g.imageIds.map(id => p.images.find(i => i.id === id)).filter(Boolean);
const groupProfile = (p, g) => profileFrom([{ imgs: imagesOf(p, g), weight: 1, kws: g.keywords }]);
function mineProfile(p) {
  let parts = p.groups.filter(g => g.inMine && g.weight > 0).map(g => ({ imgs: imagesOf(p, g), weight: g.weight, kws: g.keywords }));
  if (!parts.length && p.images.length) parts = [{ imgs: p.images, weight: 1, kws: [] }];
  return profileFrom(parts);
}

function paletteScore(a, b) {
  const one = (x, y) => x.reduce((s, c) => s + c.w * Math.exp(-Math.min(...y.map(t => labDist(lab(c.hex), lab(t.hex)))) / 30), 0);
  return (one(a, b) + one(b, a)) / 2;
}
function statScore(a, b) {
  const d = Math.abs(a.l - b.l) + .6 * Math.abs(a.s - b.s) + .4 * Math.abs(a.warm - b.warm) + .3 * Math.abs(a.c - b.c);
  return clamp(1 - d / 2.3);
}
function matchScore(cand, pr) {
  if (!pr.stats) return null;
  const t = .7 * paletteScore(cand.palette, pr.palette) + .3 * statScore(cand.stats, pr.stats);
  let s = clamp((t - .15) / .75);
  if (cand.emb && pr.emb) s = .4 * s + .6 * clamp((dot(cand.emb, pr.emb) - .55) / .4);   // subject/style similarity
  return Math.round(s * 100);
}

/* ---------------- on-device image model (optional) ----------------
   CLIP via Transformers.js runs entirely in the browser. The open model
   weights download once from Hugging Face and are then cached. No AI
   service, no API key, no data leaves the device. */
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const unit = v => { const n = Math.sqrt(dot(v, v)) || 1; return v.map(x => x / n); };
const round3 = v => v.map(x => Math.round(x * 1000) / 1000);

/* [keyword, text prompt]. Keywords double as the vocabulary gift ideas are tagged with. */
const VOCAB = [
  ['botanical', 'botanical plants'], ['floral', 'flowers'], ['cyanotype', 'cyanotype print'], ['vintage', 'vintage retro'], ['minimal', 'minimalist'],
  ['gothic', 'gothic dark'], ['academia', 'dark academia'], ['cottagecore', 'cottagecore'], ['coquette', 'coquette bows and lace'], ['dreamy', 'dreamy soft glow'],
  ['ethereal', 'ethereal'], ['grunge', 'grunge'], ['y2k', 'y2k'], ['romantic', 'romantic'], ['celestial', 'celestial moon and stars'], ['moth', 'moths and butterflies'],
  ['insect', 'insects'], ['film', 'analog film photography'], ['grain', 'grainy texture'], ['iridescent', 'iridescent holographic'], ['dark', 'moody dark'],
  ['cozy', 'cozy warm'], ['craft', 'handmade craft'], ['art', 'fine art'], ['photography', 'photograph'], ['dyed', 'tie dye gradient'], ['soft', 'soft pastel'],
  ['journal', 'journal and stationery'], ['candle', 'candles'], ['crystal', 'crystals and gemstones'], ['dried', 'dried flowers'], ['earthy', 'earthy natural'],
  ['industrial', 'industrial'], ['futuristic', 'futuristic'], ['boho', 'bohemian'], ['whimsical', 'whimsical'], ['witchy', 'witchy mystical'], ['ocean', 'ocean and water'],
  ['forest', 'forest and woods'], ['monochrome', 'monochrome black and white'], ['neon', 'neon'], ['victorian', 'victorian'], ['preppy', 'preppy'], ['streetwear', 'streetwear']
];

const ml = {
  p: null, vocab: null, ideas: null,
  load() {
    if (this.p) return this.p;
    const attempt = async () => {
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1');
      const id = 'Xenova/clip-vit-base-patch32', o = { dtype: 'q8' };
      state.mlStatus = 'Downloading the on-device model (first time only)…'; render();
      this.T = T;
      [this.proc, this.vision, this.tok, this.text] = await Promise.all([
        T.AutoProcessor.from_pretrained(id), T.CLIPVisionModelWithProjection.from_pretrained(id, o),
        T.AutoTokenizer.from_pretrained(id), T.CLIPTextModelWithProjection.from_pretrained(id, o)
      ]);
      this.vocab = await this.texts(VOCAB.map(v => `a ${v[1]} aesthetic`));
      this.ideas = await this.texts(IDEAS.map(i => `a photo of ${i[0].toLowerCase()}`));
      state.mlStatus = '';
    };
    /* downloads can fail transiently, so retry a couple of times before giving up */
    this.p = (async () => { for (let i = 0; ; i++) { try { return await attempt(); } catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } })()
      .catch(e => { this.p = null; state.mlStatus = ''; throw e; });
    return this.p;
  },
  async image(src) {
    const img = await this.T.RawImage.fromURL(src);
    const { image_embeds } = await this.vision(await this.proc(img));
    return round3(unit(Array.from(image_embeds.data)));
  },
  async texts(list) {
    const { text_embeds } = await this.text(this.tok(list, { padding: true, truncation: true }));
    const d = text_embeds.dims[1], out = [];
    for (let i = 0; i < list.length; i++) out.push(unit(Array.from(text_embeds.data.slice(i * d, (i + 1) * d))));
    return out;
  }
};

async function embedMissing() {
  const todo = state.profiles.flatMap(p => p.images).filter(i => !i.emb);
  let n = 0;
  for (const im of todo) {
    state.mlStatus = `Analyzing images ${++n} of ${todo.length}…`; render();
    try { im.emb = await ml.image(im.src); } catch { /* skip unreadable */ }
  }
  state.mlStatus = ''; if (todo.length) save(); render();
}

async function setSmart(on) {
  state.smart = on; save();
  if (!on) return render();
  try { await ml.load(); await embedMissing(); toast('Smart analysis is on'); }
  catch { state.smart = false; state.mlStatus = ''; save(); render(); toast('Could not load the on-device model. Check your connection.'); }
}

/* Style keywords the group's images suggest, from CLIP text↔image similarity. */
function suggestTags(p, g) {
  const embs = imagesOf(p, g).map(i => i.emb).filter(Boolean);
  if (!state.smart || !ml.vocab || !embs.length) return [];
  const mean = unit(embs[0].map((_, k) => embs.reduce((a, e) => a + e[k], 0)));
  return ml.vocab.map((v, i) => [VOCAB[i][0], dot(v, mean)]).sort((a, b) => b[1] - a[1])
    .map(x => x[0]).filter(k => !g.keywords.includes(k)).slice(0, 6);
}

/* ---------------- images ---------------- */
async function readImage(file, max = 720) {
  const url = URL.createObjectURL(file);
  const bmp = new Image();
  try { bmp.src = url; await bmp.decode(); } finally { URL.revokeObjectURL(url); }
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const a = analyze(c);
  return { id: uid(), src: c.toDataURL('image/jpeg', .82), w: c.width, h: c.height, palette: a.palette, stats: a.stats, added: Date.now() };
}

async function addFiles(files) {
  const p = prof(); let n = 0;
  const target = (state.filter !== 'all' && state.filter !== 'none' ? state.filter : null);
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const rec = await readImage(f);
      p.images.push(rec); n++;
      const g = target && p.groups.find(g => g.id === target);
      if (g) g.imageIds.push(rec.id);
    } catch { /* unreadable image */ }
  }
  save(); render();
  toast(n ? `Added ${n} image${n > 1 ? 's' : ''}` : 'No readable images found');
  if (n && state.smart && ml.p) embedMissing();
}

async function setFindFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Please choose an image');
  try { startFind(await readImage(file, 720)); } catch { toast('Could not read that image'); }
}

async function setMatchFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Please choose an image');
  try { state.match = await readImage(file, 560); } catch { return toast('Could not read that image'); }
  if (state.smart && ml.p) { try { await ml.p; state.match.emb = await ml.image(state.match.src); } catch { /* colour-only */ } }
  state.view = 'match'; render();
}

/* ---------------- UI helpers ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
function askText(title, placeholder = '', value = '') {
  return new Promise(res => {
    const d = $('#textDialog'), inp = $('#textInput');
    $('#textTitle').textContent = title; inp.placeholder = placeholder; inp.value = value;
    d.returnValue = ''; d.showModal(); inp.focus(); inp.select();
    d.addEventListener('close', () => res(d.returnValue === 'ok' ? inp.value.trim() : null), { once: true });
  });
}
const swatches = (pal, cls = '') => `<div class="swatches ${cls}">${pal.map(c => `<span style="--c:${c.hex};flex:${Math.max(.35, c.w * 6)}" title="${esc(nameColor(c.hex))}"></span>`).join('')}</div>`;
const hashStr = t => { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
const art = (id, cls, rot) => `<img class="art ${cls}" src="assets/${id}.webp" alt="" aria-hidden="true" decoding="async" style="--r:${rot != null ? rot : (hashStr(id + '|' + cls) % 61) - 30}deg">`;
const GIFT_ART = ['pink', 'teal', 'butterfly', 'mallow', 'bluebloom', 'moth'];
const header = (eyebrow, title, lead, flower = 'bluebloom') => `<header class="vhead">${art(flower, 'vh-art')}<h1 class="display glitch" data-text="${esc(title.replace(/<[^>]+>/g, ''))}">${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</header>`;
const emptyMsg = (text, img = 'moth') => `<div class="empty">${art(img, 'e-moth')}<p>${text}</p></div>`;
const groupsOf = (p, imgId) => p.groups.filter(g => g.imageIds.includes(imgId));
const possessive = p => p.name === 'Me' ? 'Your' : `${esc(p.name)}’s`;
const searchLinks = q => {
  const e = encodeURIComponent(q);
  return `<span class="links">
    <a class="chip" target="_blank" rel="noopener" href="https://www.pinterest.com/search/pins/?q=${e}">Pinterest</a>
    <a class="chip" target="_blank" rel="noopener" href="https://www.etsy.com/search?q=${e}">Etsy</a>
    <a class="chip" target="_blank" rel="noopener" href="https://www.google.com/search?tbm=shop&q=${e}">Shopping</a></span>`;
};

/* ---------------- views ---------------- */
const views = {};

views.collect = () => {
  const p = prof();
  const imgs = state.filter === 'all' ? p.images
    : state.filter === 'none' ? p.images.filter(i => !groupsOf(p, i.id).length)
    : (p.groups.find(g => g.id === state.filter) ? imagesOf(p, p.groups.find(g => g.id === state.filter)) : p.images);
  const ungrouped = p.images.filter(i => !groupsOf(p, i.id).length).length;
  const chip = (id, label, count, color) => `<button class="chip" data-act="filter" data-f="${id}" aria-pressed="${state.filter === id}">${color ? `<i class="dot" style="--c:${color}"></i>` : ''}${esc(label)} <span class="muted">${count}</span></button>`;
  return `${header('Collect', `Collect ${p.name === 'Me' ? 'your' : esc(p.name) + '’s'} trope`,
    'Drop in images that feel right: pins, screenshots, photos of things you love. Select a few to sort them into aesthetics.')}
  <div class="drop" id="drop">
    ${art('mallow', 'dz-l')}${art('moth', 'dz-r')}
    <p class="big">Press something here</p>
    <p class="muted">drop images, or paste with Ctrl/⌘ + V</p>
    <p><button class="primary" data-act="browse">Choose images</button></p>
  </div>
  ${p.images.length ? `<div class="chips filters">
    ${chip('all', 'Everything', p.images.length)}
    ${ungrouped && p.groups.length ? chip('none', 'Ungrouped', ungrouped) : ''}
    ${p.groups.map(g => chip(g.id, g.name, g.imageIds.length, g.color)).join('')}
  </div>` : ''}
  ${imgs.length ? `<div class="masonry">${imgs.map(i => `
    <div class="tile ${state.sel.has(i.id) ? 'sel' : ''}">
      <button class="open" data-act="open" data-id="${i.id}" aria-label="Open image"><img src="${i.src}" alt="" loading="lazy" width="${i.w}" height="${i.h}"></button>
      <button class="check" data-act="sel" data-id="${i.id}" aria-pressed="${state.sel.has(i.id)}" aria-label="Select image">✓</button>
      <span class="dots">${groupsOf(p, i.id).map(g => `<i style="--c:${g.color}"></i>`).join('')}</span>
    </div>`).join('')}</div>`
    : emptyMsg(p.images.length ? 'Nothing pressed here yet.' : 'Start with five to ten images. The more varied they are, the better the groups.', 'butterfly')}
  <div class="smart">
    <p><strong>Smart analysis:</strong> ${state.mlStatus ? esc(state.mlStatus) : state.smart ? 'On. Trope reads subjects and style (botanical, moths, grain…), not just colour. It all runs on your device.' : 'Off. Turn on to match by subject and style, not just colour. Runs on your device with an open model and no AI service. One-time ~100&nbsp;MB download.'}</p>
    <button class="${state.smart ? 'ghost' : 'primary'}" data-act="smart" ${state.mlStatus ? 'disabled' : ''}>${state.smart ? 'Turn off' : 'Turn on'}</button>
  </div>
  <p class="note">Pinterest import is on the roadmap. For now: save or screenshot pins, then drop or paste them here.</p>`;
};

views.aesthetics = () => {
  const p = prof();
  return `${header('Aesthetics', 'Not everything fits in one.', 'Group images into separate aesthetics, each with its own palette and mood. Then choose which ones feed into the blend that becomes “mine”.', 'teal')}
  <div class="row" style="margin-bottom:1.6rem">
    <button class="primary" data-act="newgroup">New aesthetic</button>
    <button class="ghost" data-act="suggest">Suggest groups from my images</button>
  </div>
  ${p.groups.length ? `<div class="agrid">${p.groups.map(g => {
    const pr = groupProfile(p, g), imgs = imagesOf(p, g).slice(0, 4);
    return `<article class="card agroup">
      <div class="collage ${imgs.length ? '' : 'none'}">${imgs.length ? imgs.map(i => `<img src="${i.src}" alt="">`).join('') : '<span>No images yet</span>'}</div>
      <div class="agbody">
        <input type="text" class="name-input" value="${esc(g.name)}" data-change="rename" data-g="${g.id}" aria-label="Aesthetic name" maxlength="60">
        ${pr.palette.length ? swatches(pr.palette) : ''}
        <p class="desc">${g.imageIds.length} image${g.imageIds.length === 1 ? '' : 's'}${pr.traits.length ? ' · ' + pr.traits.join(' · ') : ''}</p>
        <div class="chips">${g.keywords.map(k => `<span class="chip">${esc(k)} <button class="x" data-act="rmkw" data-g="${g.id}" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`).join('')}</div>
        <input type="text" class="kwadd" placeholder="Add a keyword: botanical, grain, gothic…" data-kw="${g.id}" maxlength="30">
        ${(tags => tags.length ? `<div class="suggest">Looks like: ${tags.map(k => `<button class="chip add" data-act="addkw" data-g="${g.id}" data-k="${esc(k)}">+ ${esc(k)}</button>`).join('')}</div>` : '')(suggestTags(p, g))}
        <div class="mine-row">
          <label><input type="checkbox" data-change="inmine" data-g="${g.id}" ${g.inMine ? 'checked' : ''}> Include in my aesthetic</label>
          <div class="w"><span>Less</span><input type="range" min="5" max="100" value="${g.weight}" data-change="weight" data-g="${g.id}" ${g.inMine ? '' : 'disabled'} aria-label="Influence"><span>More</span></div>
        </div>
        <div class="row"><button class="ghost" data-act="viewgroup" data-g="${g.id}">View images</button><button class="ghost danger" data-act="delgroup" data-g="${g.id}">Delete</button></div>
      </div></article>`;
  }).join('')}</div>` : `<p class="empty">No aesthetics yet. Create one, or select images in Collect and add them to a new group.</p>`}`;
};

function meter(l, r, v) { return `<div class="meter"><div class="lab"><span>${l}</span><span>${r}</span></div><div class="track" style="--p:${clamp(v) * 100}%"><i></i></div></div>`; }

views.mine = () => {
  const p = prof(), pr = mineProfile(p);
  if (!pr.stats) return `${header('Mine', `${possessive(p)} aesthetic`, 'Blend your aesthetics into one.', 'butterfly')}<p class="empty">Add some images first. This page then turns them into a palette, a mood, and search terms.</p>`;
  const st = pr.stats, names = pr.palette.slice(0, 3).map(c => nameColor(c.hex));
  const sentence = `${possessive(p)} aesthetic is ${pr.traits.length ? list(pr.traits) : 'balanced'}, built around ${list(names)}.${pr.keywords.length ? ` Recurring threads: ${list(pr.keywords.slice(0, 4))}.` : ''}`;
  const active = p.groups.filter(g => g.inMine && g.weight > 0);
  const tw = active.reduce((a, g) => a + g.weight, 0) || 1;
  return `${header('Mine', `${possessive(p)} aesthetic`, 'Blended from the aesthetics you included. Adjust the mix on the Aesthetics page.', 'butterfly')}
  <div class="mine-grid">
    <section class="card fade">
      <p class="statement">${esc(sentence)}</p>
      ${swatches(pr.palette, 'tall')}
      <div class="names">${pr.palette.map(c => `<span><b style="--c:${c.hex}"></b>${esc(nameColor(c.hex))}</span>`).join('')}</div>
    </section>
    <section class="card fade">
      <h2 class="sub">Mood</h2>
      ${meter('Deep', 'Airy', st.l)}${meter('Muted', 'Vivid', st.s)}${meter('Cool', 'Warm', (st.warm + 1) / 2)}${meter('Hazy', 'Crisp', st.c)}
    </section>
    <section class="card fade">
      <h2 class="sub">Where it comes from</h2>
      ${active.length ? `<div class="bars">${active.map(g => `<div class="bar"><span>${esc(g.name)}</span><span class="muted">${Math.round(g.weight / tw * 100)}%</span><div class="fill"><i style="--p:${g.weight / tw * 100}%;--c:${g.color}"></i></div></div>`).join('')}</div>`
      : `<p class="muted">Blending all ${pr.count} images (no groups included yet).</p>`}
    </section>
    <section class="card fade">
      <h2 class="sub">Find clothes</h2>
      <p class="muted small">Show Trope a piece you love. It reads the silhouette, pattern and colors, then searches Depop, Vinted, AliExpress, SHEIN and ethical brands for matches.</p>
      <p><button class="primary" data-act="goto" data-v="find">Open the finder</button></p>
      <p class="muted small" style="margin-top:1rem">Or <button class="link" data-act="goto" data-v="match">test an item</button> or <button class="link" data-act="goto" data-v="gifts">get gift ideas</button>.</p>
    </section>
  </div>`;
};

views.match = () => {
  const p = prof(), pr = mineProfile(p), m = state.match;
  const head = header('Match', 'Does it fit?', `Drop in a photo of anything (a bag, a lamp, a dress) and see how well it sits inside ${p.name === 'Me' ? 'your' : esc(p.name) + '’s'} aesthetic.`, 'insect');
  if (!pr.stats) return `${head}<p class="empty">Build an aesthetic first (Collect), then come back to test items against it.</p>`;
  if (!m) return `${head}<div class="drop" id="drop">${art('pink', 'dz-l')}${art('butterfly', 'dz-r')}<p class="big">Show me something</p><p class="muted">drop an item, or paste with Ctrl/⌘ + V</p><p><button class="primary" data-act="matchbrowse">Choose an image</button></p></div>`;
  const total = matchScore(m, pr);
  const verdict = total >= 80 ? 'Right at home.' : total >= 60 ? 'Close, and it fits with a little styling.' : total >= 40 ? 'Adjacent, and it works as an accent piece.' : 'Off-vibe for this aesthetic.';
  const per = p.groups.map(g => ({ g, s: matchScore(m, groupProfile(p, g)) })).filter(x => x.s !== null).sort((a, b) => b.s - a.s);
  return `${head}
  <div class="match-grid">
    <div><img class="matchimg" src="${m.src}" alt="Item being tested"><div style="margin-top:1rem">${swatches(m.palette, 'slim')}</div></div>
    <div class="card fade">
      <div class="row" style="gap:1.6rem">
        <div class="ring" style="--p:${total}"><span>${total}<small>%</small></span></div>
        <div><h2 class="display sm">${verdict}</h2><p class="muted">Compared with ${possessive(p).toLowerCase()} blended aesthetic.</p></div>
      </div>
      ${per.length ? `<h2 class="sub" style="margin-top:1.8rem">By aesthetic</h2><div class="scorelist bars">${per.map(x => `<div class="bar"><span>${esc(x.g.name)}</span><span class="muted">${x.s}%</span><div class="fill"><i style="--p:${x.s}%;--c:${x.g.color}"></i></div></div>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:1.6rem">
        <button class="primary" data-act="matchsave">Add to my collection</button>
        <button class="ghost" data-act="matchbrowse">Try another</button>
        <button class="ghost" data-act="matchfind">Find clothes like this</button>
        ${searchLinks(`${nameColor(m.palette[0].hex)} ${pr.keywords[0] || ''}`.trim())}
      </div>
    </div>
  </div>`;
};

/* [name, category, price tier 1-4, mood traits, keywords, search query] */
const IDEAS = [
  ['Pressed-flower resin pendant', 'Accessories', 2, ['muted', 'hazy'], ['botanical', 'floral', 'romantic', 'cottagecore', 'dreamy'], 'pressed flower resin pendant necklace'],
  ['Oxidized silver moth earrings', 'Accessories', 2, ['deep', 'cool'], ['gothic', 'insect', 'moth', 'botanical', 'dark'], 'oxidized silver moth earrings'],
  ['Labradorite or moonstone ring', 'Accessories', 3, ['deep', 'cool', 'hazy'], ['celestial', 'dreamy', 'crystal', 'gothic'], 'labradorite moonstone ring'],
  ['Sheer organza hair ribbons', 'Accessories', 1, ['airy', 'hazy', 'muted'], ['coquette', 'dreamy', 'romantic', 'soft'], 'organza hair ribbon set'],
  ['Iridescent glass bead bracelet', 'Accessories', 1, ['vivid', 'cool'], ['dreamy', 'y2k', 'iridescent'], 'iridescent glass bead bracelet'],
  ['Silk scarf with a watercolor floral print', 'Accessories', 3, ['muted', 'airy'], ['floral', 'vintage', 'romantic', 'botanical'], 'silk scarf watercolor floral'],
  ['Soft leather shoulder bag in a deep tone', 'Accessories', 4, ['deep', 'muted'], ['vintage', 'academia', 'minimal', 'dark'], 'vintage leather shoulder bag'],
  ['Framed botanical or cyanotype print', 'Home', 2, ['deep', 'cool'], ['botanical', 'cyanotype', 'film', 'art', 'floral'], 'cyanotype botanical print framed'],
  ['Frosted-glass candle holders + tapers', 'Home', 2, ['hazy', 'muted'], ['dreamy', 'minimal', 'candle', 'romantic'], 'frosted glass taper candle holder'],
  ['Smoked or iridescent glass vase', 'Home', 2, ['deep', 'cool'], ['minimal', 'gothic', 'iridescent', 'dreamy'], 'smoked glass vase'],
  ['Dried flower bundle in muted tones', 'Home', 1, ['muted', 'hazy'], ['botanical', 'cottagecore', 'floral', 'dried', 'vintage'], 'dried flower bundle muted'],
  ['Velvet cushion in dusty mauve or navy', 'Home', 2, ['muted', 'deep'], ['romantic', 'vintage', 'gothic', 'cozy'], 'velvet cushion cover dusty mauve'],
  ['Glowing moon night light', 'Home', 2, ['deep', 'hazy'], ['dreamy', 'celestial', 'cottagecore', 'cozy'], 'moon night light lamp'],
  ['Sheer gradient curtains', 'Home', 3, ['airy', 'hazy'], ['dreamy', 'soft', 'ethereal'], 'sheer ombre curtains'],
  ['Sheer layering top in pearl or lilac', 'Clothing', 3, ['airy', 'muted', 'hazy'], ['romantic', 'dreamy', 'coquette', 'ethereal'], 'sheer lilac layering top'],
  ['Hand-dyed gradient tee', 'Clothing', 2, ['hazy', 'cool'], ['dyed', 'dreamy', 'y2k', 'grunge'], 'hand dyed ombre tee'],
  ['Mohair or brushed-knit cardigan', 'Clothing', 3, ['muted', 'hazy'], ['cottagecore', 'vintage', 'cozy', 'academia'], 'mohair cardigan'],
  ['Black satin slip dress', 'Clothing', 4, ['deep'], ['gothic', 'romantic', 'vintage', 'dark'], 'black satin slip dress'],
  ['Botanical-jacquard wool socks', 'Clothing', 1, ['muted'], ['botanical', 'cozy', 'cottagecore'], 'botanical jacquard wool socks'],
  ['Black-paper journal + silver gel pen', 'Stationery', 1, ['deep', 'crisp'], ['film', 'minimal', 'gothic', 'journal', 'dark'], 'black paper journal silver gel pen'],
  ['Pressed-flower wax-seal stationery set', 'Stationery', 1, ['muted'], ['botanical', 'vintage', 'romantic', 'floral'], 'pressed flower stationery wax seal'],
  ['Translucent vellum sketchbook', 'Stationery', 2, ['airy', 'hazy'], ['dreamy', 'art', 'minimal', 'film'], 'vellum sketchbook'],
  ['Lilac-blue shimmer eye gloss', 'Beauty', 1, ['cool', 'vivid'], ['dreamy', 'y2k', 'iridescent', 'soft'], 'lilac blue shimmer eye gloss'],
  ['Violet and iris perfume layering set', 'Beauty', 3, ['muted', 'cool'], ['romantic', 'floral', 'botanical', 'vintage'], 'iris violet perfume set'],
  ['Mulberry lip stain', 'Beauty', 1, ['deep', 'warm'], ['gothic', 'romantic', 'dark'], 'mulberry lip stain'],
  ['Opalescent nail polish duo', 'Beauty', 1, ['hazy', 'cool'], ['dreamy', 'iridescent', 'ethereal'], 'opalescent nail polish'],
  ['35mm point-and-shoot film camera', 'Tech', 3, ['hazy', 'crisp'], ['film', 'vintage', 'grain', 'photography', 'cyanotype'], '35mm point and shoot film camera'],
  ['Instant film pack', 'Tech', 2, ['hazy'], ['film', 'vintage', 'photography', 'grain'], 'instant film pack'],
  ['Starry sky projector', 'Tech', 2, ['deep'], ['celestial', 'dreamy', 'dark', 'cozy'], 'galaxy projector night light'],
  ['Clear phone case with pressed florals', 'Tech', 1, ['hazy', 'muted'], ['botanical', 'floral', 'y2k', 'dreamy'], 'pressed flower clear phone case'],
  ['Cyanotype sun-print kit', 'Art & DIY', 1, ['deep', 'cool'], ['cyanotype', 'botanical', 'film', 'craft', 'art'], 'cyanotype kit'],
  ['Lumen / photogram printing paper', 'Art & DIY', 1, ['cool', 'hazy'], ['photography', 'botanical', 'film', 'art', 'cyanotype'], 'lumen print photogram paper'],
  ['Flower press + pressing kit', 'Art & DIY', 1, ['muted'], ['botanical', 'floral', 'craft', 'cottagecore'], 'flower press kit'],
  ['Moth embroidery kit', 'Art & DIY', 1, ['deep', 'muted'], ['moth', 'insect', 'craft', 'gothic', 'botanical'], 'moth embroidery kit'],
  ['Night-photography or darkroom workshop', 'Experiences', 3, ['deep', 'crisp'], ['film', 'photography', 'dark', 'art'], 'darkroom workshop'],
  ['Botanical garden membership', 'Experiences', 3, ['muted'], ['botanical', 'floral', 'cottagecore', 'romantic'], 'botanical garden membership gift']
];
const CATS = ['Any', 'Accessories', 'Home', 'Clothing', 'Stationery', 'Beauty', 'Tech', 'Art & DIY', 'Experiences'];
const BUDGETS = [[0, 'Any budget'], [1, 'Under $25'], [2, 'Under $60'], [3, 'Under $120']];

views.gifts = () => {
  const p = prof(), g = state.gift;
  const src = g.source === 'mine' ? null : p.groups.find(x => x.id === g.source);
  const pr = src ? groupProfile(p, src) : mineProfile(p);
  const head = header('Gifts', 'Niche, on-theme ideas.', `Ideas matched to an aesthetic. To shop for someone else, add them as a person (top right) and build their aesthetic from images they love.`, 'swallows');
  const controls = `<div class="controls">
    <div class="ctl"><span>Aesthetic</span><select data-change="gsource" aria-label="Aesthetic source">
      <option value="mine" ${g.source === 'mine' ? 'selected' : ''}>${possessive(p)} blended aesthetic</option>
      ${p.groups.map(x => `<option value="${x.id}" ${g.source === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="ctl"><span>Category</span><div class="chips">${CATS.map(c => `<button class="chip" data-act="gcat" data-v="${c}" aria-pressed="${g.cat === c}">${c}</button>`).join('')}</div></div>
    <div class="ctl"><span>Budget</span><select data-change="gbudget" aria-label="Budget">${BUDGETS.map(([v, l]) => `<option value="${v}" ${g.budget === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  </div>`;
  if (!pr.stats && !pr.keywords.length) return `${head}${controls}<p class="empty">Add images or keywords to an aesthetic first so the ideas have something to match.</p>`;

  const kws = pr.keywords.map(k => k.toLowerCase());
  const rand = n => { const x = Math.sin(n * 9301 + g.seed * 49297) * 233280; return x - Math.floor(x); };
  /* With smart analysis, rank by how close each idea is to the aesthetic's image embedding. */
  let sims = null;
  if (state.smart && ml.ideas && pr.emb) {
    const raw = ml.ideas.map(e => dot(e, pr.emb)), m = raw.reduce((a, b) => a + b) / raw.length;
    const sd = Math.sqrt(raw.reduce((a, b) => a + (b - m) ** 2, 0) / raw.length) || 1;
    sims = raw.map(x => (x - m) / sd);
  }
  const scored = IDEAS.map((idea, i) => {
    const [name, cat, tier, traits, ikws, q] = idea;
    const hitT = traits.filter(t => pr.traits.includes(t));
    const hitK = ikws.filter(k => kws.some(w => w.includes(k) || k.includes(w)));
    return { idea, hitT, hitK, score: hitT.length * 2 + hitK.length * 3 + (sims ? sims[i] * 2 : 0) + rand(i) * 1.2 };
  }).filter(x => (g.cat === 'Any' || x.idea[1] === g.cat) && (!g.budget || x.idea[2] <= g.budget))
    .sort((a, b) => b.score - a.score).slice(0, 9);

  const color = pr.palette[0] ? nameColor(pr.palette[0].hex) : '';
  const cards = scored.map(({ idea, hitT, hitK }, gi) => {
    const why = [hitK.length ? `your “${hitK[0]}” thread` : '', hitT.length ? `a ${list(hitT)} mood` : ''].filter(Boolean);
    return `<article class="card gift fade">
      ${art(GIFT_ART[gi % GIFT_ART.length], 'g-art', ((gi * 53) % 80) - 40)}
      <div class="cat"><span>${idea[1]}</span><span>${'$'.repeat(idea[2])}</span></div>
      <h3>${idea[0]}</h3>
      <p class="why">${why.length ? `Fits ${list(why)}.` : 'A softer match, but an adventurous pick.'}</p>
      ${searchLinks(`${idea[5]} ${color}`.trim())}
    </article>`;
  }).join('');
  return `${head}${controls}${cards ? `<div class="ggrid">${cards}</div><p style="margin-top:1.6rem"><button class="ghost" data-act="shuffle">Shuffle ideas</button></p>` : '<p class="empty">No ideas match those filters. Try another category or budget.</p>'}`;
};

/* ---------------- clothing finder ----------------
   Reads an item's silhouette (shape geometry), pattern (edge orientation + periodicity)
   and colours on-device, optionally names the garment with the on-device CLIP model,
   then builds a search phrase for shops and reverse-image search. No AI service involved. */
const GARMENTS = [
  ['dress', 'a photo of a dress'], ['maxi dress', 'a photo of a long maxi dress'], ['mini dress', 'a photo of a short mini dress'],
  ['midi skirt', 'a photo of a midi skirt'], ['mini skirt', 'a photo of a mini skirt'], ['maxi skirt', 'a photo of a long maxi skirt'],
  ['trousers', 'a photo of trousers'], ['wide-leg pants', 'a photo of wide-leg pants'], ['jeans', 'a photo of jeans'], ['shorts', 'a photo of shorts'],
  ['top', 'a photo of a top'], ['blouse', 'a photo of a blouse'], ['t-shirt', 'a photo of a t-shirt'], ['corset top', 'a photo of a corset top'],
  ['cardigan', 'a photo of a cardigan'], ['sweater', 'a photo of a sweater'], ['hoodie', 'a photo of a hoodie'], ['jacket', 'a photo of a jacket'],
  ['coat', 'a photo of a long coat'], ['blazer', 'a photo of a blazer'], ['vest', 'a photo of a vest'], ['jumpsuit', 'a photo of a jumpsuit'],
  ['swimsuit', 'a photo of a swimsuit'], ['shoes', 'a photo of shoes'], ['boots', 'a photo of boots'], ['bag', 'a photo of a handbag'],
  ['scarf', 'a photo of a scarf'], ['jewelry', 'a photo of jewelry']
];
const FABRICS = [
  ['sheer', 'a sheer see-through fabric'], ['satin', 'shiny satin fabric'], ['velvet', 'velvet fabric'], ['lace', 'lace fabric'], ['denim', 'denim fabric'],
  ['knit', 'chunky knit fabric'], ['crochet', 'crochet fabric'], ['corduroy', 'corduroy fabric'], ['leather', 'leather'], ['mesh', 'mesh fabric'],
  ['linen', 'linen fabric'], ['embroidered', 'embroidered fabric'], ['sequin', 'sequin fabric'], ['ruffle', 'ruffles'], ['pleated', 'pleated fabric'],
  ['puff sleeve', 'puff sleeves'], ['bow', 'bows'], ['lace-up', 'lace-up ties'], ['cut-out', 'cut-out details'], ['floral', 'a floral print'],
  ['striped', 'stripes'], ['plaid', 'plaid check'], ['gingham', 'gingham check'], ['polka dot', 'polka dots'], ['animal print', 'leopard animal print'],
  ['tie-dye', 'tie-dye'], ['paisley', 'paisley print']
];
const FITS = [
  ['oversized', 'an oversized baggy garment'], ['fitted', 'a fitted bodycon garment'], ['a-line', 'an a-line garment'], ['flowy', 'a flowy loose garment'],
  ['cropped', 'a cropped garment'], ['wide-leg', 'wide leg'], ['flared', 'a flared garment'], ['pencil', 'a pencil fit garment'], ['wrap', 'a wrap garment'],
  ['halter', 'a halter neckline'], ['strapless', 'strapless'], ['off-shoulder', 'off the shoulder'], ['long sleeve', 'long sleeves'], ['sleeveless', 'sleeveless']
];
const TYPE_CHIPS = ['dress', 'skirt', 'top', 'pants', 'jacket', 'coat', 'sweater', 'shoes', 'bag'];

const SHOPS = [
  ['Secondhand and marketplaces', [
    ['Depop', q => `https://www.depop.com/search/?q=${plus(q)}`], ['Vinted', q => `https://www.vinted.com/catalog?search_text=${plus(q)}`],
    ['Poshmark', q => `https://poshmark.com/search?query=${plus(q)}`], ['eBay', q => `https://www.ebay.com/sch/i.html?_nkw=${plus(q)}`],
    ['Etsy', q => `https://www.etsy.com/search?q=${plus(q)}`], ['ThredUp', q => `https://www.thredup.com/products?search_text=${plus(q)}`],
    ['Mercari', q => `https://www.mercari.com/search/?keyword=${plus(q)}`]]],
  ['Budget fast fashion', [
    ['AliExpress', q => `https://www.aliexpress.com/w/wholesale-${q.trim().replace(/\s+/g, '-')}.html`], ['SHEIN', q => `https://us.shein.com/pdsearch/${encodeURIComponent(q)}/`]]],
  ['Ethical and niche brands', [
    ['Reformation', q => `https://www.thereformation.com/search?q=${plus(q)}`], ['Christy Dawn', q => `https://christydawn.com/search?q=${plus(q)}`],
    ['Doen', q => `https://www.shopdoen.com/search?q=${plus(q)}`], ['Lisa Says Gah', q => `https://lisasaysgah.com/search?q=${plus(q)}`],
    ['Mara Hoffman', q => `https://marahoffman.com/search?q=${plus(q)}`], ['Girlfriend Collective', q => `https://girlfriend.com/search?q=${plus(q)}`],
    ['Reclaimed Vintage', q => `https://www.reclaimedvintage.com/search?q=${plus(q)}`], ['Pact', q => `https://wearpact.com/search?q=${plus(q)}`],
    ['Eileen Fisher', q => `https://www.eileenfisher.com/search?q=${plus(q)}`]]]
];
const plus = q => encodeURIComponent(q.trim()).replace(/%20/g, '+');

function loadCanvas(src, max) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const sc = Math.min(1, max / Math.max(im.width, im.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * sc)); c.height = Math.max(1, Math.round(im.height * sc));
      c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, c.width, c.height); res(c);
    };
    im.onerror = rej; im.src = src;
  });
}

/* Separable box dilate/erode via running sums (merges nearby pieces, e.g. white stripes that match the backdrop). */
function boxMorph(src, W, H, r, erode) {
  const need = erode ? 2 * r + 1 : 1, tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let sum = 0; for (let x = -r; x < W + r; x++) { const add = x + r, rem = x - r - 1; if (add < W && add >= 0) sum += src[y * W + add]; if (rem >= 0 && rem < W) sum -= src[y * W + rem]; if (x >= 0 && x < W) tmp[y * W + x] = erode ? (sum === need && x - r >= 0 && x + r < W ? 1 : 0) : (sum > 0 ? 1 : 0); } }
  for (let x = 0; x < W; x++) { let sum = 0; for (let y = -r; y < H + r; y++) { const add = y + r, rem = y - r - 1; if (add < H && add >= 0) sum += tmp[add * W + x]; if (rem >= 0 && rem < H) sum -= tmp[rem * W + x]; if (y >= 0 && y < H) out[y * W + x] = erode ? (sum === need && y - r >= 0 && y + r < H ? 1 : 0) : (sum > 0 ? 1 : 0); } }
  return out;
}

/* Cut the item out from its (plain) background: the largest region unlike the border colour, closed and hole-filled. */
function segmentItem(c) {
  const W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data, N = W * H;
  const R = [], G = [], B = [], b = Math.max(2, Math.round(Math.min(W, H) * .03));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < b || y < b || x >= W - b || y >= H - b) { const i = (y * W + x) * 4; R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1], bg = [med(R), med(G), med(B)];
  const raw0 = new Uint8Array(N);
  for (let p = 0; p < N; p++) { const i = p * 4; raw0[p] = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) / 255 > .1 ? 1 : 0; }
  const cr = Math.max(2, Math.round(Math.min(W, H) * .045)), raw = boxMorph(boxMorph(raw0, W, H, cr, false), W, H, cr, true);
  const lab = new Int32Array(N), q = new Int32Array(N); let best = 0, bestN = 0, nl = 0;
  for (let s = 0; s < N; s++) if (raw[s] && !lab[s]) {
    nl++; let h0 = 0, t0 = 0; q[t0++] = s; lab[s] = nl;
    while (h0 < t0) { const p = q[h0++], x = p % W, y = (p / W) | 0;
      if (x > 0 && raw[p - 1] && !lab[p - 1]) { lab[p - 1] = nl; q[t0++] = p - 1; } if (x < W - 1 && raw[p + 1] && !lab[p + 1]) { lab[p + 1] = nl; q[t0++] = p + 1; }
      if (y > 0 && raw[p - W] && !lab[p - W]) { lab[p - W] = nl; q[t0++] = p - W; } if (y < H - 1 && raw[p + W] && !lab[p + W]) { lab[p + W] = nl; q[t0++] = p + W; } }
    if (t0 > bestN) { bestN = t0; best = nl; }
  }
  const mask = new Uint8Array(N); for (let p = 0; p < N; p++) mask[p] = lab[p] === best && best ? 1 : 0;
  // fill enclosed holes: anything the border flood-fill can't reach is inside the item
  const reach = new Uint8Array(N); let h1 = 0, t1 = 0; const push = p => { if (!mask[p] && !reach[p]) { reach[p] = 1; q[t1++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (h1 < t1) { const p = q[h1++], x = p % W, y = (p / W) | 0; if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W); }
  let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
  for (let p = 0; p < N; p++) { if (!reach[p]) { mask[p] = 1; area++; const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return { mask, W, H, bbox: [x0, y0, x1, y1], area, coverage: area / N, ok: area / N > .04 && area / N < .92 };
}

/* The item's own colours, ignoring the backdrop. */
function maskedPalette(c, seg) {
  const d = c.getContext('2d').getImageData(0, 0, seg.W, seg.H).data, bk = new Map();
  for (let p = 0; p < seg.W * seg.H; p++) { if (!seg.mask[p]) continue; const i = p * 4, k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); const e = bk.get(k) || { n: 0, r: 0, g: 0, b: 0 }; e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; bk.set(k, e); }
  return mergePalette([...bk.values()].map(e => ({ hex: rgb2hex([e.r / e.n, e.g / e.n, e.b / e.n]), w: e.n })), 5, 12);
}

/* Silhouette from the cut-out's width profile (works on flat-lay and product shots). */
function silhouetteOf(seg) {
  if (!seg.ok) return { tags: [], ok: false };
  const { mask, W, bbox: [x0, y0, x1, y1] } = seg, bw = x1 - x0 + 1, bh = y1 - y0 + 1, BANDS = 12, wd = new Array(BANDS).fill(0);
  for (let k = 0; k < BANDS; k++) {
    const ya = y0 + Math.floor(k * bh / BANDS), yb = Math.max(y0 + Math.floor((k + 1) * bh / BANDS), ya + 1); let tot = 0, n = 0;
    for (let y = ya; y < yb; y++) { let cnt = 0; for (let x = x0; x <= x1; x++) cnt += mask[y * W + x]; tot += cnt; n++; }
    wd[k] = tot / n / bw;
  }
  const shoulder = Math.max(...wd.slice(0, 4)), hem = Math.max(...wd.slice(8, 12)), waist = Math.min(...wd.slice(3, 8));
  const aspect = bh / bw, fill = seg.area / (bw * bh), taper = hem / Math.max(shoulder, .01), tags = [];
  if (aspect > 1.9) tags.push('long'); else if (aspect < .8) tags.push('cropped');
  if (taper > 1.3) tags.push('a-line'); else if (taper < .75) tags.push('tapered');
  if (waist / Math.max(Math.min(shoulder, hem), .01) < .75) tags.push('cinched waist');
  if (fill > .78 && aspect < 1.15) tags.push('boxy');
  return { tags: tags.slice(0, 3), aspect, taper, fill, ok: true };
}

/* Pattern from edge orientation and repetition, compared against a short list of known patterns. */
function patternOf(c, seg, palette) {
  const { mask, W, H } = seg; if (!seg.ok) return { name: 'solid', energy: 0 };
  const g = c.getContext('2d').getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) gray[p] = .299 * g[p * 4] + .587 * g[p * 4 + 1] + .114 * g[p * 4 + 2];
  const inner = new Uint8Array(W * H), r = 3;
  for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) { const p = y * W + x; if (!mask[p]) continue; let ok = 1; for (let dy = -r; dy <= r && ok; dy += r) for (let dx = -r; dx <= r; dx += r) if (!mask[p + dy * W + dx]) { ok = 0; break; } inner[p] = ok; }
  let Eh = 0, Ev = 0, n = 0; const [x0, y0, x1, y1] = seg.bbox, rows = [], cols = [];
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) { const p = y * W + x; if (inner[p] && inner[p - 1] && inner[p + 1] && inner[p - W] && inner[p + W]) { Ev += Math.abs(gray[p + 1] - gray[p - 1]); Eh += Math.abs(gray[p + W] - gray[p - W]); n++; } }
  if (n < 80) return { name: 'solid', energy: 0 };
  const prof = (len, at) => { const a = []; for (let i = 0; i < len; i++) { let s = 0, k = 0; at(i, v => { s += v; k++; }); a.push(k > 5 ? s / k : null); } return a.filter(v => v !== null); };
  const rp = prof(y1 - y0 + 1, (i, add) => { const y = y0 + i; for (let x = x0; x <= x1; x++) if (inner[y * W + x]) add(gray[y * W + x]); });
  const cp = prof(x1 - x0 + 1, (i, add) => { const x = x0 + i; for (let y = y0; y <= y1; y++) if (inner[y * W + x]) add(gray[y * W + x]); });
  const periodic = a => {
    if (a.length < 24) return false; const m = a.reduce((s, v) => s + v, 0) / a.length, z = a.map(v => v - m), v0 = z.reduce((s, v) => s + v * v, 0) / a.length;
    if (Math.sqrt(v0) < 6) return false; let best = 0;
    for (let l = 3; l < a.length / 3; l++) { let s = 0; for (let i = 0; i + l < a.length; i++) s += z[i] * z[i + l]; const rr = s / (a.length - l) / v0; if (rr > best) best = rr; }
    return best > .5;
  };
  const hs = periodic(rp), vs = periodic(cp), energy = (Eh + Ev) / n / 255, multi = palette.filter(p => p.w > .1).length >= 4;
  let name = 'solid';
  if (hs && vs) name = 'plaid'; else if (hs || vs) name = 'striped'; else if (energy < .03 && palette[0].w > .45) name = 'solid'; else if (multi) name = 'print'; else if (energy > .06) name = 'textured';
  return { name, energy, hs, vs };
}

async function zeroShot(emb, list, n, key) {
  ml.zs = ml.zs || {}; if (!ml.zs[key]) ml.zs[key] = await ml.texts(list.map(x => x[1]));
  const sims = ml.zs[key].map(t => dot(t, emb) * 100), mx = Math.max(...sims), ex = sims.map(s => Math.exp(s - mx)), sum = ex.reduce((a, b) => a + b);
  return list.map((x, i) => [x[0], ex[i] / sum]).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function addTag(f, k, v, on) { if (!f.tags.some(t => t.v === v)) f.tags.push({ k, v, on }); }
function findQuery(f) {
  const w = []; for (const k of ['color', 'det', 'pat', 'sil', 'type']) f.tags.filter(t => t.k === k && t.on).forEach(t => w.push(t.v));
  if (f.aes) { const kw = mineProfile(prof()).keywords[0]; if (kw) w.push(kw); }
  if (f.extra) w.push(f.extra);
  const seen = new Set(); return w.join(' ').split(/\s+/).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(' ');
}

async function startFind(rec) {
  const f = { src: rec.src, palette: rec.palette, stats: rec.stats, emb: rec.emb || null, tags: [], extra: '', aes: false, busy: true, urlText: state.find && state.find.urlText || '' };
  state.find = f; state.view = 'find'; render();
  try {
    const c = await loadCanvas(rec.src, 200), seg = segmentItem(c);
    f.sil = silhouetteOf(seg); if (seg.ok) f.palette = maskedPalette(c, seg); f.pat = patternOf(c, seg, f.palette); f.segOk = seg.ok;
  } catch { f.sil = { tags: [], ok: false }; f.pat = { name: 'solid' }; f.segOk = false; }
  f.palette.slice(0, 2).forEach((c, i) => { if (i === 0 || c.w > .2) addTag(f, 'color', nameColor(c.hex), i === 0); });
  if (f.pat.name !== 'solid') addTag(f, 'pat', f.pat.name, true);
  f.sil.tags.forEach((v, i) => addTag(f, 'sil', v, i < 2));
  TYPE_CHIPS.forEach(v => addTag(f, 'type', v, false));
  f.pngP = new Promise(res => loadCanvas(rec.src, 1200).then(cv => cv.toBlob(res, 'image/png'))).catch(() => null);
  f.busy = false; if (state.find === f) render();
  if (state.smart) clipRead(f);
}

async function clipRead(f) {
  try {
    await ml.load(); if (state.find !== f) return;
    f.reading = true; render();
    if (!f.emb) f.emb = await ml.image(f.src);
    const [types, fabrics, fits] = await Promise.all([zeroShot(f.emb, GARMENTS, 2, 'g'), zeroShot(f.emb, FABRICS, 3, 'f'), zeroShot(f.emb, FITS, 2, 's')]);
    if (state.find !== f) return;
    f.tags = f.tags.filter(t => !(t.k === 'type' && !t.on)); f.hasClip = true;
    types.forEach(([v], i) => { const old = f.tags.find(t => t.v === v); if (old) old.on = i === 0 || old.on; else f.tags.push({ k: 'type', v, on: i === 0 }); });
    fabrics.forEach(([v], i) => addTag(f, 'det', v, i < 2));
    fits.forEach(([v], i) => addTag(f, 'sil', v, i < 1));
  } catch { f.clipFail = true; }
  f.reading = false; if (state.find === f) render();
}

function postForm(action, fields) {
  const fm = document.createElement('form'); fm.method = 'POST'; fm.action = action; fm.target = '_blank'; fm.enctype = 'multipart/form-data'; fm.style.display = 'none';
  for (const [k, v] of Object.entries(fields)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; fm.appendChild(i); }
  document.body.appendChild(fm); fm.submit(); setTimeout(() => fm.remove(), 1500);
}

views.find = () => {
  const p = prof(), f = state.find;
  const head = header('Find', 'Find the piece', 'Show Trope something you love. It reads the silhouette, pattern and colors, then searches for it in shops and by image.', 'butterfly');
  if (!f) {
    const thumbs = p.images.slice(0, 24).map(i => `<button class="thumb" data-act="findpick" data-id="${i.id}" aria-label="Use this image"><img src="${i.src}" alt=""></button>`).join('');
    return `${head}<div class="drop" id="drop">${art('teal', 'dz-l')}${art('butterfly', 'dz-r')}<p class="big">Show me the piece</p><p class="muted">drop a photo of a garment, or paste with Ctrl/⌘ + V</p><p><button class="primary" data-act="findbrowse">Choose an image</button></p></div>
    ${thumbs ? `<h2 class="sub">Or pick from your collection</h2><div class="thumbs">${thumbs}</div>` : ''}
    <p class="note">Works best with one item on a plain background, like a product or flat-lay photo.</p>`;
  }
  const pr = mineProfile(p), fit = pr.stats ? matchScore({ palette: f.palette, stats: f.stats, emb: f.emb }, pr) : null;
  const q = findQuery(f), enc = encodeURIComponent(f.urlText || '');
  const group = (label, k) => { const idx = f.tags.map((t, i) => [t, i]).filter(([t]) => t.k === k); return idx.length ? `<div class="ctl"><span>${label}</span><div class="chips">${idx.map(([t, i]) => `<button class="chip" data-act="ftag" data-i="${i}" aria-pressed="${t.on}">${esc(t.v)}</button>`).join('')}</div></div>` : ''; };
  const smartLine = state.smart ? (f.reading ? 'Reading the garment type and fabric on your device…' : f.hasClip ? 'Garment type and fabric were read by the on-device model.' : f.clipFail ? 'Could not run smart analysis, so choose the item type yourself.' : '')
    : `Choose the item type below, or <button class="link" data-act="fsmart">turn on smart analysis</button> to have it detected on your device.`;
  return `${head}
  <div class="find-grid">
    <div>
      <img class="matchimg" src="${f.src}" alt="Item to find">
      <div style="margin-top:1rem">${swatches(f.palette, 'slim')}</div>
      ${fit !== null ? `<p class="muted small" style="margin-top:.8rem">Fits ${possessive(p).toLowerCase()} aesthetic: <b>${fit}%</b></p>` : ''}
      <p style="margin-top:1rem"><button class="ghost" data-act="freset">Use a different item</button></p>
    </div>
    <div class="find-main">
      <section class="card fade">
        <h2 class="sub">What I see</h2>
        ${f.segOk ? '' : '<p class="muted small">The item is hard to separate from its background, so the silhouette reading is rough. A plain background helps.</p>'}
        ${group('Item', 'type')}${group('Color', 'color')}${group('Silhouette', 'sil')}${group('Fabric and details', 'det')}${group('Pattern', 'pat')}
        <p class="muted small">${smartLine}</p>
        <div class="ctl"><span>Extra words</span><input type="text" data-change="fextra" value="${esc(f.extra)}" placeholder="vintage, 90s, linen…" maxlength="40"></div>
        <label class="inline"><input type="checkbox" data-change="faes" ${f.aes ? 'checked' : ''}> Add my aesthetic keyword</label>
        <p class="phrase">Searching for: <b>${esc(q || 'pick a few tags above')}</b></p>
      </section>
      <section class="card fade">
        <h2 class="sub">Search by image</h2>
        <p class="muted small">Bing matches the actual photo and lists shopping results. Google Lens needs a paste: the image is copied for you.</p>
        <div class="row"><button class="primary" data-act="fbing">Bing visual search</button><button class="ghost" data-act="flens">Google Lens</button></div>
        <div class="ctl" style="margin-top:1rem"><span>Or search by a picture's web address</span><input type="text" data-change="furl" value="${esc(f.urlText)}" placeholder="Paste an image link from Depop, Pinterest…"></div>
        ${f.urlText ? `<div class="links"><a class="chip" target="_blank" rel="noopener" href="https://lens.google.com/uploadbyurl?url=${enc}">Google Lens</a><a class="chip" target="_blank" rel="noopener" href="https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${enc}">Bing</a><a class="chip" target="_blank" rel="noopener" href="https://yandex.com/images/search?rpt=imageview&url=${enc}">Yandex</a><a class="chip" target="_blank" rel="noopener" href="https://tineye.com/search?url=${enc}">TinEye</a></div>` : ''}
        <p class="muted small" style="margin-top:1rem">Depop, AliExpress and SHEIN only offer photo search inside their apps. Bing and Lens do index their listings, and the shop links below use each store's own search.</p>
      </section>
      <section class="card fade">
        <h2 class="sub">Shop this look</h2>
        ${q ? SHOPS.map(([label, shops]) => `<div class="ctl shopgroup"><span>${label}</span><div class="links">${shops.map(([n, u]) => `<a class="chip" target="_blank" rel="noopener" href="${esc(u(q))}">${n}</a>`).join('')}</div></div>`).join('') : '<p class="muted">Pick a few tags above to build a search.</p>'}
        <p class="muted small">Ethical here means the brand markets sustainable or fair-made practices, so check a brand on <a href="https://directory.goodonyou.eco/" target="_blank" rel="noopener">Good On You</a> before buying.</p>
      </section>
    </div>
  </div>`;
};

/* ---------------- render ---------------- */
function render() {
  const p = prof();
  $('#profileBtn').textContent = p.name;
  $('#privacy').textContent = sync.code && sync.cfg ? 'Synced to your own Firebase project.' : 'Your images stay on this device unless you turn on sync.';
  $$('#nav button').forEach(b => b.dataset.view === state.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  const v = $('#view'); v.innerHTML = views[state.view](); v.classList.remove('fade'); void v.offsetWidth; v.classList.add('fade');
  renderBar();
  if (state.refocus) { const el = $(state.refocus); if (el) el.focus(); state.refocus = null; }
}

function renderBar() {
  const bar = $('#actionbar'), p = prof(), n = state.sel.size;
  if (!n || state.view !== 'collect') { bar.hidden = true; return; }
  const inGroup = state.filter !== 'all' && state.filter !== 'none' && p.groups.some(g => g.id === state.filter);
  bar.hidden = false;
  bar.innerHTML = `<strong>${n} selected</strong>
    ${p.groups.length ? `<select data-change="addto" aria-label="Add to aesthetic"><option value="">Add to aesthetic…</option>${p.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>` : ''}
    <button class="primary" data-act="newgroupsel">New aesthetic from these</button>
    ${inGroup ? '<button class="ghost" data-act="rmfromgroup">Remove from this group</button>' : ''}
    <button class="ghost danger" data-act="delsel">Delete</button>
    <button class="ghost" data-act="clearsel">Clear</button>`;
}

/* ---------------- dialogs ---------------- */
function openImage(id) {
  const p = prof(), im = p.images.find(i => i.id === id); if (!im) return;
  const d = $('#imgDialog');
  d.innerHTML = `<div class="dlg-grid"><img src="${im.src}" alt="">
    <div class="dlg-body">
      <div><h2 class="sub">Palette</h2>${swatches(im.palette)}
        <p class="muted small" style="margin:.6rem 0 0">${list(im.palette.slice(0, 4).map(c => nameColor(c.hex)))}${traitsOf(im.stats).length ? ' · ' + traitsOf(im.stats).join(', ') : ''}</p></div>
      <div><h2 class="sub">Aesthetics</h2>
        ${p.groups.length ? `<div class="chips">${p.groups.map(g => `<button class="chip" data-act="togglegroup" data-g="${g.id}" data-id="${id}" aria-pressed="${g.imageIds.includes(id)}"><i class="dot" style="--c:${g.color}"></i>${esc(g.name)}</button>`).join('')}</div>` : '<p class="muted small">No aesthetics yet. Create one on the Aesthetics page.</p>'}</div>
      <div class="row"><button class="ghost" data-act="matchthis" data-id="${id}">Test against my aesthetic</button><button class="ghost" data-act="findthis" data-id="${id}">Find clothes like this</button><button class="ghost danger" data-act="delimg" data-id="${id}">Delete</button><button class="primary" data-close>Close</button></div>
    </div></div>`;
  if (!d.open) d.showModal();
}

function openProfiles() {
  const d = $('#profileDialog');
  d.innerHTML = `<h2 class="display sm">Whose aesthetic?</h2>
    <p class="muted small">Keep a separate collection for each person: you, a friend, a gift recipient.</p>
    <div class="plist">${state.profiles.map(p => `<div class="item ${p.id === state.activeId ? 'on' : ''}"><span>${esc(p.name)} <small class="muted">· ${p.images.length} images</small></span>
      ${p.id === state.activeId ? '' : `<button class="ghost" data-act="switchprofile" data-id="${p.id}">Switch</button>`}
      <button class="ghost" data-act="renameprofile" data-id="${p.id}">Rename</button>
      ${state.profiles.length > 1 ? `<button class="ghost danger" data-act="delprofile" data-id="${p.id}">Delete</button>` : ''}</div>`).join('')}</div>
    <div class="row"><button class="primary" data-act="newprofile">Add a person</button><button class="ghost" data-close>Close</button></div>`;
  if (!d.open) d.showModal();
}

/* ---------------- grouping helpers ---------------- */
function createGroup(name, ids = [], keywords = [], color) {
  const p = prof();
  const g = { id: uid(), name, imageIds: [...ids], keywords, inMine: true, weight: 50, color: color || ACCENTS[p.groups.length % ACCENTS.length] };
  p.groups.push(g); return g;
}

/* k-means over each image's blended Lab colour to propose groups. */
function suggestGroups() {
  const p = prof(), imgs = p.images;
  if (imgs.length < 3) return toast('Add at least 3 images first');
  if (p.groups.length && !confirm('Add suggested aesthetics alongside your existing ones?')) return;
  const feat = imgs.map(i => { const f = [0, 0, 0]; i.palette.forEach(c => lab(c.hex).forEach((v, k) => f[k] += v * c.w)); return f; });
  const k = Math.min(5, Math.max(2, Math.round(imgs.length / 4)));
  const cent = [feat[0]];
  while (cent.length < k) {
    let bi = 0, bd = -1;
    feat.forEach((f, i) => { const d = Math.min(...cent.map(c => labDist(f, c))); if (d > bd) { bd = d; bi = i; } });
    cent.push(feat[bi]);
  }
  let asg = new Array(imgs.length).fill(0);
  for (let it = 0; it < 15; it++) {
    asg = feat.map(f => cent.reduce((bi, c, ci) => labDist(f, c) < labDist(f, cent[bi]) ? ci : bi, 0));
    cent.forEach((_, ci) => {
      const m = feat.filter((_, i) => asg[i] === ci);
      if (m.length) cent[ci] = [0, 1, 2].map(d => m.reduce((a, f) => a + f[d], 0) / m.length);
    });
  }
  let made = 0;
  for (let ci = 0; ci < k; ci++) {
    const ids = imgs.filter((_, i) => asg[i] === ci).map(i => i.id);
    if (!ids.length) continue;
    const pr = profileFrom([{ imgs: imgs.filter(i => ids.includes(i.id)), weight: 1 }]);
    createGroup(cap(`${nameColor(pr.palette[0].hex)}${pr.traits[0] ? ' · ' + pr.traits[0] : ''}`), ids, [], pr.palette[0].hex);
    made++;
  }
  save(); render(); toast(`Suggested ${made} aesthetics. Rename them to taste`);
}

/* ---------------- optional cloud sync (your own Firebase project) ----------------
   Meta (profiles/groups/palettes) is one doc; each image is its own doc, so no
   document nears Firestore's 1 MB limit. Access is by a long secret code. */
const sync = {
  db: null, remote: new Set(), timer: null, busy: false,
  get cfg() { return window.TROPE_FIREBASE; },
  get code() { try { return localStorage.getItem('trope-sync') || ''; } catch { return ''; } },
  set code(v) { try { v ? localStorage.setItem('trope-sync', v) : localStorage.removeItem('trope-sync'); } catch { /* ignore */ } },
  newCode() { const a = new Uint8Array(12); crypto.getRandomValues(a); const h = [...a].map(b => b.toString(16).padStart(2, '0')).join(''); return h.match(/.{6}/g).join('-'); },
  async init() {
    if (this.db || !this.cfg) return !!this.db;
    const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const v = '10.12.2';
    await load(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await load(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
    firebase.initializeApp(this.cfg); this.db = firebase.firestore(); return true;
  },
  schedule() { if (this.code && this.cfg) { clearTimeout(this.timer); this.timer = setTimeout(() => this.push().catch(() => toast('Sync failed. It will retry on the next change.')), 2500); } },
  ref() { return this.db.collection('sync').doc(this.code); },
  async push() {
    if (this.busy || !await this.init()) return; this.busy = true;
    try {
      const imgs = state.profiles.flatMap(p => p.images.map(i => ({ pid: p.id, i })));
      const meta = JSON.stringify({
        activeId: state.activeId, smart: state.smart,
        profiles: state.profiles.map(p => ({ ...p, images: p.images.map(({ src, emb, ...rest }) => rest) }))
      });
      const ids = new Set(imgs.map(x => x.i.id));
      const ops = [];
      for (const { pid, i } of imgs) if (!this.remote.has(i.id)) ops.push(b => b.set(this.ref().collection('images').doc(i.id), { pid, src: i.src, emb: i.emb || null }));
      for (const id of this.remote) if (!ids.has(id)) ops.push(b => b.delete(this.ref().collection('images').doc(id)));
      for (let k = 0; k < ops.length; k += 100) { const b = this.db.batch(); ops.slice(k, k + 100).forEach(o => o(b)); await b.commit(); }
      await this.ref().set({ meta, updated: state.updated });
      this.remote = ids;
    } finally { this.busy = false; }
  },
  async pull() {
    if (!this.code || !await this.init()) return;
    const doc = await this.ref().get();
    if (!doc.exists) return this.push();
    const { meta, updated } = doc.data();
    const snap = await this.ref().collection('images').get();
    const blobs = new Map(); snap.forEach(d => blobs.set(d.id, d.data())); this.remote = new Set(blobs.keys());
    if (updated <= state.updated) return this.push();           // this device is newer
    const m = JSON.parse(meta);
    state.profiles = m.profiles.map(p => ({ ...p, images: p.images.map(i => ({ ...i, ...(blobs.get(i.id) ? { src: blobs.get(i.id).src, emb: blobs.get(i.id).emb || undefined } : {}) })).filter(i => i.src) }));
    state.activeId = state.profiles.some(p => p.id === m.activeId) ? m.activeId : state.profiles[0].id;
    state.updated = updated; store.set('state', snapshot()); render(); toast('Synced from your other device');
  },
  async connect(code) {
    if (!this.cfg) return;
    try { this.code = code; await this.pull(); $('#syncDialog').close(); toast('Sync is on'); }
    catch { this.code = ''; toast('Could not reach cloud sync'); }
  },
  disconnect() { this.code = ''; this.remote = new Set(); $('#syncDialog').close(); toast('Sync turned off on this device'); },
  openDialog() {
    const d = $('#syncDialog');
    if (!this.cfg) d.innerHTML = `<h2 class="display sm">Sync devices</h2>
      <p class="muted">Cloud sync isn’t set up yet. Everything works offline in the meantime. To enable it, add your Firebase config to <b>firebase-config.js</b>. Steps are in README.md.</p>
      <div class="row end"><button class="primary" data-close>Okay</button></div>`;
    else if (this.code) d.innerHTML = `<h2 class="display sm">Sync is on</h2>
      <p class="muted">Enter this code on another device to share your collection. Anyone with the code can see your images, so keep it private.</p>
      <p class="code">${esc(this.code)}</p>
      <div class="row end"><button class="ghost danger" data-act="syncoff">Turn off here</button><button class="primary" data-close>Close</button></div>`;
    else d.innerHTML = `<h2 class="display sm">Sync devices</h2>
      <p class="muted">Keep your collection on your phone, tablet and laptop. Your images are stored in your own Firebase project, never with an AI service.</p>
      <div class="row end"><button class="ghost" data-act="syncjoin">I have a code</button><button class="primary" data-act="synccreate">Create a code</button></div>`;
    if (!d.open) d.showModal();
  }
};

/* ---------------- events ---------------- */
const actions = {
  async browse() { $('#fileInput').click(); },
  matchbrowse() { $('#matchInput').click(); },
  goto(el) { state.view = el.dataset.v; render(); window.scrollTo(0, 0); },
  filter(el) { state.filter = el.dataset.f; state.sel.clear(); render(); },
  sel(el) { const id = el.dataset.id; state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); render(); },
  open(el) { openImage(el.dataset.id); },
  clearsel() { state.sel.clear(); render(); },
  async newgroupsel() {
    const name = await askText('Name this aesthetic', 'e.g. Moonlit botanicals'); if (!name) return;
    createGroup(name, [...state.sel]); state.sel.clear(); save(); render(); toast('Aesthetic created');
  },
  rmfromgroup() { const g = prof().groups.find(g => g.id === state.filter); if (g) g.imageIds = g.imageIds.filter(i => !state.sel.has(i)); state.sel.clear(); save(); render(); },
  delsel() {
    if (!confirm(`Delete ${state.sel.size} image(s)?`)) return;
    const p = prof(); p.images = p.images.filter(i => !state.sel.has(i.id)); p.groups.forEach(g => g.imageIds = g.imageIds.filter(i => !state.sel.has(i)));
    state.sel.clear(); save(); render();
  },
  async newgroup() { const name = await askText('Name this aesthetic', 'e.g. Soft grunge'); if (!name) return; createGroup(name); save(); render(); },
  suggest() { suggestGroups(); },
  delgroup(el) {
    const p = prof(), g = p.groups.find(g => g.id === el.dataset.g);
    if (!g || !confirm(`Delete “${g.name}”? Its images stay in your collection.`)) return;
    p.groups = p.groups.filter(x => x !== g); if (state.filter === g.id) state.filter = 'all'; save(); render();
  },
  viewgroup(el) { state.filter = el.dataset.g; state.view = 'collect'; state.sel.clear(); render(); window.scrollTo(0, 0); },
  smart() { setSmart(!state.smart); },
  addkw(el) { const g = prof().groups.find(g => g.id === el.dataset.g); g.keywords.push(el.dataset.k); save(); render(); },
  sync() { sync.openDialog(); },
  async synccreate() { await sync.connect(sync.newCode()); },
  async syncjoin() {
    $('#syncDialog').close(); const c = await askText('Enter your sync code', 'xxxx-xxxx-xxxx-xxxx');
    if (c) await sync.connect(c.toLowerCase().replace(/\s+/g, ''));
  },
  syncoff() { sync.disconnect(); },
  rmkw(el) { const g = prof().groups.find(g => g.id === el.dataset.g); g.keywords = g.keywords.filter(k => k !== el.dataset.k); save(); render(); },
  togglegroup(el) {
    const g = prof().groups.find(g => g.id === el.dataset.g), id = el.dataset.id;
    g.imageIds = g.imageIds.includes(id) ? g.imageIds.filter(i => i !== id) : [...g.imageIds, id];
    save(); openImage(id); render();
  },
  delimg(el) {
    const p = prof(), id = el.dataset.id; p.images = p.images.filter(i => i.id !== id); p.groups.forEach(g => g.imageIds = g.imageIds.filter(i => i !== id));
    $('#imgDialog').close(); save(); render();
  },
  findbrowse() { $('#findInput').click(); },
  findpick(el) { const im = prof().images.find(i => i.id === el.dataset.id); if (im) startFind(im); },
  ftag(el) { const f = state.find, t = f.tags[+el.dataset.i]; if (t.k === 'type' && !t.on) f.tags.forEach(x => { if (x.k === 'type') x.on = false; }); t.on = !t.on; render(); },
  fbing() { postForm('https://www.bing.com/images/search?view=detailv2&iss=sbiupload&FORM=SBIHMP', { imageBin: state.find.src.split(',')[1] }); },
  flens() {
    const f = state.find, fail = () => toast('Could not copy the image. Save it and upload it on Google Lens.');
    try { navigator.clipboard.write([new ClipboardItem({ 'image/png': f.pngP })]).then(() => toast('Image copied. Press Ctrl+V on the Google Lens page.')).catch(fail); } catch { fail(); }
    window.open('https://lens.google.com/', '_blank');
  },
  fsmart() { setSmart(true).then(() => { if (state.find && state.smart) clipRead(state.find); }); },
  freset() { state.find = null; render(); },
  matchfind() { if (state.match) startFind(state.match); },
  findthis(el) { const im = prof().images.find(i => i.id === el.dataset.id); $('#imgDialog').close(); if (im) startFind(im); },
  matchthis(el) {
    const im = prof().images.find(i => i.id === el.dataset.id); state.match = im; $('#imgDialog').close(); state.view = 'match'; render();
  },
  async matchsave() {
    if (!state.match) return; const p = prof();
    if (!p.images.some(i => i.id === state.match.id)) { p.images.push({ ...state.match, id: uid() }); save(); toast('Added to your collection'); }
  },
  gcat(el) { state.gift.cat = el.dataset.v; render(); },
  shuffle() { state.gift.seed++; render(); },
  profiles() { openProfiles(); },
  switchprofile(el) { state.activeId = el.dataset.id; state.filter = 'all'; state.sel.clear(); state.match = null; state.gift.source = 'mine'; save(); render(); openProfiles(); },
  async newprofile() {
    $('#profileDialog').close(); const name = await askText('Whose aesthetic is this?', 'e.g. Maya');
    if (name) { const np = newProfile(name); state.profiles.push(np); state.activeId = np.id; state.filter = 'all'; state.sel.clear(); state.match = null; state.gift.source = 'mine'; save(); render(); }
  },
  async renameprofile(el) {
    const p = state.profiles.find(p => p.id === el.dataset.id); $('#profileDialog').close();
    const name = await askText('Rename', '', p.name); if (name) { p.name = name; save(); render(); }
  },
  delprofile(el) {
    const p = state.profiles.find(p => p.id === el.dataset.id);
    if (!confirm(`Delete ${p.name} and all of their images?`)) return;
    state.profiles = state.profiles.filter(x => x !== p);
    if (state.activeId === p.id) state.activeId = state.profiles[0].id;
    save(); render(); openProfiles();
  },
  export() {
    const blob = new Blob([JSON.stringify({ profiles: state.profiles, activeId: state.activeId })], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'trope-backup.json' }); a.click(); URL.revokeObjectURL(a.href);
  },
  import() { $('#importInput').click(); }
};

const changes = {
  rename(el) { const g = prof().groups.find(g => g.id === el.dataset.g); g.name = el.value.trim() || g.name; save(); render(); },
  inmine(el) { prof().groups.find(g => g.id === el.dataset.g).inMine = el.checked; save(); render(); },
  weight(el) { prof().groups.find(g => g.id === el.dataset.g).weight = +el.value; save(); },
  addto(el) {
    if (!el.value) return;
    const g = prof().groups.find(g => g.id === el.value); state.sel.forEach(id => { if (!g.imageIds.includes(id)) g.imageIds.push(id); });
    toast(`Added to “${g.name}”`); state.sel.clear(); save(); render();
  },
  fextra(el) { state.find.extra = el.value.trim(); render(); },
  furl(el) { state.find.urlText = el.value.trim(); render(); },
  faes(el) { state.find.aes = el.checked; render(); },
  gsource(el) { state.gift.source = el.value; render(); },
  gbudget(el) { state.gift.budget = +el.value; render(); }
};

document.addEventListener('click', e => {
  const nav = e.target.closest('#nav button'); if (nav) { state.view = nav.dataset.view; render(); window.scrollTo(0, 0); return; }
  const close = e.target.closest('[data-close]'); if (close) { close.closest('dialog').close(); return; }
  const el = e.target.closest('[data-act]'); if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]'); if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.kw) {
    const v = e.target.value.trim().toLowerCase(); if (!v) return;
    const g = prof().groups.find(g => g.id === e.target.dataset.kw);
    if (!g.keywords.includes(v)) g.keywords.push(v);
    state.refocus = `[data-kw="${g.id}"]`; save(); render();
  }
});

$('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
$('#findInput').addEventListener('change', e => { setFindFile(e.target.files[0]); e.target.value = ''; });
$('#matchInput').addEventListener('change', e => { setMatchFile(e.target.files[0]); e.target.value = ''; });
$('#importInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.profiles) || !data.profiles.length) throw 0;
    if (!confirm('Replace everything in this browser with the backup?')) return;
    state.profiles = data.profiles; state.activeId = data.activeId && data.profiles.some(p => p.id === data.activeId) ? data.activeId : data.profiles[0].id;
    save(); render(); toast('Backup restored');
  } catch { toast('That file is not a Trope backup'); }
});

/* drag-and-drop & paste work anywhere on the page */
const fileDrop = files => state.view === 'match' ? setMatchFile(files[0]) : state.view === 'find' ? setFindFile(files[0]) : addFiles(files);
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); const d = $('#drop'); if (d) d.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); const d = $('#drop'); if (d) d.classList.remove('over'); }));
window.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) fileDrop([...e.dataTransfer.files]); });
window.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); fileDrop(files); }
});

/* ---------------- boot ---------------- */
(async function init() {
  await store.open();
  const saved = await store.get('state');
  if (saved && saved.profiles && saved.profiles.length) { state.profiles = saved.profiles; state.activeId = saved.activeId; state.smart = !!saved.smart; state.updated = saved.updated || 0; }
  if (!state.profiles.some(p => p.id === state.activeId)) {
    if (!state.profiles.length) state.profiles = [newProfile('Me')];
    state.activeId = state.profiles[0].id;
  }
  render();
  if (sync.cfg && sync.code) sync.pull().catch(() => {});
  if (state.smart) ml.load().then(embedMissing).catch(() => { state.mlStatus = ''; render(); });   // keep the setting on if the download fails; it retries next visit
})();
