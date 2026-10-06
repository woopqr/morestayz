#!/usr/bin/env node
/**
 * morestayz 전체 재빌드(self-heal)
 *  - data/articles/*.json → articles/*.html
 *  - index.html(1p) + page/N.html (전체 최신 피드, 정적 페이지네이션)
 *  - category/<id>.html + category/<id>/N.html (카테고리별 재배치)
 *  - articles.json(검색) + sitemap.xml
 *  publish.js가 매 실행 호출 → 생성물이 항상 데이터와 일치
 */
const fs = require('fs');
const path = require('path');
const { adInFeedHtml, buildOne, buildSpecial, editorialTitle, editorialDescription, isCurrentOrFuture } = require('./build');

const ROOT = __dirname;
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));
const THEMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/themes.json'), 'utf8'));
const ART = path.join(ROOT, 'data/articles');
const PAGE_SIZE = 12;
const BASE = `https://${SITE.domain}`;

// 카테고리 정의(테마 순서 = 노출 순서). 실제 글이 있는 카테고리만 노출.
// '국내 특별 여행지'(domestic)는 자동 테마가 아닌 에디토리얼 기획 카테고리로 맨 앞에 노출.
const SPECIALS = path.join(ROOT, 'data/specials');
// 패싯 필터(국가→도시)용: 도시 슬러그 → 국가
const CITY_COUNTRY = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8')).map(c => [c.slug, c.country]));
const CATS = [{ id: 'domestic', label: '국내 특별 여행지', emoji: '🇰🇷' }, { id: 'tv-luxury', label: '방송 속 럭셔리 호텔', emoji: '📺' }, { id: 'tv-trip', label: '방송·셀럽 여행', emoji: '🎬' }, ...THEMES.themes.map(t => ({ id: t.id, label: t.audience, emoji: t.emoji }))];

// 특별기획 글은 이미지가 없으므로 지역명 타이포 카드(SVG data-URI)를 썸네일로 사용
function specialCardImg(region, sub = '국내 특별 기획', from = '#6f8f67', to = '#365a78') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><text x="50%" y="45%" fill="#ffffff" font-family="sans-serif" font-size="66" font-weight="800" text-anchor="middle">${region}</text><text x="50%" y="61%" fill="rgba(255,255,255,0.9)" font-family="sans-serif" font-size="20" font-weight="700" letter-spacing="5" text-anchor="middle">${sub}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
// 특별기획 카드 썸네일: d.cardImg(직접 지정) → 자기 사이드카 호텔 사진 → cardImgFrom 사이드카 → 타이포 SVG
function sidecarImg(file, idx = 0, match = '') {
  const p = path.join(SPECIALS, file.replace(/\.json$/, '') + '.hotels.json');
  if (!fs.existsSync(p)) return '';
  try { const hs = (JSON.parse(fs.readFileSync(p, 'utf8')).hotels || []).filter(h => h.img);
    const hit = match ? hs.find(h => new RegExp(match, 'i').test(h.name)) : null;
    return (hit || hs[idx] || hs[0] || {}).img || ''; } catch (e) { return ''; }
}
function specialMetas() {
  if (!fs.existsSync(SPECIALS)) return [];
  return fs.readdirSync(SPECIALS).filter(f => f.endsWith('.json') && !f.endsWith('.hotels.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(SPECIALS, f), 'utf8'));
    return {
      slug: d.slug, theme: d.category || 'domestic', title: d.title, special: true, description: d.metaDescription || '',
      audience: d.categoryLabel || '국내 특별 여행지', emoji: d.emoji || '🇰🇷',
      city: d.region || '', season: '특별기획', travelMonthLabel: '',
      heroImg: d.cardImg || sidecarImg(f, d.cardImgIndex || 0, d.cardImgMatch) || (d.cardImgFrom ? sidecarImg(d.cardImgFrom, d.cardImgIndex || 0, d.cardImgMatch) : '')
        || specialCardImg(d.region || d.slug, ...(d.card ? [d.card.sub, d.card.from, d.card.to] : [])),
      country: d.country || '한국', cities: d.facetCities || [d.region || ''],
      chip: d.region || '', chipSub: (d.card && d.card.sub) || '국내 특별 기획', updated: d.updated || '',
    };
  });
}

