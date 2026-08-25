# 인수인계 — 뷰티블라썸 통합 성과 보고서

담당자: 이건호 (doctor.leegh@gmail.com) · 최종 갱신 2026-08-20

GA4 · YouTube · Google Search Console · 네이버 서치어드바이저 · Instagram 5개 소스를
수집해 단일 HTML 대시보드로 만들고 GitHub Pages로 배포하는 파이프라인입니다.

| 항목 | 값 |
|---|---|
| 작업 폴더 | `C:\Users\metic\Desktop\paseo\project(1)` |
| 저장소 | https://github.com/doctorleegh-debug/beautyblossom-analytics |
| 공개 보고서 | https://doctorleegh-debug.github.io/beautyblossom-analytics/ |
| 배포 방식 | GitHub Pages, `master` 브랜치 **저장소 루트** |
| 런타임 | Node 24+, Windows PowerShell 5.1, Chrome |

---

## 1. 이사 체크리스트 — 이것부터 읽으세요

`git clone` 만으로는 **동작하지 않습니다.** 인증 정보와 브라우저 세션이 저장소 밖에 있습니다.

### 반드시 수동으로 옮겨야 하는 것 (git 에 없음)

| 대상 | 경로 | 내용 |
|---|---|---|
| 환경 변수 | `.env.local` | Meta 시스템 토큰, 앱 ID 등 |
| 구글 인증 | `.secrets/` | OAuth 클라이언트 + refresh token 4개 파일 |
| 네이버 크롬 프로필 | `C:\Users\metic\.bb-chrome-naver\` | 옮겨도 세션은 안 살아납니다(아래 참고) |

`.secrets/` 안의 파일:
```
google-oauth.local.json                 클라이언트 ID/시크릿 (3개 구글 소스 공용)
google-oauth-token.local.json           GA4 refresh token
google-oauth-youtube-token.local.json   YouTube refresh token
google-oauth-gsc-token.local.json       Search Console refresh token
meta-token.local.json                   Meta 사용자 토큰 (참고용, 실사용은 .env.local)
```

**보안:** 위 파일들은 `.gitignore` 로 제외돼 있습니다. 절대 커밋하지 말고, 채팅·이슈·로그에
값을 붙여넣지 마세요. 이동은 파일 복사로만 하세요.

### 이사 후 검증 순서

```powershell
# 1. 5개 연결 상태 한 번에 점검 (토큰 값은 출력 안 함)
powershell -NoProfile -File scripts\check-connections.ps1

# 2. 네이버 세션 기동 (창 뜸 → 로그인 → 자동으로 화면 밖 이동)
node scripts\naver-session.mjs start

# 3. 전체 수집 + 빌드
powershell -NoProfile -File scripts\collect-ga4.ps1
powershell -NoProfile -File scripts\collect-youtube.ps1
powershell -NoProfile -File scripts\collect-searchconsole.ps1
powershell -NoProfile -File scripts\collect-instagram.ps1
node scripts\collect-naver.mjs
node scripts\build-report.mjs

# 4. 배포 (Pages 가 루트를 서빙하므로 복사 필요)
copy report\index.html index.html
git add -A; git commit -m "..."; git push origin master
```

---

## 2. 소스별 인증 방식과 만료 특성

| 소스 | 방식 | 만료 | 갱신 필요? |
|---|---|---|---|
| GA4 | Google OAuth refresh_token | access 1시간, refresh 무기한 | **불필요** — 실행할 때마다 자동 갱신 |
| YouTube | 〃 | 〃 | **불필요** |
| Search Console | 〃 | 〃 | **불필요** |
| Meta / Instagram | 시스템 사용자 토큰 | **없음** | **불필요** |
| 네이버 | 브라우저 로그인 세션 | 수일~수주 | **필요** — 아래 3장 |

구글 3종은 `.secrets/google-oauth.local.json` 의 클라이언트로 매 실행마다
refresh token 을 써서 새 access token 을 받습니다. 재인증이 필요해지면
`scripts\auth-youtube-oauth.ps1`, `scripts\auth-searchconsole-oauth.ps1` 로 다시 받습니다
(loopback `http://localhost:53682/`).

Meta 는 `.env.local` 의 `META_SYSTEM_TOKEN` 을 씁니다. 시스템 사용자 토큰이라 만료가 없고
`instagram_manage_insights` 를 포함합니다. `debug_token` 으로 확인 시 `expires_at` 이 없습니다.

---

## 3. 네이버 — 이 프로젝트에서 가장 특이한 부분

**네이버는 성과 조회용 공개 API 가 없습니다.** 로그인된 서치어드바이저 콘솔 화면에서만
데이터를 얻을 수 있습니다.

### 왜 이렇게 만들었나

두 가지 제약을 동시에 만족시켜야 했습니다.

1. **담당자 모니터·마우스를 뺏으면 안 됨** — 초기 구현은 UIAutomation 으로 실제 크롬 창을
   읽어서, 담당자가 일하는 중에는 돌릴 수 없었습니다.
