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
  if (resi) {
    const r = String(resi).trim();
    if (/^MGT\d/i.test(r))           return 'SAP';
    if (/^SPXID/i.test(r))           return 'SPX';
    if (/^26MNG\d+$/i.test(r))       return 'POS';
    if (/^C1[A-Z0-9]{5,8}$/i.test(r)) return 'LION';
    if (/^\d{16}$/.test(r))          return 'JNE';
    if (/^(JO|JJ)\d{10}$/i.test(r))  return 'J&T';
  }
  if (!pembayaran) return '';
  const p = pembayaran.toUpperCase();
  const map = [
    ['SPX','SPX'],['SICEPAT','SICEPAT'],['ANTERAJA','ANTERAJA'],
    ['IDEXPRESS','IDEXPRESS'],['ID EXPRESS','IDEXPRESS'],['IDE ','IDEXPRESS'],
    ['NINJA','NINJA'],['LION','LION'],
    ['J&T','J&T'],['JNT','J&T'],['JNE','JNE'],['POS','POS'],['SAP','SAP'],
  ];
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

  // 1. Fetch CS Input — cache 15 menit di sessionStorage supaya tidak hit Supabase tiap reload
  const PAGE = 1000;
  const CACHE_TTL = 15 * 60 * 1000; // 15 menit
  const cacheKey = `cs_orders_${dateFrom}_${dateTo}`;
  let csOrders = null;

  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL) csOrders = data;
    } catch (_) {}
  }

  if (!csOrders) {
    const baseParams = [
      'select=id,tanggal,nama,hp,alamat,jumlah,quantity,total_pembayaran,pembayaran,kabupaten,cs,resi',
      'sumber=eq.cs_input',
      'tanggal=gte.' + dateFrom,
      'tanggal=lte.' + dateTo,
      'order=tanggal.desc,id.desc',
    ].join('&');
    const csHeaders = { apikey: _CS_INPUT_KEY, Authorization: 'Bearer ' + _CS_INPUT_KEY };

    // Fetch semua halaman sampai halaman kosong — lebih robust dari approach "total count dulu"
    // yang bergantung pada header content-range (bisa tidak terbaca di mobile browser tertentu).
    csOrders = [];
    let offset = 0;
    while (true) {
      const r = await fetch(
        _CS_INPUT_URL + '/rest/v1/all_orderan?' + baseParams + `&limit=${PAGE}&offset=${offset}`,
        { headers: csHeaders }
      );
      if (!r.ok) throw new Error('CS Input query gagal: ' + r.status);
      const page = await r.json();
      csOrders = csOrders.concat(page);
      if (page.length < PAGE) break; // halaman terakhir — selesai
      offset += PAGE;
    }

    // Simpan ke cache
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: csOrders })); } catch (_) {}
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

  // 3. Batch query akuisisi_orders untuk tracking status (skip IMP-) — semua chunk paralel
  const resiIds = mapped.filter(o => !o.id.startsWith('IMP-')).map(o => o.id);
  if (resiIds.length) {
    const CHUNK = 500;
    const chunks = [];
    for (let i = 0; i < resiIds.length; i += CHUNK) chunks.push(resiIds.slice(i, i + CHUNK));
    const trackResults = await Promise.all(chunks.map(chunk =>
      _sb.from('akuisisi_orders')
        .select('id,status_resi,status_resi_step,status_resi_updated_at,ekspedisi,cek_sl,followup_attempts,followup_responded,followup_courier_notified,status_resi_detail->>masalah_kategori,status_resi_detail->>bermasalah_since,status_resi_detail->>redeliver_attempts')
        .in('id', chunk)
    ));
    const trackMap = {};
    trackResults.forEach(({ data }) => (data || []).forEach(t => { trackMap[t.id] = t; }));
    mapped.forEach(o => {
      const t = trackMap[o.id];
      if (!t) return;
      o.status_resi            = t.status_resi;
      o.status_resi_step       = t.status_resi_step;
      o.status_resi_updated_at = t.status_resi_updated_at;
      o.followup_attempts      = t.followup_attempts      || 0;
      o.followup_responded     = t.followup_responded     || false;
      o.followup_courier_notified = t.followup_courier_notified || false;
      o.cek_sl                 = t.cek_sl                 || false;
      o.masalah_kategori       = t.masalah_kategori       || null;
      o.bermasalah_since       = t.bermasalah_since       || null;
      o.redeliver_attempts     = t.redeliver_attempts ? parseInt(t.redeliver_attempts) : 0;
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

// ── CS Profiles — diambil dari CS Input via /api/cs-profiles (server-side, bypass RLS) ──
async function dbGetTeamMembers(domain) {
  // domain diabaikan — semua CS dari CS Input ditampilkan sekaligus
  const r = await fetch('/api/cs-profiles');
  if (!r.ok) throw new Error('Gagal fetch CS profiles: ' + r.status);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  // Map ke shape yang sama dengan team_members lama
  return (data || []).map(cs => ({
    id: cs.id,
    name: cs.nama,
    no_wa: cs.no_wa,
    domain: 'akuisisi',
    role: cs.role,
  }));
}

// ── Room Work — ambil FU status untuk BERMASALAH resi (batch) ─────────────────
async function dbGetRoomWorkByResi(resiList) {
  if (!resiList || !resiList.length) return [];
  const CHUNK = 500;
  const results = [];
  for (let i = 0; i < resiList.length; i += CHUNK) {
    const chunk = resiList.slice(i, i + CHUNK);
    const { data, error } = await _sb.from('room_work')
      .select('resi,fu_count,cs_responded')
      .in('resi', chunk);
    if (!error && data) results.push(...data);
  }
  return results;
}

// ── Mapping kode SKU -> nama produk ──────────────────────────────────────────
async function dbGetSkuMap() {
  const { data, error } = await _sb.from('sku_produk').select('kode,nama_produk,urutan').order('urutan', { nullsLast: true });
  if (error) throw error;
  const map = new Map();
  (data || []).forEach(r => map.set(String(r.kode).trim().toUpperCase(), r.nama_produk));
  return map;
}
