// 내장 파서 단위 테스트. 입력은 합성 캡처를 Tesseract로 읽은 실제 원문(오인식 포함)과 붙여넣은 글이다.
// 실행: npm test
process.env.TZ = "Asia/Seoul";   // 기대값은 한국 시각 기준

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localParse, normalizeOcrText, wonToNumber } = require("../js/parse.js");

const at = (s) => new Date(s);   // 로컬 시각

test("번개장터 캡처 OCR 원문", () => {
  const text = `9:41                                         LTE 87%
250,000원
[양도] 하늘빚 밴드 콘서트 막콘 플로어 양도합니다
하늘빛 밴드 2026 전국투어 ‘BLUE HOUR" 서울 막
2026년 11월 22일 일요일 오후 6시
장소: 고척스카이돔
좌석: 플로어 &구역 12열 7번
정가 154,000원
NOL티켓 예매내역 있어요. 번개톡 주세요
3시간 전 · 조회 128 · 찜 5
구매하기`;
  const d = localParse(text, { now: at("2026-10-08T15:00") });
  assert.equal(d.title, "BLUE HOUR");
  assert.equal(d.price, 250000);
  assert.equal(d.officialPrice, 154000);
  assert.equal(d.showDate, "2026-11-22T18:00");
  assert.equal(d.postDate, "2026-10-08T12:00");
  assert.equal(d.venue, "고척스카이돔");
  assert.equal(d.seat, "플로어 A구역 12열 7번");
  assert.equal(d.platform, "번개장터");
  assert.equal(d.vendor, "NOL티켓");
});

test("당근마켓 캡처: M/D 날짜, '22만원', 상대 게시 시각, 좌석 앞말 붙이기", () => {
  const text = `2:17                     5G 64%
티켓마스터                                   36.5°C
역삼동                                          매너온도
BLUE HOUR 콘서트 티켓 양도
티켓/교환권ㆍ2일 전
11/22(일) 18:00 고척스카이돔 공연이에요.
2층 R석 B블록 5열 11번 한 장입니다.
정가 132,000원인데 22만원에 드려요.
예매처는 티켓링크예요.
채팅 3ㆍ관심 7ㆍ조회 211`;
  const d = localParse(text, { now: at("2026-10-08T14:17") });
  assert.equal(d.title, "BLUE HOUR 콘서트 티켓");
  assert.equal(d.showDate, "2026-11-22T18:00");
  assert.equal(d.postDate, "2026-10-06T14:17");
  assert.equal(d.venue, "고척스카이돔");
  assert.equal(d.seat, "2층 R석 B블록 5열 11번");
  assert.equal(d.officialPrice, 132000);
  assert.equal(d.price, 220000);
  assert.equal(d.platform, "당근마켓");
  assert.equal(d.vendor, "티켓링크");
});

test("중고나라: 라벨 붙은 공연일시와 작성 시각 구분, <제목>, '1장' 수량 무시", () => {
  const text = `중고나라 티켓/양도
[티켓] 뮤지컬 <별의 정원> VIP석 양도
musicalfan77 · 2026.10.07. 21:34 · 조회 56
공연일시: 2026.12.05(토) 14:00
공연장소: 블루스퀘어 마스터카드홀
좌석: 1층 OP석 3열 15번
티켓정가: 170,000원
판매가: 1장 300,000원
YES24에서 예매했습니다.`;
  const d = localParse(text, { now: at("2026-10-08T10:05") });
  assert.equal(d.title, "별의 정원");
  assert.equal(d.showDate, "2026-12-05T14:00");
  assert.equal(d.postDate, "2026-10-07T21:34");
  assert.equal(d.venue, "블루스퀘어 마스터카드홀");
  assert.equal(d.seat, "1층 OP석 3열 15번");
  assert.equal(d.officialPrice, 170000);
  assert.equal(d.price, 300000);
  assert.equal(d.platform, "중고나라");
  assert.equal(d.vendor, "YES24");
});

test("X 게시글: '원가 → 양도가', 'n시' 시각, 오전 시각 콜론 오인식, @아이디", () => {
  const text = `11:40                                         5G 55%
< 게시물
티켓 양도계
@ticket_yangdo_24
하늘빛 밴드 BLUE HOUR 부산 공연 양도합니다
12/13 토 19시 벡스코 오디토리움
스탠딩 R구역 120번대
원가 143,000 → 양도가 280,000
티켓링크 예매, DM 주세요
오후 3:24ㆍ2026년 10월 8일ㆍ1.2만 조회수
리포스트 3 마음에 들어요 12`;
  const d = localParse(text, { now: at("2026-10-08T15:31") });
  assert.equal(d.sellerHandle, "@ticket_yangdo_24");
  assert.match(d.title, /BLUE HOUR/);
  assert.equal(d.showDate, "2026-12-13T19:00");
  assert.equal(d.postDate, "2026-10-08T15:24");
  assert.equal(d.venue, "벡스코 오디토리움");
  assert.equal(d.seat, "스탠딩 R구역 120번대");
  assert.equal(d.officialPrice, 143000);
  assert.equal(d.price, 280000);
  assert.equal(d.platform, "SNS");
  assert.equal(d.vendor, "티켓링크");
});