2. **네이버가 인증 쿠키를 세션 쿠키로 발급함** — `NID_AUT` / `NID_SES` 가 디스크에 저장되지
   않고 브라우저 프로세스 메모리에만 존재합니다. 그래서 헤드리스 크롬을 새로 띄우면
   **항상 로그아웃 상태**입니다. (「로그인 상태 유지」 체크로도 해결되지 않았습니다.)

### 현재 방식

로그인된 크롬 **한 개를 계속 살려두고** CDP(Chrome DevTools Protocol)로 조종합니다.

- 프로필: `C:\Users\metic\.bb-chrome-naver` (담당자 일상 크롬과 완전 분리)
- 디버깅 포트: `9335`
- 창 위치: `(-32000, -32000)` — 화면 밖
- `Emulation.setFocusEmulationEnabled` 로 렌더러 throttling 방지

> **최소화하면 안 됩니다.** 최소화된 창은 `visibilityState: hidden` 이 되고,
> 서치어드바이저 SPA 가 데이터를 아예 fetch 하지 않습니다. 화면 밖 배치여야 합니다.

### 운영 규칙

- ⚠️ **화면 밖 크롬을 닫으면 세션이 사라집니다.** 작업표시줄에 보여도 닫지 마세요.
- 세션이 끊기면 수집기가 `LOGIN_REQUIRED` 로 명확히 실패하고 **exit 2** 로 끝나며,
  기존 데이터를 덮어쓰지 않습니다.
- 재로그인: `node scripts\naver-session.mjs start`
- 상태 확인(창 안 뜸): `node scripts\naver-session.mjs status`
- **이사 시 프로필 폴더를 복사해도 세션은 안 살아납니다** (메모리에만 있으므로).
  새 PC 에서 `start` 로 한 번 로그인하세요.

---

## 4. 파일 구조

```
scripts/
  cdp.mjs                    CDP 클라이언트 (Node 내장 WebSocket)
  naver-session.mjs          네이버 세션 브라우저 관리 (start/status/stop)
  collect-naver.mjs          네이버 수집 — CDP+DOM, 창 안 뜸
  collect-ga4.ps1            GA4 6개 속성
  collect-youtube.ps1        YouTube 채널 + Analytics
  collect-searchconsole.ps1  Search Console
  collect-instagram.ps1      Instagram 5개 계정 (Meta Graph API)
  build-report.mjs           data/*.json → report/index.html 인라인 빌드
  report-template.html       대시보드 본체 (HTML+CSS+JS 단일 파일)
  check-connections.ps1      5개 연결 상태 점검
  auth-*.ps1                 OAuth 재인증용
data/                        수집 결과 JSON (커밋됨)
report/index.html            빌드 산출물
index.html                   Pages 서빙용 사본 (report/index.html 과 동일해야 함)
```

### 정리 대상 (동작에는 무해, 현재 미사용)

- `scripts/collect-naver-search-advisor.ps1`, `scripts/collect-naver-tw.ps1`,
  `scripts/naver-search-advisor-ui-labels.json`, `scripts/open-and-read.ps1`
  → UIAutomation 시절 잔재. `collect-naver.mjs` 로 대체됨.
- `scripts/auth-threads-oauth.ps1`, `scripts/meta-enumerate.ps1`
  → Threads 는 보고서에서 제외됨(담당자 지시). 진단용으로만 남아 있음.
- `data/instagram-public.json`, `data/meta-page-ids.json` → 초기 조사 산출물.

---

## 5. 환경 함정 (여기서 시간을 많이 씀)

| 증상 | 원인 | 대응 |
|---|---|---|
| PowerShell 스크립트의 한글이 깨짐 | PS 5.1 은 `.ps1` 을 ANSI 로 읽음 | **UTF-8 BOM 으로 저장** (아래 스니펫) |
| `JSON.parse` 실패 | PS `Set-Content -Encoding utf8` 이 BOM 을 씀 | `build-report.mjs` 가 `\uFEFF` 제거 |
| 콘솔 출력 한글 깨짐 | CP949 | `... 2>&1 \| iconv -f CP949 -t UTF-8` |
| `.mjs` 안 정규식이 깨짐 | 템플릿 리터럴에서 `\n` 이 먼저 해석됨 | 페이지로 보낼 문자열엔 `\\n`, 또는 정규식 회피 |
| bash heredoc 으로 큰 파일 작성 실패 | 이스케이프 충돌 | 에디터 도구로 파일 직접 작성 |

```powershell
# .ps1 수정 후 반드시 실행 — UTF-8 BOM 재저장
$p='scripts\파일명.ps1'
$c=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)
[IO.File]::WriteAllText($p,$c,(New-Object Text.UTF8Encoding($true)))
```

