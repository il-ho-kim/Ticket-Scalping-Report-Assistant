// 캡처 글자 인식 e2e: 실제 브라우저(Chromium)에서 index.html을 열고 합성 캡처를 올린 뒤
// [캡처에서 자동으로 읽기]를 눌러 채워진 입력칸을 기대값(tests/fixtures/templates/*.expected.json)과 비교한다.
// Tesseract 라이브러리·글자 데이터는 CDN 대신 node_modules에서 받는다 (외부 요청은 모두 막는다).
// 실행: npm run test:e2e   (먼저 npm install)
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "tests/fixtures");
const outDir = join(root, "tests/output");
mkdirSync(outDir, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".wasm": "application/wasm", ".gz": "application/gzip", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };

// /api/kopis: 실제 서버 함수(api/kopis.js)를 쓰되, KOPIS 대신 tests/fixtures/kopis/*.xml 가짜 응답을 돌려준다
const require = createRequire(import.meta.url);
const { createHandler } = require("../api/kopis.js");
const kopisHandler = createHandler({
  getKey: () => "E2E",
  fetch: async (url) => {
    const u = new URL(url);
    let name = null;
    if (u.pathname.endsWith("/pblprfr")) name = /BLUE/i.test(u.searchParams.get("shprfnm") || "") ? "list-blue-hour.xml" : null;
    else name = `detail-${u.pathname.split("/").pop()}.xml`;
    const f = name && join(fixtures, "kopis", name);
    return { ok: true, status: 200, text: async () => (f && existsSync(f) ? readFileSync(f, "utf8") : "<dbs></dbs>") };
  }
});

// /api/listing: 실제 서버 함수(api/listing.js)를 쓰되, 티켓베이 대신 tests/fixtures/ticketbay/ 가상 응답을 돌려준다
const listingHandler = require("../api/listing.js").createHandler({
  delayMs: 0,
  fetch: async (url) => {
    const u = new URL(url), tb = (f) => join(fixtures, "ticketbay", f);
    let f = null;
    if (u.pathname === "/search") f = /BLUE|하늘빛/.test(u.searchParams.get("keyword") || "") ? "search-blue-hour.html" : "search-empty.html";
    else if (u.pathname === "/product/990001/list/1") f = "category-990001.html";
    else if (u.pathname === "/ticketbayApi/product/v1/public/products") f = "products.json";
    else if (u.pathname.startsWith("/product/view/")) f = `view-${u.pathname.split("/").pop()}.html`;
    if (!f || !existsSync(tb(f))) return { ok: false, status: 404, text: async () => readFileSync(tb("not-found.html"), "utf8") };
    return { ok: true, status: 200, text: async () => readFileSync(tb(f), "utf8") };
  }
});

// ---------- 정적 서버 ----------
const server = http.createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/api/kopis") return kopisHandler(req, res);
  if (path === "/api/listing") return listingHandler(req, res);
  // 언어 데이터는 언어별 패키지에 나뉘어 있어 한 경로로 모아 준다: /__lang/kor.traineddata.gz
  const lang = /^\/__lang\/(\w+)\.traineddata\.gz$/.exec(path);
  const file = lang
    ? join(root, "node_modules/@tesseract.js-data", lang[1], "4.0.0_best_int", `${lang[1]}.traineddata.gz`)
    : join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const OCR_CONFIG = {
  scriptUrl: `${base}/node_modules/tesseract.js/dist/tesseract.min.js`,
  workerPath: `${base}/node_modules/tesseract.js/dist/worker.min.js`,
  corePath: `${base}/node_modules/tesseract.js-core`,
  langPath: `${base}/__lang`
};