function articleMetas() {
  if (!fs.existsSync(ART)) return [];
  return fs.readdirSync(ART).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ART, f), 'utf8'));
    return {
      slug: d.slug, theme: d.theme, title: editorialTitle(d), description: editorialDescription(d), audience: d.audience, emoji: d.emoji,
      city: d.city, citySlug: d.citySlug, ym: (String(d.slug).match(/(\d{4}-\d{2})$/) || [])[1] || '', country: CITY_COUNTRY[d.citySlug] || '', cities: [d.city], season: d.season || '', travelMonthLabel: d.travelMonthLabel || '',
      heroImg: d.heroImg || '', updated: d.updated || (d._meta && d._meta.fetchedAt) || '', indexable: isCurrentOrFuture(d),
    };
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

function cardHtml(m) {
  return `      <a class="card" href="/articles/${m.slug}">
        <div class="cthumb"><img src="${m.heroImg}" alt="${String(m.title || '').replace(/"/g, '&quot;')}" loading="lazy">${m.chip ? `<span class="cchipx"><b>${m.chip}</b><small>${m.chipSub}</small></span>` : ''}<span class="ctag">${m.emoji} ${m.audience}</span></div>
        <div class="cbody"><span class="cmeta">${[m.season, m.travelMonthLabel].filter(Boolean).join(' · ')}</span><h2>${m.title}</h2></div>
      </a>`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [[]];
}

// base: '/' (홈) 또는 '/category/<id>'
function pageUrl(base, k) {
  if (k === 1) return base;
  return (base === '/' ? '/page' : base) + '/' + k;
}

function pagerHtml(base, cur, total) {
  if (total <= 1) return '';
  const want = new Set([1, total, cur, cur - 1, cur + 1, cur - 2, cur + 2]);
  const ks = [];
  for (let k = 1; k <= total; k++) if (want.has(k)) ks.push(k);
  let html = '', last = 0;
  if (cur > 1) html += `<a class="pg nav" href="${pageUrl(base, cur - 1)}" aria-label="이전">‹</a>`;
  ks.forEach(k => {
    if (last && k - last > 1) html += `<span class="pg gap">…</span>`;
    html += (k === cur)
      ? `<span class="pg cur" aria-current="page">${k}</span>`
      : `<a class="pg" href="${pageUrl(base, k)}">${k}</a>`;
    last = k;
  });
  if (cur < total) html += `<a class="pg nav" href="${pageUrl(base, cur + 1)}" aria-label="다음">›</a>`;
  return html;
}

function catnavHtml(activeCats, currentId) {
  const chip = (href, label, on) => `<a class="cchip${on ? ' on' : ''}" href="${href}">${label}</a>`;
  let html = chip('/', '전체', currentId === 'all');
  seasonGuideList().forEach(g => { html += chip(`/season/${g.id}`, `${g.emoji} ${g.label} 여행지`, currentId === 'season-' + g.id); });
  activeCats.forEach(c => { html += chip(`/category/${c.id}`, `${c.emoji} ${c.label}`, currentId === c.id); });
  return html;
}

// 국가 칩(서버 렌더) + 국가별 도시 목록(data-cities, JS가 2단 칩으로 렌더). 기본은 '전체'(최신순 피드 그대로)
function facetsHtml(ctx) {
  const byCountry = {};
  ctx.metas.forEach(m => {
    if (!m.country) return;
    const c = byCountry[m.country] = byCountry[m.country] || { n: 0, cities: {} };
    c.n++;
    (m.cities || []).filter(Boolean).forEach(ct => { c.cities[ct] = (c.cities[ct] || 0) + 1; });
  });
  const countries = Object.keys(byCountry).sort((a, b) => byCountry[b].n - byCountry[a].n);
  if (countries.length < 2) return '';
  const cityMap = {};
  countries.forEach(c => { cityMap[c] = Object.entries(byCountry[c].cities).sort((a, b) => b[1] - a[1]); });
  const chip = (c) => `<button type="button" class="fchip" data-country="${c}">${c}<sup>${byCountry[c].n}</sup></button>`;
  return `<div class="facets" id="facets" data-cat="${ctx.kind === 'home' ? 'all' : ctx.id}" data-cities='${JSON.stringify(cityMap).replace(/'/g, '&#39;')}'>`
    + `<div class="frow"><span class="flabel">Country</span><div class="ftrack" id="fcountry"><button type="button" class="fchip on" data-country="">전체<sup>${ctx.metas.length}</sup></button>${countries.map(chip).join('')}</div></div>`
    + `<div class="frow sub" id="fcityrow" hidden><span class="flabel">City</span><div class="ftrack" id="fcity"></div></div></div>`;
}