모든 `.ps1` 수집 스크립트는 `-SelfTest` 를 지원합니다 (실제 호출 없이 설정만 점검).

---

## 6. 데이터 해석 시 반드시 알아야 할 것

### 문의(핵심 이벤트) 전월 대비는 아직 유효하지 않음

GA4 핵심 이벤트가 **2026-07-14 부터** 측정 시작됐습니다. 직전 30일 구간이 일부만 계측돼
있어, 그대로 계산하면 실제 증가가 아닌 **계측 시작이 증가율로 잡힙니다**(약 +540%).

수집기가 `key_events_from` 에 최초 측정일을 기록하고, 보고서는 비교 구간이 완전히 덮이기
전까지 증감 표시를 **의도적으로 숨깁니다.** 2026-08-14 이후 수집분부터 유효해집니다.
이 로직을 임의로 제거하지 마세요.

### `naver_booking_click` 이 전환 집계에서 빠져 있음

이벤트는 정상 발생(30일 212건: KR 187 · EN 16 · TW 8)하지만 GA4 에서 **핵심 이벤트로
등록되지 않아** 문의 합계에 포함되지 않습니다. 보고서에 빨간색으로 명시돼 있습니다.
GA4 관리 화면에서 체크 한 번이면 되지만 **담당자 계정 설정이라 임의로 바꾸지 마세요.**

### `follower_count` 는 순증이 아니라 신규 팔로우 총량

Instagram API 의 `follower_count` 일별 합계는 `follows_and_unfollows` 의 `FOLLOWER` 값과
정확히 일치합니다. 즉 **순증이 아닙니다.** 팔로워 증감은
`신규 팔로우 − 언팔로우` 로 계산합니다. (`follower_count` 는 직전 30일 조회도 불가.)

### 의도적 제외 대상

- GA4 속성 `Beauty Blossom - Link` (549949719) — 링크 트래킹용, 제외
- Search Console `hongdae-skin.tistory.com` — 제외
- Threads — 담당자 지시로 보고서에서 전면 제거
- `tw.beautyblossom.kr` 네이버 — 버그 아님. 네이버가 "콘텐츠 노출/클릭 정보가 없습니다"
  라고 직접 표시. `NO_EXPOSURE` 상태로 사유와 함께 보고서에 표시됨.

---

## 7. 보고서 작성 규칙 (담당자 피드백 반영분)

임의로 되돌리지 마세요. 모두 담당자가 명시적으로 요구한 사항입니다.

- **증감은 값 옆에 인라인으로.** 별도 열로 빼면 "뭐가 올랐는지 모른다"는 지적을 받았습니다.
- **방향을 색에만 의존시키지 않기.** ▲▼ 기호와 숫자를 함께 표기합니다.
- **영문 지표명 금지.** GA4 채널명 등은 한글 이름 + 한 줄 설명을 붙입니다
  (예: `Paid Social` → 유료 소셜 광고 · 인스타그램·페이스북 등에 돈 주고 낸 광고).
- **표에는 결론 문장을 함께.** 읽는 사람이 숫자에서 직접 도출하지 않아도 되게 합니다.
- 색상 팔레트는 라이트/다크 각각 검증된 값이 `report-template.html` 상단에 있습니다.

---

## 8. 현재 남아 있는 과제

1. **`naver_booking_click` 핵심 이벤트 등록** — 담당자 GA4 설정 작업 (212건 미집계)
2. **시술명 키워드 CTR 개선** — 상위 노출 중인데 클릭이 거의 없음.
   덴서티 28,524노출/0% · 울쎄라 20,493/0% · 볼뉴머 16,289/0.1% · ldm 12,933/0.6%.
   반면 지역명 결합 키워드는 양호(홍대 수액 30.6% · 홍대 바디온다 25%).
   해당 페이지 제목·설명 재작성 필요. URL 이 `/141` `/45` `/LDM` 같은 숫자 슬러그인 점도 확인 요망.
3. **대만(TW) 전환율** — 트래픽 2위(19,840명)인데 전환율 최하위(1.06%).
   Paid Social 86% 의존, 이탈률 79%. 랜딩페이지와 LINE 도입부 점검 필요.

---

## 9. 작업 규칙 (담당자 요구사항)

- **비밀정보 원문 출력 금지** — API key / token / cookie / localStorage /
  webSocketDebuggerUrl. 존재 여부·길이·마스킹 형태로만 보고.
- **발행/저장/임시저장 버튼 클릭 금지.** 외부 발행을 임의로 실행하지 않습니다.
- **요청하지 않은 다음 단계로 자동 진행 금지.**
- **무관한 변경 파일은 건드리지 않기.** 보고만 합니다.
- 완료 보고 전 `git status --short`, `git diff`, `git log --oneline -n 8` 확인.
- **테스트 통과만으로 "완료" 금지.** 실제 동작 검증 후 보고합니다.
- 실패 시 에러 원문 상위 3줄을 그대로 보고 (요약 금지).
