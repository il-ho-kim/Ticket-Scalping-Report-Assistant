// 공연예술통합전산망(KOPIS) 연동 테스트: 응답 정리, 입력값 비교 규칙, 서버 함수(api/kopis.js).
// 실제 KOPIS 대신 tests/fixtures/kopis/*.xml 가짜 응답을 쓴다.
process.env.TZ = "Asia/Seoul";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const M = require("../js/kopis-match.js");
const { createHandler, searchPeriod, yearWindows } = require("../api/kopis.js");
const fx = (name) => readFileSync(new URL(`./fixtures/kopis/${name}`, import.meta.url), "utf8");

test("공연목록·상세 XML 정리", () => {
  const list = M.parseList(fx("list-blue-hour.xml"));
  assert.equal(list.length, 2);
  assert.equal(list[1].title, "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울");
  assert.equal(list[1].from, "2026-11-21");

  const d = M.parseDetail(fx("detail-PF900001.xml"));
  assert.equal(d.id, "PF900001");
  assert.equal(d.venue, "고척스카이돔 (고척스카이돔)");
  assert.deepEqual(d.prices, [{ grade: "플로어석", won: 154000 }, { grade: "R석", won: 154000 }, { grade: "S석", won: 132000 }]);
  assert.deepEqual(d.schedule, [{ days: [6, 0], times: ["18:00"] }]);
  assert.deepEqual(d.vendors.map((v) => v.name), ["NOL티켓", "티켓링크"]);
  assert.deepEqual(M.parseError(fx("error-key.xml")), { code: "02", message: "SERVICE KEY IS NOT REGISTERED ERROR." });
  assert.equal(M.parseError(fx("detail-PF900001.xml")), null);
});

test("가격·공연 시간 문구 나누기", () => {
  assert.deepEqual(M.parsePrices("전석 50,000원"), [{ grade: "전석", won: 50000 }]);
  assert.deepEqual(M.parsePrices("VIP석 170,000원 / R석 140,000원"), [{ grade: "VIP석", won: 170000 }, { grade: "R석", won: 140000 }]);
  assert.deepEqual(M.parsePrices("무료"), []);
  const t = M.parseTimes("화요일 ~ 금요일(20:00), 토요일 ~ 일요일(14:00,18:00), HOL(15:00)");
  assert.deepEqual(t[0], { days: [2, 3, 4, 5], times: ["20:00"] });
  assert.deepEqual(t[1], { days: [6, 0], times: ["14:00", "18:00"] });
  assert.equal(t[2].days, null);
  assert.deepEqual(M.timesOn(t, "2026-12-05"), ["14:00", "18:00"]);   // 토요일
  assert.deepEqual(M.timesOn(t, "2026-12-08"), ["20:00"]);            // 화요일
});

test("후보 순서: 이름이 비슷하고 공연일이 기간 안에 드는 공연 먼저", () => {
  const list = M.parseList(fx("list-blue-hour.xml"));
  assert.equal(M.rankCandidates(list, "BLUE HOUR", "2026-11-22")[0].id, "PF900001");
  assert.equal(M.rankCandidates(list, "BLUE HOUR", "2026-12-13")[0].id, "PF900002");
  assert.ok(M.nameScore("BLUE HOUR", "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울") >= 0.9);
  assert.ok(M.nameScore("별의 정원", "하늘빛 밴드 2026 전국투어") < 0.3);
});

test("입력값 비교: 번개장터 캡처에서 읽은 값", () => {
  const perf = M.parseDetail(fx("detail-PF900001.xml"));
  const rows = M.compare({ title: "BLUE HOUR", venue: "고척스카이돔", showDate: "2026-11-22T18:00",
    officialPrice: "154000", seat: "플로어 A구역 12열 7번", vendor: "NOL티켓" }, perf);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.title.same, false);
  assert.equal(by.title.suggest, "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울");
  assert.equal(by.venue.same, true);
  assert.equal(by.venue.suggest, "고척스카이돔");
  assert.equal(by.showDate.same, true);
  assert.equal(by.officialPrice.same, true);        // 플로어석 154,000원
  assert.equal(by.vendor.same, true);
});

test("입력값 비교: 틀린 정가·시각·장소·예매처를 바로잡을 값", () => {
  const perf = M.parseDetail(fx("detail-PF900001.xml"));
  const rows = M.compare({ title: "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울", venue: "고척돔",
    showDate: "2026-11-22T19:00", officialPrice: "132000", seat: "2층 R석 B블록 5열 11번", vendor: "YES24" }, perf);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.title.same, true);
  assert.equal(by.venue.same, false);
  assert.equal(by.venue.suggest, "고척스카이돔");
  assert.equal(by.showDate.same, false);
  assert.equal(by.showDate.suggest, "2026-11-22T18:00");
  assert.equal(by.officialPrice.same, false);       // R석은 154,000원
  assert.equal(by.officialPrice.suggest, "154000");
  assert.equal(by.vendor.same, false);
  assert.deepEqual(by.vendor.options.map((o) => o.value), ["NOL티켓", "티켓링크"]);
});

