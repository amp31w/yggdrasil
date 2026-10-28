import { parseLine, parseWhatsAppExport, categories, configureParser, pocketCategory, hash } from './parser.js';

// ---------------------------------------------------------------------------
// Rencana keuangan
//
// Kode ini publik, jadi tidak boleh berisi angka atau rencana pribadi apa pun.
// Rencana yang sebenarnya (gaji, tagihan, target, jadwal) disimpan di Google Sheet
// pemilik (lihat PLAN di Code.gs) dan dimuat saat aplikasi terhubung.
// ---------------------------------------------------------------------------
const STORE_KEY = 'yggdrasil-v1';

const DEFAULT_SETTINGS = {
  configured: false,
  income: { main: { label: 'Gaji utama', amount: 0 }, side: { label: 'Gaji sampingan', amount: 0 } },
  fixed: [],
  savings: { dd: 0, trip: 0 },
  weekly: { 'Makan & Kopi': 0, 'Astro & Groceries': 0, 'Transport': 0 },
  monthly: { 'Sedekah': 0, 'Pulang & Keluarga': 0, 'Lainnya': 0 },
  dd: { initial: 0, goal: 0, tiers: [] },
  trip: {
    label: 'Liburan', title: 'Liburan', tags: [], departure: '', target: 0, initial: 0,
    windfall: { thr: 50, bonus: 50 }, treat: null, milestones: [], checklist: [],
  },
  schedule: [],
  moratorium: { start: '', end: '', limit: 0 },
  keywords: {},
};

// Gabungkan rencana tersimpan ke bentuk default, supaya field yang belum ada tetap aman dipakai.
function normalizeSettings(s = {}) {
  const d = structuredClone(DEFAULT_SETTINGS);
  return {
    ...d, ...s,
    income: { main: { ...d.income.main, ...s.income?.main }, side: { ...d.income.side, ...s.income?.side } },
    savings: { ...d.savings, ...s.savings },
    dd: { ...d.dd, ...s.dd },
    trip: { ...d.trip, ...s.trip, windfall: { ...d.trip.windfall, ...s.trip?.windfall } },
    moratorium: { ...d.moratorium, ...s.moratorium },
  };
}

// ---------------------------------------------------------------------------
// Penyimpanan lokal
// ---------------------------------------------------------------------------
function emptyState() {
  return { settings: normalizeSettings(), payday: {}, checklist: {}, milestones: {}, wishlist: [], deletedIds: [], lastImport: null };
}

function normalizeState(s = {}) {
  return { ...emptyState(), ...s, settings: normalizeSettings(s.settings) };
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  const db = saved || { txns: {}, meta: {} };
  db.txns ||= {};
  db.state = normalizeState(db.state);
  db.meta = { url: '', token: '', dirty: [], deletes: [], stateDirty: false, lastSync: null, ...db.meta };
  return db;
}

let db = load();
const S = () => db.state.settings;
const tripName = () => S().trip.label;
const pocketName = p => (p === 'dd' ? 'Darurat' : tripName());

function applyPlan() {
  const s = S();
  const keywords = { ...s.keywords };
  const fixedWords = s.fixed.flatMap(f => f.keywords || []);
  if (fixedWords.length) keywords['Tagihan Tetap'] = [...(keywords['Tagihan Tetap'] || []), ...fixedWords];
  configureParser({ tripLabel: s.trip.label, tripTags: s.trip.tags, keywords });
}

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { toast('Gagal menyimpan di perangkat: ' + e.message); }
}

function commit({ txIds = [], deletes = [], state = false } = {}) {
  const dirty = new Set(db.meta.dirty);
  txIds.forEach(id => dirty.add(id));
  deletes.forEach(id => dirty.delete(id));
  db.meta.dirty = [...dirty];
  db.meta.deletes = [...new Set([...db.meta.deletes, ...deletes])];
  if (state) db.meta.stateDirty = true;
  persist();
  render();
  scheduleSync();
}

function putTxns(list) {
  const now = Date.now();
  list.forEach(t => { db.txns[t.id] = { review: false, pocket: '', raw: '', ...t, updatedAt: now }; });
  commit({ txIds: list.map(t => t.id) });
}

function removeTxn(id) {
  const t = db.txns[id];
  if (!t) return;
  delete db.txns[id];
  // Supaya transaksi dari WA yang sudah dihapus tidak muncul lagi saat import ulang.
  if (t.source === 'wa' && !db.state.deletedIds.includes(id)) db.state.deletedIds.push(id);
  commit({ deletes: [id], state: t.source === 'wa' });
}

function setState(fn) {
  fn(db.state);
  commit({ state: true });
}

// ---------------------------------------------------------------------------
// Sinkron ke Google Sheet (Apps Script)
// ---------------------------------------------------------------------------
let syncTimer = null;
let syncing = false;
let syncError = '';

function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (!db.meta.url || !db.meta.token) { renderSync(); return; }
  if (syncing) { scheduleSync(); return; }
  if (!navigator.onLine) { renderSync(); return; }
  syncing = true; syncError = ''; render();

  const sentIds = [...db.meta.dirty];
  const sentDeletes = [...db.meta.deletes];
  const sentState = db.meta.stateDirty;
  const body = {
    token: db.meta.token,
    upserts: sentIds.map(id => db.txns[id]).filter(Boolean),
    deletes: sentDeletes,
    state: sentState ? db.state : undefined,
  };
  db.meta.stateDirty = false;

  try {
    let res;
    try {
      res = await fetch(db.meta.url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'Tidak ada jawaban dalam 30 detik' : 'URL tidak bisa dihubungi (cek URL /exec & akses "Anyone")');
    }
    let data;
    try { data = await res.json(); } catch { throw new Error('Jawaban bukan dari backend Yggdrasil (cek URL /exec & akses "Anyone")'); }
    if (!data.ok) throw new Error(data.error === 'unauthorized' ? 'Token tidak cocok dengan TOKEN di Code.gs' : data.error);

    const stillDirty = db.meta.dirty.filter(id => !sentIds.includes(id) || (db.txns[id] && db.txns[id].updatedAt > (body.upserts.find(t => t.id === id)?.updatedAt || 0)));
    const keep = Object.fromEntries(stillDirty.filter(id => db.txns[id]).map(id => [id, db.txns[id]]));
    const pendingDeletes = db.meta.deletes.filter(id => !sentDeletes.includes(id));
    const txns = {};
    data.transactions.forEach(t => { if (!pendingDeletes.includes(t.id)) txns[t.id] = t; });
    db.txns = { ...txns, ...keep };
    db.meta.dirty = stillDirty;
    db.meta.deletes = pendingDeletes;
    const wasConfigured = S().configured;
    if (!db.meta.stateDirty && data.state && Object.keys(data.state).length) db.state = normalizeState(data.state);
    if (!wasConfigured && S().configured) reparseWithPlan();
    db.meta.lastSync = new Date().toISOString();
  } catch (e) {
    if (sentState) db.meta.stateDirty = true;
    syncError = e.message || 'Gagal';
  } finally {
    syncing = false;
    persist();
    render();
    if (db.meta.dirty.length || db.meta.deletes.length || db.meta.stateDirty) if (!syncError) scheduleSync(500);
  }
}

// Catatan yang diketik sebelum rencana termuat dibaca tanpa kata kunci & tag pribadi; baca ulang sekali.
function reparseWithPlan() {
  applyPlan();
  const now = Date.now();
  Object.values(db.txns).forEach(t => {
    if (!t.raw || !['app', 'wa'].includes(t.source)) return;
    const p = parseLine(t.raw);
    if (!p || (p.type === t.type && p.category === t.category && p.pocket === t.pocket)) return;
    db.txns[t.id] = { ...t, ...p, updatedAt: now };
    if (!db.meta.dirty.includes(t.id)) db.meta.dirty.push(t.id);
  });
}

function renderSync() {
  const pill = document.getElementById('syncPill');
  const label = pill.querySelector('.label');
  const pending = db.meta.dirty.length + db.meta.deletes.length + (db.meta.stateDirty ? 1 : 0);
  let state = 'idle', text;
  if (!db.meta.url) text = 'Belum terhubung';
  else if (syncing) { state = 'busy'; text = 'Menyinkron…'; }
  else if (syncError) { state = 'err'; text = 'Gagal sinkron'; }
  else if (!navigator.onLine) text = pending ? `Offline · ${pending} antre` : 'Offline';
  else if (pending) { state = 'busy'; text = `${pending} antre`; }
  else { state = 'ok'; text = 'Tersinkron'; }
  pill.dataset.state = state;
  label.textContent = text;
  pill.title = syncError || (db.meta.lastSync ? 'Terakhir: ' + new Date(db.meta.lastSync).toLocaleString('id-ID') : '');
}