function applyShell(shell, opts) {
  // opts: { cards, pager, catnav, canon, title, seclabel }
  let html = shell
    .replace(/<!--ARTICLES_START-->[\s\S]*?<!--ARTICLES_END-->/, `<!--ARTICLES_START-->\n${opts.cards}\n      <!--ARTICLES_END-->`)
    .replace(/<!--PAGER_START-->[\s\S]*?<!--PAGER_END-->/, `<!--PAGER_START-->${opts.pager}<!--PAGER_END-->`)
    .replace(/<!--CATNAV_START-->[\s\S]*?<!--CATNAV_END-->/, `<!--CATNAV_START-->${opts.catnav}<!--CATNAV_END-->`)
    .replace(/<!--FACETS_START-->[\s\S]*?<!--FACETS_END-->/, `<!--FACETS_START-->${opts.facets || ''}<!--FACETS_END-->`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${opts.canon}">`)
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${opts.canon}$2`);
  if (opts.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${opts.title}</title>`);
  if (opts.seclabel) html = html.replace(/<div class="seclabel"[^>]*id="seclabel"[^>]*>[\s\S]*?<\/div>/,
    `<div class="seclabel" id="seclabel"><h2>${opts.seclabel}</h2><span class="ln"></span></div>`);
  return html;
}

function writePages(shell, ctx, activeCats) {
  // ctx: { kind:'home'|'category', id, label, base, metas }
  const pages = chunk(ctx.metas, PAGE_SIZE);
  const total = pages.length;
  pages.forEach((chunkMetas, i) => {
    const p = i + 1;
    const url = pageUrl(ctx.base, p);
    const canon = BASE + (url === '/' ? '/' : url);
    const cardList = chunkMetas.map(cardHtml);
    if (cardList.length > 6) cardList.splice(6, 0, adInFeedHtml());
    const cards = cardList.join('\n');
    const opts = {
      cards,
      pager: pagerHtml(ctx.base, p, total),
      catnav: catnavHtml(activeCats, ctx.kind === 'home' ? 'all' : ctx.id),
      canon,
      facets: facetsHtml(ctx),
    };
    if (ctx.kind === 'category') {
      opts.seclabel = `${ctx.label}`;
      opts.title = `${ctx.label}${p > 1 ? ` (${p})` : ''} | morestayz — 데이터로 고르는 여행 숙소`;
    } else if (p > 1) {
      opts.title = `morestayz — ${p}페이지 · 데이터로 고르는 여행 숙소`;
    }
    const html = applyShell(shell, opts);
    if (ctx.kind === 'home') {
      if (p === 1) fs.writeFileSync(path.join(ROOT, 'index.html'), html);
      else { const d = path.join(ROOT, 'page'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${p}.html`), html); }
    } else {
      if (p === 1) { fs.mkdirSync(path.join(ROOT, 'category'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'category', `${ctx.id}.html`), html); }
      else { const d = path.join(ROOT, 'category', ctx.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${p}.html`), html); }
    }
  });
  return total;
}

function cleanDir(dir, re) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    const full = path.join(dir, f);
    if (re.test(f)) { try { fs.unlinkSync(full); } catch (e) {} }
    else if (fs.statSync(full).isDirectory()) { cleanDir(full, re); }
  });
}

function regenAll(metas) {
  const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // 활성 카테고리(글 1개 이상)
  const byCat = {};
  metas.forEach(m => { (byCat[m.theme] = byCat[m.theme] || []).push(m); });
  const activeCats = CATS.filter(c => (byCat[c.id] || []).length);

  // 이전 빌드 잔여물 정리(sandbox에선 unlink 실패해도 무시)
  cleanDir(path.join(ROOT, 'page'), /^\d+\.html$/);
  cleanDir(path.join(ROOT, 'category'), /\.html$/);

  // 홈(전체 최신 피드)
  const homePages = writePages(shell, { kind: 'home', base: '/', metas }, activeCats);

  // 카테고리별
  const catPageInfo = [];
  activeCats.forEach(c => {
    const total = writePages(shell, { kind: 'category', id: c.id, label: `${c.emoji} ${c.label}`, base: `/category/${c.id}`, metas: byCat[c.id] }, activeCats);
    catPageInfo.push({ id: c.id, total });
  });

  return { homePages, activeCats, catPageInfo };
}

