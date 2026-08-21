# 뷰티블라썸 통합 성과 보고서

GA4 · YouTube · Google Search Console · 네이버 서치어드바이저 · Instagram 성과를 하나의 HTML 대시보드로 모으는 수집·리포팅 파이프라인.

## 보고서 열기

`report/index.html` 을 브라우저로 열면 됩니다. 데이터가 파일 안에 들어 있어 서버 없이 동작합니다.

```powershell
start report\index.html
```

라이트/다크 테마 전환, 차트 호버 툴팁, 사이트별 키워드 탭이 포함되어 있습니다.

## 데이터 수집

각 스크립트는 `data/` 에 JSON 을 남기고, 빌드 스크립트가 그 JSON 을 HTML 에 인라인으로 넣습니다.

```powershell
.\scripts\collect-ga4.ps1            -Days 30   # GA4 6개 속성
.\scripts\collect-youtube.ps1        -Days 30   # YouTube 채널
.\scripts\collect-searchconsole.ps1  -Days 30   # Search Console 9개 속성
.\scripts\collect-naver.ps1                     # 네이버 (로그인된 콘솔 UI 수집)
node scripts\build-report.mjs                   # report/index.html 재생성
```

## AI 분석 통합 전략 리포트

성과 보고서가 "무슨 일이 있었나"라면, 이 리포트는 "지난달 실적을 근거로 다음 달에 무엇을 할 것인가"다.
경쟁 병원 광고 해부·검색 결과 점유 조사·본원 시술 목록 대조를 한 문서에 모은다.
월별로 파일이 쌓이므로 다음 달에 지난달 판단의 적중 여부를 검증할 수 있다.

```powershell
node scripts\collect-competitors.mjs --self-test   # 조회 계획만 점검
node scripts\collect-competitors.mjs               # Meta 광고 라이브러리 탐색
node scripts\collect-competitors.mjs --deep        # 선정 경쟁사·자사 국가별 심층 조회
node scripts\collect-serp.mjs                      # 시술 검색어 1페이지 점유 조사
node scripts\build-strategy.mjs                    # report/strategy-2026-09.html 생성
```

파일명은 `strategy-YYYY-MM.html` 로, **실행 대상 월**을 쓴다. 근거가 되는 실적은 그 전월이다.

### 공유 링크

리포트는 Orca 아티팩트로 공개 링크를 만들어 공유한다.

```powershell
orca artifacts share  .\report\strategy-2026-09.html   # 최초 1회만
orca artifacts update .\report\strategy-2026-09.html   # 이후 수정할 때마다
```

**이미 공유한 파일은 `share` 를 다시 쓰지 말 것.** 새 링크가 생겨 이미 배포된 주소가 옛 내용에 묶인다.
`update` 는 주소를 유지한 채 내용만 교체하고, 만료일도 그 시점부터 30일로 다시 늘어난다.

링크는 로그인 없이 열리므로 내부 성과 수치가 그대로 공개된다. 시술 가격은 리포트에 담지 않지만
시장별 전환율·광고 규모·시술 목록은 보인다. 내릴 때는 `orca artifacts unshare` 를 쓴다.

경쟁사 수집은 공개된 Meta 광고 라이브러리를 HTTP로만 읽는다. 로그인도, 브라우저 창도, 사용자 Chrome 프로필도 쓰지 않는다. 원본 응답은 `.cache/adlib/` 에 남으므로 파싱 로직을 고쳐 다시 돌려도 추가 조회가 발생하지 않는다.

소재지·다국어 운영 구조는 광고 라이브러리에 없어 각 클리닉 사이트를 직접 확인해 `data/competitor-profiles.json` 에 출처와 함께 손으로 기록한다. 이 파일은 수집 스크립트가 덮어쓰지 않는다.

설계 근거와 데이터 한계는 `docs/superpowers/specs/2026-08-21-september-marketing-strategy-design.md` 에 있다.

모든 수집 스크립트는 `-SelfTest` 를 지원합니다 — 실제 호출 없이 설정만 점검합니다.

## 소스별 수집 방식

| 소스 | 방식 | 비고 |
|---|---|---|
| GA4 | Analytics Data API | OAuth (`analytics.readonly`) |
| YouTube | Data API v3 + Analytics API v2 | OAuth (`youtube.readonly`, `yt-analytics.readonly`) |
| Google Search Console | Search Analytics API | OAuth (`webmasters.readonly`), 데이터 약 2일 지연 |
| 네이버 서치어드바이저 | 로그인된 콘솔 UI 를 UIAutomation 으로 판독 | 성과 조회용 공개 API 가 없음 |
| Instagram | Meta Graph API | 미연동 — 아래 참조 |

### 네이버 관련 주의점

- 헤드라인 합계(총 클릭·총 노출)는 네이버가 화면에 축약 표기(`1.8천`, `27.5만`)한 값을 되돌린 **근사치**입니다.
- 키워드·웹문서 표의 수치는 **원값**입니다.
- 콘솔이 한 페이지에 10행씩 표시하므로 각 사이트 상위 10개가 수집됩니다.
- 브라우저에 네이버 로그인 세션이 살아 있어야 하며, 창을 최소화하면 접근성 트리가 사라져 판독이 실패합니다.

### Instagram 미연동 사유

계정 5개(`beautyblossom_clinic`, `_jp`, `_tw`, `_th`, `_global`)는 확인했지만 지표는 아직 못 가져옵니다.
Meta 앱이 자산을 소유한 비즈니스 포트폴리오(`뷰티블라썸`)가 아닌 별도 포트폴리오에 등록되어 있어
Graph API 가 페이지·Instagram 계정을 반환하지 않습니다. 앱을 해당 포트폴리오에 추가하면 해결됩니다.

## 비밀정보

`.secrets/` 와 `.env.local` 은 커밋되지 않습니다. OAuth 클라이언트와 토큰은 로컬에만 존재합니다.

## 디렉터리

```
data/      수집된 JSON (커밋됨 - 보고서 재생성용)
report/    생성된 HTML 대시보드
scripts/   수집 · 인증 · 빌드 스크립트
```