// ---------------------------------------------------------------------------
// Utilitas tanggal & format
// ---------------------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const tsOf = d => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function parseTs(ts) {
  const [date, time = '00:00'] = ts.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const s = startOfDay(d); return addDays(s, -((s.getDay() + 6) % 7)); }
const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const fmtDay = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtMonth = key => { const [y, m] = key.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
const fmtDate = d => `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;

const rp = n => (n < 0 ? '-' : '') + 'Rp' + Math.round(Math.abs(n)).toLocaleString('id-ID');
function short(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e6) return s + (a / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + 'jt';
  if (a >= 1e3) return s + (a / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + 'k';
  return s + a;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const sum = (list, f = t => t.amount) => list.reduce((s, t) => s + f(t), 0);
function money(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const p = parseLine('-' + s.replace(/^[-+]/, ''));
  return p ? p.amount : 0;
}
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------------------
// Perhitungan
// ---------------------------------------------------------------------------
const allTx = () => Object.values(db.txns).sort((a, b) => b.ts.localeCompare(a.ts));
const inRange = (t, from, to) => { const d = parseTs(t.ts); return d >= from && d < to; };

function weekStats(now = new Date()) {
  const s = S();
  const from = startOfWeek(now), to = addDays(from, 7);
  const cats = Object.keys(s.weekly);
  const list = allTx().filter(t => t.type === 'keluar' && cats.includes(t.category) && inRange(t, from, to));
  const byCat = Object.fromEntries(cats.map(c => [c, sum(list.filter(t => t.category === c))]));
  const budget = sum(cats, c => s.weekly[c]);
  const spent = sum(list);
  const remaining = budget - spent;
  const daysLeft = 7 - ((now.getDay() + 6) % 7);
  const firstDow = (new Date(now.getFullYear(), now.getMonth(), 1).getDay() + 6) % 7;
  const weekNo = Math.floor((now.getDate() - 1 + firstDow) / 7) + 1;
  return { from, to: addDays(to, -1), byCat, budget, spent, remaining, daysLeft, safe: remaining / daysLeft, weekNo };
}

function weekStatus(w) {
  if (w.remaining < 0) return { label: 'Over', tone: 'bad' };
  const base = w.budget / 7;
  if (w.safe >= base * 0.9) return { label: 'Aman', tone: 'good' };
  if (w.safe >= base * 0.6) return { label: 'Hati-hati', tone: 'warn' };
  return { label: 'Rem dulu', tone: 'bad' };
}

function monthTx(key) { return allTx().filter(t => t.ts.startsWith(key)); }

function pockets() {
  const s = S();
  const tx = allTx();
  const of = (type, pocket) => sum(tx.filter(t => t.type === type && t.pocket === pocket));
  const ddIn = s.dd.initial + of('nabung', 'dd'), ddOut = of('pakai', 'dd');
  const tripIn = s.trip.initial + of('nabung', 'trip'), tripOut = of('pakai', 'trip');
  return { dd: ddIn - ddOut, tripFunded: tripIn, tripSpent: tripOut, trip: tripIn - tripOut };
}

function isMoratoriumBreach(t) {
  const m = S().moratorium;
  if (!m.limit || !m.start || !m.end) return false;
  const d = t.ts.slice(0, 10);
  return t.type === 'keluar' && t.category === 'Hobi & Gadget' && t.amount > m.limit && d >= m.start && d <= m.end;
}

function daysToDeparture() {
  const dep = S().trip.departure;
  return dep ? Math.ceil((parseTs(dep) - startOfDay(new Date())) / 864e5) : null;
}

function scheduleFor(key) {
  let row = null;
  for (const r of S().schedule) if (r[0] <= key) row = r;
  return row;
}

const ddTop = () => S().dd.tiers.at(-1)?.amount || S().dd.goal || 0;
const fixedTotal = () => sum(S().fixed);
const opsTarget = () => S().income.main.amount + S().income.side.amount - fixedTotal() - S().savings.dd - S().savings.trip;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let currentTab = 'home';
let historyMonth = monthKey(new Date());
let historyFilter = 'all';

function render() {
  applyPlan();
  renderSync();
  if (currentTab === 'home') renderHome();
  if (currentTab === 'history') renderHistory();
  if (currentTab === 'goals') renderGoals();
  if (currentTab === 'more') renderMore();
}

function meter(label, spent, budget, extra = '') {
  const over = spent > budget;
  const tone = over ? 'bad' : spent > budget * 0.8 ? 'warn' : '';
  return `<div class="meter">
    <div class="row"><b>${label}${extra}</b><span>${short(spent)} / ${short(budget)}</span></div>
    <div class="bar ${tone}"><i style="width:${pct(spent, budget)}%"></i></div>
  </div>`;
}

function txItem(t, { showDate = false } = {}) {
  const d = parseTs(t.ts);
  const sign = t.type === 'masuk' ? '+' : t.type === 'nabung' ? '→' : '-';
  const cls = t.type === 'masuk' ? 'in' : t.type === 'nabung' ? 'save' : '';
  const pocket = t.pocket ? `<span class="chip ${t.pocket}">${esc(pocketName(t.pocket))}</span>` : '';
  const breach = isMoratoriumBreach(t) ? '<span class="chip bad">Moratorium</span>' : '';
  const when = showDate ? `${fmtDay(d)} · ` : '';
  return `<li><button class="tx" data-action="edit" data-id="${esc(t.id)}" type="button">
    ${t.review ? '<span class="flag" title="Perlu dicek"></span>' : ''}
    <div class="main">
      <div class="note">${esc(t.note || t.category)}</div>
      <div class="meta">${when}${esc(t.category)} · ${pad(d.getHours())}.${pad(d.getMinutes())}${t.source === 'wa' ? ' · WA' : ''} ${pocket}${breach}</div>
    </div>
    <div class="amt ${cls}">${sign}${short(t.amount)}</div>
  </button></li>`;
}

function setupCard() {
  let title = 'Rencanamu belum dimuat';
  let body = 'Gaji, tagihan, dan target disimpan privat di Google Sheet-mu, bukan di aplikasi publik ini. Hubungkan ke Sheet untuk memuatnya.';
  let button = '<button class="btn primary" data-action="settings" type="button">Hubungkan ke Google Sheet</button>';
  if (db.meta.url && syncing) {
    title = 'Menghubungi Google Sheet…';
    body = 'Permintaan pertama ke Apps Script bisa makan waktu 5–15 detik.';
    button = '';
  } else if (db.meta.url && syncError) {
    title = 'Gagal terhubung ke Google Sheet';
    body = `Alasan: <b>${esc(syncError)}</b>. Cek lagi URL /exec & token di Pengaturan, dan pastikan deployment Apps Script diatur "Who has access: Anyone".`;
    button = '<div class="btn-row"><button class="btn primary" data-action="sync" type="button">Coba lagi</button><button class="btn" data-action="settings" type="button">Pengaturan</button></div>';
  } else if (db.meta.url && db.meta.lastSync) {
    title = 'Terhubung, tapi rencana tidak ditemukan';
    body = 'Sheet menjawab, tapi tidak mengirim rencana. Biasanya karena Apps Script masih menjalankan versi lama: di Apps Script buka <b>Deploy → Manage deployments → ✏️ → Version: New version → Deploy</b>, lalu tekan Coba lagi.';
    button = '<button class="btn primary" data-action="sync" type="button">Coba lagi</button>';
  }
  return `<div class="card stack">
    <h3>${title}</h3>
    <p class="hint">${body}</p>
    ${button}
  </div>`;
}

function renderHome() {
  const el = document.getElementById('view-home');
  const now = new Date();
  const todayKey = ymd(now);
  const today = allTx().filter(t => t.type === 'keluar' && t.ts.startsWith(todayKey));
  const todayCard = `<div class="card">
      <div class="card-head"><h3>Hari ini</h3><span class="sub">${today.length ? '-' + short(sum(today)) : 'Belum ada'}</span></div>
      ${today.length ? `<ul class="tx-list">${today.map(t => txItem(t)).join('')}</ul>` : '<p class="hint">Ketik di kolom bawah, sama seperti di grup WA: <code>-30k ayam geprek</code></p>'}
    </div>`;

  if (!S().configured) { el.innerHTML = setupCard() + todayCard; return; }

  const s = S();
  const w = weekStats(now);
  const st = weekStatus(w);
  const key = monthKey(now);
  const month = monthTx(key);
  const p = pockets();
  const nextTier = s.dd.tiers.find(t => p.dd < t.amount);
  const breaches = month.filter(isMoratoriumBreach);
  const paydayDone = db.state.payday[key]?.done;
  const reviewCount = allTx().filter(t => t.review).length;
  const days = daysToDeparture();

  const banners = [];
  if (now.getDate() <= 5 && !paydayDone) {
    banners.push(`<div class="banner"><div><b>Gajian ${MONTHS_LONG[now.getMonth()]}</b><div class="small">Bagi gaji dulu sebelum dipakai.</div></div><button class="btn primary" data-action="payday" type="button">Mulai</button></div>`);
  }
  if (breaches.length) {
    banners.push(`<div class="banner bad"><div><b>Moratorium dilanggar</b><div class="small">${breaches.length} belanja hobi/gadget &gt; ${short(s.moratorium.limit)} bulan ini (${short(sum(breaches))}).</div></div></div>`);
  }
  if (reviewCount) {
    banners.push(`<div class="banner info"><div><b>${reviewCount} catatan perlu dicek</b><div class="small">Kategori atau nominalnya ditebak.</div></div><button class="btn" data-action="goto-review" type="button">Cek</button></div>`);
  }

  const monthlyCats = Object.keys(s.monthly);
  const monthlyBy = c => sum(month.filter(t => t.type === 'keluar' && (c === 'Lainnya' ? ['Lainnya', 'Kesehatan'].includes(t.category) : t.category === c)));
  const hobby = sum(month.filter(t => t.type === 'keluar' && t.category === 'Hobi & Gadget'));

  el.innerHTML = `
    ${banners.join('')}
    <div class="card hero ${w.remaining < 0 ? 'over' : ''}">
      <div class="card-head" style="margin-bottom:4px">
        <h2>Sisa kuota minggu ${w.weekNo} · ${fmtDay(w.from)}–${fmtDay(w.to)}</h2>
        <span class="chip">${st.label}</span>
      </div>
      <div class="big">${rp(w.remaining)} <small>/ ${short(w.budget)}</small></div>
      <div class="bar thick" style="margin-top:12px"><i style="width:${pct(w.remaining, w.budget)}%"></i></div>
      <div class="safe"><span>Aman dipakai per hari<br><span class="muted small">${w.daysLeft} hari lagi sampai Minggu</span></span><b>${rp(Math.max(0, w.safe))}</b></div>
    </div>

    <div class="card stack">
      ${Object.keys(s.weekly).map(c => meter(c, w.byCat[c], s.weekly[c])).join('')}
    </div>

    ${todayCard}

    <div class="grid-2">
      <button class="card" data-action="tab" data-tab="goals" type="button" style="text-align:left">
        <h2>Dana Darurat</h2>
        <div style="font-size:20px;font-weight:800;margin:2px 0 8px">${short(p.dd)}</div>
        <div class="bar dd"><i style="width:${pct(p.dd, nextTier ? nextTier.amount : ddTop())}%"></i></div>
        <div class="small muted" style="margin-top:6px">${nextTier ? `${short(nextTier.amount - p.dd)} lagi ke ${esc(nextTier.label.split(' ·')[0])}` : 'Semua tier tercapai'}</div>
      </button>
      <button class="card" data-action="tab" data-tab="goals" type="button" style="text-align:left">
        <h2>${esc(tripName())}${days !== null ? ` · ${Math.max(0, days)} hari lagi` : ''}</h2>
        <div style="font-size:20px;font-weight:800;margin:2px 0 8px">${short(p.tripFunded)}</div>
        <div class="bar trip"><i style="width:${pct(p.tripFunded, s.trip.target)}%"></i></div>
        <div class="small muted" style="margin-top:6px">${Math.round(pct(p.tripFunded, s.trip.target))}% dari ${short(s.trip.target)}</div>
      </button>
    </div>

    <div class="card stack">
      <div class="card-head" style="margin:0"><h3>Pos bulanan · ${MONTHS_LONG[now.getMonth()]}</h3></div>
      ${monthlyCats.map(c => meter(c === 'Lainnya' ? 'Lain-lain & buffer' : c, monthlyBy(c), s.monthly[c])).join('')}
      ${meter('Hobi & Gadget', hobby, 0, s.moratorium.limit ? ' <span class="chip warn">moratorium</span>' : '')}
    </div>
  `;
}

function renderHistory() {
  const el = document.getElementById('view-history');
  const key = historyMonth;
  let list = historyFilter === 'review' ? allTx().filter(t => t.review) : monthTx(key);
  const month = monthTx(key);
  const income = sum(month.filter(t => t.type === 'masuk'));
  const expense = sum(month.filter(t => t.type === 'keluar' || (t.type === 'pakai' && t.pocket !== 'trip')));
  const saved = sum(month.filter(t => t.type === 'nabung'));
  const byCat = {};
  month.filter(t => t.type === 'keluar').forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = cats[0]?.[1] || 1;

  if (historyFilter !== 'all' && historyFilter !== 'review') list = list.filter(t => t.type === historyFilter);
  const groups = {};
  list.forEach(t => { (groups[t.ts.slice(0, 10)] ||= []).push(t); });

  el.innerHTML = `
    <div class="switcher">
      <button class="icon-btn" data-action="month" data-dir="-1" type="button" aria-label="Bulan sebelumnya">‹</button>
      <h3>${fmtMonth(key)}</h3>
      <button class="icon-btn" data-action="month" data-dir="1" type="button" aria-label="Bulan berikutnya">›</button>
    </div>
    <div class="card">
      <div class="grid-2" style="gap:10px">
        <div><h2>Pemasukan</h2><div style="font-size:19px;font-weight:800;color:var(--good)">${short(income)}</div></div>
        <div><h2>Pengeluaran</h2><div style="font-size:19px;font-weight:800">${short(expense)}</div></div>
        <div><h2>Ditabung</h2><div style="font-size:19px;font-weight:800;color:var(--dd)">${short(saved)}</div></div>
        <div><h2>Sisa bersih</h2><div style="font-size:19px;font-weight:800">${short(income - expense - saved)}</div></div>
      </div>
    </div>
    ${cats.length ? `<div class="card stack"><h3>Per kategori</h3>${cats.map(([c, v]) => `
      <div class="cat-row"><span>${esc(c)}</span><span class="small muted">${short(v)} · ${Math.round((v / expense) * 100) || 0}%</span>
      <div class="bar ${c === 'Hobi & Gadget' ? 'bad' : ''}"><i style="width:${(v / maxCat) * 100}%"></i></div></div>`).join('')}</div>` : ''}
    <div class="segmented">
      ${[['all', 'Semua'], ['keluar', 'Keluar'], ['masuk', 'Masuk'], ['nabung', 'Kantong'], ['review', 'Perlu dicek']].map(([k, l]) => `<button class="${historyFilter === k ? 'on' : ''}" data-action="filter" data-filter="${k}" type="button">${l}</button>`).join('')}
    </div>
    ${Object.keys(groups).length ? Object.entries(groups).map(([day, items]) => {
      const d = parseTs(day);
      const out = sum(items.filter(t => t.type === 'keluar'));
      return `<div class="tx-day"><div class="tx-day-head"><span>${DAYS[d.getDay()]}, ${fmtDay(d)}</span><span>${out ? '-' + short(out) : ''}</span></div>
        <ul class="tx-list">${items.map(t => txItem(t)).join('')}</ul></div>`;
    }).join('') : `<div class="empty">${historyFilter === 'review' ? 'Semua catatan sudah rapi.' : 'Belum ada catatan di bulan ini.'}</div>`}
  `;
}

const checkIcon = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderGoals() {
  const el = document.getElementById('view-goals');
  if (!S().configured) { el.innerHTML = setupCard(); return; }
  const s = S();
  const p = pockets();
  const now = new Date();
  const key = monthKey(now);
  const paidThisMonth = db.state.payday[key]?.done;
  const compareKey = paidThisMonth ? key : monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const plan = scheduleFor(compareKey);
  const diff = (actual, expected) => {
    const d = actual - expected;
    if (Math.abs(d) < 1000) return '<span class="chip good">Sesuai rencana</span>';
    return d > 0 ? `<span class="chip good">+${short(d)} dari rencana</span>` : `<span class="chip warn">Kurang ${short(-d)}</span>`;
  };
  const days = daysToDeparture();
  const dep = s.trip.departure ? parseTs(s.trip.departure) : null;
  const top = ddTop();

  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Dana Darurat</h3>${plan ? diff(p.dd, plan[1]) : ''}</div>
      <div class="big" style="color:var(--dd)">${rp(p.dd)}</div>
      <div class="bar thick dd" style="margin-top:12px">
        <i style="width:${pct(p.dd, top)}%"></i>
        ${s.dd.tiers.slice(0, -1).map(t => `<span class="tick" style="left:${pct(t.amount, top)}%"></span>`).join('')}
      </div>
      <div class="tiers">${s.dd.tiers.map(t => `<span class="${p.dd >= t.amount ? 'done' : ''}">${esc(t.label)}<br>${short(t.amount)}</span>`).join('')}</div>
      ${s.dd.goal && dep ? `<p class="hint" style="margin-top:10px">Target ${MONTHS_LONG[dep.getMonth()]} ${dep.getFullYear()}: ${short(s.dd.goal)}. Tidak dipakai untuk ${esc(tripName())}.</p>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><h3>${esc(s.trip.title)}${dep ? ` · ${MONTHS_LONG[dep.getMonth()]} ${dep.getFullYear()}` : ''}</h3>${plan ? diff(p.tripFunded, plan[2]) : ''}</div>
      <div class="row" style="align-items:flex-end">
        <div>
          <div class="big" style="color:var(--trip)">${rp(p.tripFunded)}</div>
          <div class="small muted">terkumpul dari ${short(s.trip.target)} · saldo kantong ${short(p.trip)}</div>
        </div>
        ${days !== null ? `<div class="countdown"><b>${Math.max(0, days)}</b><span class="small muted">hari<br>lagi</span></div>` : ''}
      </div>
      <div class="bar thick trip" style="margin:12px 0 4px"><i style="width:${pct(p.tripFunded, s.trip.target)}%"></i></div>
      <p class="hint">${dep ? `Berangkat ${DAYS[dep.getDay()]}, ${fmtDate(dep)}. ` : ''}Usahakan ada cadangan 5–10% dari target untuk biaya tak terduga.</p>
      <div style="margin-top:8px">
        ${s.trip.milestones.map(m => {
          const paid = db.state.milestones[m.id];
          const tx = paid && db.txns[paid];
          return `<div class="milestone">
            <button class="check ${tx ? 'on trip' : ''}" data-action="milestone" data-id="${esc(m.id)}" type="button" aria-label="Tandai ${esc(m.name)}">${tx ? checkIcon : ''}</button>
            <div class="main"><b>${esc(m.name)}</b><div class="small muted">${esc(m.due || '')}${tx ? ` · dibayar ${short(tx.amount)}` : ''}</div></div>
            <span class="small" style="font-weight:700">${short(m.amount)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    ${s.schedule.length ? `<div class="card">
      <div class="card-head"><h3>Rencana vs aktual</h3><span class="sub">setelah setoran bulan itu</span></div>
      <table class="plan-table">
        <thead><tr><th>Bulan</th><th>Darurat</th><th>Setoran ${esc(tripName())}</th></tr></thead>
        <tbody>${s.schedule.map(([k, dd, trip]) => `<tr class="${k === compareKey ? 'now' : ''}"><td>${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}</td><td>${short(dd)}</td><td>${short(trip)}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>Dapat THR / bonus?</h3></div>
      <p class="hint" style="margin-bottom:10px">Bagi langsung ke kantong supaya tidak ikut terpakai.</p>
      <button class="btn block" data-action="windfall" type="button">Bagi THR / bonus</button>
    </div>

    ${s.trip.checklist.length ? `<div class="card">
      <div class="card-head"><h3>Persiapan ${esc(tripName())}</h3><span class="sub">${s.trip.checklist.filter(c => db.state.checklist[c[0]]).length}/${s.trip.checklist.length}</span></div>
      ${s.trip.checklist.map(([id, label, when]) => `<div class="checkline">
        <button class="check ${db.state.checklist[id] ? 'on' : ''}" data-action="check" data-id="${esc(id)}" type="button" aria-label="${esc(label)}">${db.state.checklist[id] ? checkIcon : ''}</button>
        <div class="main"><div style="${db.state.checklist[id] ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(label)}</div><div class="small muted">${esc(when || '')}</div></div>
      </div>`).join('')}
    </div>` : ''}
  `;
}

const ICONS = {
  import: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  payday: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
  wish: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M9 3h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
  backup: '<path d="M4 7h16v12H4zM4 7l2-3h12l2 3M9 12h6"/>',
};

function renderMore() {
  const el = document.getElementById('view-more');
  const waiting = db.state.wishlist.filter(w => w.status === 'waiting').length;
  const item = (action, icon, t, d) => `<li><button data-action="${action}" type="button"><span class="ic"><svg viewBox="0 0 24 24">${ICONS[icon]}</svg></span><span><div class="t">${t}</div><div class="d">${d}</div></span></button></li>`;
  el.innerHTML = `
    <ul class="menu">
      ${item('payday', 'payday', 'SOP gajian tanggal 1', 'Checklist bagi gaji & setor ke kantong')}
      ${item('wishlist', 'wish', 'Wishlist 14 hari', waiting ? `${waiting} barang masih ditahan` : 'Tahan dulu keinginan belanja gadget')}
      ${item('help', 'help', 'Cara mencatat', 'Format singkat yang dikenali')}
    </ul>
    <ul class="menu">
      ${item('settings', 'settings', 'Pengaturan & sinkron', db.meta.url ? 'Terhubung ke Google Sheet' : 'Hubungkan ke Google Sheet')}
      ${item('backup', 'backup', 'Backup JSON', 'Unduh atau pulihkan semua data')}
      ${item('import', 'import', 'Pindahkan riwayat dari WA', db.state.lastImport ? 'Sudah dipindahkan · bisa diulang dengan aman' : 'Sekali saja: bawa catatan lama grup WA')}
    </ul>
    <p class="hint" style="text-align:center">${Object.keys(db.txns).length} transaksi tersimpan</p>
  `;
}

// ---------------------------------------------------------------------------
// Sheet (dialog)
// ---------------------------------------------------------------------------
function openSheet({ title, body, foot = '', onMount }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close type="button" aria-label="Tutup">✕</button></div>
    <div class="sheet-body">${body}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  dlg.showModal();
  onMount?.(dlg, close);
  return dlg;
}

function requirePlan() {
  if (S().configured) return true;
  toast('Hubungkan ke Google Sheet dulu supaya rencanamu termuat');
  openSettings();
  return false;
}

// ---------- Edit transaksi ----------
function categoryOptions(type, selected) {
  let list;
  if (type === 'masuk') list = categories().masuk;
  else if (type === 'nabung') list = [pocketCategory('dd'), pocketCategory('trip')];
  else list = categories().keluar;
  if (selected && !list.includes(selected)) list = [selected, ...list];
  return list.map(c => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function openEdit(id) {
  const t = id ? db.txns[id] : { id: uid('app'), ts: tsOf(new Date()), type: 'keluar', category: 'Makan & Kopi', amount: 0, note: '', pocket: '', source: 'app' };
  if (!t) return;
  openSheet({
    title: id ? 'Ubah catatan' : 'Catatan baru',
    body: `
      ${t.raw ? `<p class="hint">Teks asli: <code>${esc(t.raw)}</code></p>` : ''}
      <label class="field"><span>Jenis</span><select name="type">
        ${[['keluar', 'Pengeluaran'], ['masuk', 'Pemasukan'], ['nabung', 'Setor ke kantong'], ['pakai', 'Bayar dari kantong']].map(([v, l]) => `<option value="${v}" ${t.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label class="field"><span>Nominal</span><input name="amount" inputmode="decimal" value="${t.amount ? t.amount.toLocaleString('id-ID') : ''}" placeholder="30k / 30.000"></label>
      <label class="field"><span>Catatan</span><input name="note" value="${esc(t.note)}"></label>
      <label class="field"><span>Kategori</span><select name="category">${categoryOptions(t.type, t.category)}</select></label>
      <label class="field" data-pocket ${['nabung', 'pakai'].includes(t.type) ? '' : 'hidden'}><span>Kantong</span><select name="pocket">
        <option value="dd" ${t.pocket === 'dd' ? 'selected' : ''}>Dana Darurat</option>
        <option value="trip" ${t.pocket === 'trip' ? 'selected' : ''}>${esc(tripName())}</option>
      </select></label>
      <label class="field"><span>Waktu</span><input name="ts" type="datetime-local" value="${t.ts}"></label>
    `,
    foot: `${id ? '<button class="btn danger" data-del type="button">Hapus</button>' : ''}<button class="btn primary" data-save type="button">Simpan</button>`,
    onMount(dlg, close) {
      const f = n => dlg.querySelector(`[name="${n}"]`);
      f('type').addEventListener('change', () => {
        const type = f('type').value;
        f('category').innerHTML = categoryOptions(type, type === 'pakai' ? tripName() : '');
        dlg.querySelector('[data-pocket]').hidden = !['nabung', 'pakai'].includes(type);
      });
      f('pocket').addEventListener('change', () => {
        if (f('type').value === 'nabung') f('category').value = pocketCategory(f('pocket').value);
      });
      dlg.querySelector('[data-save]').addEventListener('click', () => {
        const amount = money(f('amount').value);
        if (!amount) { toast('Nominal belum diisi'); return; }
        const type = f('type').value;
        putTxns([{ ...t, type, amount, note: f('note').value.trim(), category: f('category').value, pocket: ['nabung', 'pakai'].includes(type) ? f('pocket').value : '', ts: f('ts').value || t.ts, review: false }]);
        close();
      });
      dlg.querySelector('[data-del]')?.addEventListener('click', () => {
        if (!confirm('Hapus catatan ini?')) return;
        removeTxn(t.id);
        close();
      });
    },
  });
}

// ---------- Import WA ----------
async function readImportFile(file) {
  if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
    if (!window.JSZip) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    const zip = await window.JSZip.loadAsync(file);
    const txt = Object.values(zip.files).find(f => /\.txt$/i.test(f.name));
    if (!txt) throw new Error('Tidak ada file .txt di dalam zip');
    return txt.async('string');
  }
  return file.text();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Gagal memuat ' + src));
    document.head.appendChild(s);
  });
}

function openImport(prefill = '') {
  openSheet({
    title: 'Pindahkan riwayat dari WA',
    body: `
      <p class="hint">Cukup sekali, supaya catatan lama ikut masuk. Di WA: buka grup catatanmu → ⋮ → Lainnya → Ekspor chat → <b>Tanpa media</b>, lalu pilih <b>Yggdrasil</b> di menu bagikan (atau simpan filenya dan pilih di bawah). Baris yang sudah ada otomatis dilewati.</p>
      <label class="btn block" style="position:relative">Pilih file .txt / .zip
        <input type="file" accept=".txt,.zip,text/plain,application/zip" data-file style="position:absolute;inset:0;opacity:0">
      </label>
      <label class="field"><span>Atau tempel teksnya</span><textarea data-text placeholder="[14/10/2026 11.35] -37k nasi goreng">${esc(prefill)}</textarea></label>
      <label class="field"><span>Ambil mulai tanggal (opsional)</span><input type="date" data-since></label>
      <div data-result></div>
    `,
    foot: '<button class="btn primary" data-go type="button" disabled>Import</button>',
    onMount(dlg, close) {
      const text = dlg.querySelector('[data-text]');
      const since = dlg.querySelector('[data-since]');
      const result = dlg.querySelector('[data-result]');
      const go = dlg.querySelector('[data-go]');
      let fresh = [];
      let skippedRows = [];
      // Perbaikan manual untuk baris yang dilewati: kunci "ts|baris asli" → teks pengganti.
      const fixes = new Map();
      const fixedTxns = () => skippedRows.flatMap(s => {
        const value = fixes.get(s.ts + '|' + s.line);
        const p = value && parseLine(value);
        return p ? [{ id: 'wa-fix-' + hash(s.ts + '|' + s.line), ts: s.ts, raw: value, source: 'wa', ...p }] : [];
      }).filter(t => !db.txns[t.id]);
      const updateGo = () => {
        const n = fresh.length + fixedTxns().length;
        go.disabled = !n;
        go.textContent = n ? `Import ${n} catatan` : 'Tidak ada yang baru';
      };

      const analyse = () => {
        const raw = text.value;
        if (!raw.trim()) { result.innerHTML = ''; go.disabled = true; return; }
        const { transactions, skipped } = parseWhatsAppExport(raw);
        const tomb = new Set(db.state.deletedIds);
        const from = since.value;
        const inScope = transactions.filter(t => !from || t.ts.slice(0, 10) >= from);
        fresh = inScope.filter(t => !db.txns[t.id] && !tomb.has(t.id));
        skippedRows = skipped.filter(s => !from || s.ts.slice(0, 10) >= from);
        const dup = inScope.length - fresh.length;
        const rev = fresh.filter(t => t.review).length;
        updateGo();
        result.innerHTML = `
          <div class="btn-row" style="margin-bottom:10px">
            <span class="chip good">${fresh.length} baru</span>
            <span class="chip">${dup} sudah ada</span>
            ${rev ? `<span class="chip warn">${rev} perlu dicek</span>` : ''}
            <span class="chip">${skippedRows.length} baris dilewati</span>
          </div>
          ${fresh.length ? `<ul class="tx-list preview-list">${fresh.slice().reverse().slice(0, 300).map(t => txItem(t, { showDate: true }).replace('data-action="edit"', 'disabled')).join('')}</ul>` : ''}
          ${skippedRows.length ? `<details style="margin-top:10px"><summary>Lihat & perbaiki baris yang dilewati</summary>
            <p class="hint" style="margin:8px 0">Saldo, pesan sistem grup, dan rincian struk memang sengaja dilewati. Kalau ada yang sebenarnya transaksi, ketik ulang di kotaknya, mis. <code>-171k belanja astro</code>.</p>
            <div class="skip-list">${skippedRows.slice(0, 300).map(s => {
              const key = s.ts + '|' + s.line;
              const d = parseTs(s.ts);
              return `<div class="skip-row">
                <div class="small muted">${fmtDay(d)} · ${esc(s.line)}</div>
                <input class="input" data-fix="${esc(key)}" value="${esc(fixes.get(key) || '')}" placeholder="Ketik ulang kalau ini transaksi">
                <span class="small" data-fix-preview="${esc(key)}"></span>
              </div>`;
            }).join('')}</div>
          </details>` : ''}
        `;
        result.querySelectorAll('[data-fix]').forEach(inp => showFix(inp));
      };

      const showFix = inp => {
        const key = inp.dataset.fix;
        const out = [...result.querySelectorAll('[data-fix-preview]')].find(el => el.dataset.fixPreview === key);
        const p = inp.value.trim() && parseLine(inp.value);
        out.innerHTML = !inp.value.trim() ? '' : p ? `<span class="chip good">${esc(p.category)} · ${rp(p.amount)}</span>` : '<span class="chip warn">Belum terbaca: awali dengan - atau + dan nominal</span>';
      };

      result.addEventListener('input', e => {
        const inp = e.target.closest('[data-fix]');
        if (!inp) return;
        fixes.set(inp.dataset.fix, inp.value.trim());
        showFix(inp);
        updateGo();
      });

      dlg.querySelector('[data-file]').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        try { text.value = await readImportFile(file); analyse(); } catch (err) { toast(err.message); }
      });
      text.addEventListener('input', analyse);
      since.addEventListener('change', analyse);
      go.addEventListener('click', () => {
        const all = [...fresh, ...fixedTxns()];
        putTxns(all);
        db.state.lastImport = new Date().toISOString();
        commit({ state: true });
        toast(`${all.length} catatan masuk`);
        close();
      });
      if (prefill) analyse();
    },
  });
}

// ---------- SOP gajian ----------
function openPayday() {
  if (!requirePlan()) return;
  const s = S();
  const now = new Date();
  const key = monthKey(now);
  const month = monthTx(key);
  const record = db.state.payday[key] || { checks: {} };
  const existingIncome = cat => sum(month.filter(t => t.type === 'masuk' && t.category === cat));
  const recorded = f => {
    const words = (f.keywords || []).map(w => w.toLowerCase());
    return words.length > 0 && month.some(t => t.type === 'keluar' && !t.id.startsWith('pay-') && words.some(w => (t.note + ' ' + t.raw).toLowerCase().includes(w)));
  };
  const savedManually = pocket => month.some(t => t.type === 'nabung' && t.pocket === pocket && !t.id.startsWith('pay-'));
  const { main, side } = s.income;

  openSheet({
    title: `Gajian ${fmtMonth(key)}`,
    body: `
      <div class="grid-2" style="gap:10px">
        <label class="field"><span>${esc(main.label)}</span><input data-in="main" inputmode="decimal" value="${(existingIncome('Gaji Utama') || main.amount).toLocaleString('id-ID')}"></label>
        <label class="field"><span>${esc(side.label)}</span><input data-in="side" inputmode="decimal" value="${(existingIncome('Gaji Sampingan') || side.amount).toLocaleString('id-ID')}"></label>
      </div>
      <div data-surplus></div>
      <div class="card" style="padding:4px 14px" data-list></div>
      <div class="banner info" data-ops></div>
      <p class="hint">Gaji & tagihan yang sudah kamu ketik sendiri bulan ini tidak akan dicatat dua kali.</p>
    `,
    foot: '<button class="btn primary" data-save type="button">Simpan & catat</button>',
    onMount(dlg, close) {
      const $ = q => dlg.querySelector(q);
      let alloc = record.alloc || 'trip';
      const draw = () => {
        const mainAmt = money($('[data-in="main"]').value);
        const sideAmt = money($('[data-in="side"]').value);
        const surplus = Math.max(0, sideAmt - side.amount);
        const half = Math.floor(surplus / 2);
        const toDD = s.savings.dd + (alloc === 'dd' ? surplus : alloc === 'split' ? half : 0);
        const toTrip = s.savings.trip + (alloc === 'trip' ? surplus : alloc === 'split' ? surplus - half : 0);
        const items = [
          ...s.fixed.map(f => ({ id: f.id, label: f.label, amount: f.amount, done: recorded(f) })),
          { id: 'dd', label: 'Setor ke Kantong Dana Darurat', amount: toDD, done: savedManually('dd') },
          { id: 'trip', label: `Setor ke ${pocketCategory('trip')}`, amount: toTrip, done: savedManually('trip') },
        ];
        $('[data-surplus]').innerHTML = surplus ? `
          <div class="banner info" style="display:grid;gap:8px">
            <div><b>Surplus ${esc(side.label.toLowerCase())} ${rp(surplus)}</b><div class="small">Tidak boleh masuk rekening operasional. Arahkan ke:</div></div>
            <div class="segmented">${[['trip', tripName()], ['dd', 'Darurat'], ['split', '50 : 50']].map(([k, l]) => `<button type="button" data-alloc="${k}" class="${alloc === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
          </div>` : '';
        $('[data-list]').innerHTML = items.map(i => {
          const on = i.done || record.checks[i.id];
          return `<div class="checkline">
            <button class="check ${on ? 'on' : ''}" data-check="${esc(i.id)}" ${i.done ? 'disabled' : ''} type="button">${on ? checkIcon : ''}</button>
            <div class="main"><div>${esc(i.label)}</div>${i.done ? '<div class="small muted">Sudah kamu catat bulan ini</div>' : ''}</div>
            <b class="small">${rp(i.amount)}</b>
          </div>`;
        }).join('');
        const ops = mainAmt + sideAmt - fixedTotal() - toDD - toTrip;
        const target = opsTarget();
        $('[data-ops]').innerHTML = `<div><b>Sisa di rekening operasional: ${rp(ops)}</b><div class="small">Seharusnya ${rp(target)}${Math.abs(ops - target) > 1000 ? ` · selisih ${short(ops - target)}` : ' ✓'}</div></div>`;
        return { mainAmt, sideAmt, toDD, toTrip, items };
      };
      dlg.addEventListener('input', e => { if (e.target.matches('[data-in]')) draw(); });
      dlg.addEventListener('click', e => {
        const a = e.target.closest('[data-alloc]');
        if (a) { alloc = a.dataset.alloc; draw(); }
        const c = e.target.closest('[data-check]');
        if (c && !c.disabled) { record.checks[c.dataset.check] = !record.checks[c.dataset.check]; draw(); }
      });
      draw();

      $('[data-save]').addEventListener('click', () => {
        const { mainAmt, sideAmt, toDD, toTrip, items } = draw();
        const ts = `${key}-01T08:00`;
        const out = [];
        if (!existingIncome('Gaji Utama') && mainAmt) out.push({ id: `pay-${key}-main`, ts, type: 'masuk', category: 'Gaji Utama', amount: mainAmt, note: main.label, source: 'payday' });
        if (!existingIncome('Gaji Sampingan') && sideAmt) out.push({ id: `pay-${key}-side`, ts: `${key}-02T08:00`, type: 'masuk', category: 'Gaji Sampingan', amount: sideAmt, note: side.label, source: 'payday' });
        items.forEach(i => {
          if (i.done || !record.checks[i.id]) return;
          if (i.id === 'dd' || i.id === 'trip') {
            out.push({ id: `pay-${key}-${i.id}`, ts, type: 'nabung', pocket: i.id, category: pocketCategory(i.id), amount: i.id === 'dd' ? toDD : toTrip, note: 'Setoran gajian', source: 'payday' });
          } else {
            out.push({ id: `pay-${key}-${i.id}`, ts, type: 'keluar', category: 'Tagihan Tetap', amount: i.amount, note: i.label, source: 'payday' });
          }
        });
        const allDone = items.every(i => i.done || record.checks[i.id]);
        db.state.payday[key] = { ...record, alloc, done: allDone };
        if (out.length) putTxns(out);
        commit({ state: true });
        toast(allDone ? 'Gajian beres. Semua sudah di kantongnya.' : 'Progres disimpan');
        close();
      });
    },
  });
}

// ---------- THR / bonus ----------
function openWindfall() {
  if (!requirePlan()) return;
  const wf = S().trip.windfall;
  openSheet({
    title: 'Bagi THR / bonus',
    body: `
      <div class="segmented" data-preset>
        <button type="button" data-p="thr" class="on">THR</button>
        <button type="button" data-p="bonus">Bonus</button>
      </div>
      <label class="field"><span>Jumlah</span><input data-amt inputmode="decimal" placeholder="contoh: 5jt"></label>
      <label class="field"><span>Porsi ke ${esc(pocketCategory('trip'))}: <b data-pct></b></span><input type="range" min="0" max="100" step="5" value="${wf.thr}" data-range></label>
      <div class="grid-2" style="gap:10px">
        <div class="card"><h2>Dana Darurat</h2><b data-dd style="font-size:18px;color:var(--dd)"></b></div>
        <div class="card"><h2>${esc(tripName())}</h2><b data-trip style="font-size:18px;color:var(--trip)"></b></div>
      </div>
      <p class="hint">Porsi bawaan sesuai rencanamu: THR ${wf.thr}% dan bonus ${wf.bonus}% ke ${esc(tripName())}.</p>
    `,
    foot: '<button class="btn primary" data-save type="button">Catat & bagi</button>',
    onMount(dlg, close) {
      const $ = q => dlg.querySelector(q);
      let kind = 'thr';
      const draw = () => {
        const amt = money($('[data-amt]').value);
        const p = Number($('[data-range]').value);
        const trip = Math.round((amt * p) / 100);
        $('[data-pct]').textContent = p + '%';
        $('[data-dd]').textContent = rp(amt - trip);
        $('[data-trip]').textContent = rp(trip);
        return { amt, trip, dd: amt - trip };
      };
      $('[data-preset]').addEventListener('click', e => {
        const b = e.target.closest('[data-p]');
        if (!b) return;
        kind = b.dataset.p;
        dlg.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x === b));
        $('[data-range]').value = wf[kind];
        draw();
      });
      dlg.addEventListener('input', draw);
      draw();
      $('[data-save]').addEventListener('click', () => {
        const { amt, trip, dd } = draw();
        if (!amt) { toast('Isi jumlahnya dulu'); return; }
        const ts = tsOf(new Date());
        const id = uid(kind);
        const label = kind === 'thr' ? 'THR' : 'Bonus';
        const out = [{ id, ts, type: 'masuk', category: label, amount: amt, note: label, source: 'app' }];
        if (dd) out.push({ id: id + '-dd', ts, type: 'nabung', pocket: 'dd', category: pocketCategory('dd'), amount: dd, note: `${label} → Darurat`, source: 'app' });
        if (trip) out.push({ id: id + '-trip', ts, type: 'nabung', pocket: 'trip', category: pocketCategory('trip'), amount: trip, note: `${label} → ${tripName()}`, source: 'app' });
        putTxns(out);
        toast(`${label} sudah dibagi ke kantong`);
        close();
      });
    },
  });
}

// ---------- Milestone liburan ----------
function toggleMilestone(id) {
  const m = S().trip.milestones.find(x => x.id === id);
  if (!m) return;
  const existing = db.state.milestones[id];
  if (existing && db.txns[existing]) {
    if (!confirm(`Batalkan tanda "${m.name}" sudah dibayar?`)) return;
    delete db.state.milestones[id];
    removeTxn(existing);
    commit({ state: true });
    return;
  }
  openSheet({
    title: esc(m.name),
    body: `<label class="field"><span>Dibayar dari ${esc(pocketCategory('trip'))}</span><input data-amt inputmode="decimal" value="${m.amount.toLocaleString('id-ID')}"></label>
      <p class="hint">Masukkan harga sebenarnya. Selisih dari anggaran (${rp(m.amount)}) langsung terlihat di saldo kantong.</p>`,
    foot: '<button class="btn primary" data-save type="button">Tandai dibayar</button>',
    onMount(dlg, close) {
      dlg.querySelector('[data-save]').addEventListener('click', () => {
        const amount = money(dlg.querySelector('[data-amt]').value);
        if (!amount) return;
        const txId = 'ms-' + id;
        db.state.milestones[id] = txId;
        putTxns([{ id: txId, ts: tsOf(new Date()), type: 'pakai', pocket: 'trip', category: tripName(), amount, note: m.name, source: 'app' }]);
        commit({ state: true });
        close();
      });
    },
  });
}

// ---------- Wishlist 14 hari ----------
function openWishlist() {
  const s = S();
  const draw = dlg => {
    const list = db.state.wishlist;
    const saved = sum(list.filter(w => w.status === 'dropped'), w => w.price);
    const daily = (s.weekly['Makan & Kopi'] || 0) / 7;
    const top = ddTop();
    dlg.querySelector('[data-list]').innerHTML = list.length ? list.slice().reverse().map(w => {
      const left = 14 - Math.floor((Date.now() - new Date(w.addedAt)) / 864e5);
      const locked = left > 0;
      const status = w.status === 'dropped' ? '<span class="chip good">Batal beli</span>' : w.status === 'bought' ? '<span class="chip warn">Dibeli</span>' : locked ? `<span class="chip">Terkunci ${left} hari</span>` : '<span class="chip warn">Boleh diputuskan</span>';
      const compare = [
        daily ? `${Math.round(w.price / daily)} hari jatah makan` : '',
        s.trip.treat?.idr ? `${Math.round(w.price / s.trip.treat.idr)} ${esc(s.trip.treat.label)}` : '',
        top ? `${(w.price / top * 100).toFixed(1)}% target Dana Darurat` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="wish">
        <div class="row"><b>${esc(w.name)}</b><b>${short(w.price)}</b></div>
        ${compare ? `<div class="small muted">= ${compare}</div>` : ''}
        <div class="row">${status}
          ${w.status === 'waiting' ? `<div class="btn-row">
            <button class="btn ghost" data-wish="drop" data-id="${w.id}" type="button">Batal beli</button>
            <button class="btn" data-wish="buy" data-id="${w.id}" type="button" ${locked ? 'disabled' : ''}>Beli</button>
          </div>` : ''}
        </div>
      </div>`;
    }).join('') : '<div class="empty">Belum ada. Kalau tiba-tiba pengin gadget, taruh di sini dulu.</div>';
    dlg.querySelector('[data-saved]').textContent = saved ? `Uang yang sudah kamu selamatkan: ${rp(saved)}` : '';
  };
  const m = s.moratorium;
  openSheet({
    title: 'Wishlist 14 hari',
    body: `
      <p class="hint">${m.end && m.limit ? `Moratorium sampai ${fmtDate(parseTs(m.end))}: gadget, peripheral, lampu, game di atas ${short(m.limit)}. ` : ''}Tulis dulu di sini, tunggu 14 hari, baru putuskan.</p>
      <div class="grid-2" style="gap:8px;grid-template-columns:1fr 120px">
        <input class="input" data-name placeholder="Nama barang">
        <input class="input" data-price inputmode="decimal" placeholder="Harga">
      </div>
      <button class="btn block" data-add type="button">Tahan di wishlist</button>
      <b class="small" style="color:var(--good)" data-saved></b>
      <div data-list></div>
    `,
    onMount(dlg) {
      draw(dlg);
      dlg.querySelector('[data-add]').addEventListener('click', () => {
        const name = dlg.querySelector('[data-name]').value.trim();
        const price = money(dlg.querySelector('[data-price]').value);
        if (!name || !price) { toast('Isi nama & harga'); return; }
        setState(st => st.wishlist.push({ id: uid('w'), name, price, addedAt: new Date().toISOString(), status: 'waiting' }));
        dlg.querySelector('[data-name]').value = '';
        dlg.querySelector('[data-price]').value = '';
        draw(dlg);
      });
      dlg.addEventListener('click', e => {
        const b = e.target.closest('[data-wish]');
        if (!b || b.disabled) return;
        const w = db.state.wishlist.find(x => x.id === b.dataset.id);
        if (b.dataset.wish === 'drop') {
          setState(() => { w.status = 'dropped'; });
          toast('Mantap. Uangnya tetap di jalur tabungan.');
        } else {
          if (!confirm(`Yakin beli ${w.name} ${rp(w.price)}?`)) return;
          setState(() => { w.status = 'bought'; });
          putTxns([{ id: uid('app'), ts: tsOf(new Date()), type: 'keluar', category: 'Hobi & Gadget', amount: w.price, note: w.name, source: 'app' }]);
        }
        draw(dlg);
      });
    },
  });
}

// ---------- Pengaturan ----------
function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = val;
}

function openSettings() {
  const s = S();
  const field = (label, path, kind = 'money') => {
    const v = getPath(s, path);
    const value = kind === 'money' ? Number(v || 0).toLocaleString('id-ID') : v ?? '';
    return `<label class="field"><span>${esc(label)}</span><input data-path="${esc(path)}" data-kind="${kind}" ${kind === 'date' ? 'type="date"' : kind === 'money' ? 'inputmode="decimal"' : ''} value="${esc(value)}"></label>`;
  };
  const planFields = s.configured ? `
      <div class="card stack">
        <h3>Pemasukan</h3>
        ${field('Nama gaji utama', 'income.main.label', 'text')}
        ${field('Jumlah gaji utama', 'income.main.amount')}
        ${field('Nama gaji sampingan', 'income.side.label', 'text')}
        ${field('Batas bawah gaji sampingan', 'income.side.amount')}
      </div>
      ${s.fixed.length ? `<div class="card stack"><h3>Tagihan tetap</h3>${s.fixed.map((f, i) => field(f.label, `fixed.${i}.amount`)).join('')}</div>` : ''}
      <div class="card stack">
        <h3>Setoran bulanan</h3>
        ${field('Ke Dana Darurat', 'savings.dd')}
        ${field(`Ke ${pocketCategory('trip')}`, 'savings.trip')}
      </div>
      <div class="card stack">
        <h3>Kuota mingguan (Senin–Minggu)</h3>
        ${Object.keys(s.weekly).map(k => field(k, `weekly.${k}`)).join('')}
      </div>
      <div class="card stack">
        <h3>Pos bulanan</h3>
        ${Object.keys(s.monthly).map(k => field(k === 'Lainnya' ? 'Lain-lain & buffer' : k, `monthly.${k}`)).join('')}
      </div>
      <div class="card stack">
        <h3>Target</h3>
        ${field('Saldo awal Dana Darurat', 'dd.initial')}
        ${field('Target Dana Darurat', 'dd.goal')}
        ${field('Nama kantong tujuan', 'trip.label', 'text')}
        ${field('Judul tujuan', 'trip.title', 'text')}
        ${field('Target dana tujuan', 'trip.target')}
        ${field('Saldo awal kantong tujuan', 'trip.initial')}
        ${field('Tanggal berangkat', 'trip.departure', 'date')}
      </div>
      <details class="card">
        <summary>Lanjutan: edit seluruh rencana (JSON)</summary>
        <p class="hint" style="margin:8px 0">Untuk milestone, checklist, jadwal, tier, dan kata kunci. Kalau bagian ini diubah, isian di atas diabaikan.</p>
        <label class="field"><textarea data-json style="min-height:240px">${esc(JSON.stringify(s, null, 2))}</textarea></label>
      </details>` : `<div class="card"><p class="hint">Setelah terhubung, rencanamu dari Google Sheet muncul di sini dan bisa diubah.</p></div>`;

  openSheet({
    title: 'Pengaturan',
    body: `
      <div class="card stack">
        <h3>Sinkron Google Sheet</h3>
        <label class="field"><span>URL Web App (…/exec)</span><input data-url value="${esc(db.meta.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field"><span>Token</span><input data-token type="password" value="${esc(db.meta.token)}" autocomplete="off"></label>
        <p class="hint">URL & token hanya disimpan di perangkat ini. Isi dengan nilai yang sama di HP dan laptop.</p>
        <div class="small" style="color:var(--bad)">${esc(syncError)}</div>
      </div>
      ${planFields}
    `,
    foot: '<button class="btn primary" data-save type="button">Simpan</button>',
    onMount(dlg, close) {
      const jsonBox = dlg.querySelector('[data-json]');
      const jsonInitial = jsonBox?.value;
      dlg.querySelector('[data-save]').addEventListener('click', () => {
        const url = dlg.querySelector('[data-url]').value.trim();
        const token = dlg.querySelector('[data-token]').value.trim();
        if (url !== db.meta.url || token !== db.meta.token) {
          // Koneksi baru: kirim semua transaksi lokal, lalu ambil rencana dari Sheet.
          db.meta.url = url; db.meta.token = token;
          db.meta.dirty = Object.keys(db.txns);
          db.meta.stateDirty = false;
          syncError = '';
          persist();
          sync();
          close();
          toast(url ? 'Menghubungkan ke Google Sheet…' : 'Sinkron dimatikan');
          return;
        }
        if (!S().configured) { close(); return; }
        if (jsonBox && jsonBox.value !== jsonInitial) {
          let parsed;
          try { parsed = JSON.parse(jsonBox.value); } catch (e) { toast('JSON tidak valid: ' + e.message); return; }
          setState(st => { st.settings = normalizeSettings({ ...parsed, configured: true }); });
        } else {
          setState(st => {
            dlg.querySelectorAll('[data-path]').forEach(inp => {
              const v = inp.dataset.kind === 'money' ? money(inp.value) : inp.value.trim();
              setPath(st.settings, inp.dataset.path, v);
            });
          });
        }
        close();
        toast('Tersimpan');
      });
    },
  });
}

function openBackup() {
  openSheet({
    title: 'Backup JSON',
    body: `
      <p class="hint">Unduh semua transaksi & pengaturan sebagai file JSON. Simpan di Google Drive sebagai cadangan kedua selain Sheet.</p>
      <button class="btn block" data-dl type="button">Unduh backup</button>
      <label class="btn block" style="position:relative">Pulihkan dari file backup
        <input type="file" accept="application/json,.json" data-up style="position:absolute;inset:0;opacity:0">
      </label>
    `,
    onMount(dlg, close) {
      dlg.querySelector('[data-dl]').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), transactions: Object.values(db.txns), state: db.state }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `yggdrasil-backup-${ymd(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
      dlg.querySelector('[data-up]').addEventListener('change', async e => {
        try {
          const data = JSON.parse(await e.target.files[0].text());
          if (!Array.isArray(data.transactions)) throw new Error('Format tidak dikenali');
          if (!confirm(`Pulihkan ${data.transactions.length} transaksi? Data dengan id sama akan ditimpa.`)) return;
          if (data.state) db.state = normalizeState(data.state);
          putTxns(data.transactions);
          commit({ state: true });
          toast('Data dipulihkan');
          close();
        } catch (err) { toast(err.message); }
      });
    },
  });
}

function openHelp() {
  const tag = S().trip.tags[0] || 'trip';
  const row = (input, out) => `<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><code>${esc(input)}</code><span class="small muted" style="text-align:right">${esc(out)}</span></div>`;
  openSheet({
    title: 'Cara mencatat',
    body: `
      <p class="hint">Ketik di kolom bawah Beranda, sama seperti dulu di grup WA. Tanda <b>-</b> = keluar, <b>+</b> = masuk. Satuan: <code>k</code> <code>rb</code> <code>ribu</code> <code>jt</code> <code>juta</code>, desimal pakai titik atau koma. Satu baris = satu transaksi.</p>
      <div class="card" style="padding:4px 14px">
        ${row('-30k ayam geprek 2pcs', 'Makan & Kopi · 30.000')}
        ${row('-115.5 k belanja astro', 'Astro · 115.500')}
        ${row('-7.5k gojek', 'Transport · 7.500')}
        ${row('kebab jumbo -25k', 'Makan & Kopi · 25.000')}
        ${row('+2jt freelance', 'Gaji Sampingan · 2.000.000')}
        ${row('+500k >dd', 'Setor ke Dana Darurat')}
        ${row(`+500k >${tag}`, `Setor ke ${pocketCategory('trip')}`)}
        ${row(`-1.2jt tiket pesawat >${tag}`, `Bayar dari ${pocketCategory('trip')}`)}
      </div>
      <p class="hint">Catatan yang kategorinya ditebak atau angkanya tanpa satuan (mis. <code>-30 ayam</code> → 30rb) diberi titik kuning. Cek di Riwayat → Perlu dicek.</p>
      <p class="hint">Lupa catat kemarin? Ketuk chip <b>Hari ini</b> di sebelah kolom ketik untuk pilih tanggal. Salah ketik? Tekan <b>Batalkan</b> di notifikasi, atau ketuk catatannya untuk ubah/hapus.</p>
    `,
  });
}

// ---------------------------------------------------------------------------
// Toast (opsional dengan tombol aksi, mis. Batalkan)
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.classList.toggle('actionable', !!action);
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.fn(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 3200);
}

// ---------------------------------------------------------------------------
// Composer (input cepat)
// ---------------------------------------------------------------------------
const input = document.getElementById('composerInput');
const dateInput = document.getElementById('composerDate');
const dateLabel = document.getElementById('composerDateLabel');
const preview = document.getElementById('composerPreview');

function composerTs() {
  const now = new Date();
  const picked = dateInput.value;
  if (!picked || picked === ymd(now)) return tsOf(now);
  return `${picked}T12:00`;
}

function updateDateChip() {
  const v = dateInput.value;
  const isToday = !v || v === ymd(new Date());
  dateLabel.textContent = isToday ? 'Hari ini' : fmtDay(parseTs(v));
  dateInput.parentElement.classList.toggle('custom', !isToday);
}

function updatePreview() {
  const lines = input.value.split('\n').map(l => l.trim()).filter(Boolean);
  preview.innerHTML = lines.map(l => {
    const p = parseLine(l);
    if (!p) return `<span class="chip">“${esc(l.slice(0, 20))}” belum terbaca</span>`;
    const tone = p.type === 'masuk' ? 'good' : p.pocket ? p.pocket : p.review ? 'warn' : '';
    return `<span class="chip ${tone}">${esc(p.category)} · ${rp(p.amount)}</span>`;
  }).join('');
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function submitComposer() {
  const lines = input.value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const ts = composerTs();
  const parsed = lines.map(l => [l, parseLine(l)]);
  const bad = parsed.filter(([, p]) => !p);
  if (bad.length) { toast(`Tidak terbaca: "${bad[0][0]}". Awali dengan - atau + dan nominal.`); return; }
  const list = parsed.map(([raw, p]) => ({ id: uid('app'), ts, raw, source: 'app', ...p }));
  putTxns(list);
  input.value = '';
  dateInput.value = '';
  updateDateChip();
  updatePreview();
  autosize();
  const first = list[0];
  const lead = list.length > 1 ? `${list.length} catatan masuk` : `${first.category} ${short(first.amount)}`;
  let msg = lead;
  if (S().configured) {
    const w = weekStats();
    msg += ` · sisa minggu ini ${short(w.remaining)} (${short(Math.max(0, w.safe))}/hari)`;
  }
  toast(msg, {
    label: 'Batalkan',
    fn: () => {
      list.forEach(t => { delete db.txns[t.id]; });
      // Selalu kirim hapus: bisa jadi sinkron sedang berjalan dan baris sudah sampai di Sheet.
      commit({ deletes: list.map(t => t.id) });
      input.value = lines.join('\n');
      updatePreview(); autosize(); input.focus();
    },
  });
}

input.addEventListener('input', () => { autosize(); updatePreview(); });
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); }
});
dateInput.addEventListener('change', updateDateChip);
document.getElementById('composer').addEventListener('submit', e => { e.preventDefault(); submitComposer(); });

// ---------------------------------------------------------------------------
// Navigasi & aksi
// ---------------------------------------------------------------------------
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + tab; });
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('composer').hidden = tab === 'more' || tab === 'goals';
  render();
  window.scrollTo({ top: 0 });
}

document.getElementById('tabbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('dialog')) return;
  const { action } = el.dataset;
  switch (action) {
    case 'tab': showTab(el.dataset.tab); break;
    case 'edit': openEdit(el.dataset.id); break;
    case 'payday': openPayday(); break;
    case 'import': openImport(); break;
    case 'windfall': openWindfall(); break;
    case 'wishlist': openWishlist(); break;
    case 'settings': openSettings(); break;
    case 'backup': openBackup(); break;
    case 'help': openHelp(); break;
    case 'milestone': toggleMilestone(el.dataset.id); break;
    case 'check': setState(st => { st.checklist[el.dataset.id] = !st.checklist[el.dataset.id]; }); break;
    case 'goto-review': historyFilter = 'review'; showTab('history'); break;
    case 'filter': historyFilter = el.dataset.filter; renderHistory(); break;
    case 'month': {
      const [y, m] = historyMonth.split('-').map(Number);
      historyMonth = monthKey(new Date(y, m - 1 + Number(el.dataset.dir), 1));
      if (historyFilter === 'review') historyFilter = 'all';
      renderHistory();
      break;
    }
    case 'sync':
      if (!db.meta.url) openSettings();
      else { syncError = ''; sync(); }
      break;
  }
});

window.addEventListener('online', () => sync());
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); sync(); } });

// ---------------------------------------------------------------------------
// Terima file dari menu "Bagikan" Android (Web Share Target)
// ---------------------------------------------------------------------------
async function consumeShare() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('ygg-share');
    const keys = await cache.keys();
    let text = '';
    for (const req of keys) {
      const res = await cache.match(req);
      const name = res.headers.get('x-filename') || '';
      if (req.url.endsWith('/text')) text += (await res.text()) + '\n';
      else text += (await readImportFile(new File([await res.blob()], name, { type: res.headers.get('content-type') || '' }))) + '\n';
      await cache.delete(req);
    }
    if (text.trim()) openImport(text.trim());
  } catch (err) {
    toast('Gagal membaca file yang dibagikan: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Mulai
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateDateChip();
showTab('home');
// Dibuka dari shortcut "Catat" (tekan lama ikon aplikasi) → langsung siap ketik.
if (new URLSearchParams(location.search).has('catat')) {
  history.replaceState(null, '', location.pathname);
  input.focus();
}
consumeShare();
sync();
