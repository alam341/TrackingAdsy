// ── Supabase Client ───────────────────────────────────────────────────────────
// URL & anon key gak di-hardcode di sini -- diambil dari /api/config (baca Vercel
// Environment Variables). WAJIB panggil `await initSupabaseClient()` di awal tiap
// halaman sebelum manggil fungsi apa pun lain di file ini.
let _sb = null;
async function initSupabaseClient() {
  if (_sb) return _sb;
  const res = await fetch('/api/config');
  const cfg = await res.json();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY belum di-set di Environment Variables Vercel');
  }
  _sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return _sb;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function sbSignUp(email, password, name) {
  const { data, error } = await _sb.auth.signUp({
    email, password,
    options: { data: { name } },
  });
  if (error) throw error;
  if (data.user) {
    // Self-heal: pastikan row profiles kebentuk walau trigger DB gagal
    await _sb.from('profiles').upsert({ id: data.user.id, email, name, role: 'user' });
  }
  return data;
}

async function sbLogin(email, password) {
  const { data, error } = await _sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

async function sbLogout() {
  await _sb.auth.signOut();
  sessionStorage.clear();
  window.location.href = 'index.html';
}

async function sbGetSession() {
  const { data } = await _sb.auth.getSession();
  return data.session;
}

// ── Profiles ──────────────────────────────────────────────────────────────────
async function dbGetProfile(userId) {
  const { data, error } = await _sb.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}


// Fetch 1 order lengkap termasuk status_resi_detail -- dipanggil hanya saat buka modal detail.
// Dipisah dari dbGetTrackableOrders supaya status_resi_detail (JSONB besar) tidak ikut
// ditarik saat list biasa → hemat egress signifikan.
async function dbGetOrderDetail(table, id) {
  const { data, error } = await _sb.from(table).select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null; // row not found — order baru belum dicek
    throw error;
  }
  return data;
}

// Follow-up manual buat resi Bermasalah (percobaan/direspon/diinfo kurir) -- status ringkas
// aja, gak ada tabel histori terpisah (keputusan user 2026-07-11, lihat sql/006).
async function dbUpdateFollowup(table, id, patch) {
  const { error } = await _sb.from(table).update(patch).eq('id', id);
  if (error) throw error;
}


// ── Akuisisi: query langsung dari CS Input (real-time, tanpa sync) ────────────
// Order data diambil dari all_orderan CS Input, tracking status dari akuisisi_orders.
// Ini menggantikan sync cron VPS yang sebelumnya copy data ke akuisisi_orders.
const _AUTO_EKSPEDISI = ['SPX','POS','JNE','J&T','SICEPAT','ANTERAJA','NINJA','IDEXPRESS','LION'];
const _CS_INPUT_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';
const _CS_INPUT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxcGNuemRzc3Z2Y2F5cXZkanhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTgxMDIsImV4cCI6MjA5MDU5NDEwMn0.4M4okAfJWhBD6AbL71utafrFL-ZgbVxcz3ANLnG_jH4';

function _extractEkspedisiCS(pembayaran, resi) {
  if (resi && /^MGT\d/i.test(String(resi).trim())) return 'SAP';
  if (!pembayaran) return '';
  const p = pembayaran.toUpperCase();
  const map = [['SPX','SPX'],['SICEPAT','SICEPAT'],['ANTERAJA','ANTERAJA'],['IDEXPRESS','IDEXPRESS'],['NINJA','NINJA'],['LION','LION'],['J&T','J&T'],['JNT','J&T'],['JNE','JNE'],['POS','POS'],['SAP','SAP']];
  for (const [k, v] of map) if (p.includes(k)) return v;
  return '';
}

