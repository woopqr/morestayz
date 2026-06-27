#!/usr/bin/env node
/**
 * morestayz 글 생성기 — 테마(오디언스×시즌) × 도시
 *   node gen.js <themeId> <cityId> <citySlug> [yyyy-mm] [N]
 *   예) node gen.js couple 9590 osaka-namba 2026-08 6
 *
 *  - 선행발행: yyyy-mm(여행 시점) 미지정 시 '현재월+1'을 타깃 → 그 시점 가격으로 수집
 *  - 선별: 테마 preferType(커플/가족/혼행/친구) 적합도 + 가성비
 *  - 시각화 데이터: 여행자 유형 분포·유형별 평점(실데이터)
 * 결과: data/articles/<slug>.json  →  node build.js <slug>
 */
const fs = require('fs');
const path = require('path');
const af = require('./lib/agoda-fetch');
const md = require('./lib/morestaz-data');
const agoda = require('./lib/agoda');

const ROOT = __dirname;
const THEMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/themes.json'), 'utf8'));
const MIN_REVIEWS = 30;

const [themeId, cityId, citySlug, ymArg, nArg] = process.argv.slice(2);
const N = Number(nArg) || 6;
if (!themeId || !cityId || !citySlug) {
  console.error('사용법: node gen.js <themeId> <cityId> <citySlug> [yyyy-mm] [N]');
  process.exit(1);
}
const theme = THEMES.themes.find(t => t.id === themeId);
if (!theme) { console.error('알 수 없는 테마: ' + themeId + ' (가능: ' + THEMES.themes.map(t => t.id).join(', ') + ')'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');

// 타깃 여행월
function targetMonth(ym) {
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { const [y, m] = ym.split('-').map(Number); return { y, m }; }
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function daysUntilMid(y, m) {
  const mid = new Date(Date.UTC(y, m - 1, 15, 12));
  const diff = Math.ceil((mid - Date.now()) / 86400000);
  return Math.max(14, Math.min(330, diff)); // 아고다 가격 조회 가능 범위 내
}
function seasonFor(m) {
  const matches = THEMES.seasons.filter(s => s.months.includes(m));
  if (!matches.length) return null;
  matches.sort((a, b) => a.months.length - b.months.length); // 더 구체적인(연휴 등) 우선
  return matches[0];
}
function pick(arr, i) { return arr[((i % arr.length) + arr.length) % arr.length]; }
const shortName = s => String(s).split('(')[0].trim();

(async () => {
  const tm = targetMonth(ymArg);
  const daysAhead = daysUntilMid(tm.y, tm.m);
  const season = seasonFor(tm.m);
  const travelMonthLabel = `${tm.y}년 ${tm.m}월`;
  console.log(`▶ ${theme.audience} · ${citySlug} · 여행시점 ${travelMonthLabel}(D+${daysAhead}) · top ${N}`);

  const cs = await af.fetchCitySearch(Number(cityId), { daysAhead });
  const rawCityName = cs?.searchResult?.searchInfo?.objectInfo?.cityName || '';
  const city = rawCityName.split('/')[0].trim() || citySlug;

  const props = (cs.properties || []).map(p => md.mapPropertyRich(p));
  const eligible = props.filter(h => h.name && h.score != null && h.agodaUrl && h.reviewCount >= MIN_REVIEWS);
  if (!eligible.length) throw new Error('조건을 만족하는 호텔이 없습니다.');

  // 테마 적합도(여행자 유형) + 가성비 결합 정렬. 유형 데이터 없으면 가성비로 폴백.
  const score = h => {
    const aff = md.affinityFor(theme.preferType, h.travelerTypes); // 0~100
    const val = (h.valueIndex || 0) * 8; // 0~80 가량
    return aff * 1.0 + val;
  };
  const picked = eligible.sort((a, b) => score(b) - score(a)).slice(0, N).map((h, i) => ({ ...h, rank: i + 1 }));

  // 비한국어 리뷰 번역(무료 구글)
  let tr = 0;
  for (const h of picked) for (const r of (h.reviews || [])) {
    if (/[가-힣]/.test(r.text)) continue;
    const ko = await af.translateToKo(r.text);
    if (ko && /[가-힣]/.test(ko)) { r.original = r.text; r.text = ko; r.translated = true; tr++; }
    await new Promise(res => setTimeout(res, 120));
  }
  if (tr) console.log(`  ↳ 리뷰 ${tr}건 번역`);

  // 집계 여행자 유형(이 글의 숙소 전체)
  const aggAcc = {};
  for (const h of picked) for (const d of (h.travelerTypes?.distribution || [])) {
    const a = aggAcc[d.key] || (aggAcc[d.key] = { key: d.key, label: d.label, count: 0 });
    a.count += d.count;
  }
  const aggArr = Object.values(aggAcc);
  const aggTotal = aggArr.reduce((n, g) => n + g.count, 0);
  const aggregate = aggTotal ? {
    total: aggTotal,
    distribution: aggArr.map(g => ({ ...g, pct: Math.round(g.count / aggTotal * 100) }))
      .sort((a, b) => b.count - a.count),
  } : null;

  // 제목/메타/본문
  const hook = pick(theme.hooks, Number(cityId) + tm.m);
  const title = theme.titlePattern.replace('{city}', city).replace('{hook}', hook);
  const top = picked[0];
  const topPrice = (top.priceText.split('·')[1] || '').trim();
  const themeShareTxt = aggregate
    ? (() => { const g = aggregate.distribution.find(d => d.key === theme.preferType); return g ? `이 숙소들의 ${theme.audience.replace('여행', '')} 리뷰 비중은 평균 ${g.pct}%로 ` : ''; })()
    : '';
  const verdict = `${themeShareTxt}${theme.audience} 기준 1순위는 <b>${shortName(top.name)}</b>입니다 (평점 ${top.score}·리뷰 ${Number(top.reviewCount).toLocaleString('en-US')}건${topPrice ? `·1박 ${topPrice}` : ''}). ${theme.viewpoint}`;

  const hotels = picked.map(h => {
    const tt = h.travelerTypes;
    const tags = [];
    if (h.priceKRW) tags.push('💰 약 ' + Math.round(h.priceKRW / 10000) + '만원');
    tags.push('📝 리뷰 ' + Number(h.reviewCount).toLocaleString('en-US') + '건');
    if (h.star) tags.push('⭐ ' + h.star + '성급');
    if (tt?.topLabel) tags.push('👥 ' + tt.topLabel + ' 선호');
    const refLabel = h.refLandmark || '주요 역';
    const typeTxt = tt ? `${theme.audience.replace('여행', '')} 리뷰 비중 ${(tt.distribution.find(d => d.key === theme.preferType) || {}).pct || 0}%` : '';
    const blurb = `평점 ${h.score} · 리뷰 ${Number(h.reviewCount).toLocaleString('en-US')}건. ${refLabel} 도보 ${h.walkMin}분, ${h.priceText}.${typeTxt ? ' ' + typeTxt + '.' : ''}`;
    return {
      rank: h.rank, name: h.name, agodaUrl: h.agodaUrl,
      img: h.img ? 'https:' + h.img.replace(/^https?:/, '') : '',
      score: h.score, reviewCount: h.reviewCount,
      reviewCountFmt: Number(h.reviewCount).toLocaleString('en-US') + '건',
      priceText: h.priceText, walkMin: h.walkMin, refLabel,
      star: h.star || null,
      blurb, metaTags: tags,
      travelerTypes: tt ? { topLabel: tt.topLabel, topPct: tt.topPct, distribution: tt.distribution } : null,
      reviews: (h.reviews || []).map(r => ({
        text: r.text, score: r.rating != null ? String(r.rating) : '★',
        country: r.country || '', date: r.date || '', translated: !!r.translated,
      })),
    };
  });

  const heroImg = hotels[0].img || '';
  const slug = `${theme.id}-${citySlug}-${tm.y}-${pad(tm.m)}`;
  const data = {
    slug, theme: theme.id, audience: theme.audience, emoji: theme.emoji,
    city, citySlug, cityId: Number(cityId),
    cityUrl: agoda.citySearchById(Number(cityId)),
    season: season?.label || '', seasonNote: season?.note || '',
    travelMonthLabel,
    title,
    metaDescription: `${city} ${theme.audience}, ${travelMonthLabel}을 앞두고 아고다 실제 리뷰 데이터로 고른 ${theme.audience.replace('여행', '')} 선호 가성비 숙소 ${hotels.length}곳. 여행자 유형 분포·평점까지 비교.`,
    intro: theme.intro, viewpoint: theme.viewpoint, verdict,
    aggregate,
    heroImg, heroAlt: `${city} ${theme.audience}`,
    updated: new Date().toISOString().slice(0, 10),
    hotels,
    _meta: { fetchedAt: new Date().toISOString(), source: 'agoda citySearch', daysAhead, targetMonth: `${tm.y}-${pad(tm.m)}`, count: hotels.length },
  };

  const outPath = path.join(ROOT, 'data/articles', slug + '.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✓ data/articles/${slug}.json (${hotels.length}곳, 테마=${theme.id}, city="${city}")`);
  console.log('  다음: node build.js ' + slug);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
