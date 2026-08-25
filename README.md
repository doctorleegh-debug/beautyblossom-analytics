# 뷰티블라썸 통합 성과 보고서

GA4 · YouTube · Google Search Console · 네이버 서치어드바이저 · Instagram 성과를 하나의 HTML 대시보드로 모으는 수집·리포팅 파이프라인.

> 이 저장소를 새로 넘겨받았다면 **[HANDOFF.md](HANDOFF.md)** 를 먼저 읽으세요.
> `git clone` 만으로는 동작하지 않습니다 (인증 정보·브라우저 세션이 저장소 밖에 있음).

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
.\scripts\collect-instagram.ps1        -Days 30   # Instagram 5개 계정
node scripts
aver-session.mjs start            # 네이버 세션 1회 로그인 (창 뜸)
node scripts\collect-naver.mjs                  # 네이버 (CDP, 창 안 뜸)
node scripts\build-report.mjs                   # report/index.html 재생성
```

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