// ---------- 테스트 케이스 ----------
const names = readdirSync(join(fixtures, "templates")).filter((f) => f.endsWith(".expected.json")).map((f) => f.replace(".expected.json", ""));
const expected = Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(join(fixtures, "templates", `${n}.expected.json`), "utf8"))]));
const cases = [];
for (const n of names) {
  cases.push({ name: n, files: [`${n}.png`], exp: expected[n], gate: true });
  cases.push({ name: `${n} (저화질)`, files: [`${n}.lowq.jpg`], exp: expected[n], gate: false });
}
// 게시글 + 예매내역 두 장: 게시글 값이 먼저, 게시글에서 못 읽은 항목은 예매내역에서 채운다
cases.push({ name: "bunjang + nol_booking (2장)", files: ["bunjang.png", "nol_booking.png"], exp: expected.bunjang, gate: true, flow: true });

function check(actual, want) {
  if (want && typeof want === "object") return actual.includes(want.includes);
  return actual === want;
}

const browser = await chromium.launch();
const context = await browser.newContext({ timezoneId: "Asia/Seoul", locale: "ko-KR", viewport: { width: 420, height: 900 } });
const external = new Set();
await context.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(base) || u.startsWith("blob:") || u.startsWith("data:")) return route.continue();
  external.add(u);
  return route.abort();
});
await context.addInitScript((cfg) => { window.TICKET_OCR_CONFIG = cfg; }, OCR_CONFIG);

