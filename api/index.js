const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BASE = 'https://v1.samehadaku.how';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function ua() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function makeHeaders(referer = BASE) {
  return {
    'User-Agent': ua(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Referer': referer,
    'Cache-Control': 'no-cache',
  };
}

// Proxy list — dicoba urut dari atas
const PROXY_LIST = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => url, // direct fallback
];

async function fetchWithProxy(url) {
  let lastErr;
  for (const proxyFn of PROXY_LIST) {
    try {
      const proxyUrl = proxyFn(url);
      const res = await axios.get(proxyUrl, { headers: makeHeaders(url), timeout: 20000 });
      if (res.data && res.status === 200) return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Semua proxy gagal');
}

async function postWithProxy(url, body, extraHeaders = {}) {
  const attempts = [
    // Direct
    () => axios.post(url, body, {
      headers: { ...makeHeaders(url), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE, ...extraHeaders },
      timeout: 20000,
    }),
    // Via corsproxy
    () => axios.post(`https://corsproxy.io/?${encodeURIComponent(url)}`, body, {
      headers: { ...makeHeaders(url), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE, ...extraHeaders },
      timeout: 20000,
    }),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try { const res = await attempt(); if (res.data) return res; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('POST gagal');
}

async function animeterbaru(page = 1) {
  const res = await fetchWithProxy(`${BASE}/anime-terbaru/page/${page}/`);
  const $ = cheerio.load(res.data);
  const data = [];
  $('.post-show ul li').each((_, e) => {
    const a = $(e).find('.dtla h2 a');
    const title = a.text().trim();
    const url = a.attr('href');
    if (!title || !url) return;
    data.push({
      title, url,
      image: $(e).find('.thumb img').attr('src') || $(e).find('.thumb img').attr('data-src') || '',
      episode: $(e).find('.dtla span:contains("Episode")').text().replace('Episode', '').trim(),
    });
  });
  return data;
}

async function search(query) {
  const res = await fetchWithProxy(`${BASE}/?s=${encodeURIComponent(query)}`);
  const $ = cheerio.load(res.data);
  const data = [];
  $('.animpost').each((_, e) => {
    const url = $(e).find('a').attr('href');
    const title = $(e).find('.data .title h2').text().trim();
    if (!title || !url) return;
    data.push({
      title,
      image: $(e).find('.content-thumb img').attr('src') || $(e).find('.content-thumb img').attr('data-src') || '',
      type: $(e).find('.type').text().trim(),
      score: $(e).find('.score').text().trim(),
      url,
    });
  });
  return data;
}

async function detail(link) {
  const targetUrl = link.startsWith('http') ? link : `${BASE}${link}`;
  const res = await fetchWithProxy(targetUrl);
  const $ = cheerio.load(res.data);
  const episodes = [];
  for (const sel of ['.lstepsiode ul li', '.episodelist ul li', '#episodelist li']) {
    if ($(sel).length > 0) {
      $(sel).each((_, e) => {
        const a = $(e).find('a').first();
        const epUrl = a.attr('href');
        if (epUrl) episodes.push({ title: a.text().trim() || 'Episode', url: epUrl, date: $(e).find('.date').text().trim() });
      });
      break;
    }
  }
  const info = {};
  $('.anim-senct .right-senc .spe span, .infoanime .spe span').each((_, e) => {
    const t = $(e).text();
    if (t.includes(':')) {
      const idx = t.indexOf(':');
      const k = t.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '_');
      const v = t.slice(idx + 1).trim();
      if (k && v) info[k] = v;
    }
  });
  return {
    title: $('title').text().replace(/\s*[-–]\s*Samehadaku.*/i, '').trim() || $('h1').first().text().trim(),
    image: $('meta[property="og:image"]').attr('content') || '',
    description: ($('.entry-content').text().trim() || $('meta[name="description"]').attr('content') || '').substring(0, 800),
    episodes, info,
  };
}

async function getStreams(link) {
  const targetUrl = link.startsWith('http') ? link : `${BASE}${link}`;
  const res = await fetchWithProxy(targetUrl);
  const $ = cheerio.load(res.data);

  // Coba ambil cookies langsung
  let cookies = '';
  try {
    const directRes = await axios.get(targetUrl, { headers: makeHeaders(targetUrl), timeout: 15000 });
    cookies = directRes.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') || '';
  } catch (e) { console.log('Cookie gagal:', e.message); }

  const servers = [];
  $('div#server > ul > li').each((_, li) => {
    const div = $(li).find('div').first();
    const post = div.attr('data-post');
    const nume = div.attr('data-nume');
    const type = div.attr('data-type');
    const name = $(li).find('span').text().trim() || `Server ${servers.length + 1}`;
    if (post) servers.push({ post, nume, type, name });
  });

  console.log(`Servers: ${servers.length} | URL: ${targetUrl}`);

  const streams = [];
  for (const srv of servers) {
    try {
      const body = new URLSearchParams({ action: 'player_ajax', post: srv.post, nume: srv.nume, type: srv.type }).toString();
      const r = await postWithProxy(`${BASE}/wp-admin/admin-ajax.php`, body, { 'Cookie': cookies, 'Referer': targetUrl, 'Origin': BASE });
      const $$ = cheerio.load(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
      let src = $$('iframe').attr('src') || $$('iframe').attr('data-src');
      if (!src) {
        const raw = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        const m1 = raw.match(/https?:\/\/[^\s"'\\<>]+\.(mp4|m3u8)[^\s"'\\<>]*/i);
        const m2 = raw.match(/https?:\/\/[^\s"'\\<>]*(?:embed|player|stream)[^\s"'\\<>]*/i);
        src = m1?.[0] || m2?.[0];
      }
      if (src) {
        if (src.startsWith('//')) src = 'https:' + src;
        streams.push({ server: srv.name, url: src });
        console.log(`✅ ${srv.name}: ${src}`);
      }
    } catch (e) { console.log(`❌ ${srv.name}: ${e.message}`); }
  }

  // Fallback: iframe langsung di halaman
  if (streams.length === 0) {
    $('iframe[src], iframe[data-src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src?.startsWith('http') && !src.includes('facebook') && !src.includes('google')) {
        streams.push({ server: 'Stream', url: src });
      }
    });
  }

  return {
    title: $('h1[itemprop="name"], .entry-title, h1').first().text().trim(),
    streams,
    _debug: { serversFound: servers.length, streamsFound: streams.length }
  };
}

// ROUTES
app.get('/api/latest', async (req, res) => {
  try { res.json(await animeterbaru(req.query.page || 1)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ error: 'Parameter q diperlukan' });
    res.json(await search(req.query.q));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/detail', async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: 'Parameter url diperlukan' });
    res.json(await detail(req.query.url));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/watch', async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: 'Parameter url diperlukan' });
    res.json(await getStreams(req.query.url));
  } catch (e) { res.status(500).json({ error: e.message, streams: [] }); }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', endpoints: ['/api/latest?page=1', '/api/search?q=naruto', '/api/detail?url=...', '/api/watch?url=...'] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
module.exports = app;
