// 티켓베이 판매글 조회. 공개 페이지(로그인 불필요)에 들어 있는 Next.js 데이터(__NEXT_DATA__)만 읽는다.
//   판매글:      https://www.ticketbay.co.kr/product/view/{상품번호 13자리}
//   공연 검색:   https://www.ticketbay.co.kr/search?keyword=…
//   공연 회차·등급: https://www.ticketbay.co.kr/product/{공연번호}/list/1 (첫 쪽에 함께 들어 있다)
//   판매글 목록: POST https://www.ticketbay.co.kr/ticketbayApi/product/v1/public/products  (사이트가 쪽 넘김에 쓰는 공개 주소)
//                {category_id, depth1_id, size, offset, start_perform_date:"YYYY-MM-DD HH:mm:ss", seat_grade:"S"}
// 신고할 글 한 건을 찾는 데만 쓰고 저장하지 않는다. 판매자 내부 번호·설명글 등은 돌려주지 않는다.
// (판매자 정보 수집·추적은 하지 않는다 — docs/PRD.md "안 할 것")
"use strict";

const ORIGIN = "https://www.ticketbay.co.kr";
const HOSTS = ["www.ticketbay.co.kr", "ticketbay.co.kr", "m.ticketbay.co.kr"];
const UA = "Mozilla/5.0 (compatible; TicketReportAssistant/1.0; +https://ticket-scalping-report-assistant.vercel.app)";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;

// 붙여넣은 주소에서 상품번호를 꺼낸다. 티켓베이 주소가 아니면 null.
function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!HOSTS.includes(u.hostname.toLowerCase())) return null;
  const m = /^\/product\/view\/(\d{6,20})\/?$/.exec(u.pathname);
  return m ? { id: m[1], url: `${ORIGIN}/product/view/${m[1]}` } : { id: null, url: null };
}
function isTicketbayUrl(raw) { return parseUrl(raw) !== null; }

function nextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || "");
  if (!m) throw Object.assign(new Error("티켓베이 페이지 형식을 읽지 못했어요"), { code: "format" });
  return JSON.parse(m[1]);
}

function minute(v) { return v ? String(v).replace(" ", "T").slice(0, 16) : ""; }

// 판매글 원본 → 대조에 필요한 값만
function normalize(p, title) {
  const rowDigits = String(p.seat_number || "").match(/\d{1,3}/);
  const num = /(\d{1,3})\s*번(?!대)/.exec(p.name || "");
  const floor = /(\d{1,2})\s*층/.exec(p.floor || "") ? /(\d{1,2})\s*층/.exec(p.floor)[1] : (/플로어|floor/i.test(p.floor || "") ? "플로어" : "");
  return {
    platform: "ticketbay",
    id: String(p.display_number),
    url: `${ORIGIN}/product/view/${p.display_number}`,
    title: title || p.depth3_name || "",
    performDate: minute(p.perform_date || p.start_perform_date),
    price: p.price != null ? Number(p.price) : null,
    totalPrice: p.total_price != null ? Number(p.total_price) : null,
    listPrice: p.list_price != null ? Number(p.list_price) : null,
    quantity: p.sale_quantity || 1,
    seat: {
      floor,
      grade: String(p.grade || "").toUpperCase(),
      area: String(p.area || "").toUpperCase().replace(/\s+/g, ""),
      row: rowDigits && p.seat_number_type === "ROW" ? String(Number(rowDigits[0])) : "",
      num: num ? String(Number(num[1])) : ""
    },
    // 등급이 "S"처럼 짧으면 "S석", "스탠딩석 (Standing seat)"처럼 이미 석이 붙어 있으면 그대로
    seatText: [p.floor, p.grade ? (/석/.test(p.grade) ? p.grade : p.grade + "석") : "", (p.name || "").trim()].filter(Boolean).join(" "),
    status: p.product_status || "",
    createdAt: minute(p.created_at)
  };
}