let gateFailures = 0;
const summary = [];
for (const c of cases) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/index.html");
  // 1 → 2(공연) → 3 → 4단계
  await page.click("#primaryBtn");
  await page.click("#optConcert");
  await page.click("#primaryBtn");
  await page.click("#primaryBtn");

  // 캡처 업로드: 캡처 시각(lastModified)을 기대값의 capturedAt으로 맞춘다
  const payload = c.files.map((f) => ({ name: f, type: f.endsWith(".png") ? "image/png" : "image/jpeg",
    b64: readFileSync(join(fixtures, "captures", f)).toString("base64") }));
  await page.evaluate(({ payload, capturedAt }) => {
    const dt = new DataTransfer();
    for (const p of payload) {
      const bytes = Uint8Array.from(atob(p.b64), (ch) => ch.charCodeAt(0));
      dt.items.add(new File([bytes], p.name, { type: p.type, lastModified: new Date(capturedAt).getTime() }));
    }
    const input = document.getElementById("fileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { payload, capturedAt: c.exp.capturedAt });
  await page.waitForFunction((n) => document.querySelectorAll("#thumbs .thumb").length === n, c.files.length);
  await page.waitForFunction(() => !document.getElementById("extractBtn").disabled);
  const routeName = await page.textContent("#routeName");
  const t0 = Date.now();
  await page.click("#extractBtn");
  await page.waitForFunction(() => /채웠어요|찾지 못했어요|불러오지 못했어요/.test(document.getElementById("extractStatus").textContent), null, { timeout: 180000 });
  const ms = Date.now() - t0;
  const status = await page.textContent("#extractStatus");

  const got = await page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const chip = (sel, key) => { const el = document.querySelector(sel + " .chip.picked"); return el ? el.dataset[key] : ""; };
    const out = {};
    for (const id of ["titleInput", "showDateInput", "postDateInput", "venueInput", "seatInput", "officialPriceInput", "saleInput", "sellerInput", "urlInput"]) out[id] = v(id);
    out.platform = chip("#platformChips", "platform");
    out.vendor = chip("#vendorChips", "vendor");
    out.flags = Array.from(document.querySelectorAll(".field-flag")).map((f) => f.textContent).filter(Boolean);
    out.bodyText = document.body.innerText;
    return out;
  });

  const rows = Object.entries(c.exp.fields).map(([k, want]) => ({ k, want, got: got[k], ok: check(got[k], want) }));
  const hit = rows.filter((r) => r.ok).length;
  console.log(`\n■ ${c.name}  [${routeName}]  ${hit}/${rows.length}  (${(ms / 1000).toFixed(1)}s)`);
  console.log(`  상태: ${status}`);
  for (const r of rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.k.padEnd(19)} ${JSON.stringify(r.got)}${r.ok ? "" : `   ← 기대 ${JSON.stringify(r.want)}`}`);
  const problems = [];
  if (/추정/.test(got.bodyText)) problems.push("화면에 '추정' 문구가 있음");
  if (got.flags.some((f) => f !== "캡처에서 읽음")) problems.push("출처 표시가 '캡처에서 읽음'이 아님: " + got.flags.join(","));
  if (errors.length) problems.push("페이지 오류: " + errors.join(" | "));
  problems.forEach((p) => console.log("  ! " + p));
  if (process.env.OCR_DEBUG) {
    const diag = await page.textContent("#diagText");
    console.log("  --- 읽은 글자 ---\n" + diag.split("[캡처에서 읽은 글자]\n")[1]);
  }
  if (c.gate && problems.length) gateFailures++;
  summary.push({ name: c.name, hit, total: rows.length, gate: c.gate });

  if (c.files[0] === "bunjang.png" && c.files.length === 1) await page.screenshot({ path: join(outDir, "step4-bunjang.png"), fullPage: true });

  if (c.flow) {
    // 이후 단계가 그대로 동작하는지: URL을 직접 넣고 5단계(초안) → 6단계(북마크릿)
    await page.fill("#urlInput", "https://example.com/post/123");
    await page.click("#primaryBtn");
    const draft = await page.inputValue("#draftText");
    await page.click("#primaryBtn");
    const href = await page.getAttribute("#bookmarkletLink", "href");
    const okFlow = draft.includes("고척스카이돔") && draft.includes("https://example.com/post/123") && href.startsWith("javascript:(function");
    console.log(`  ${okFlow ? "✓" : "✗"} 5·6단계: 초안 ${draft.length}자, 북마크릿 ${href.length}자`);
    if (!okFlow) gateFailures++;
  }
  await page.close();
}

// 공식 정보(KOPIS) 확인: 캡처 읽기 → 자동으로 찾기 → 다른 항목 [바꾸기] → '공식 정보로 고침' 표시
{
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/index.html");
  await page.click("#primaryBtn"); await page.click("#optConcert"); await page.click("#primaryBtn"); await page.click("#primaryBtn");
  const b64 = readFileSync(join(fixtures, "captures", "bunjang.png")).toString("base64");
  await page.evaluate(({ b64 }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "bunjang.png", { type: "image/png", lastModified: new Date("2026-10-08T15:00").getTime() }));
    const input = document.getElementById("fileInput"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { b64 });
  await page.waitForFunction(() => !document.getElementById("extractBtn").disabled);
  await page.click("#extractBtn");
  // 서울·부산 두 후보 중 공연일(11/22)이 기간 안에 드는 서울 공연이 바로 골라져 비교가 나와야 한다
  await page.waitForSelector("#kopisCompare:not([hidden]) .kopis-row", { timeout: 180000 });
  const before = await page.evaluate(() => ({
    status: document.getElementById("kopisStatus").textContent,
    cands: document.querySelectorAll("#kopisCandidates .kopis-cand").length,
    picked: (document.querySelector(".kopis-cand.picked") || {}).textContent || "",
    rows: Array.from(document.querySelectorAll(".kopis-row")).map((r) => r.querySelector(".kopis-label").textContent + ":" + (r.querySelector(".kopis-same") ? "같음" : "다름"))
  }));
  await page.screenshot({ path: join(outDir, "kopis-card.png"), fullPage: true });
  // 공연명 [바꾸기]
  await page.click(".kopis-row:has(.kopis-label:text-is('공연명')) .kopis-apply");
  const afterTitle = await page.evaluate(() => ({ title: document.getElementById("titleInput").value, flag: document.getElementById("flag-titleInput").textContent }));
  // 부산 공연으로 바꿔 고르면 장소·일시 등이 달라지고, [다른 항목 모두 바꾸기]로 한 번에 바꾼다
  await page.click(".kopis-cand:nth-child(2)");
  await page.click("#kopisApplyAll");
  const afterAll = await page.evaluate(() => ({
    venue: document.getElementById("venueInput").value, venueFlag: document.getElementById("flag-venueInput").textContent,
    show: document.getElementById("showDateInput").value,
    body: document.body.innerText
  }));
  const ok = before.cands === 2 && /서울/.test(before.picked) && before.rows.includes("공연명:다름") && before.rows.includes("공연 장소:같음")
    && afterTitle.title === "하늘빛 밴드 2026 전국투어 'BLUE HOUR' - 서울" && afterTitle.flag === "공식 정보로 고침"
    && afterAll.venue === "벡스코 오디토리움" && afterAll.venueFlag === "공식 정보로 고침" && afterAll.show === "2026-12-13T19:00"
    && !/추정/.test(afterAll.body) && !errors.length;
  console.log(`\n■ 공식 정보 확인  ${ok ? "✓" : "✗"}`);
  console.log(`  처음: ${before.status} / 후보 ${before.cands}개, 고른 것: ${before.picked.slice(0, 40)}`);
  console.log(`  비교: ${before.rows.join(", ")}`);
  console.log(`  공연명 바꾼 뒤: ${afterTitle.title} [${afterTitle.flag}]`);
  console.log(`  부산으로 모두 바꾼 뒤: 장소 ${afterAll.venue} [${afterAll.venueFlag}], 일시 ${afterAll.show}`);
  if (errors.length) console.log("  ! 페이지 오류: " + errors.join(" | "));
  if (!ok) gateFailures++;
  await page.close();
}

// 게시글 주소 찾기·대조: 티켓베이 캡처 → 자동 검색 → [이 주소 쓰기] → 다른 글 주소 붙여넣기 → '다른 글'
{
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/index.html");
  await page.click("#primaryBtn"); await page.click("#optConcert"); await page.click("#primaryBtn"); await page.click("#primaryBtn");
  const b64 = readFileSync(join(fixtures, "captures", "ticketbay.png")).toString("base64");
  await page.evaluate(({ b64 }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "ticketbay.png", { type: "image/png", lastModified: new Date("2026-10-08T15:02").getTime() }));
    const input = document.getElementById("fileInput"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { b64 });
  await page.waitForFunction(() => !document.getElementById("extractBtn").disabled);
  await page.click("#extractBtn");
  await page.waitForSelector("#listingResults:not([hidden]) .listing-item", { timeout: 180000 });
  const found = await page.evaluate(() => ({
    status: document.getElementById("listingStatus").textContent,
    items: Array.from(document.querySelectorAll("#listingResults .listing-item")).map((x) => x.innerText.replace(/\n+/g, " | "))
  }));
  await page.locator("#listingCard").screenshot({ path: join(outDir, "listing-found.png") });
  await page.click("#listingResults .kopis-apply");
  const used = await page.evaluate(() => ({ url: document.getElementById("urlInput").value, flag: document.getElementById("flag-urlInput").textContent }));
  // 다른 판매글 주소를 붙여넣으면 '다른 글'과 다른 항목이 나와야 한다
  await page.fill("#urlInput", "https://www.ticketbay.co.kr/product/view/9000000000002");
  await page.waitForSelector("#listingResults .listing-verdict.diff", { timeout: 15000 });
  const pasted = await page.evaluate(() => ({
    verdict: document.querySelector("#listingResults .listing-verdict").textContent,
    reasons: Array.from(document.querySelectorAll("#listingResults .listing-reasons li")).map((x) => x.textContent),
    guide: !document.getElementById("listingGuide").hidden, flag: document.getElementById("flag-urlInput").textContent
  }));
  await page.locator("#listingCard").screenshot({ path: join(outDir, "listing-diff.png") });
  // 같은 글 주소를 다시 붙여넣으면 '같은 글'과 '캡처와 대조함' 표시
  await page.fill("#urlInput", "https://www.ticketbay.co.kr/product/view/9000000000001");
  await page.waitForSelector("#listingResults .listing-verdict.same", { timeout: 15000 });
  const repasted = await page.evaluate(() => document.getElementById("flag-urlInput").textContent);
  const body = await page.evaluate(() => document.body.innerText);
  const ok = found.items.length === 1 && /캡처와 같은 글이에요/.test(found.items[0]) && /9000000000001/.test(found.items[0])
    && used.url === "https://www.ticketbay.co.kr/product/view/9000000000001" && used.flag === "캡처와 대조함"
    && pasted.verdict === "캡처와 다른 글이에요" && pasted.reasons.some((r) => /판매가가 달라요/.test(r)) && pasted.guide && pasted.flag === ""
    && repasted === "캡처와 대조함" && !/추정/.test(body) && !errors.length;
  console.log(`\n■ 게시글 주소 찾기  ${ok ? "✓" : "✗"}`);
  console.log(`  찾기: ${found.status} / ${found.items.join(" // ").slice(0, 160)}`);
  console.log(`  쓰기: ${used.url} [${used.flag}]`);
  console.log(`  다른 글 붙여넣기: ${pasted.verdict} — ${pasted.reasons.join(" / ")} (안내 ${pasted.guide ? "보임" : "숨김"})`);
  console.log(`  같은 글 다시 붙여넣기: [${repasted}]`);
  if (errors.length) console.log("  ! 페이지 오류: " + errors.join(" | "));
  if (!ok) gateFailures++;
  await page.close();
}

// 붙여넣기만 한 경우(캡처 없음): 내장 파서 경로, 출처 표시는 '글에서 읽음'
{
  const page = await context.newPage();
  await page.goto(base + "/index.html");
  await page.click("#primaryBtn"); await page.click("#optConcert"); await page.click("#primaryBtn"); await page.click("#primaryBtn");
  await page.fill("#pasteText", "뮤지컬 <별의 정원> 양도\n공연일시: 2026.12.05(토) 14:00\n공연장소: 블루스퀘어 마스터카드홀\n정가 170,000원 / 판매가 300,000원\n중고나라에 올렸어요");
  await page.click("#extractBtn");
  const status = await page.textContent("#extractStatus");
  const flags = await page.$$eval(".field-flag", (els) => els.map((e) => e.textContent).filter(Boolean));
  const body = await page.evaluate(() => document.body.innerText);
  const ok = /찾았어요/.test(status) && flags.length >= 5 && flags.every((f) => f === "글에서 읽음") && !/추정/.test(body);
  console.log(`\n■ 붙여넣기만  ${ok ? "✓" : "✗"}  상태: ${status} / 표시: ${[...new Set(flags)].join(",")} (${flags.length}개)`);
  if (!ok) gateFailures++;
  await page.close();
}

await browser.close();
server.close();

console.log("\n===== 요약 =====");
for (const s of summary) console.log(`${s.gate ? "기준" : "기록"}  ${String(s.hit).padStart(2)}/${s.total}  ${s.name}`);
// 합격 기준: 원본 화질 캡처의 항목 일치율 90% 이상. 저화질은 기록만 한다.
const rate = (list) => { const h = list.reduce((a, s) => a + s.hit, 0), t = list.reduce((a, s) => a + s.total, 0); return [h, t, h / t]; };
const [gh, gt, gr] = rate(summary.filter((s) => s.gate));
const [lh, lt, lr] = rate(summary.filter((s) => !s.gate));
console.log(`\n원본 화질 일치율 ${gh}/${gt} (${(gr * 100).toFixed(1)}%) · 저화질 ${lh}/${lt} (${(lr * 100).toFixed(1)}%)`);
if (gr < 0.9) { console.log("원본 화질 일치율이 기준(90%)보다 낮아요"); gateFailures++; }
if (external.size) console.log("막은 외부 요청:", [...external].join(", "));
if (gateFailures) { console.log(`\n실패 ${gateFailures}건`); process.exit(1); }
console.log("통과");