function regenSearchIndex(metas) {
  const data = metas.map(m => ({
    slug: m.slug, title: m.title, audience: m.audience, emoji: m.emoji,
    theme: m.theme, country: m.country || '', cities: m.cities || [],
    city: m.city, season: m.season, month: m.travelMonthLabel, img: m.heroImg, description: m.description || '',
  }));
  fs.writeFileSync(path.join(ROOT, 'articles.json'), JSON.stringify(data));
}

function regenSitemap(metas, info) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: BASE + '/', pri: '1.0', cf: 'daily' },
    { loc: BASE + '/pages/about', pri: '0.5', cf: 'monthly' },
    { loc: BASE + '/pages/contact', pri: '0.3', cf: 'yearly' },
    { loc: BASE + '/pages/privacy', pri: '0.3', cf: 'yearly' },
    { loc: BASE + '/pages/methodology', pri: '0.6', cf: 'monthly' },
    { loc: BASE + '/pages/editorial-policy', pri: '0.5', cf: 'monthly' },
    { loc: BASE + '/pages/price-observatory', pri: '0.7', cf: 'daily' },
  ];
  seasonGuideList().forEach(g => urls.push({ loc: `${BASE}/season/${g.id}`, pri: '0.9', cf: 'weekly' }));
  for (let p = 2; p <= (info.homePages || 1); p++) urls.push({ loc: `${BASE}/page/${p}`, pri: '0.5', cf: 'daily' });
  info.catPageInfo.forEach(c => {
    urls.push({ loc: `${BASE}/category/${c.id}`, pri: '0.7', cf: 'daily' });
    for (let p = 2; p <= c.total; p++) urls.push({ loc: `${BASE}/category/${c.id}/${p}`, pri: '0.4', cf: 'weekly' });
  });
  // 국내 특별기획(domestic)은 우선순위 상향(트래픽 핵심)
  metas.filter(m => m.special || m.indexable !== false).forEach(m => urls.push({ loc: `${BASE}/articles/${m.slug}`, pri: m.special ? '0.9' : '0.8', cf: 'monthly', last: m.updated }));
  const body = urls.map(u =>
    `  <url><loc>${u.loc}</loc><lastmod>${String(u.last || today).slice(0, 10)}</lastmod><changefreq>${u.cf}</changefreq><priority>${u.pri}</priority></url>`).join('\n');
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}

// 정적 자산 캐시 무효화: CSS/JS 내용 해시를 ?v= 로 붙여 Cloudflare/브라우저가 새 파일을 받게 함
const ASSETS = ['assets/css/article.css', 'assets/consent.js'];
function stampAssets() {
  const crypto = require('crypto');
  const subs = ASSETS.filter(a => fs.existsSync(path.join(ROOT, a))).map(a => {
    const v = crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, a))).digest('hex').slice(0, 8);
    return [new RegExp('/' + a.replace(/[.]/g, '\\.') + '(\\?v=[0-9a-f]+)?(?=")', 'g'), `/${a}?v=${v}`];
  });
  const walk = d => fs.existsSync(d) ? fs.readdirSync(d).flatMap(f => { const full = path.join(d, f); return fs.statSync(full).isDirectory() ? walk(full) : (f.endsWith('.html') ? [full] : []); }) : [];
  const files = [path.join(ROOT, 'index.html'), path.join(ROOT, '404.html'), ...['templates', 'pages', 'articles', 'category', 'page', 'season'].flatMap(d => walk(path.join(ROOT, d)))];
  let n = 0;
  files.filter(f => fs.existsSync(f)).forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    const out = subs.reduce((t, [re, rep]) => t.replace(re, rep), src);
    if (out !== src) { fs.writeFileSync(f, out); n++; }
  });
  return n;
}

