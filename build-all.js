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
const { buildOne } = require('./build');

const ROOT = __dirname;
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));
const THEMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/themes.json'), 'utf8'));
const ART = path.join(ROOT, 'data/articles');
const PAGE_SIZE = 12;
const BASE = `https://${SITE.domain}`;

// 카테고리 정의(테마 순서 = 노출 순서). 실제 글이 있는 카테고리만 노출.
const CATS = THEMES.themes.map(t => ({ id: t.id, label: t.audience, emoji: t.emoji }));

function articleMetas() {
  if (!fs.existsSync(ART)) return [];
  return fs.readdirSync(ART).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ART, f), 'utf8'));
    return {
      slug: d.slug, theme: d.theme, title: d.title, audience: d.audience, emoji: d.emoji,
      city: d.city, season: d.season || '', travelMonthLabel: d.travelMonthLabel || '',
      heroImg: d.heroImg || '', updated: d.updated || (d._meta && d._meta.fetchedAt) || '',
    };
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

function cardHtml(m) {
  return `      <a class="card" href="/articles/${m.slug}">
        <div class="cthumb"><img src="${m.heroImg}" alt="" loading="lazy"><span class="ctag">${m.emoji} ${m.audience}</span></div>
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
  activeCats.forEach(c => { html += chip(`/category/${c.id}`, `${c.emoji} ${c.label}`, currentId === c.id); });
  return html;
}

function applyShell(shell, opts) {
  // opts: { cards, pager, catnav, canon, title, seclabel }
  let html = shell
    .replace(/<!--ARTICLES_START-->[\s\S]*?<!--ARTICLES_END-->/, `<!--ARTICLES_START-->\n${opts.cards}\n      <!--ARTICLES_END-->`)
    .replace(/<!--PAGER_START-->[\s\S]*?<!--PAGER_END-->/, `<!--PAGER_START-->${opts.pager}<!--PAGER_END-->`)
    .replace(/<!--CATNAV_START-->[\s\S]*?<!--CATNAV_END-->/, `<!--CATNAV_START-->${opts.catnav}<!--CATNAV_END-->`)
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
    const cards = chunkMetas.map(cardHtml).join('\n');
    const opts = {
      cards,
      pager: pagerHtml(ctx.base, p, total),
      catnav: catnavHtml(activeCats, ctx.kind === 'home' ? 'all' : ctx.id),
      canon,
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
    city: m.city, season: m.season, month: m.travelMonthLabel, img: m.heroImg,
  }));
  fs.writeFileSync(path.join(ROOT, 'articles.json'), JSON.stringify(data));
}

function regenSitemap(metas, info) {
  const urls = [
    { loc: BASE + '/', pri: '1.0' },
    { loc: BASE + '/pages/about.html', pri: '0.4' },
    { loc: BASE + '/pages/privacy.html', pri: '0.3' },
    { loc: BASE + '/pages/contact.html', pri: '0.3' },
  ];
  for (let p = 2; p <= (info.homePages || 1); p++) urls.push({ loc: `${BASE}/page/${p}`, pri: '0.5' });
  info.catPageInfo.forEach(c => {
    urls.push({ loc: `${BASE}/category/${c.id}`, pri: '0.6' });
    for (let p = 2; p <= c.total; p++) urls.push({ loc: `${BASE}/category/${c.id}/${p}`, pri: '0.4' });
  });
  metas.forEach(m => urls.push({ loc: `${BASE}/articles/${m.slug}`, pri: '0.8', last: m.updated }));
  const body = urls.map(u =>
    `  <url><loc>${u.loc}</loc>${u.last ? `<lastmod>${String(u.last).slice(0, 10)}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n');
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}

function rebuildAll() {
  if (fs.existsSync(ART)) fs.readdirSync(ART).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  const metas = articleMetas();
  const info = regenAll(metas);
  regenSearchIndex(metas);
  regenSitemap(metas, info);
  console.log(`✓ rebuildAll: ${metas.length}개 글 · 홈 ${info.homePages}p · 카테고리 ${info.activeCats.length}개 · articles.json/sitemap 갱신`);
  return metas;
}

if (require.main === module) rebuildAll();
module.exports = { rebuildAll, articleMetas };
