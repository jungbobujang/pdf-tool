# 밤샘 작업 보고 (night-0927)

(요약은 마지막에 맨 위에 넣습니다)

## 0. 시작과 안전장치

- 시작: 2026-09-27 01:32
- git pull origin main: 이미 최신. 선행 작업 확인: `61ab89f feat: 모든 도구에 움직이는 사용법 패널 + 저장 위치 안내 + 넓은 화면 정리`가 HEAD, 배포 /version = 61ab89f
- 가지: `night-0927` (main에는 push하지 않음)
- npm ci 후 기준선: verify 44/44, test:ui 92개 중 91개 통과 + 1개 실패
  - 실패는 axe-core 자동 접근성 검사의 color-contrast(serious)가 가끔 나오는 것이었고, 같은 코드로 다시 세 번 돌리면 세 번 다 통과했습니다
  - 원인: 사용법 예시 무대(aria-hidden 장식)가 움직이는 중간(투명도 전환)에 검사되면 대비가 낮게 계산됨
  - 조치: axe 검사에서 `.demo-stage`만 빼고(설명 글은 그대로 검사), 이후 계속 통과
- 기준선 로그: `%TEMP%\pdftool-night\verify.log`, `%TEMP%\pdftool-night\ui.log`

## 1단계. 전송 차단과 오프라인

**한 것**

- CSP 헤더(server.js)를 요청대로 조였습니다
  - `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'self'`
  - `style-src 'unsafe-inline'`는 뺐습니다. 필요했던 곳은 index.html의 도구 색 `style="--tc:…"` 12군데뿐이라 CSS 규칙(`[data-tab="edit"]{--tc:…}`)으로 옮겼습니다. JS가 넣는 스타일은 CSSOM(`el.style`)이라 CSP에 걸리지 않습니다
  - `connect-src`, `font-src`에 있던 `blob:`/`data:`도 뺐는데, pdf.js 워커 · HEIC 변환(heic-to CSP 빌드) · 용량 줄이기 Worker · 워터마크 글꼴이 모두 에러 없이 동작합니다(전체 ui-check의 흐름별 "콘솔 에러 0" 항목으로 확인)
  - `object-src 'none'`은 원래 있던 것이라 그대로 뒀습니다
- 서비스 워커 `public/sw.js` (서버가 `/sw.js`로 줄 때 커밋과 목록을 채움)
  - 설치 때 212개 파일을 미리 받아 둡니다: 화면, app.js 등 `?v=커밋` 파일, compress-worker, manifest, 아이콘, `/vendor/*` 전부(pdf-lib · pdf.js와 워커 · jszip · pako · fontkit · jpeg-decoder · heic-to), Pretendard 글꼴(css + woff2 전부 + 워터마크용 otf), pdf.js cmaps · standard_fonts
  - 캐시 이름은 `pdfws-<커밋>`이고, 새 버전이 켜지면 옛 캐시를 지웁니다. `/version`과 `/sw.js`는 캐시하지 않습니다
  - 처음 설치는 바로 켜지고, 업데이트는 "대기"로 둡니다. 화면 위쪽에 "새 버전이 있어요. [새로고침]" 띠가 뜹니다
  - 작업 중이면 [새로고침]을 눌러도 바로 바꾸지 않고, "새로고침하면 지금 작업이 사라져요. 먼저 저장하세요. [그래도 새로고침]"으로 한 번 더 묻습니다
- 오프라인 판별: `navigator.onLine`과 `/version` 요청 실패로 판단해 "지금 인터넷 없이 작동 중" 배지를 켭니다(사이드바 아래 안심 문구, 처음 화면 위쪽 안심 문구 두 곳)
- `manifest.webmanifest`
  - 이름 "PDF 작업실", start_url `/`, display standalone
  - 배경 #EEF1F6, 테마 #141B2E
  - 아이콘: 192/512 PNG, maskable 192/512, SVG
  - 아이콘은 `scripts/gen-icons.mjs`가 로고 마크 SVG로 만듭니다(playwright 필요, 결과 PNG는 저장소에 넣음)
- 처음 화면 오른쪽 위 [바탕화면에 설치]: `beforeinstallprompt`가 올 때만 보이고, 설치되면 숨깁니다

**검증**

- verify 44/44, ui-check 98/98 (새 항목 6개)
  - CSP 헤더
  - manifest · sw.js 200 + 아이콘
  - 서비스 워커 등록과 212개 미리 캐시
  - `context.setOffline(true)` → 새로고침 → PDF 2개 넣기 → 합쳐 저장 7쪽 + 배지
  - CSP 위반 · 콘솔 에러 0
  - 새 버전 배포 흉내: 커밋만 다른 서버로 바꿔 띄워 띠 → 작업 중 재확인 → 새로고침 후 새 커밋
- 스크린샷: `docs/screens/offline.png`

**먼저 챙긴 것**