// RSS 2.0 피드(네이버 서치어드바이저 'RSS 제출'용): 특집 + 색인 대상 글 중 최신 30개
function regenRss(metas) {
  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rfc822 = d => { const t = new Date(String(d || '').slice(0, 10) + 'T06:00:00+09:00'); return isNaN(t) ? new Date().toUTCString() : t.toUTCString(); };
  const items = metas.filter(m => m.special || m.indexable !== false)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 30)
    .map(m => `    <item>
      <title>${esc(m.title)}</title>
      <link>${BASE}/articles/${m.slug}</link>
      <guid isPermaLink="true">${BASE}/articles/${m.slug}</guid>
      <description>${esc(m.description || m.title)}</description>
      <category>${esc(m.audience || '')}</category>
      <pubDate>${rfc822(m.updated)}</pubDate>
    </item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)} — ${esc(SITE.tagline)}</title>
    <link>${BASE}/</link>
    <description>${esc(SITE.description)}</description>
    <language>ko</language>
    <atom:link href="${BASE}/rss.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  fs.writeFileSync(path.join(ROOT, 'rss.xml'), xml);
}

// ── 계절별 여행지 안내(/season/<id>): data/season-fit.json → 나라별 도시 적합도 + 해당 시즌 글 링크 ──
const SEASON_GUIDE_FILE = path.join(ROOT, 'data/season-fit.json');
function seasonGuideList() {
  if (!fs.existsSync(SEASON_GUIDE_FILE)) return [];
  const g = JSON.parse(fs.readFileSync(SEASON_GUIDE_FILE, 'utf8'));
  return Object.entries(g.seasons || {}).filter(([, v]) => v.cities && Object.keys(v.cities).length).map(([id, v]) => ({ id, ...v, countryOrder: g.countryOrder || [] }));
}
const CITY_INFO = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8')).map(c => [c.slug, c]));
const THEME_SHORT = { couple: '연인', family: '가족', kids: '아이와', solo: '혼자', friends: '친구', waterpark: '수영장', pet: '반려견' };
function regenSeasonPages(metas) {
  const dir = path.join(ROOT, 'season');
  const guides = seasonGuideList();
  if (!guides.length) return;
  fs.mkdirSync(dir, { recursive: true });
  const { adMultiplexHtml } = require('./build');
  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const FIT = { best: '최적', good: '추천', avoid: '비추천' };
  guides.forEach(g => {
    const canon = `${BASE}/season/${g.id}`;
    const monthsTxt = g.months.length > 1 ? `${g.months[0]}~${g.months[g.months.length - 1]}월` : `${g.months[0]}월`;
    // 해당 시즌 월의 자동 큐레이션 글 (도시별)
    const byCity = {};
    metas.filter(m => m.citySlug && m.ym && g.months.includes(Number(m.ym.slice(5)))).forEach(m => {
      (byCity[m.citySlug] = byCity[m.citySlug] || []).push(m);
    });
    const rows = Object.entries(g.cities).map(([slug, v]) => ({ slug, ...v, info: CITY_INFO[slug] || { name: slug, country: '' } }));
    const order = c => { const i = g.countryOrder.indexOf(c); return i < 0 ? 99 : i; };
    const countries = [...new Set(rows.filter(r => r.fit !== 'avoid').map(r => r.info.country))].sort((a, b) => order(a) - order(b));
    const fitOrder = { best: 0, good: 1 };
    const linksFor = slug => {
      const list = (byCity[slug] || []).sort((a, b) => a.ym.localeCompare(b.ym));
      if (!list.length) return '<span class="sg-soon">숙소 비교 글 준비 중</span>';
      const byYm = {};
      list.forEach(m => { (byYm[m.ym] = byYm[m.ym] || []).push(m); });
      return Object.entries(byYm).map(([ym, ms]) => `<span class="sg-ym">${Number(ym.slice(5))}월</span> ` +
        ms.map(m => `<a href="/articles/${m.slug}">${THEME_SHORT[m.theme] || m.audience}</a>`).join('<i>·</i>')).join('<span class="sg-sep"></span>');
    };
    const rowHtml = r => `<div class="sg-row"><div class="sg-city"><b>${esc(r.info.name)}</b><span class="fit ${r.fit}">${FIT[r.fit]}</span></div>`
      + `<p class="sg-note">${esc(r.note)}</p>` + (r.fit === 'avoid' ? '' : `<div class="sg-links">${linksFor(r.slug)}</div>`) + `</div>`;
    const sections = countries.map(c => {
      const rs = rows.filter(r => r.info.country === c && r.fit !== 'avoid').sort((a, b) => fitOrder[a.fit] - fitOrder[b.fit]);
      return `<section class="sg-country" id="${esc(c)}"><h2>${esc(c)}<sup>${rs.length}</sup></h2>${rs.map(rowHtml).join('')}</section>`;
    }).join('\n');
    const avoid = rows.filter(r => r.fit === 'avoid');
    const avoidHtml = avoid.length ? `<section class="sg-country sg-avoid"><h2>이번 ${esc(g.label)}엔 다시 생각해 볼 곳</h2>${avoid.map(r => `<div class="sg-row"><div class="sg-city"><b>${esc(r.info.name)}</b><span class="fit avoid">${esc(r.info.country)} · 비추천</span></div><p class="sg-note">${esc(r.note)}</p></div>`).join('')}</section>` : '';
    const title = `${g.emoji} ${g.title} (${monthsTxt}) | ${SITE.name}`;
    const desc = `${monthsTxt} ${g.label} 여행지를 나라별로 정리했습니다. ${countries.slice(0, 5).join('·')} 도시별 ${g.label} 적합도와 이유, 숙소 비교 글까지 한 번에.`;
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: `${g.title} (${monthsTxt})`, description: desc, mainEntityOfPage: canon, dateModified: new Date().toISOString().slice(0, 10), author: { '@type': 'Organization', name: 'morestayz 데이터 편집팀', url: `${BASE}/pages/about` }, publisher: { '@type': 'Organization', name: SITE.name } }).replace(/</g, '\\u003c');
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canon}">
<meta property="og:title" content="${esc(g.title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:type" content="article">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script>(function(){try{var t=localStorage.getItem('mz-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();</script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});try{if(localStorage.getItem('mz-consent')==='granted')gtag('consent','update',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'})}catch(e){}</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${SITE.adsense}" crossorigin="anonymous"></script>
<script defer src="/assets/consent.js"></script>
<link rel="stylesheet" href="/assets/css/article.css">
<script type="application/ld+json">${ld}</script>
</head>
<body>
<article class="post season-guide">
  <a class="backbar" href="/">← morestayz 홈</a>
  <p class="sg-kicker">Season guide · ${monthsTxt}</p>
  <h1>${g.emoji} ${esc(g.title)}</h1>
  <p class="lede">${esc(g.intro)}</p>
  <nav class="sg-toc" aria-label="나라 바로가기">${countries.map(c => `<a href="#${esc(c)}">${esc(c)}</a>`).join('')}</nav>
  <p class="sg-legend"><span class="fit best">최적</span> 이 시기에 가장 좋은 곳 <span class="fit good">추천</span> 무난하게 좋은 곳 <span class="fit avoid">비추천</span> 우기·결항 등으로 피하는 게 나은 곳</p>
${sections}
${avoidHtml}
  <p class="disc">날씨·축제 정보는 일반적인 기후 경향을 바탕으로 정리했으며 해마다 달라질 수 있습니다. 숙소 비교 글의 일부 링크는 제휴 링크입니다.</p>
  ${adMultiplexHtml()}
  <nav class="pagenav"><a href="/">← 다른 여행 큐레이션 보기</a><span><a href="/pages/methodology">분석 방법</a> · <a href="/pages/about">소개</a></span></nav>
</article>
</body>
</html>
`;
    fs.writeFileSync(path.join(dir, `${g.id}.html`), html);
  });
}

function rebuildAll() {
  if (fs.existsSync(ART)) fs.readdirSync(ART).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  if (fs.existsSync(SPECIALS)) fs.readdirSync(SPECIALS).filter(f => f.endsWith('.json') && !f.endsWith('.hotels.json')).forEach(f => buildSpecial(f.replace(/\.json$/, '')));
  // 특별 기획(국내)은 홈 상단에 고정 노출(최신순), 그 아래 자동 큐레이션(최신순)
  const specials = specialMetas().sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const metas = [...specials, ...articleMetas()];
  const info = regenAll(metas);
  regenSearchIndex(metas);
  regenSitemap(metas, info);
  regenRss(metas);
  regenSeasonPages(metas);
  const stamped = stampAssets();
  console.log(`✓ rebuildAll: ${metas.length}개 글 · 홈 ${info.homePages}p · 카테고리 ${info.activeCats.length}개 · articles.json/sitemap 갱신`);
  return metas;
}

if (require.main === module) { if (process.argv.includes('--stamp')) console.log(`✓ stampAssets: ${stampAssets()}개 파일`); else rebuildAll(); }
module.exports = { rebuildAll, articleMetas, stampAssets };
