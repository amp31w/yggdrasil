// Yggdrasil parser: ubah teks gaya WhatsApp ("-30k ayam geprek 2pcs") jadi transaksi terstruktur.

// Kategori dasar. Nama kategori liburan & kata kunci pribadi diatur lewat configureParser()
// dari rencana yang tersimpan di Google Sheet (bukan di kode publik).
const BASE_EXPENSE = [
  'Makan & Kopi', 'Astro & Groceries', 'Transport', 'Tagihan Tetap', 'Sedekah',
  'Pulang & Keluarga', 'Hobi & Gadget', 'Kesehatan', 'Lainnya',
];
const INCOME = ['Gaji Utama', 'Gaji Sampingan', 'THR', 'Bonus', 'Pemasukan Lain'];

const config = { tripLabel: 'Liburan', tripTags: ['trip', 'liburan'], custom: [] };

/** tripLabel: nama kantong/kategori tujuan; tripTags: tag tambahan (mis. "bali"); keywords: { kategori: [kata] } */
export function configureParser({ tripLabel, tripTags = [], keywords = {} } = {}) {
  config.tripLabel = tripLabel || 'Liburan';
  config.tripTags = [...new Set(['trip', 'liburan', ...tripTags.map(t => t.toLowerCase())])];
  config.custom = Object.entries(keywords)
    .filter(([, words]) => words && words.length)
    .map(([cat, words]) => [cat, new RegExp(`\\b(${words.map(escapeRe).join('|')})\\b`)]);
}

export function categories() {
  return { keluar: [...BASE_EXPENSE.slice(0, -1), config.tripLabel, 'Lainnya'], masuk: INCOME };
}

const escapeRe = s => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Urutan penting: aturan yang lebih spesifik dicek lebih dulu. TRIP diganti nama kategori liburan.
const TRIP = Symbol('trip');
const EXPENSE_RULES = [
  [TRIP, /\b(paspor|passport|visa|tiket pesawat|pesawat|hotel|penginapan|airbnb)\b/],
  ['Tagihan Tetap', /\b(kontrakan|kos|kost|sewa|listrik|token|pln|gemini|langganan|subscription|wifi|internet|pulsa|paket data|kuota)\b/],
  ['Sedekah', /\b(sedekah|infaq|infak|zakat|donasi|amal|jumatan)\b/],
  ['Pulang & Keluarga', /\b(pulang|mudik|oleh[- ]?oleh|keluarga|ortu|ibu|bapak|mamah|mama|papah)\b/],
  ['Hobi & Gadget', /\b(game|games|steam|nintendo|switch|eshop|merch|figure|figurine|gacha|top ?up|keyboard|keycap|mouse|monitor|ram|gpu|vga|ssd|hdd|headphone|headset|gadget|akrilik|acrylic|manga|komik|anime|lightbar|lampu|peripheral|controller)\b/],
  ['Kesehatan', /\b(obat|apotek|apotik|dokter|klinik|vitamin|bpjs|rs)\b/],
  ['Transport', /\b(angkot|gojek|goride|gocar|grab|grabbike|krl|commuter|ojek|ojol|bensin|parkir|tol|transjakarta|tj|mrt|lrt|busway|kereta|maxim|bus)\b/],
  ['Astro & Groceries', /\b(astro|belanja|groceries|grocery|bahan|sayur|beras|telur|minyak|galon|indomaret|alfamart|alfa|sabun|deterjen|tisu|sampo)\b/],
  ['Makan & Kopi', /\b(makan|minum|ayam|geprek|nasi|kopi|coffee|kebab|burger|karaage|padang|mie|mi|bakso|sate|soto|martabak|roti|jajan|snack|teh|es|boba|gofood|grabfood|shopeefood|warteg|seblak|indomie|ramen|sushi|pizza|chicken|cafe|kafe|pcs|bubur|gorengan|pecel|lele|katsu|dimsum|susu|air|cemilan|camilan|sarapan|lunch|dinner)\b/],
];

const INCOME_RULES = [
  ['Gaji Sampingan', /\b(remote|upwork|freelance|fiverr|project|proyek|usd|dollar|sampingan)\b/],
  ['THR', /\b(thr)\b/],
  ['Bonus', /\b(bonus|insentif)\b/],
  ['Gaji Utama', /\b(gaji|salary|gajian)\b/],
];

// Tag kantong di mana pun dalam baris: ">dd" / ">darurat" atau tag liburan (">trip", ">liburan", + tag dari rencana).
const pocketTag = () => new RegExp(`(?:^|\\s)>\\s*(dd|darurat|${config.tripTags.map(escapeRe).join('|')})\\b`, 'i');