async function dbGetAkuisisiOrders(dateFrom, dateTo, preloadedSkuMap = null) {
  // 0. Pakai skuMap yang sudah di-load (dari page init) — kalau tidak ada, fetch sendiri
  const _skuMapPromise = preloadedSkuMap ? Promise.resolve(preloadedSkuMap) : dbGetSkuMap().catch(() => new Map());

  // Fallback: bersihkan kolom jumlah kalau SKU tidak ketemu di nama
  // "4 BOX NEW PRIMAGOLD" → "PRIMAGOLD", "*1 BOTOL NEW HERBAPIL*" → "HERBAPIL"
  function _cleanJumlah(jumlah) {
    return String(jumlah || '')
      .replace(/\*/g, '')
      .replace(/^\d+\s+(BOTOL|BOX|PCS|BTL)\s+(NEW\s+)?/i, '')
      .trim();
  }

  // 1. Fetch order data langsung dari CS Input all_orderan (real-time)
  // SKU map jalan paralel di background (_skuMapPromise), akan di-await setelah loop ini selesai
  const PAGE = 1000;
  let csOrders = [], offset = 0;
  while (true) {
    const params = [
      'select=id,tanggal,nama,hp,alamat,jumlah,quantity,total_pembayaran,pembayaran,kabupaten,cs,resi',
      'sumber=eq.cs_input',
      'tanggal=gte.' + dateFrom,
      'tanggal=lte.' + dateTo,
      'order=tanggal.desc,id.desc',
      'limit=' + PAGE,
      'offset=' + offset,
    ].join('&');
    const r = await fetch(_CS_INPUT_URL + '/rest/v1/all_orderan?' + params, {
      headers: { apikey: _CS_INPUT_KEY, Authorization: 'Bearer ' + _CS_INPUT_KEY },
    });
    if (!r.ok) throw new Error('CS Input query gagal: ' + r.status);
    const batch = await r.json();
    csOrders = csOrders.concat(batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }

  // Tunggu SKU map (sudah jalan paralel, biasanya sudah resolve sebelum loop selesai)
  const _skuMap = await _skuMapPromise;

  // Resolve produk dari segmen SKU di kolom nama, format: "NAMA PELANGGAN|SKU_BUNDLE|PROMO"
  // SKU bisa bundle: "HRB 1 MAK 1" = 1x Herbanesia + 1x Maksir
  function _csSkuToProduk(rawNama) {
    const sku = (rawNama || '').split('|')[1]?.trim() || '';
    if (!sku) return '';
    const tokens = [...sku.matchAll(/([A-Za-z]+)\s*(\d+)/g)];
    if (!tokens.length) return '';
    return tokens.map(([, code]) => _skuMap.get(code.toUpperCase()) || code.toUpperCase()).join(' + ');
  }

  // 2. Map ke shape yang sama dengan akuisisi_orders
  const mapped = csOrders.map(r => {
    const resiClean = r.resi ? String(r.resi).replace(/^'+/, '').trim() : '';
    const namaClean = (r.nama || '').split('|')[0].trim() || r.nama || '';
    const produkFromSku = _csSkuToProduk(r.nama);
    return {
      id: resiClean || ('IMP-' + r.id),
      _cs_id: r.id,
      order_date: r.tanggal,
      nama: namaClean,
      hp: r.hp || '',
      alamat: r.alamat || '',
      produk: produkFromSku || _cleanJumlah(r.jumlah),
      qty: r.quantity || 1,
      total: r.total_pembayaran || 0,
      ekspedisi: _extractEkspedisiCS(r.pembayaran, resiClean),
      kota_tujuan: r.kabupaten || '',
      cs_nama: r.cs || '',
      status_resi: null, status_resi_step: null, status_resi_updated_at: null,
      followup_attempts: 0, followup_responded: false, followup_courier_notified: false,
      masalah_kategori: null,
    };
  });

  // 3. Batch query akuisisi_orders untuk tracking status (skip IMP-)
  const resiIds = mapped.filter(o => !o.id.startsWith('IMP-')).map(o => o.id);
  if (resiIds.length) {
    const CHUNK = 500;
    const trackMap = {};
    for (let i = 0; i < resiIds.length; i += CHUNK) {
      const chunk = resiIds.slice(i, i + CHUNK);
      const { data } = await _sb.from('akuisisi_orders')
        .select('id,status_resi,status_resi_step,status_resi_updated_at,ekspedisi,followup_attempts,followup_responded,followup_courier_notified,status_resi_detail->>masalah_kategori,status_resi_detail->>bermasalah_since')
        .in('id', chunk);
      (data || []).forEach(t => { trackMap[t.id] = t; });
    }
    mapped.forEach(o => {
      const t = trackMap[o.id];
      if (!t) return;
      o.status_resi            = t.status_resi;
      o.status_resi_step       = t.status_resi_step;
      o.status_resi_updated_at = t.status_resi_updated_at;
      o.followup_attempts      = t.followup_attempts      || 0;
      o.followup_responded     = t.followup_responded     || false;
      o.followup_courier_notified = t.followup_courier_notified || false;
      o.masalah_kategori       = t.masalah_kategori       || null;
      o.bermasalah_since       = t.bermasalah_since       || null;
      if (t.ekspedisi) o.ekspedisi = t.ekspedisi; // prefer stored (mungkin sudah diedit manual)
    });

    // Final pass: order yang ekspedisinya tidak didukung auto-track
    // → paksa ke MANUAL, meski sudah ada di akuisisi_orders sebagai BELUM_DICEK
    mapped.forEach(o => {
      if (!o.status_resi || o.status_resi === 'BELUM_DICEK') {
        const isAkResi = /^AK/i.test(o.id);
        const isUnsupportedEksp = o.ekspedisi && !_AUTO_EKSPEDISI.includes(o.ekspedisi);
        if (isAkResi || isUnsupportedEksp) {
          o.status_resi = 'MANUAL';
          o.status_resi_step = 1;
        }
      }
    });
  }

  return mapped;
}

// ── Mapping kode SKU -> nama produk ──────────────────────────────────────────
async function dbGetSkuMap() {
  const { data, error } = await _sb.from('sku_produk').select('kode,nama_produk').neq('aktif', false).order('urutan');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach(r => map.set(String(r.kode).trim().toUpperCase(), r.nama_produk));
  return map;
}