- 인터넷 없이 열려도 화면 구석 버전(v 커밋)이 보이도록 HTML에 `<meta name="app-version">`을 서버가 채워 넣습니다(예전에는 /version 요청이 실패하면 버전이 비었음)
- 파비콘(SVG · 32px PNG)과 apple-touch-icon도 이번에 같이 붙였습니다(3단계 항목의 일부를 미리)
- 서비스 워커는 PDF · 사진 파일 자체를 절대 캐시하지 않습니다(파일은 blob 주소라 서비스 워커를 거치지 않음)

**참고**

- 이 컴퓨터의 로컬 실행은 예전 `npm run deploy` 때 만든 `build-info.json`(추적 안 됨) 때문에 버전이 `ffc6f3a`로 보입니다. 배포(Railway GitHub 연동)는 `RAILWAY_GIT_COMMIT_SHA`를 쓰므로 영향이 없습니다

## 2단계. 신뢰 페이지들과 홈 아래쪽

**한 것**

- `/check` 직접 확인하는 법(전체 화면 모달 대신 따로 된 페이지로 만들었습니다. 주소를 공유할 수 있고 인쇄 · 뒤로 가기가 자연스러워서)
  - ① 와이파이 끄고 해 보기: 움직이는 예시 `chk-wifi`(와이파이 끄기 → 두 파일 합치기 → 바로 저장 → "인터넷 없이도 합쳐졌어요")
  - ② F12 → Network 탭: 움직이는 예시 `chk-network`(파일을 넣어도 "요청 0건")
  - ③ CSP 설명: 서버가 실제로 보내는 규칙 11줄을 서버 코드에서 그대로 넣고, 줄마다 쉬운 설명을 붙였습니다(헤더와 페이지가 어긋날 수 없음)
  - 예시는 화면에 보일 때만 재생하고, 탭이 뒤로 가면 멈추고, "움직임 줄이기"면 마지막 장면만 보여 줍니다(`public/pages.js`)
- `/privacy` 개인정보 안내: 수집 없음, 파일은 브라우저 안에서만 처리, 설정은 localStorage, 쿠키 · 통계 · 외부 스크립트 없음, 마지막 갱신일 2026년 9월 27일, 책임 한계 한 줄
- `/licenses` 사용한 라이브러리
  - `scripts/gen-licenses.mjs`가 package.json의 dependencies · devDependencies와 node_modules에서 이름 · 버전 · 라이선스 · 저장소 · 라이선스 전문을 읽어 `public/pages/licenses.html`을 만듭니다
  - `npm run build`에 넣었습니다(Railway가 배포 때 자동 실행)
  - 배포 서버에 개발용 패키지가 없으면 새로 만들지 않고 저장소에 있는 페이지를 그대로 씁니다(빌드를 막지 않게)
  - verify가 페이지와 package.json이 맞는지 확인합니다(`--check`)
- 책임 한계 한 줄("이 도구는 원본 파일을 바꾸지 않습니다. 결과물은 저장 후 열어서 확인해 주세요."): 처음 화면 푸터, /privacy, 안내 페이지 푸터
- 처음 화면 아래쪽(최대 1100px, 가운데)
  - ① "정말 밖으로 안 나가나요?" 3단계 카드 + [직접 확인하는 법 →]
  - ② 자주 하는 작업 3개
    - "공문 첨부용 10MB 만들기": 용량 줄이기를 열고 목표를 10MB로 미리 정해 둡니다. 파일을 넣으면 막대가 10MB로 시작
    - "스캔본 정리해서 합치기": 편집을 열고 빈 쪽 · 크기 · 양면 스캔 안내
    - "학습지 사진을 PDF로": 사진→PDF
  - ③ 새 소식: CHANGELOG 최근 3개(3단계에서 만들 CHANGELOG를 여기서 먼저 만들었습니다)
  - ④ 푸터: 버전 · 직접 확인하는 법 · 개인정보 안내 · 사용한 라이브러리 · 책임 한계. 의견 보내기는 3단계에서 붙입니다

**검증**

- verify 46/46 (새 2개: 라이브러리 페이지 · 새 소식 JSON이 원본과 일치)
- ui-check 105/105 (새 7개)
  - /check · /privacy · /licenses 각각
  - 안내 페이지 콘솔 에러 0
  - 처음 화면 아래 구성
  - 바로가기 3개(13.6MB 파일 → 목표 10.0MB로 시작)
  - 400px 가로 스크롤 없음
- 스크린샷: `docs/screens/home-full.png`, `check.png`, `privacy.png`, `licenses.png`

**우회한 것**

- 예시 부품 이름 `doc`이 안내 페이지의 `.doc` 틀과 겹쳐 예시 속 파일이 페이지 폭만큼 늘어나는 문제가 있어 `demo-doc`으로 바꿨습니다

**먼저 챙긴 것**

