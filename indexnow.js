#!/usr/bin/env node
/**
 * IndexNow 자동 알림 — 새로 생기거나 lastmod가 바뀐 sitemap URL만 네이버·IndexNow 공용 서버에 전송.
 *  - 키: data/indexnow.json(key) + 루트 /<key>.txt (공개 소유확인 파일)
 *  - 상태: data/indexnow-state.json { url: lastmod } — 이미 알린 URL은 다시 보내지 않음
 *  - 성공(200/202)한 경우에만 상태 저장. 실패해도 발행은 계속(publish.js에서 try/catch)
 *  node indexnow.js           # 변경분만 전송
 *  node indexnow.js --all     # 전체 재전송
 *  node indexnow.js --dry     # 전송 없이 대상만 출력
 *  node indexnow.js --wait    # 대상 URL이 실제로 200이 될 때까지(최대 10분) 기다린 뒤 전송 — 배포 직후용
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));
const KEY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/indexnow.json'), 'utf8')).key;
const STATE = path.join(ROOT, 'data/indexnow-state.json');
const ENDPOINTS = [
  'https://searchadvisor.naver.com/indexnow', // 네이버(공식)
  'https://api.indexnow.org/indexnow',        // 공용(빙 등 참여 검색엔진에 공유)
];

function sitemapEntries() {
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const out = {};
  for (const m of xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)) out[m[1]] = m[2];
  return out;
}

async function waitLive(urls, maxMs = 10 * 60 * 1000) {
  const t0 = Date.now();
  let pending = urls.slice();
  while (pending.length && Date.now() - t0 < maxMs) {
    const res = await Promise.all(pending.map(u => fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) }).then(r => r.status).catch(() => 0)));
    pending = pending.filter((u, i) => res[i] !== 200);
    if (pending.length) await new Promise(r => setTimeout(r, 15000));
  }
  return pending; // 아직 200이 아닌 URL
}

async function notify({ all = false, dry = false, wait = false } = {}) {
  const now = sitemapEntries();
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const urls = Object.keys(now).filter(u => all || prev[u] !== now[u]);
  if (!urls.length) { console.log('✓ IndexNow: 변경된 URL 없음'); return { sent: 0 }; }
  console.log(`▶ IndexNow: ${urls.length}개 URL ${dry ? '(dry-run)' : '전송'}`);
  if (dry) { urls.forEach(u => console.log('  ' + u)); return { sent: 0 }; }
  if (wait) {
    const notLive = await waitLive(urls);
    if (notLive.length) {
      console.log(`  ⚠ 아직 배포 안 된 URL ${notLive.length}개는 다음 실행으로 미룸`);
      notLive.forEach(u => { const i = urls.indexOf(u); if (i >= 0) urls.splice(i, 1); });
      if (!urls.length) return { sent: 0 };
    }
  }
  const body = JSON.stringify({ host: SITE.domain, key: KEY, keyLocation: `https://${SITE.domain}/${KEY}.txt`, urlList: urls.slice(0, 10000) });
  let ok = false;
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body, signal: AbortSignal.timeout(20000) });
      const t = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
      console.log(`  ${r.status} ${ep}${t ? ' — ' + t : ''}`);
      if (r.status === 200 || r.status === 202) ok = true;
    } catch (e) { console.log(`  ✗ ${ep} — ${String(e.message).slice(0, 120)}`); }
  }
  if (ok) {
    urls.forEach(u => { prev[u] = now[u]; });
    fs.writeFileSync(STATE, JSON.stringify(prev, null, 2) + '\n');
  }
  return { sent: ok ? urls.length : 0 };
}

if (require.main === module) notify({ all: process.argv.includes('--all'), dry: process.argv.includes('--dry'), wait: process.argv.includes('--wait') }).catch(e => { console.error(e); process.exit(1); });
module.exports = { notify };
