// Vercel 서버 함수: 캡처로 판매글 주소 찾기·대조 (지금은 티켓베이만).
//   GET /api/listing?action=search&title=…&date=YYYY-MM-DDTHH:mm&price=…&seat=…[&number=상품번호][&postDate=…]
//       → 캡처와 "같은 글"로 판정된 판매글만 최대 3개
//   GET /api/listing?action=verify&url=…&date=…&price=…&seat=…[&number=…]
//       → 붙여넣은 주소의 판매글을 캡처와 대조 (같은 글 / 다른 글 + 다른 항목)
// 브라우저는 티켓베이를 직접 부를 수 없어서(다른 사이트 호출 차단) 이 함수가 대신 부른다.
// 신고할 글 한 건을 찾는 데만 쓰고, 아무것도 저장하지 않는다.
"use strict";

const LM = require("../js/listing-match.js");
const KM = require("../js/kopis-match.js");
const ticketbay = require("./_platforms/ticketbay.js");

const MAX_CANDIDATES = 3;
const MAX_CATEGORIES = 2;

function send(res, status, body, cacheSeconds) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheSeconds ? `public, s-maxage=${cacheSeconds}` : "no-store");
  res.end(JSON.stringify(body));
}
// 화면에 돌려줄 판매글 값 (판매자 내부 번호·설명글 등은 넣지 않는다)
function publicListing(l) {
  return { platform: l.platform, id: l.id, url: l.url, title: l.title, performDate: l.performDate, price: l.price,
    totalPrice: l.totalPrice, listPrice: l.listPrice, quantity: l.quantity, seatText: l.seatText, seatLabel: l.seatLabel,
    createdAt: l.createdAt, status: l.status,
    // 신고서 채우기용 공연 정보 (티켓베이 공연 소개글·아티스트 이름·좌석 등급 정가)
    officialTitle: l.officialTitle || "", venue: l.venue || "", artist: l.artist || "", aliases: l.aliases || [], gradePrice: l.gradePrice == null ? null : l.gradePrice };
}
function captureFrom(q) {
  return { listingNumber: q.get("number") || "", price: q.get("price") || "", showDate: q.get("date") || "",
    seat: q.get("seat") || "", title: q.get("title") || "", postDate: q.get("postDate") || "" };
}
function judge(capture, listing) { return LM.compare(capture, listing, { nameScore: KM.nameScore }); }
// 같은 글이 여럿이면 게시 시각이 캡처의 게시일시와 가까운 순, 없으면 최근 글 먼저
function byPostTime(capture) {
  const t = capture.postDate ? new Date(capture.postDate).getTime() : null;
  return (a, b) => t
    ? Math.abs(new Date(a.createdAt) - t) - Math.abs(new Date(b.createdAt) - t)
    : String(b.createdAt).localeCompare(String(a.createdAt));
}
function keywords(title) {
  const t = String(title || "").trim();
  const words = t.replace(/['"‘’“”<>〈〉《》\[\]()\-:]/g, " ").split(/\s+/).filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
  return [t, words[0]].filter((w, i, a) => w && a.indexOf(w) === i);
}

function createHandler(opts) {
  const clientFor = () => ticketbay.createClient(opts);

  async function search(capture) {
    const client = clientFor();
    // 1) 상품번호가 캡처에 보이면 그 글만 확인
    if (capture.listingNumber) {
      const l = await client.getListing(capture.listingNumber.replace(/\D/g, ""));
      const r = l && judge(capture, l);
      return { candidates: l && r.same ? [{ listing: publicListing(l), result: r }] : [], checked: l ? 1 : 0, requests: client.requestCount() };
    }
    // 2) 공연명으로 티켓베이 공연을 찾고, 그 회차의 판매글 중 캡처와 같은 글을 고른다
    let cats = [];
    for (const kw of keywords(capture.title)) {
      cats = await client.searchCategories(kw);
      if (cats.length) break;
    }
    cats = cats.map((c) => ({ c, s: KM.nameScore(capture.title, c.name) })).sort((a, b) => b.s - a.s).map((x) => x.c).slice(0, MAX_CATEGORIES);
    let checked = 0;
    for (const cat of cats) {
      const info = await client.getCategoryInfo(cat.id);
      const pd = client.pickPerformDate(info, capture.showDate);
      if (!pd) continue;   // 이 공연에는 그날 회차가 없다
      const grade = LM.parseSeat(capture.seat).grade;
      const gradeOk = grade && ((info.seat_grade_list || []).some((g) => String(g.name).toUpperCase() === grade));
      const items = await client.listListings(cat.id, { depth1Id: info.depth1_id, performDate: String(pd.real_date).replace("T", " "), grade: gradeOk ? grade : "" }, 3, info);
      items.forEach((l) => { if (!l.venue) l.venue = cat.location; });
      checked += items.length;
      const same = items.map((l) => ({ l, r: judge(capture, l) })).filter((x) => x.r.same);
      if (same.length) {
        same.sort((a, b) => byPostTime(capture)(a.l, b.l));
        return { category: { id: cat.id, name: cat.name }, candidates: same.slice(0, MAX_CANDIDATES).map((x) => ({ listing: publicListing(x.l), result: x.r })), checked, requests: client.requestCount() };
      }
    }
    return { category: cats[0] ? { id: cats[0].id, name: cats[0].name } : null, candidates: [], checked, requests: client.requestCount() };
  }

  return async function handler(req, res) {
    const q = new URL(req.url, "http://localhost").searchParams;
    const action = q.get("action");
    const capture = captureFrom(q);
    try {
      if (action === "verify") {
        const parsed = ticketbay.parseUrl(q.get("url"));
        if (!parsed) return send(res, 200, { ok: false, error: "unsupported", message: "지금은 티켓베이 판매글 주소만 대조할 수 있어요." });
        if (!parsed.id) return send(res, 200, { ok: false, error: "not_listing", message: "티켓베이 판매글 주소가 아니에요. 판매글 화면의 공유 → 링크 복사로 받은 주소를 넣어주세요." });
        const client = clientFor();
        const l = await client.getListing(parsed.id);
        if (!l) return send(res, 200, { ok: false, error: "not_found", message: "판매글을 찾을 수 없어요. 삭제됐거나 판매가 끝났을 수 있어요." });
        return send(res, 200, { ok: true, listing: publicListing(l), result: judge(capture, l) }, 60);
      }
      if (action === "search") {
        if (!capture.listingNumber && (!capture.title || !capture.showDate || !capture.price)) {
          return send(res, 400, { ok: false, error: "need_more", message: "공연명·공연 일시·판매 가격이 있어야 찾을 수 있어요." });
        }
        const out = await search(capture);
        return send(res, 200, Object.assign({ ok: true }, out), 120);
      }
      return send(res, 400, { ok: false, error: "bad_action", message: "action은 search 또는 verify여야 해요." });
    } catch (e) {
      const timeout = e && e.name === "AbortError";
      return send(res, 502, { ok: false, error: timeout ? "timeout" : (e.code || "failed"),
        message: timeout ? "티켓베이 응답이 늦어요. 잠시 뒤 다시 시도해주세요." : "티켓베이에서 정보를 받지 못했어요. 잠시 뒤 다시 시도해주세요." });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
