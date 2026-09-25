# PDF 작업실

브라우저 안에서만 PDF를 다루는 웹앱입니다. 합치기, 자르기, 쪽 순서 바꾸기, 이미지 변환, 암호, 쪽번호를 설치 없이 쓸 수 있습니다.

## 파일은 브라우저 밖으로 나가지 않아요

- 모든 처리는 사용자의 브라우저 안(JavaScript)에서 끝납니다. 서버는 화면을 이루는 정적 파일(HTML·CSS·JS)만 보내 주고, 파일을 받는 주소가 아예 없습니다.
- 서버가 `Content-Security-Policy`의 `connect-src 'self'`를 보내므로, 페이지가 다른 사이트로 데이터를 보낼 수 없습니다.
- 라이브러리도 CDN을 쓰지 않고 이 서버에서 직접 제공합니다(`/vendor/*`).
- 결과물은 `Blob`으로 만들어 브라우저 내려받기로 저장합니다.

## 화면

![처음 화면](docs/screens/home.png)

**처음 화면** — 남색 띠 아래 "파일 넣기" 카드와 도구 카드 5개가 있습니다.

- PDF나 사진을 끌어다 놓거나 [파일 고르기]를 누르면 알맞은 도구가 열립니다.
  - PDF가 하나라도 있으면 **편집** 화면으로 갑니다.
  - 사진만 넣으면 **사진 → PDF** 화면으로 갑니다.
  - 둘이 섞여 있으면 PDF는 편집으로, 사진은 사진 → PDF 목록에 넣어 두고 알림으로 알려 줍니다.
- 도구 카드를 누르면 그 도구가 바로 열립니다.

![편집 화면](docs/screens/edit-with-files.png)

**작업 화면** — 왼쪽 남색 사이드바에서 도구를 바꿉니다.

- 도구를 옮겨 다녀도 각 도구에 넣은 파일과 상태는 그대로 남습니다.
- 사이드바는 키보드 화살표로도 이동할 수 있습니다.
- 폭 820px 이하에서는 사이드바가 화면 위쪽의 가로 줄로 바뀝니다.
- 왼쪽 위 로고를 누르면 새로고침 없이 모든 상태를 지우고 처음 화면으로 돌아갑니다.

<img src="docs/screens/mobile-home.png" alt="휴대폰 처음 화면" width="240">

## 기능

| 도구 | 할 수 있는 일 |
|---|---|
| 편집 · 합치기 | PDF 여러 개를 한 화면에 펼쳐 놓고 끌어서 순서 바꾸기(마우스·터치). 쪽마다 회전 · 다른 쪽으로 교체 · 삭제 예정 표시("되돌리기"로 복구). 아래 저장 막대에서 범위만 저장(`1-2, 4-7`), 한 쪽씩 나눠 zip 저장, 홀수 · 짝수 · 역순, 합쳐서 저장. 잠긴 PDF는 노란 안내줄에서 비밀번호를 넣으면 함께 편집 |
| 사진 → PDF | JPG · PNG · WEBP 여러 장을 순서대로 PDF로. 용지(A4 세로/가로/원본 크기), 여백(없음/좁게/보통), 비율 유지 가운데 맞춤, 휴대폰 사진 EXIF 방향 반영 |
| PDF → 사진 | 고른 쪽만 PNG로 저장(여러 장이면 zip). 보통 150dpi / 선명 300dpi |
| 암호 | 왼쪽 카드: 암호 풀기(풀어서 저장, 풀고 편집으로 보내기). 오른쪽 카드: 암호 걸기(AES-256, 열기 암호 · 권한 암호, 인쇄 · 복사 · 편집 허용 선택) |
| 쪽번호 | 위치(아래 가운데/아래 오른쪽/위 오른쪽), 형식(`3` / `- 3 -` / `3 / 12`), 시작 번호, 첫 쪽(표지) 건너뛰기, 종이 모양 미리보기. 회전된 쪽도 보이는 방향대로 찍힘 |

그 밖에:

- 손상된 파일, 틀린 비밀번호, 지원하지 않는 형식, 메모리 부족 같은 오류는 오른쪽 위 알림으로 원인과 해결 방법을 알려 줍니다.
- 오래 걸리는 작업은 "몇 번째 쪽 처리 중"을 보여 주고 버튼을 잠급니다.
- 폭 400px 휴대폰에서도 가로 스크롤 없이 쓸 수 있습니다.
- 라이트 · 다크 모드를 모두 지원하고, 움직임 줄이기 설정도 따릅니다.
- 글꼴 Pretendard도 이 서버에서 직접 제공합니다.

## 로컬 실행

Node.js 18 이상이 필요합니다.

```bash
npm install
npm start
```

브라우저에서 <http://localhost:3000>을 엽니다. 포트는 `PORT` 환경변수로 바꿀 수 있습니다.

## 검증

```bash
npm run verify      # 합치기 · 범위 · 회전 · 교체 · 암호 · 쪽번호 로직 검증 (node)
npm run test:ui     # 헤드리스 브라우저 점검 (playwright가 있을 때만, 없으면 건너뜀)
npm run screens     # 점검 + docs/screens/ 스크린샷 다시 찍기
```

`test:ui`는 프로젝트에 playwright가 없으면 `PLAYWRIGHT_DIR=<playwright를 설치한 폴더>`로 위치를 알려 줄 수 있습니다.

## 구성

```
server.js            express 정적 서버 (+ /vendor/* 로 라이브러리 제공)
public/index.html    화면 (처음 화면 + 작업 화면, 선 아이콘 SVG 스프라이트)
public/style.css     스타일 (라이트/다크, 반응형)
public/pdf-core.js   PDF 핵심 로직 (브라우저와 검증 스크립트가 함께 씀)
public/app.js        화면 동작
test/verify.mjs      로직 검증
test/ui-check.mjs    브라우저 점검 (+ --screens 로 스크린샷)
docs/screens/        스크린샷
```

사용한 라이브러리(버전 고정):

- [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) 2.11.1 — 편집, 암호 걸기/풀기 (원래 pdf-lib는 암호를 지원하지 않아 이 포크를 씀)
- [pdfjs-dist](https://github.com/mozilla/pdf.js) 3.11.174 — 썸네일, PDF → 이미지
- [JSZip](https://stuk.github.io/jszip/) 3.10.1 — 여러 파일을 zip으로 묶기
- [express](https://expressjs.com/) 4.21.2 — 정적 파일 서버
- [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9 — 글꼴 (SIL OFL)

## 배포 (Railway)

`npm start`(= `node server.js`)로 실행되고 Railway가 주는 `PORT` 환경변수를 씁니다. 따로 설정할 것은 없습니다.
