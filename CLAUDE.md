# CLAUDE.md

암표 신고 준비 도우미 — 중고거래·SNS 암표 게시글 캡처를 받아 신고에 필요한 정보를 정리하고, 신고 초안을 만들어 공식 신고 사이트(한국콘텐츠진흥원 온라인 암표 신고센터)로 넘겨주는 웹앱. 제품 범위와 "안 할 것"은 `docs/PRD.md`가 기준이다.

## 구조

빌드 단계 없는 정적 사이트 + Vercel 서버 함수 하나.

- `index.html` — 화면 전체(마크업·CSS·앱 스크립트 인라인). 6단계 흐름: 시작 → 분야 → 판단 → 증빙 → 초안 → 이동(`STEP_NAMES`, `showStep`, `canLeaveStep`).
- `js/parse.js` — 붙여넣은 글·OCR 글자에서 공연명·일시·장소·좌석·가격·플랫폼·예매처·판매자·게시일시를 찾는 규칙 파서. `window.TicketParse` / `module.exports`.
- `js/ocr.js` — Tesseract.js로 브라우저 안에서 캡처 글자 인식. 라이브러리·언어 데이터는 jsdelivr CDN에서 받고, `window.TICKET_OCR_CONFIG`로 경로를 바꿀 수 있다(테스트용).
- `js/kopis-match.js` — KOPIS XML 파싱, 가격·공연 시간 파싱, 입력값과 공식 정보 비교. 서버 함수·브라우저·테스트가 함께 쓴다. `window.KopisMatch` / `module.exports`.
- `api/kopis.js` — KOPIS 오픈 API 중계(Vercel 함수, CommonJS). `GET /api/kopis?title=&date=`, `GET /api/kopis?ping=1`. `createHandler({ fetch, getKey })`로 테스트에서 주입 가능.
- `fonts/` — Pretendard woff2(인라인하지 말고 파일로 둔다).
- `tests/` — 단위 테스트, e2e, 합성 캡처 생성기와 픽스처.

## 명령

```sh
python3 -m http.server 8000   # 로컬 실행 (file:// 로 열면 OCR이 안 될 수 있음)
npm install
npm test                      # node --test tests/*.test.mjs  (파서·KOPIS 단위 테스트)
npm run test:e2e              # Playwright(Chromium)로 index.html에 합성 캡처를 올려 인식·KOPIS 흐름 확인
npm run fixtures              # tests/fixtures/templates/*.html → captures/*.png, *.lowq.jpg 재생성
```

- e2e는 외부 요청을 모두 막고 Tesseract를 `node_modules`에서, KOPIS는 `tests/fixtures/kopis/*.xml`에서 받는다. 네트워크 없이 돌아야 한다.
- e2e 결과물은 `tests/output/`(gitignore)에 남는다.
- 클라우드 환경에서는 Chromium이 `/opt/pw-browsers`에 있다. `playwright install`은 하지 않는다.

## 코드 규칙

- 번들러·프레임워크·트랜스파일러를 들이지 않는다. `js/*.js`는 브라우저에 그대로 실리므로 기존 스타일(UMD 래퍼, `var`, `function`, `"use strict"`)을 따른다.
- `js/parse.js`, `js/kopis-match.js`는 브라우저와 Node 양쪽에서 돌아야 한다. DOM·Node 전용 API를 쓰지 않는다.
- 주석은 한국어, 평서체(~한다). 왜 그렇게 했는지(예: OCR이 자주 틀리는 모양)를 적는다.
- 화면 문구는 쉬운 한국어 해요체("~해요", "~해주세요"). 법률·행정 용어는 꼭 필요할 때만.
- 파서 규칙을 바꾸면 `tests/parse.test.mjs`에 사례를 추가하고, 인식 결과가 바뀌면 `tests/fixtures/templates/*.expected.json`도 맞춘다.
- Tesseract 버전은 `js/ocr.js`의 `VERSION`과 `package.json`의 `tesseract.js`를 같이 올린다.
- 화면을 고치면 `index.html` 하단 "마지막으로 고친 날" 날짜를 갱신한다.

## 지켜야 할 것

- **캡처는 기기 밖으로 보내지 않는다.** OCR은 브라우저 안에서만. 이미지·추출 내용을 서버로 보내는 기능을 넣지 않는다(claude.ai 아티팩트 안에서 `window.claude`로 읽는 경로는 예외).
- **KOPIS 키(`KOPIS_API_KEY`)는 Vercel 환경변수에만.** 웹페이지·저장소·응답·로그에 키 값이 나오면 안 된다(`ping`도 설정 여부만 보여준다).
- **공식 정보는 덮어쓰지 않는다.** KOPIS와 다른 항목은 차이만 보여주고, 사용자가 [바꾸기]를 눌러야 바뀐다.
- **기능이 없어도 앱은 돈다.** 서버 함수·키·OCR 엔진이 없으면 해당 카드만 "쓸 수 없어요"로 바뀌고 나머지 흐름은 그대로여야 한다.
- **PRD의 "안 할 것"을 넘지 않는다.** 로그인, 대리 제출(자동 접수), 판매자 추적·신원 조회, 위반 여부 확정, 신고 이력·캡처 장기 보관은 만들지 않는다. 판단은 "가능성 안내"까지만.
- **픽스처는 전부 가상.** 실제 게시글·판매자·개인정보를 테스트 데이터에 넣지 않는다.

## Git

- 커밋 메시지는 영어 명령형 제목 + 필요하면 본문에 변경 이유. PR 제목은 한국어로 짧게.
- 푸시 전에 `npm test`, 화면·OCR·KOPIS를 건드렸다면 `npm run test:e2e`까지 통과시킨다.