test("X 다크모드: '장당 32만 (정가 17만)', 콜론이 0으로 읽힌 게시 시각", () => {
  const text = `@musical_resell
뮤지컬 <별의 정원> 12/5 낮공 VIP 양도해요
블루스퀘어 마스터카드홀 1층 5열
장당 32만 (정가 17만)
멜론티켓 예매건이에요
오전 11002ㆍ2026년 10월 6일ㆍ3,401 조회수
리포스트 ㅇ 마음에 들어요 4`;
  const d = localParse(text, { now: at("2026-10-08T11:40") });
  assert.equal(d.title, "별의 정원");
  assert.equal(d.price, 320000);
  assert.equal(d.officialPrice, 170000);
  assert.equal(d.postDate, "2026-10-06T11:02");
  assert.equal(d.showDate, "2026-12-05T00:00");
  assert.equal(d.venue, "블루스퀘어 마스터카드홀");
  assert.equal(d.platform, "SNS");
  assert.equal(d.vendor, "멜론티켓");
});

test("예매내역 캡처: 티켓금액은 정가, 수수료·결제금액은 판매가로 잡지 않는다", () => {
  const text = `9:12 LTE 80%
NOL 티켓 · 예매확인
예매번호 T1234567890
하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울
관람일시          2026.11.22(일) 18:00
공연장             고척스카이돔
좌석              플로어 A구역 12열 7번
티켓금액            154,000원
예매수수료            2,000원
결제금액            156,000원
예매자                김*호`;
  const d = localParse(text, { now: at("2026-10-08T09:12") });
  assert.equal(d.title, "BLUE HOUR");
  assert.equal(d.officialPrice, 154000);
  assert.equal(d.price, undefined);
  assert.equal(d.showDate, "2026-11-22T18:00");
  assert.equal(d.venue, "고척스카이돔");
  assert.equal(d.seat, "플로어 A구역 12열 7번");
  assert.equal(d.vendor, "NOL티켓");
  assert.equal(d.platform, undefined);
});

test("글자 인식 오류 대응: '원' 빠진 큰 가격, 깨진 요일·오전오후, 띄어진 라벨, 잘린 '수수료'", () => {
  const post = localParse(`250,000
[양도] 콘서트 플로어 양도합니다
공연일시: 2026.12.05(E) 14:00
정가 154,000원
NOLE|Z! 예매내역 있어요`, { now: at("2026-10-08T15:00") });
  assert.equal(post.price, 250000);
  assert.equal(post.officialPrice, 154000);
  assert.equal(post.showDate, "2026-12-05T14:00");
  assert.equal(post.vendor, "NOL티켓");

  const x = localParse("RF 3:24 -2026H 10월 8일ㆍ1.2만 조회수", { now: at("2026-10-08T15:31") });
  assert.equal(x.postDate, "2026-10-08T15:24");

  const receipt = localParse(`티켓금액                                            154,000원
예매수수                                               2,000원
결제금액                                            156,000원`);
  assert.equal(receipt.officialPrice, 154000);
  assert.equal(receipt.price, undefined);
});

test("판매자 아이디: 메일 주소는 아이디로 보지 않는다", () => {
  assert.equal(localParse("문의 abc@naver.com 으로 주세요 15만원").sellerHandle, undefined);
  assert.equal(localParse("판매자 @seller_01 15만원").sellerHandle, "@seller_01");
});

test("연도 없는 공연일은 지난 날짜면 다음 해로 본다", () => {
  const d = localParse("1/10 19:00 공연 양도 20만원", { now: at("2026-10-08T12:00") });
  assert.equal(d.showDate, "2027-01-10T19:00");
});

test("상태바 시각만 있으면 날짜를 만들지 않는다", () => {
  const d = localParse("9:41 LTE 87%\n콘서트 양도 20만원", { now: at("2026-10-08T12:00") });
  assert.equal(d.showDate, undefined);
  assert.equal(d.postDate, undefined);
});

test("normalizeOcrText", () => {
  assert.equal(normalizeOcrText("아 이 유 콘 서 트"), "아이유콘서트");
  assert.equal(normalizeOcrText("하늘빛 밴드 콘서트"), "하늘빛 밴드 콘서트");
  assert.equal(normalizeOcrText("15O,OOO원"), "150,000원");
  assert.equal(normalizeOcrText("&구역 3열"), "A구역 3열");
  assert.equal(normalizeOcrText("플로어 ^구역"), "플로어 A구역");
  assert.equal(normalizeOcrText("오후 3024 · 2026년"), "오후 3:24 · 2026년");
  assert.equal(normalizeOcrText("NOLＥ"), "NOLE");
});

test("wonToNumber", () => {
  assert.equal(wonToNumber("150,000원"), 150000);
  assert.equal(wonToNumber("150.000"), 150000);
  assert.equal(wonToNumber("22만원"), 220000);
  assert.equal(wonToNumber("1.5만"), 15000);
  assert.equal(wonToNumber("12"), null);
});
