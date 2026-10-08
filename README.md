# Ticket-Scalping-Report-Assistant
암표 신고 도우미

## 문서

- [PRD (v0.2)](docs/PRD.md)

## 실행

정적 파일만으로 동작해요. GitHub Pages에 그대로 올리거나, 로컬에서는 아무 정적 서버로 열면 돼요.

```sh
python3 -m http.server 8000   # http://localhost:8000
```

`index.html`을 파일로 바로 열면(`file://`) 브라우저 보안 정책 때문에 캡처 글자 인식이 동작하지 않을 수 있어요.

## 캡처 자동 인식

- 캡처를 올리고 [캡처에서 자동으로 읽기]를 누르면, 브라우저 안에서 [Tesseract.js](https://github.com/naptha/tesseract.js)로 글자를 읽고(`js/ocr.js`) 내장 규칙으로 공연명·일시·장소·좌석·가격·플랫폼·예매처·판매자·게시일시를 찾아 채워요(`js/parse.js`).
- 캡처는 기기 밖으로 전송되지 않아요. 처음 한 번은 인식 엔진(약 4MB)과 한국어·영어 글자 데이터(약 4.4MB)를 jsdelivr CDN에서 받고, 이후에는 브라우저에 저장된 것을 써요.
- claude.ai 아티팩트 안에서 열면 Claude가 캡처를 직접 읽는 경로를 먼저 써요.

## 테스트

```sh
npm install
npm test              # 내장 파서 단위 테스트
npm run test:e2e      # 합성 캡처로 브라우저에서 인식 → 입력칸 비교 (Playwright, Chromium)
npm run fixtures      # tests/fixtures/templates/*.html 로 합성 캡처 다시 만들기
```

합성 캡처(`tests/fixtures/captures/`)는 실제 서비스 화면을 흉내 낸 가짜 화면이고, 공연·판매자 정보도 모두 가상이에요.