// Nominal bertanda: -30k, - 115.5 k, +1,66 juta, -Rp30.000, -30rb
const AMOUNT_RE = /([+-])\s*(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(ribu|rb|juta|jt|k)?(?![a-z0-9])/i;

const UNIT = { k: 1e3, rb: 1e3, ribu: 1e3, jt: 1e6, juta: 1e6 };

export function parseAmount(numStr, unit) {
  let review = false;
  let value;
  if (unit) {
    const seps = numStr.match(/[.,]/g) || [];
    if (seps.length <= 1) value = parseFloat(numStr.replace(',', '.'));
    else value = parseFloat(numStr.replace(/[.,]/g, ''));
    value *= UNIT[unit.toLowerCase()];
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(numStr)) {
    value = parseInt(numStr.replace(/[.,]/g, ''), 10);
  } else {
    value = parseFloat(numStr.replace(',', '.'));
    // "-30 ayam" hampir pasti maksudnya 30rb; tandai supaya dicek.
    if (value < 1000) { value *= 1000; review = true; }
  }
  return { value: Math.round(value), review };
}

function categorize(type, text) {
  const t = text.toLowerCase();
  const valid = type === 'masuk' ? INCOME : categories().keluar;
  // Kata kunci pribadi dari rencana dicek lebih dulu.
  for (const [cat, re] of config.custom) if (valid.includes(cat) && re.test(t)) return { category: cat, known: true };
  const rules = type === 'masuk' ? INCOME_RULES : EXPENSE_RULES;
  for (const [cat, re] of rules) if (re.test(t)) return { category: cat === TRIP ? config.tripLabel : cat, known: true };
  return { category: type === 'masuk' ? 'Pemasukan Lain' : 'Lainnya', known: false };
}

/**
 * Parse satu baris catatan. Mengembalikan null kalau bukan transaksi.
 * Hasil: { type, amount, category, note, pocket, review }
 *   type: 'keluar' | 'masuk' | 'nabung' (masuk ke kantong) | 'pakai' (bayar dari kantong)
 */
export function parseLine(line) {
  if (!line) return null;
  let text = clean(line);
  const m = text.match(AMOUNT_RE);
  if (!m) return null;
  const sign = m[1];
  const { value, review: amountReview } = parseAmount(m[2], m[3]);
  if (!value) return null;

  let pocket = '';
  const tag = pocketTag();
  const pm = text.match(tag);
  if (pm) {
    pocket = /^(dd|darurat)$/i.test(pm[1]) ? 'dd' : 'trip';
    text = text.replace(tag, ' ');
  }
  let note = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  note = note.replace(/^[-:,.\s]+|[-:,.\s]+$/g, '');

  let type;
  if (pocket) type = sign === '+' ? 'nabung' : 'pakai';
  else type = sign === '+' ? 'masuk' : 'keluar';

  let category, known = true;
  if (type === 'nabung') category = pocketCategory(pocket);
  else if (type === 'pakai') ({ category, known } = pocket === 'trip' ? { category: config.tripLabel, known: true } : categorize('keluar', note));
  else ({ category, known } = categorize(type, note));

  return { type, amount: value, category, note, pocket, review: amountReview || !known };
}

export function pocketCategory(pocket) {
  return pocket === 'dd' ? 'Kantong Dana Darurat' : `Kantong ${config.tripLabel}`;
}

export function clean(s) {
  return s.replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[  ]/g, ' ')
    .trim();
}

// Baris header pesan WA. Mendukung:
//   Android: "14/10/26, 11.35 - Nama: isi"
//   iOS:     "[14/10/26 11.35.22] Nama: isi"
//   Tanpa nama: "[14/10/2026 11.35] isi"
const WA_HEADER = /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?\s*([AaPp]\.?[Mm]\.?)?\]?\s*(?:-\s+)?(.*)$/;

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Pecah export chat WhatsApp jadi daftar { ts: 'YYYY-MM-DDTHH:mm', line }.
 * Setiap baris dalam satu pesan multi-baris diperlakukan sebagai kandidat transaksi
 * dengan waktu pesan tersebut.
 */
export function splitWhatsAppExport(raw) {
  const out = [];
  let currentTs = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = clean(rawLine);
    if (!line) continue;
    const h = line.match(WA_HEADER);
    if (h) {
      let [, d, mo, y, hh, mi, ampm, rest] = h;
      if (y.length === 2) y = '20' + y;
      let hour = parseInt(hh, 10);
      if (ampm) {
        const pm = /^p/i.test(ampm);
        if (pm && hour < 12) hour += 12;
        if (!pm && hour === 12) hour = 0;
      }
      currentTs = `${y}-${pad(mo)}-${pad(d)}T${pad(hour)}:${mi}`;
      // Buang nama pengirim ("Nama: isi"), tapi jangan kalau isinya sendiri diawali tanda +/-.
      const sender = rest.match(/^([^:+\-][^:]{0,40}):\s(.*)$/);
      if (sender) rest = sender[2];
      out.push({ ts: currentTs, line: rest });
    } else if (currentTs) {
      out.push({ ts: currentTs, line });
    }
  }
  return out;
}

// Hash pendek deterministik (FNV-1a) supaya import ulang tidak menggandakan data.
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Parse export WA penuh → { transactions, skipped } */
export function parseWhatsAppExport(raw) {
  const seen = new Map();
  const transactions = [];
  const skipped = [];
  for (const { ts, line } of splitWhatsAppExport(raw)) {
    const p = parseLine(line);
    if (!p) { skipped.push({ ts, line }); continue; }
    const key = ts + '|' + line.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    transactions.push({ id: 'wa-' + hash(key + '|' + n), ts, raw: line, source: 'wa', ...p });
  }
  return { transactions, skipped };
}