test("입력값 비교: 공연 기간 밖 날짜면 공식 회차를 고를 수 있게", () => {
  const perf = M.parseDetail(fx("detail-PF900001.xml"));
  const row = M.compare({ title: "x", showDate: "2026-11-29T18:00" }, perf).find((r) => r.key === "showDate");
  assert.equal(row.same, false);
  assert.deepEqual(row.options.map((o) => o.value), ["2026-11-21T18:00", "2026-11-22T18:00"]);
  const empty = M.compare({ title: "x" }, perf).find((r) => r.key === "showDate");
  assert.equal(empty.options.length, 2);
});

test("실제 KOPIS 값: 겹친 괄호 공연장 이름, 운영사 이름 예매처", () => {
  assert.equal(M.venueName("큐씨어터(구. 수상한흥신소전용관) (큐씨어터(구. 수상한흥신소전용관))"), "큐씨어터(구. 수상한흥신소전용관)");
  assert.equal(M.venueName("소극장 플랫폼74 (소극장 플랫폼74)"), "소극장 플랫폼74");
  assert.equal(M.venueName("세종문화회관 (세종문화회관 대극장)"), "세종문화회관 대극장");
  assert.equal(M.venueName("블루스퀘어 (마스터카드홀)"), "블루스퀘어 마스터카드홀");
  assert.equal(M.venueName("예술의전당"), "예술의전당");
  assert.equal(M.appVendor("놀유니버스"), "NOL티켓");
  assert.equal(M.appVendor("NHN티켓링크"), "티켓링크");
  // 실제 응답(2026-10-15, 「여기에는 생각보다 뭐가 많다」)의 공연 시간 문구
  assert.deepEqual(M.parseTimes("목요일 ~ 금요일(19:30), 토요일(15:00,19:30), 일요일(15:00)"),
    [{ days: [4, 5], times: ["19:30"] }, { days: [6], times: ["15:00", "19:30"] }, { days: [0], times: ["15:00"] }]);
});

test("예매처·좌석 등급 맞추기", () => {
  assert.equal(M.appVendor("인터파크티켓"), "NOL티켓");
  assert.equal(M.appVendor("예스24"), "YES24");
  assert.equal(M.appVendor("네이버예약"), null);
  assert.equal(M.seatGrade("1층 VIP석 3열"), "VIP");
  assert.equal(M.seatGrade("3열 15번"), null);
});

// ---------- 서버 함수 ----------
function fakeKopis(map) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const name = map(u);
    if (!name) return { ok: true, status: 200, text: async () => "<dbs></dbs>" };
    return { ok: true, status: 200, text: async () => fx(name) };
  };
  return { fetch, calls };
}
function call(handler, url) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) })
    };
    handler({ url }, res);
  });
}
const blueHour = (u) => {
  if (u.pathname.endsWith("/pblprfr")) return u.searchParams.get("shprfnm").includes("BLUE") ? "list-blue-hour.xml" : null;
  const id = u.pathname.split("/").pop();
  return `detail-${id}.xml`;
};

// 목록 조회에 쓴 검색어(같은 낱말은 한 번만, 부른 순서대로)
const uniqKeywords = (calls) => [...new Set(calls.filter((c) => c.includes("/pblprfr?")).map((c) => new URL(c).searchParams.get("shprfnm")))];

test("검색어 나누기", () => {
  assert.deepEqual(M.parseQuery("2026 실리카겔"), { year: 2026, phrase: "실리카겔", words: ["실리카겔"] });
  assert.deepEqual(M.parseQuery("실리카겔 SILICA GEL 2025"), { year: 2025, phrase: "실리카겔 SILICA GEL", words: ["실리카겔", "SILICA", "GEL"] });
  assert.deepEqual(M.parseQuery("EXO"), { year: null, phrase: "EXO", words: ["EXO"] });
  assert.equal(M.parseQuery("  2026  ").phrase, "");
});

