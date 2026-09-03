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
const SPECIAL_TPL = fs.existsSync(path.join(ROOT, 'templates/special.template.html')) ? fs.readFileSync(path.join(ROOT, 'templates/special.template.html'), 'utf8') : '';
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));

// ── 무의존성 Mustache(부분집합) 렌더러 ──
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function lookup(stack, key) {
  if (key === '.') return stack[stack.length - 1];
  const parts = key.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    let value = stack[i], found = true;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !(part in value)) { found = false; break; }
      value = value[part];
    }
    if (found) return value;
  }
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
// ── 글마다 고유한 intro 생성(중복 보일러플레이트 방지) — JSON 데이터만 사용, 재수집 불필요 ──
function shortName(s) { return String(s || '').split('(')[0].trim(); }
function hashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
const INTRO_OPENERS = [
  '{aud}은 어디서 묵느냐가 만족도의 절반을 정합니다.',
  '같은 예산이어도 어느 숙소에 묵느냐로 여행의 질이 갈립니다.',
  '숙소 하나 잘 고르면 {city} 여행 전체의 동선이 편해집니다.',
  '{city}은 위치와 컨디션에 따라 체감 만족이 크게 달라지는 곳입니다.',
  '성수기일수록 평 좋은 가성비 숙소는 예상보다 빨리 마감됩니다.',
  '리뷰가 충분히 쌓이고 평이 안정적인 숙소가 결국 실패가 적습니다.',
  '처음 가는 도시일수록 검증된 후기가 많은 숙소가 안전합니다.',
];
function uniqueIntro(data) {
  const city = data.city || '', season = data.season || '', mon = data.travelMonthLabel || '', aud = data.audience || '';
  const n = (data.hotels || []).length;
  const top = (data.hotels || [])[0];
  const topType = data.aggregate && data.aggregate.distribution && data.aggregate.distribution[0];
  const opener = INTRO_OPENERS[hashStr(data.slug || city) % INTRO_OPENERS.length].replace('{aud}', aud).replace('{city}', city);
  let s = opener + ' ';
  s += `이번 편은 ${mon ? mon + ' ' : ''}${city} ${season} 여행을 앞두고, ${aud} 투숙객 리뷰가 많고 평이 좋은 숙소 ${n}곳을 평점·가성비 기준으로 비교했습니다.`;
  if (topType && topType.pct) s += ` 선정 숙소의 후기는 ${topType.label} 비중이 평균 ${topType.pct}% 수준으로, 실제 이용층과 목적이 잘 맞습니다.`;
  if (top && top.score != null) s += ` 데이터상 1순위는 ${shortName(top.name)}(평점 ${top.score})입니다.`;
  return s;
}

// 기존 홍보형 제목을 검색 의도와 비교 대상을 바로 설명하는 제목으로 정규화한다.
function editorialTitle(data) {
  const city = data.city || '';
  const audience = data.audience || '여행';
  const month = data.travelMonthLabel ? ` ${data.travelMonthLabel}` : '';
  return `${city} ${audience} 숙소 실제 비교${month} | 평점·가격·위치 분석`;
}

function editorialDescription(data) {
  const count = (data.hotels || []).length;
  return `${data.city} ${data.audience} 숙소 ${count}곳을 ${data.travelMonthLabel || '조회 시점'} 기준 평점·리뷰 수·가격·교통거리로 비교했습니다. 데이터 출처, 검색 조건과 유형 표본 수를 함께 공개합니다.`;
}

function isCurrentOrFuture(data, now = new Date()) {
  const ym = data._meta?.targetMonth || /^(\d{4})-(\d{2})/.exec(String(data.slug || '').match(/\d{4}-\d{2}$/)?.[0] || '')?.[0];
  if (!ym) return true;
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
}

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
    hasPrice: !!h.priceKRW || !/가격 변동|확인 불가/.test(h.priceText || ''),
    priceStatus: h.priceStatus || (/가격 변동/.test(h.priceText || '') ? '조회 시점 가격 확인 불가' : '조회됨'),
    locationStatus: h.locationStatus || (h.walkMin && h.refLabel ? '조회됨' : '위치 상세 확인 필요'),
    sampleCount: h.travelerTypes?.total || (h.travelerTypes?.distribution || []).reduce((n, d) => n + (d.count || 0), 0),
  }));
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  const fetchedAt = data.methodology?.fetchedAt || data._meta?.fetchedAt || data.updated;
  const sampleTotal = data.aggregate?.total || 0;
  const title = editorialTitle(data);
  const metaDescription = editorialDescription(data);
  return {
    ...data, title, metaDescription, site: SITE, hotels,
    intro: uniqueIntro(data),
    hasAggregate: !!data.aggregate,
    aggregateChartHtml: aggregateChart(data.aggregate, themeKey),
    canonical,
    ogImage: data.heroImg || '',
    adsense: SITE.adsense,
    sourceName: data.methodology?.source || 'Agoda citySearch 검색 응답',
    fetchedAtLabel: fetchedAt ? new Date(fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '',
    searchCondition: data.methodology?.searchCondition || `${data.travelMonthLabel || ''} 조회 조건`,
    sampleTotal,
    sampleReliability: sampleTotal >= 50 ? '참고 가능한 표본' : '소표본·방향성 참고',
    sampleNotice: data.methodology?.sampleNotice || '여행자 유형 비중은 전체 리뷰가 아니라 검색 응답에 포함된 리뷰 스니펫 표본을 집계한 값입니다.',
    robotsContent: isCurrentOrFuture(data) ? 'index,follow,max-image-preview:large' : 'noindex,follow',
    authorName: 'morestayz 데이터 편집팀',
    updatedLabel: data.updated || String(fetchedAt || '').slice(0, 10),
    jsonld: JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Article',
      headline: title, description: metaDescription,
      datePublished: data.updated, dateModified: data.updated,
      image: data.heroImg || undefined,
      author: { '@type': 'Organization', name: 'morestayz 데이터 편집팀', url: `https://${SITE.domain}/pages/about.html` },
      publisher: { '@type': 'Organization', name: SITE.name, url: `https://${SITE.domain}/` },
      about: [{ '@type': 'Thing', name: data.city }, { '@type': 'Thing', name: data.audience }],
      isPartOf: { '@type': 'WebSite', name: SITE.name, url: `https://${SITE.domain}/` },
      mainEntityOfPage: canonical,
    }).replace(/</g, '\\u003c'),
  };
}

