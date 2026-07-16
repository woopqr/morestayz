#!/bin/bash
# morestayz 안전 배포 — 충돌 없이 pull → 재빌드 → commit → push
# 사용법:  bash push.sh "커밋 메시지"
set -e
cd "$(dirname "$0")"

# 생성 파일 자동 병합 드라이버(최초 1회만 필요, 반복 실행 무해)
git config merge.ours.driver true

echo "▶ 최신 변경 가져오는 중(자동 발행 봇 포함)…"
git pull --rebase

echo "▶ 사이트 재빌드…"
node build-all.js

git add -A
if git commit -m "${1:-chore: update}" ; then
  echo "▶ 커밋 완료"
else
  echo "▶ 커밋할 변경 없음"
fi

echo "▶ 배포(push)…"
git push
echo "✓ 완료 — Cloudflare가 곧 재배포합니다."
