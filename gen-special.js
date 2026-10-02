#!/usr/bin/env node
/**
 * morestayz 특별기획 숙소 수집 — data/specials/<slug>.json 에 cityId(또는 cities[])가 있으면
 * 아고다에서 해당 지역 숙소를 수집해 <slug>.hotels.json(사이드카)로 저장.
 *  - 안전장치: 반환된 지명이 cityNameMatch(정규식)와 맞을 때만 저장(엉뚱한 도시 방지)
 *  - cities: [{ cityId, cityNameMatch, label }] — 여러 도시를 한 글에 묶을 때(예: 타이베이+가오슝)
 *  - luxury: { minStar, minScore, minReviews, minPriceKRW, excludeName, pages, perCity }
 *      → 성급·평점·가격·이름 필터로 '럭셔리 호텔'만 추려 평점순 정렬(가격 미표시는 통과)
 *  - GitHub Actions에서 실행(샌드박스는 아고다 접속 불가)
 *  node gen-special.js            # 전체 특별글
 */
const fs = require('fs');
const path = require('path');
const af = require('./lib/agoda-fetch');
const md = require('./lib/morestaz-data');

const ROOT = __dirname;
const DIR = path.join(ROOT, 'data/specials');
const MAX = 40;

function toCard(h, i, label) {
  return {
    rank: i + 1,
    name: h.name,
    agodaUrl: h.agodaUrl,
    img: h.img ? 'https:' + h.img.replace(/^https?:/, '') : '',
    score: h.score,
    reviewCountFmt: Number(h.reviewCount || 0).toLocaleString('en-US') + '건',
    priceText: h.priceText || '',
    star: h.star || null,
    badge: label ? [h.star ? `${h.star}성` : '', label].filter(Boolean).join(' · ') : '',
    refLabel: h.refLandmark || '',
    walkMin: h.walkMin || null,
  };
}

function luxuryFilter(lux) {
  const ex = lux.excludeName ? new RegExp(lux.excludeName, 'i') : null;
  return h => (h.star || 0) >= (lux.minStar || 5)
    && h.score >= (lux.minScore || 8.5)
    && (h.reviewCount || 0) >= (lux.minReviews || 300)
    && (h.priceKRW == null || h.priceKRW >= (lux.minPriceKRW || 0))
    && !(ex && ex.test(h.name));
}

async function collectCity(c, lux) {
  const pages = lux ? (lux.pages || 3) : 1;
  let cityName = '';
  const seen = new Set();
  let props = [];
  for (let page = 1; page <= pages; page++) {
    const cs = await af.fetchCitySearch(Number(c.cityId), { page, daysAhead: 30 });
    if (page === 1) cityName = cs?.searchResult?.searchInfo?.objectInfo?.cityName || '';
    (cs.properties || []).map(p => md.mapPropertyRich(p)).forEach(h => {
      if (seen.has(h.propertyId)) return;
      seen.add(h.propertyId);
      props.push(h);
    });
  }
  const re = c.cityNameMatch ? new RegExp(c.cityNameMatch, 'i') : null;
  if (re && !re.test(cityName)) throw new Error(`반환 지명 "${cityName}"가 "${c.cityNameMatch}"와 불일치 → 저장 안 함(안전)`);
  let eligible = props.filter(h => h.name && h.agodaUrl && h.score != null);
  if (lux) {
    eligible = eligible.filter(luxuryFilter(lux))
      .sort((a, b) => (b.score - a.score) || ((b.reviewCount || 0) - (a.reviewCount || 0)))
      .slice(0, lux.perCity || 10);
  }
  return { cityName, hotels: eligible };
}

async function genOne(file) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const cities = d.cities || (d.cityId ? [{ cityId: d.cityId, cityNameMatch: d.cityNameMatch }] : []);
  if (!cities.length) { console.log(`- ${file}: cityId 없음, 건너뜀`); return; }
  const names = [];
  let cards = [];
  for (const c of cities) {
    const { cityName, hotels } = await collectCity(c, d.luxury);
    names.push(cityName);
    const label = cities.length > 1 ? (c.label || cityName) : '';
    cards = cards.concat(hotels.map(h => ({ h, label })));
    console.log(`  · ${cityName}: ${hotels.length}곳`);
  }
  const hotels = cards.slice(0, MAX).map(({ h, label }, i) => toCard(h, i, label));
  if (!hotels.length) { console.warn(`✗ ${file}: 조건에 맞는 숙소 0곳 → 기존 사이드카 유지`); return; }
  const outFile = file.replace(/\.json$/, '.hotels.json');
  const cityName = names.join(' · ');
  fs.writeFileSync(path.join(DIR, outFile), JSON.stringify({ cityName, count: hotels.length, updated: new Date().toISOString().slice(0, 10), hotels }, null, 2));
  console.log(`✓ ${outFile}: ${cityName} 숙소 ${hotels.length}곳 저장`);
}

(async () => {
  if (!fs.existsSync(DIR)) return;
  const only = process.argv[2];
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !f.endsWith('.hotels.json'))
    .filter(f => !only || f === only || f === only + '.json');
  for (const f of files) {
    try { await genOne(f); }
    catch (e) { console.error(`✗ ${f}: ${String(e.message).slice(0, 160)}`); }
  }
})();
