// 판매글 주소 찾기·대조 테스트: 대조 규칙(js/listing-match.js), 티켓베이 처리(api/_platforms/ticketbay.js),
// 서버 함수(api/listing.js). 실제 티켓베이 대신 tests/fixtures/ticketbay/ 가상 응답을 쓴다.
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const LM = require("../js/listing-match.js");
const TB = require("../api/_platforms/ticketbay.js");
const { createHandler } = require("../api/listing.js");
const fxPath = (name) => new URL(`./fixtures/ticketbay/${name}`, import.meta.url);
const fx = (name) => readFileSync(fxPath(name), "utf8");

// 캡처(captures/ticketbay.png)에서 읽은 값
const CAPTURE = { price: "250000", showDate: "2026-11-22T18:00", seat: "플로어 R석 A구역 12열 7번",
  title: "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울", postDate: "2026-10-08T12:02" };
const listings = () => JSON.parse(fx("products.json")).data.content.map((p) => TB.normalize(p));

test("좌석 문구 나누기", () => {
  assert.deepEqual(LM.parseSeat("플로어 R석 A구역 12열 7번"), { floor: "플로어", grade: "R", area: "A", row: "12", num: "7" });
  assert.deepEqual(LM.parseSeat("2층 (2F) S석 23구역(존/블럭) 11ROW"), { floor: "2", grade: "S", area: "23", row: "11" });
  assert.deepEqual(LM.parseSeat("스탠딩 R구역 120번대"), { area: "R" });
  assert.deepEqual(LM.parseSeat(""), {});
});

test("티켓베이 판매글 정리", () => {
  const l = listings()[0];
  assert.equal(l.id, "9000000000001");
  assert.equal(l.url, "https://www.ticketbay.co.kr/product/view/9000000000001");
  assert.equal(l.performDate, "2026-11-22T18:00");
  assert.deepEqual(l.seat, { floor: "플로어", grade: "R", area: "A", row: "12", num: "7" });
  assert.equal(l.price, 250000);
  assert.equal(l.createdAt, "2026-10-08T12:02");
});

test("대조: 같은 글은 하나뿐, 다른 글은 다른 항목을 알려준다", () => {
  const results = listings().map((l) => ({ id: l.id, r: LM.compare(CAPTURE, l) }));
  assert.deepEqual(results.filter((x) => x.r.same).map((x) => x.id), ["9000000000001"]);
  const by = Object.fromEntries(results.map((x) => [x.id, x.r]));
  assert.match(by["9000000000002"].reasons.join(), /판매가가 달라요: 캡처 250,000원 \/ 글 230,000원/);
  assert.match(by["9000000000002"].reasons.join(), /좌석이 달라요\(번호\)/);
  assert.match(by["9000000000003"].reasons.join(), /좌석이 달라요\(구역·열\)/);
  assert.match(by["9000000000004"].reasons.join(), /공연일이 달라요: 캡처 11\/22 \/ 글 11\/21/);
});

test("대조: 판매가·공연일을 확인할 수 없으면 같은 글로 보지 않는다", () => {
  const l = listings()[0];
  const r = LM.compare({ seat: CAPTURE.seat }, l);
  assert.equal(r.same, false);
  assert.deepEqual(r.reasons, ["캡처에서 판매가를 확인할 수 없어요", "캡처에서 공연일을 확인할 수 없어요"]);
  // 좌석이 캡처에 없으면 좌석은 비교하지 않는다 (판매가·공연일만으로 판정)
  assert.equal(LM.compare({ price: "250000", showDate: "2026-11-22T18:00" }, l).same, true);
  // 총액(2장 가격)으로 적힌 경우도 같은 글
  assert.equal(LM.compare({ price: "500000", showDate: "2026-11-22T18:00" }, Object.assign({}, l, { totalPrice: 500000 })).same, true);
});

test("대조: 상품번호가 보이면 번호만으로 결정", () => {
  const l = listings()[0];
  assert.equal(LM.compare({ listingNumber: "9000000000001" }, l).same, true);
  const r = LM.compare({ listingNumber: "9000000000002", price: "250000", showDate: "2026-11-22T18:00" }, l);
  assert.equal(r.same, false);
  assert.match(r.reasons[0], /상품번호가 달라요/);
});

test("대조: 공연명·게시 시각은 참고 정보 (판정에 안 씀)", () => {
  const l = listings()[0];
  const r = LM.compare(Object.assign({}, CAPTURE, { title: "엉뚱한 공연", postDate: "2026-01-01T00:00" }), l, { nameScore: () => 0 });
  assert.equal(r.same, true);
  assert.deepEqual(r.checks.filter((c) => !c.decisive).map((c) => [c.key, c.ok]), [["title", false], ["postDate", false]]);
});

test("티켓베이 주소 해석", () => {
  assert.deepEqual(TB.parseUrl("https://www.ticketbay.co.kr/product/view/5659303910765"),
    { id: "5659303910765", url: "https://www.ticketbay.co.kr/product/view/5659303910765" });
  assert.equal(TB.parseUrl("https://m.ticketbay.co.kr/product/view/123456789012?utm=x").id, "123456789012");
  assert.deepEqual(TB.parseUrl("https://www.ticketbay.co.kr/"), { id: null, url: null });
  assert.equal(TB.parseUrl("https://ticketbay.co.kr.evil.com/product/view/1234567"), null);
  assert.equal(TB.parseUrl("javascript:alert(1)"), null);
  assert.equal(TB.parseUrl("not a url"), null);
});