function buildOne(slug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/articles', slug + '.json'), 'utf8'));
  const html = render(TPL, [buildContext(data)]);
  fs.mkdirSync(path.join(ROOT, 'articles'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'articles', slug + '.html'), html);
  console.log('✓ articles/' + slug + '.html (' + data.hotels.length + '곳)');
}

// ── 국내 특별 기획(에디토리얼) 렌더러 ──
const AGODA_ULLEUNG = agoda.citySearchById(182676);
function buildSpecialContext(data, hotels) {
  hotels = hotels || [];
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  const agodaUrl = data.agodaUrl || AGODA_ULLEUNG;
  const faqLd = (data.faq && data.faq.length) ? {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: data.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  } : null;
  const artLd = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: data.title, description: data.metaDescription,
    datePublished: data.updated, dateModified: data.updated,
    author: { '@type': 'Organization', name: SITE.name },
    publisher: { '@type': 'Organization', name: SITE.name },
    mainEntityOfPage: canonical,
  };
  const jsonld = JSON.stringify(faqLd ? [artLd, faqLd] : artLd).replace(/</g, '\\u003c');
  const hero = data.hero || {};
  const region = data.region || '여행지';
  return {
    site: SITE, adsense: SITE.adsense, canonical, jsonld, agodaUrl,
    slug: data.slug, title: data.title, metaDescription: data.metaDescription,
    keywordsCsv: (data.keywords || []).join(', '),
    heroEyebrow: hero.eyebrow || '', heroHeadline: escapeHtml(hero.headline || '').replace(/\n/g, '<br>'), heroSub: hero.sub || '',
    keywords: data.keywords || [],
    intro: data.intro || '',
    sections: data.sections || [],
    stays: (data.stays || []).map(s => ({ ...s, url: s.url || agodaUrl })),
    nearbyFood: (data.nearby && data.nearby.food) || [],
    nearbyCafe: (data.nearby && data.nearby.cafe) || [],
    faq: data.faq || [],
    hotels: hotels,
    hasHotels: hotels.length > 0,
    hotelCount: hotels.length,
    hotelHeading: data.hotelHeading || `🏨 ${region} 실제 숙소`,
    topCtaText: data.topCtaText || `🏨 ${region} 숙소 최저가 비교하기 →`,
    staysHeading: data.staysHeading || `🏨 ${region} 권역별 숙소`,
    nearbyHeading: data.nearbyHeading || `🍽️ ${region} 대표 맛집 & 카페`,
    faqHeading: data.faqHeading || `❓ 자주 묻는 질문 (${region} 여행 Q&A)`,
    bottomCtaText: data.bottomCtaText || `🏨 지금 ${region} 숙소 미리 예약하기 →`,
    disc: data.disc || '일부 링크는 제휴 링크이며 구매 시 수수료를 받을 수 있습니다. 방송·명소·시설 정보는 공개된 자료를 바탕으로 정리했으며 방문 시점에 따라 달라질 수 있습니다.',
  };
}
function buildSpecial(fileSlug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/specials', fileSlug + '.json'), 'utf8'));
  const sidecar = path.join(ROOT, 'data/specials', fileSlug + '.hotels.json');
  let hotels = [];
  if (fs.existsSync(sidecar)) { try { hotels = JSON.parse(fs.readFileSync(sidecar, 'utf8')).hotels || []; } catch (e) {} }
  const html = render(SPECIAL_TPL, [buildSpecialContext(data, hotels)]);
  fs.mkdirSync(path.join(ROOT, 'articles'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'articles', data.slug + '.html'), html);
  console.log('✓ articles/' + data.slug + '.html (특별기획: ' + (data.region || data.slug) + ')');
  return data;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg) buildOne(arg);
  else {
    const dir = path.join(ROOT, 'data/articles');
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  }
}
module.exports = { buildOne, buildSpecial, buildContext, render, aggregateChart, typeBars, editorialTitle, editorialDescription, isCurrentOrFuture };