test("연도 + 아티스트 검색: 그해 공연을 지난 공연까지 모두, 날짜순으로", async () => {
  // 가상 아티스트 '하늘빛'의 2026년 공연 3건: 2월(지난 공연), 11월 서울, 12월 부산 — 달마다 다른 목록을 돌려준다
  const k = fakeKopis((u) => {
    if (!u.pathname.endsWith("/pblprfr")) return `detail-${u.pathname.split("/").pop()}.xml`;
    if (!/하늘빛|HANEULBIT/.test(u.searchParams.get("shprfnm") || "")) return null;
    const month = u.searchParams.get("stdate").slice(4, 6);
    return month === "02" ? "list-haneulbit-feb.xml" : (month === "11" || month === "12") ? "list-blue-hour.xml" : null;
  });
  const h = createHandler({ fetch: k.fetch, getKey: () => "K" });
  const r = await call(h, "/api/kopis?q=" + encodeURIComponent("2026 하늘빛"));
  assert.equal(r.status, 200);
  assert.equal(r.body.query.year, 2026);
  assert.deepEqual(r.body.results.map((p) => p.id), ["PF900003", "PF900001", "PF900002"]);   // 날짜순, 11·12월에 겹쳐 나온 공연은 한 번만
  assert.equal(r.body.results[0].from, "2026-02-14");
  assert.equal(k.calls.filter((c) => c.includes("/pblprfr?")).length, 12);
  assert.ok(!k.calls.some((c) => /\/pblprfr\/PF/.test(c)), "목록 검색에서는 상세를 부르지 않는다");
  assert.match(r.headers["cache-control"], /s-maxage/);

  // 한글·영문 이름을 함께 넣으면 각각 찾아 합친다
  const k2 = fakeKopis((u) => u.pathname.endsWith("/pblprfr") && u.searchParams.get("shprfnm") === "HANEULBIT" && u.searchParams.get("stdate").slice(4, 6) === "02" ? "list-haneulbit-feb.xml" : null);
  const r2 = await call(createHandler({ fetch: k2.fetch, getKey: () => "K" }), "/api/kopis?q=" + encodeURIComponent("2026 하늘빛 HANEULBIT"));
  assert.deepEqual(r2.body.results.map((p) => p.id), ["PF900003"]);
  assert.deepEqual(uniqKeywords(k2.calls), ["하늘빛 HANEULBIT", "하늘빛", "HANEULBIT"]);

  // 검색어가 없으면 안내
  const r3 = await call(h, "/api/kopis?q=2026");
  assert.equal(r3.body.error, "no_query");
});

test("공연 하나 상세 (?id=)", async () => {
  const k = fakeKopis((u) => `detail-${u.pathname.split("/").pop()}.xml`);
  const h = createHandler({ fetch: k.fetch, getKey: () => "K" });
  const r = await call(h, "/api/kopis?id=PF900003");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.detail.title, "하늘빛 밴드 단독공연 'SPRING' 2026");
  assert.equal(r.body.detail.prices[0].won, 99000);
  assert.equal((await call(h, "/api/kopis?id=../etc")).body.error, "bad_id");
});

test("한 해 검색 기간", () => {
  const w = yearWindows(2026);
  assert.equal(w.length, 12);
  assert.deepEqual(w[1], ["20260201", "20260228"]);
  assert.deepEqual(w[11], ["20261201", "20261231"]);
});

test("서버 함수: 공연 검색 → 후보 상세 정보", async () => {
  const k = fakeKopis(blueHour);
  const h = createHandler({ fetch: k.fetch, getKey: () => "TESTKEY" });
  const r = await call(h, "/api/kopis?title=BLUE%20HOUR&date=2026-11-22");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.candidates[0].id, "PF900001");
  assert.equal(r.body.candidates[0].prices.length, 3);
  assert.match(r.headers["cache-control"], /s-maxage/);
  // 공연일이 있는 해(2026)를 한 달씩 12번 나눠 찾는다
  const listCalls = k.calls.filter((c) => c.includes("/pblprfr?")).map((c) => new URL(c).searchParams);
  assert.equal(listCalls.length, 12);
  assert.deepEqual(listCalls.map((p) => p.get("stdate")).sort()[0], "20260101");
  assert.ok(listCalls.some((p) => p.get("stdate") === "20261101" && p.get("eddate") === "20261130"));
  assert.ok(listCalls.every((p) => p.get("service") === "TESTKEY" && p.get("shprfnm") === "BLUE HOUR"));
  assert.ok(!JSON.stringify(r.body).includes("TESTKEY"), "응답에 키가 들어가면 안 된다");
});

test("서버 함수: 전체 이름으로 못 찾으면 가장 긴 낱말로 다시 찾는다", async () => {
  const k = fakeKopis((u) => u.pathname.endsWith("/pblprfr")
    ? (u.searchParams.get("shprfnm") === "BLUE" ? "list-blue-hour.xml" : null)
    : `detail-${u.pathname.split("/").pop()}.xml`);
  const h = createHandler({ fetch: k.fetch, getKey: () => "K" });
  const r = await call(h, "/api/kopis?title=" + encodeURIComponent("'BLUE' 콘서트"));
  assert.equal(r.status, 200);
  assert.equal(r.body.candidates.length, 2);
  assert.deepEqual(uniqKeywords(k.calls), ["'BLUE' 콘서트", "BLUE"]);
});

