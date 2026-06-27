#!/usr/bin/env node
/**
 * morestayz 정적 글 생성기 (매거진형)
 *  data/articles/<slug>.json + templates/article.template.html → articles/<slug>.html
 *  - 데이터 시각화(여행자 유형 도넛·유형별 막대)는 여기서 인라인 SVG/HTML로 생성($0, 외부 JS 불필요)
 *
 *  node build.js            # 전체
 *  node build.js <slug>     # 특정 글
 */
const fs = require('fs');
const path = require('path');
const agoda = require('./lib/agoda');

const ROOT = __dirname;
const TPL = fs.readFileSync(path.join(ROOT, 'templates/article.template.html'), 'utf8');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));

// ── 무의존성 Mustache(부분집합) 렌더러 ──
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function lookup(stack, key) {
  if (key === '.') return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; if (c && typeof c === 'object' && key in c) return c[key]; }
  return undefined;
}
function findClose(tpl, from, name) {
  const re = new RegExp('\\{\\{([#/])\\s*' + name.replace(/\./g, '\\.') + '\\s*\\}\\}', 'g');
  re.lastIndex = from; let depth = 1, m;
  while ((m = re.exec(tpl))) { if (m[1] === '#') depth++; else if (--depth === 0) return { start: m.index, end: re.lastIndex }; }
  throw new Error('unclosed section: ' + name);
}
function render(tpl, stack) {
  const re = /\{\{([#\/]?)(\{?)\s*([\w.]+)\s*\}?\}\}/g;
  let out = '', last = 0, m;
  while ((m = re.exec(tpl))) {
    out += tpl.slice(last, m.index);
    const sigil = m[1], triple = m[2] === '{', name = m[3];
    if (sigil === '#') {
      const close = findClose(tpl, re.lastIndex, name);
      const inner = tpl.slice(re.lastIndex, close.start);
      const val = lookup(stack, name);
      if (Array.isArray(val)) val.forEach(item => out += render(inner, stack.concat([item])));
      else if (val) out += render(inner, stack.concat([typeof val === 'object' ? val : {}]));
      re.lastIndex = close.end; last = close.end; continue;
    }
    const val = lookup(stack, name);
    const s = val == null ? '' : String(val);
    out += triple ? s : escapeHtml(s);
    last = re.lastIndex;
  }
  return out + tpl.slice(last);
}

// ── 데이터 시각화 ──
const TYPE_COLOR = { couple: '#d36c8f', family: '#88a37a', solo: '#6f93b8', friends: '#d2a24c', group: '#9d83b3', business: '#8a8f98' };
const colorOf = k => TYPE_COLOR[k] || '#8a8f98';

// 집계 도넛 + 범례 (여행자 유형 분포)
function aggregateChart(agg, themeKey) {
  if (!agg || !agg.distribution.length) return '';
  const r = 54, cx = 70, cy = 70, sw = 22, C = 2 * Math.PI * r;
  let acc = 0, segs = '';
  for (const d of agg.distribution) {
    const len = (d.pct / 100) * C;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorOf(d.key)}" stroke-width="${sw}" `
      + `stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    acc += len;
  }
  const top = agg.distribution[0];
  const svg = `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="여행자 유형 분포">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>`
    + segs
    + `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="dnum">${top.pct}%</text>`
    + `<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="dlab">${escapeHtml(top.label)}</text></svg>`;
  const legend = agg.distribution.map(d =>
    `<li><span class="dot" style="background:${colorOf(d.key)}"></span>`
    + `<span class="lb${d.key === themeKey ? ' on' : ''}">${escapeHtml(d.label)}</span>`
    + `<span class="pc">${d.pct}%</span></li>`).join('');
  return `<div class="chart"><div class="donutwrap">${svg}</div><ul class="legend">${legend}</ul></div>`;
}

// 호텔별 유형 막대
function typeBars(tt, themeKey) {
  if (!tt || !tt.distribution.length) return '';
  const rows = tt.distribution.map(d => {
    const on = d.key === themeKey ? ' on' : '';
    const rt = d.rating != null ? `<span class="rt">★${d.rating}</span>` : '';
    return `<div class="tbar${on}"><span class="tl">${escapeHtml(d.label)}</span>`
      + `<span class="trk"><i style="width:${d.pct}%;background:${colorOf(d.key)}"></i></span>`
      + `<span class="tp">${d.pct}%</span>${rt}</div>`;
  }).join('');
  return `<div class="types"><div class="tcap">여행자 유형 분포 · 유형별 평점 <span>(실제 리뷰 기반)</span></div>${rows}</div>`;
}

// ── 컨텍스트 ──
function buildContext(data) {
  const themeKey = data.theme;
  const hotels = data.hotels.map(h => ({
    ...h,
    reviewCountFmt: h.reviewCountFmt || (Number(h.reviewCount).toLocaleString('en-US') + '건'),
    rankBadge: (h.rank === 1 ? '🏆 ' : '') + h.rank + '위',
    rankClass: h.rank === 1 ? 'top' : '',
    hasReviews: Array.isArray(h.reviews) && h.reviews.length > 0,
    hasTypes: !!(h.travelerTypes && h.travelerTypes.distribution && h.travelerTypes.distribution.length),
    typeBarsHtml: typeBars(h.travelerTypes, themeKey),
    img: h.img || data.heroImg,
  }));
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  return {
    ...data, site: SITE, hotels,
    hasAggregate: !!data.aggregate,
    aggregateChartHtml: aggregateChart(data.aggregate, themeKey),
    canonical,
    ogImage: data.heroImg || '',
    adsense: SITE.adsense,
    jsonld: JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Article',
      headline: data.title, description: data.metaDescription,
      datePublished: data.updated, dateModified: data.updated,
      image: data.heroImg || undefined,
      author: { '@type': 'Organization', name: SITE.name },
      publisher: { '@type': 'Organization', name: SITE.name },
      mainEntityOfPage: canonical,
    }).replace(/</g, '\\u003c'),
  };
}

function buildOne(slug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/articles', slug + '.json'), 'utf8'));
  const html = render(TPL, [buildContext(data)]);
  fs.writeFileSync(path.join(ROOT, 'articles', slug + '.html'), html);
  console.log('✓ articles/' + slug + '.html (' + data.hotels.length + '곳)');
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg) buildOne(arg);
  else {
    const dir = path.join(ROOT, 'data/articles');
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  }
}
module.exports = { buildOne, buildContext, render, aggregateChart, typeBars };