function createClient(opts) {
  const doFetch = (opts && opts.fetch) || ((...a) => fetch(...a));
  const delay = (opts && opts.delayMs != null) ? opts.delayMs : 150;
  let requests = 0;

  async function request(path, init) {
    if (requests++ && delay) await new Promise((r) => setTimeout(r, delay));   // 연달아 부를 땐 조금씩 쉰다
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // 다른 사이트로 넘기는 응답은 따라가지 않는다
      const r = await doFetch(ORIGIN + path, Object.assign({ redirect: "manual", signal: ctrl.signal }, init,
        { headers: Object.assign({ "User-Agent": UA }, init && init.headers) }));
      if (r.status === 404) return { notFound: true };
      if (r.status >= 300 && r.status < 400) throw Object.assign(new Error("티켓베이가 다른 주소로 넘겼어요"), { code: "redirect" });
      if (!r.ok) throw Object.assign(new Error("티켓베이 응답 " + r.status), { code: "http" });
      const text = await r.text();
      if (text.length > MAX_BYTES) throw Object.assign(new Error("응답이 너무 커요"), { code: "too_big" });
      return { text };
    } finally {
      clearTimeout(timer);
    }
  }
  // 공개 페이지의 Next.js 데이터
  async function get(path, query) {
    const url = new URL(ORIGIN + path);
    Object.entries(query || {}).forEach(([k, v]) => { if (v != null && v !== "") url.searchParams.set(k, v); });
    const r = await request(url.pathname + url.search, { headers: { "Accept": "text/html" } });
    if (r.notFound) return r;
    const d = nextData(r.text);
    if (d.page === "/404" || d.page === "/_error") return { notFound: true };
    return { data: d.props && d.props.pageProps };
  }

  // 상품번호로 판매글 한 건
  async function getListing(id) {
    const r = await get(`/product/view/${encodeURIComponent(id)}`);
    if (r.notFound || !r.data || !r.data.info) return null;
    return normalize(r.data.info, r.data.categoryInfo && r.data.categoryInfo.category_name);
  }

  // 공연명으로 티켓베이 공연(카테고리) 찾기
  async function searchCategories(keyword) {
    const r = await get("/search", { keyword });
    const obj = (r.data && r.data.searchObj) || {};
    const out = [];
    Object.values(obj).forEach((list) => (list || []).forEach((c) => {
      if (c && c.depth3Id) out.push({ id: c.depth3Id, name: c.depth3Name || "", location: String(c.performLocation || "").trim() });
    }));
    return out;
  }

  // 공연의 회차·좌석 등급 목록 (판매글 목록 첫 쪽에 함께 들어 있다)
  async function getCategoryInfo(categoryId) {
    const r = await get(`/product/${encodeURIComponent(categoryId)}/list/1`);
    return (r.data && r.data.filterItem) || null;
  }

  // 회차·좌석 등급으로 좁힌 판매글 목록 (한 번에 50개씩, 최대 maxPages번)
  // filter: {depth1Id, performDate:"YYYY-MM-DD HH:mm:ss", grade:"S"}
  async function listListings(categoryId, filter, maxPages) {
    const items = [];
    for (let offset = 0; offset < (maxPages || 3); offset++) {
      const body = { category_id: Number(categoryId), size: 50, offset };
      if (filter.depth1Id) body.depth1_id = filter.depth1Id;
      if (filter.performDate) body.start_perform_date = filter.performDate;
      if (filter.grade) body.seat_grade = filter.grade;
      const r = await request("/ticketbayApi/product/v1/public/products",
        { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) });
      if (r.notFound) break;
      let page;
      try { page = JSON.parse(r.text).data; } catch { throw Object.assign(new Error("티켓베이 목록 형식을 읽지 못했어요"), { code: "format" }); }
      if (!page) break;
      (page.content || []).forEach((p) => items.push(normalize(p)));
      if (page.last || !(page.content || []).length) break;
    }
    return items;
  }

  // 회차 목록에서 공연일(같은 날, 시각까지 같으면 우선)에 맞는 회차를 고른다
  function pickPerformDate(info, showDate) {
    const list = (info && info.perform_date_list) || [];
    const d = String(showDate || "").slice(0, 10), t = String(showDate || "").slice(11, 16);
    const sameDay = list.filter((p) => String(p.real_date).slice(0, 10) === d);
    if (!sameDay.length) return null;
    return sameDay.find((p) => String(p.real_date).slice(11, 16) === t) || sameDay[0];
  }

  return { getListing, searchCategories, getCategoryInfo, listListings, pickPerformDate, requestCount: () => requests };
}

module.exports = { parseUrl, isTicketbayUrl, normalize, createClient, ORIGIN };