test("서버 함수: 중고거래 표기로 못 찾으면 다른 이름(영문명)으로, 그래도 없으면 그날 같은 공연장으로", async () => {
  // 실제 사례: 티켓베이 "엑소 2026 - 서울" ↔ KOPIS "EXO PLANET #6, EXhOrizon [dot]"
  const byAlt = fakeKopis((u) => u.pathname.endsWith("/pblprfr")
    ? (u.searchParams.get("shprfnm") === "HANEULBIT" ? "list-blue-hour.xml" : null)
    : `detail-${u.pathname.split("/").pop()}.xml`);
  let h = createHandler({ fetch: byAlt.fetch, getKey: () => "K" });
  let r = await call(h, "/api/kopis?title=" + encodeURIComponent("하늘빛 2026 - 서울") + "&date=2026-11-22&alt=HANEULBIT");
  assert.equal(r.body.candidates[0].id, "PF900001");
  assert.deepEqual(uniqKeywords(byAlt.calls), ["하늘빛 2026 - 서울", "HANEULBIT"]);

  // 이름으로는 아무것도 안 나오고, 그날 목록(이름 없이)에서 공연장이 같은 것만 고른다
  const byVenue = fakeKopis((u) => u.pathname.endsWith("/pblprfr")
    ? (u.searchParams.has("shprfnm") ? null : "list-blue-hour.xml")
    : `detail-${u.pathname.split("/").pop()}.xml`);
  h = createHandler({ fetch: byVenue.fetch, getKey: () => "K" });
  r = await call(h, "/api/kopis?title=" + encodeURIComponent("하늘빛 2026") + "&date=2026-11-22&venue=" + encodeURIComponent("고척스카이돔"));
  assert.deepEqual(r.body.candidates.map((c) => c.id), ["PF900001"]);
  // 공연장을 모르면 그날 목록으로 넓히지 않는다
  r = await call(h, "/api/kopis?title=" + encodeURIComponent("하늘빛 2026") + "&date=2026-11-22");
  assert.deepEqual(r.body.candidates, []);
});

test("후보 순서: 다른 이름·공연장도 반영", () => {
  const list = M.parseList(fx("list-blue-hour.xml"));
  assert.equal(M.rankCandidates(list, "엑소 2026", "", { alts: ["BLUE HOUR"], venue: "벡스코" })[0].id, "PF900002");
  assert.ok(M.sameVenue("KSPO DOME", "올림픽공원 (KSPO DOME(체조경기장))"));
});

test("서버 함수: 키가 없거나 잘못됐을 때", async () => {
  const noKey = createHandler({ fetch: async () => { throw new Error("부르면 안 됨"); }, getKey: () => "" });
  const r1 = await call(noKey, "/api/kopis?title=BLUE%20HOUR");
  assert.equal(r1.status, 503);
  assert.equal(r1.body.error, "no_key");
  const p1 = await call(noKey, "/api/kopis?ping=1");
  assert.equal(p1.body.keyConfigured, false);

  const bad = createHandler({ fetch: async () => ({ ok: true, status: 200, text: async () => fx("error-key.xml") }), getKey: () => "WRONG" });
  const r2 = await call(bad, "/api/kopis?title=BLUE%20HOUR");
  assert.equal(r2.status, 502);
  assert.equal(r2.body.error, "kopis_error");
  const p2 = await call(bad, "/api/kopis?ping=1");
  assert.equal(p2.body.keyConfigured, true);
  assert.equal(p2.body.kopisReachable, false);
  assert.match(p2.body.message, /SERVICE KEY IS NOT REGISTERED/);
  assert.ok(!JSON.stringify(p2.body).includes("WRONG"));

  const short = await call(bad, "/api/kopis?title=A");
  assert.equal(short.status, 400);
});

test("서버 함수: 점검 주소", async () => {
  const k = fakeKopis(() => "list-blue-hour.xml");
  const h = createHandler({ fetch: k.fetch, getKey: () => "K" });
  const r = await call(h, "/api/kopis?ping=1");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.kopisReachable, true);
  assert.equal(r.body.sample.length, 2);
});

test("검색 기간", () => {
  assert.deepEqual(searchPeriod("2026-11-22T18:00"), ["20261122", "20261122"]);
  const [s, e] = searchPeriod("");
  assert.match(s, /^\d{8}$/);
  assert.ok(Number(e) > Number(s));
});