- 개인정보 안내에 서명 · 도장 그림이 IndexedDB에 보관된다는 사실도 적었습니다(실제 코드 확인 결과)
- 안내 페이지들도 서비스 워커가 미리 받아 두므로 인터넷 없이 열립니다

## 3단계. 새 소식 · 의견 보내기 · 브라우저 안내 · 공유 미리보기

**한 것**

- 새 소식
  - `CHANGELOG.md`(2단계에서 만듦, 지금까지 커밋 7개를 사용자 말로)를 `npm run build`가 `public/changelog.json`으로 바꿉니다
  - 화면 구석 "v 해시"(처음 화면 푸터 · 사이드바 아래)가 단추가 되어 누르면 새 소식 창이 열립니다
  - 새 버전을 처음 열면 버전 옆에 주황 점이 켜지고, 창을 한 번 열면 꺼집니다(localStorage `pdfws.newsSeen`)
  - 보수적으로 정한 것: 처음 온 사람(이 사이트의 저장 값이 하나도 없음)에게는 점을 켜지 않습니다. 모든 소식이 새것이라 의미가 없어서
- 의견 보내기
  - 사이드바 아래와 푸터에 [의견 보내기]. 누르면 작은 창: "의견은 외부 설문 페이지(새 창)에서 받아요. 파일이나 화면 내용은 전송되지 않아요." + [설문 열기] + [오류 내용 복사]
  - 설문 주소는 `public/config.js`의 `FEEDBACK_URL`. 지금은 빈 값이라 "아직 설문 주소가 없어요"가 보이고 [설문 열기]는 눌리지 않습니다
  - https 주소만 받습니다
  - [오류 내용 복사]는 최근 오류 알림의 보고서(파일 이름 · 내용 제외)를, 없으면 브라우저 · 버전 정보만 복사합니다
  - 안내 페이지의 [의견 보내기]는 `/#feedback`으로 와서 창을 엽니다
- 오래된 브라우저 안내
  - `public/compat.js`(ES5로 작성, `<head>` 맨 앞)가 필수 기능을 확인합니다: ES2020(globalThis · Promise.allSettled · matchAll · BigInt), Promise, Blob, fetch, URL, CSS grid, OffscreenCanvas 또는 canvas
  - 하나라도 없으면 "이 브라우저에서는 열 수 없어요. 엣지, 크롬, 웨일로 열어 주세요" 일반 HTML 안내만 보이고 앱은 숨깁니다
  - 자바스크립트가 꺼져 있으면 `<noscript>`로 같은 안내를 보여 줍니다
- 파비콘 SVG + 32px PNG + apple-touch-icon(1단계에서 만든 것)
- 탭 제목
  - 상태에 따라: "PDF 작업실" → "편집 중 · 파일 2개" → 진행 중 "알맞은 크기 찾는 중 17%"
  - 진행 %는 진행 막대 또는 "3/8" 같은 글에서 계산합니다
- 작업 중(파일이 있거나 처리 중) 탭을 닫거나 새로고침하면 `beforeunload` 확인. 파일이 없으면 묻지 않습니다
- 공유 미리보기(Open Graph)
  - 제목 "PDF 작업실"
  - 설명 "PDF 합치기·나누기·암호·용량 줄이기, 파일은 컴퓨터 밖으로 안 나가요"
  - 1200×630 그림 `public/icons/og-image.png`(로고 + 문구, `scripts/gen-icons.mjs`가 만듦)
  - twitter:card summary_large_image
  - 그림 주소는 절대 주소(기본 https://pdf-tool-production-a037.up.railway.app, `PUBLIC_URL` 환경 변수로 바꿀 수 있음)

**검증**

- verify 46/46, ui-check 112/112 (새 7개)
  - 새 소식 창과 점
  - 의견 보내기
  - 탭 제목
  - 작업 중 새로고침 확인
  - 콘솔 에러 0
  - Open Graph와 그림 크기 1200×630, 파비콘 200
  - 오래된 브라우저(Promise.allSettled 지운 상태) · 자바스크립트 꺼짐 안내

**우회한 것**

- 브라우저 정책상 `beforeunload` 확인창의 문구는 사이트가 정할 수 없습니다(크롬 · 엣지 · 웨일은 "사이트에서 나가시겠습니까?" 같은 브라우저 기본 문구). 코드에는 "작업 중인 내용이 사라져요"를 넣어 두었지만 실제로는 기본 문구가 보입니다
- 점검 도구(playwright)는 확인창을 기본으로 "취소"해서 기존 점검의 새로고침이 멈출 수 있어, 점검에서는 새로고침 확인을 "진행"으로 처리하게 했습니다(확인창이 뜨는지는 따로 점검)

**먼저 챙긴 것**

- 새 버전 띠에서 [그래도 새로고침]을 누른 경우에는 탭 닫기 확인을 다시 묻지 않습니다
- 새 소식 · 의견 창은 처리 중에는 열리지 않습니다