// ---------- 서버 함수 ----------
function fakeTicketbay(opts) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, method: (init && init.method) || "GET", body: init && init.body, redirect: init && init.redirect });
    if (opts && opts.redirect) return { ok: false, status: 302, text: async () => "" };
    let name = null;
    if (u.pathname === "/search") name = /BLUE|하늘빛/.test(u.searchParams.get("keyword")) ? "search-blue-hour.html" : "search-empty.html";
    else if (u.pathname === "/product/990001/list/1") name = "category-990001.html";
    else if (u.pathname === "/ticketbayApi/product/v1/public/products") name = "products.json";
    else if (u.pathname.startsWith("/product/view/")) {
      const f = `view-${u.pathname.split("/").pop()}.html`;
      if (existsSync(fxPath(f))) name = f;
      else return { ok: false, status: 404, text: async () => fx("not-found.html") };
    }
    if (!name) return { ok: false, status: 404, text: async () => fx("not-found.html") };
    return { ok: true, status: 200, text: async () => fx(name) };
  };
  return { fetch, calls };
}
// 화면이 보내는 쿼리 이름(date)으로 바꾼다
const Q = (c) => ({ title: c.title, date: c.showDate, price: c.price, seat: c.seat, postDate: c.postDate });
function call(handler, params) {
  return new Promise((resolve) => {
    const headers = {};
    const res = { statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) }) };
    handler({ url: "/api/listing?" + new URLSearchParams(params) }, res);
  });
}

test("서버 함수: 캡처 값으로 찾기 → 같은 글 하나", async () => {
  const k = fakeTicketbay();
  const h = createHandler({ fetch: k.fetch, delayMs: 0 });
  const r = await call(h, Object.assign({ action: "search" }, Q(CAPTURE)));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.candidates.map((c) => c.listing.url), ["https://www.ticketbay.co.kr/product/view/9000000000001"]);
  assert.equal(r.body.candidates[0].result.same, true);
  assert.equal(r.body.checked, 4);
  assert.ok(r.body.requests <= 5, "요청 수는 5번 이하");
  // 목록 조회는 그날 회차·좌석 등급으로 좁혀서 부른다
  const post = k.calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { category_id: 990001, size: 50, offset: 0, depth1_id: 3, start_perform_date: "2026-11-22 18:00:00", seat_grade: "R" });
  assert.ok(k.calls.every((c) => c.redirect === "manual" && c.url.startsWith("https://www.ticketbay.co.kr/")));
  // 판매자 내부 번호·설명글은 돌려주지 않는다
  const json = JSON.stringify(r.body);
  assert.ok(!json.includes("member_id") && !json.includes("가상 판매글"));
});

test("서버 함수: 같은 글이 없으면 빈 후보", async () => {
  const h = createHandler({ fetch: fakeTicketbay().fetch, delayMs: 0 });
  const r = await call(h, Object.assign({ action: "search" }, Q(CAPTURE), { price: "260000" }));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.candidates, []);
  const none = await call(h, Object.assign({ action: "search" }, Q(CAPTURE), { title: "없는 공연" }));
  assert.deepEqual(none.body.candidates, []);
  assert.equal(none.body.category, null);
});

test("서버 함수: 상품번호가 있으면 그 글만 확인", async () => {
  const k = fakeTicketbay();
  const h = createHandler({ fetch: k.fetch, delayMs: 0 });
  const r = await call(h, { action: "search", number: "9000000000001" });
  assert.equal(r.body.candidates.length, 1);
  assert.equal(k.calls.length, 1);
});

test("서버 함수: 붙여넣은 주소 대조", async () => {
  const h = createHandler({ fetch: fakeTicketbay().fetch, delayMs: 0 });
  const same = await call(h, Object.assign({ action: "verify", url: "https://www.ticketbay.co.kr/product/view/9000000000001" }, Q(CAPTURE)));
  assert.equal(same.body.ok, true);
  assert.equal(same.body.result.same, true);
  const diff = await call(h, Object.assign({ action: "verify", url: "https://www.ticketbay.co.kr/product/view/9000000000002" }, Q(CAPTURE)));
  assert.equal(diff.body.result.same, false);
  assert.ok(diff.body.result.reasons.length >= 1);
  const gone = await call(h, Object.assign({ action: "verify", url: "https://www.ticketbay.co.kr/product/view/9000000000999" }, Q(CAPTURE)));
  assert.equal(gone.body.error, "not_found");
  const other = await call(h, { action: "verify", url: "https://example.com/product/view/9000000000001" });
  assert.equal(other.body.error, "unsupported");
  const home = await call(h, { action: "verify", url: "https://www.ticketbay.co.kr/event/1" });
  assert.equal(home.body.error, "not_listing");
});

test("서버 함수: 다른 주소로 넘기는 응답은 따라가지 않는다", async () => {
  const h = createHandler({ fetch: fakeTicketbay({ redirect: true }).fetch, delayMs: 0 });
  const r = await call(h, Object.assign({ action: "verify", url: "https://www.ticketbay.co.kr/product/view/9000000000001" }, Q(CAPTURE)));
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "redirect");
});

test("서버 함수: 값이 모자라거나 잘못된 요청", async () => {
  const h = createHandler({ fetch: fakeTicketbay().fetch, delayMs: 0 });
  assert.equal((await call(h, { action: "search", title: "BLUE HOUR" })).body.error, "need_more");
  assert.equal((await call(h, { action: "nope" })).body.error, "bad_action");
});
