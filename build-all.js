#!/usr/bin/env node
/**
 * morestayz 전체 재빌드(self-heal)
 *  - data/articles/*.json → articles/*.html
 *  - index.html 의 ARTICLES 영역(최신순) + sitemap.xml 재생성
 *  publish.js가 매 실행 호출 → 생성HTML이 항상 데이터와 일치
 */
const fs = require('fs');
const path = require('path');
const { buildOne } = require('./build');

const ROOT = __dirname;
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));
const ART = path.join(ROOT, 'data/articles');

function articleMetas() {
  if (!fs.existsSync(ART)) return [];
  return fs.readdirSync(ART).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(ART, f), 'utf8'));
    return {
      slug: d.slug, title: d.title, audience: d.audience, emoji: d.emoji,
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

function regenIndex(metas) {
  const idxPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(idxPath, 'utf8');
  const cards = metas.map(cardHtml).join('\n');
  html = html.replace(/<!--ARTICLES_START-->[\s\S]*?<!--ARTICLES_END-->/,
    `<!--ARTICLES_START-->\n${cards}\n      <!--ARTICLES_END-->`);
  fs.writeFileSync(idxPath, html);
}

function regenSitemap(metas) {
  const base = `https://${SITE.domain}`;
  const urls = [
    { loc: base + '/', pri: '1.0' },
    { loc: base + '/pages/about.html', pri: '0.4' },
    { loc: base + '/pages/privacy.html', pri: '0.3' },
    { loc: base + '/pages/contact.html', pri: '0.3' },
    ...metas.map(m => ({ loc: `${base}/articles/${m.slug}`, pri: '0.8', last: m.updated })),
  ];
  const body = urls.map(u =>
    `  <url><loc>${u.loc}</loc>${u.last ? `<lastmod>${String(u.last).slice(0, 10)}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n');
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}

function rebuildAll() {
  if (fs.existsSync(ART)) fs.readdirSync(ART).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  const metas = articleMetas();
  regenIndex(metas);
  regenSitemap(metas);
  console.log(`✓ rebuildAll: ${metas.length}개 글, index·sitemap 갱신`);
  return metas;
}

if (require.main === module) rebuildAll();
module.exports = { rebuildAll, articleMetas };
