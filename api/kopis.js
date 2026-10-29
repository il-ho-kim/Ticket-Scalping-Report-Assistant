// Vercel 서버 함수: 공연예술통합전산망(KOPIS) 오픈 API 중계.
// KOPIS 키는 웹페이지에 넣으면 누구나 볼 수 있고, KOPIS는 브라우저에서 바로 부를 수도 없어서(http, 교차 출처 차단)
// 이 함수가 대신 불러 정리된 JSON으로 돌려준다. 키는 Vercel 환경변수 KOPIS_API_KEY 에만 둔다.
//
//   GET /api/kopis?title=공연명&date=2026-11-22[&alt=EXO,엑소][&venue=KSPO DOME]   → { ok, candidates:[공연 정보...] }
//       alt: 다른 이름(아티스트 영문명 등) — KOPIS는 정식 공연명("EXO PLANET #6, …")으로 등록돼 있어
//            중고거래 표기("엑소 2026 - 서울")로는 안 찾아지는 경우가 많다.
//       venue: 공연장 — 이름으로 못 찾으면 그날 공연 중 공연장이 같은 것을 찾는다.
//   GET /api/kopis?q=2026 실리카겔                  → 그해(연도가 없으면 올해) 공연명에 그 낱말이 들어간 공연 목록 (지난 공연 포함)
//   GET /api/kopis?id=PF299607                      → 공연 하나의 상세(가격·공연 시간·예매처)
//   GET /api/kopis?ping=1                          → 키 설정·KOPIS 연결 점검 (키 값은 보여주지 않는다)
"use strict";

const M = require("../js/kopis-match.js");

const BASE = "http://www.kopis.or.kr/openApi/restful";
const MAX_DETAILS = 5;
const MAX_RESULTS = 60;
const MAX_KEYWORDS = 4;
const RETRY_DELAY_MS = 600; // KOPIS는 연달아 부르면 400·429로 거절하기도 한다 — 0.6초, 1.2초 쉬고 다시
const RETRIES = 2;
const CACHE_MS = 60 * 60 * 1000;
// 같은 낱말·같은 해 목록은 1시간 동안 다시 부르지 않는다 (서버가 깨어 있는 동안)
const listCache = new Map();

const TIMEOUT_MS = 8000;

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function koreaToday() {
  // Vercel 서버는 UTC로 돈다. 한국 날짜 기준으로 맞춘다.
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
// 검색 기간: 공연일을 알면 그날 하루(그날 걸쳐 있는 공연이 나온다), 모르면 오늘부터 30일
function searchPeriod(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || "");
  if (m) { const s = m[1] + m[2] + m[3]; return [s, s]; }
  const start = koreaToday(), end = new Date(start); end.setDate(end.getDate() + 30);
  return [ymd(start), ymd(end)];
}
const ROWS = 100;
const MAX_PAGES = 3;   // 한 낱말로 최대 300개까지 (아티스트 이름 검색은 보통 한 쪽이면 충분하다)
// 공연명이 길거나 일부가 틀리면 검색이 안 될 수 있어, 가장 긴 낱말로 한 번 더 찾는다
function fallbackKeyword(title) {
  const words = String(title).replace(/['"‘’“”<>〈〉《》\[\]()]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  words.sort((a, b) => b.length - a.length);
  return words[0] && words[0] !== title.trim() ? words[0] : null;
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache ? "public, s-maxage=3600, stale-while-revalidate=86400" : "no-store");
  res.end(JSON.stringify(body));
}

function createHandler(opts) {
  const doFetch = (opts && opts.fetch) || ((...a) => fetch(...a));
  const getKey = (opts && opts.getKey) || (() => process.env.KOPIS_API_KEY);

  // 거절(400·429·5xx)이나 시간 초과면 잠깐 쉬고 다시 부른다 (KOPIS는 연달아 부르면 400으로 거절하기도 한다)
  async function kopis(path, params) {
    const base = (opts && opts.retryDelayMs != null) ? opts.retryDelayMs : RETRY_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await kopisOnce(path, params);
      } catch (e) {
        const retryable = e.name === "AbortError" || (e.code === "kopis_http" && (e.status === 400 || e.status === 429 || e.status >= 500));
        if (!retryable || attempt >= RETRIES) throw e;
        await new Promise((r) => setTimeout(r, base * (attempt + 1)));
      }
    }
  }
  async function kopisOnce(path, params) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await doFetch(url.toString(), { signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error("KOPIS 응답 " + r.status), { code: "kopis_http", status: r.status });
      const err = M.parseError(text);
      if (err) throw Object.assign(new Error(err.message || "KOPIS 오류 " + err.code), { code: "kopis_error" });
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // 한 낱말로 한 해 전체를 찾는다. KOPIS는 1년 기간도 한 번에 조회해 준다(2026-10-29 점검 주소로 확인).
  // 한 쪽(100개)이 꽉 차면 다음 쪽까지. 같은 낱말·같은 해 결과는 1시간 기억한다.
  async function searchYear(key, keyword, year) {
    const useCache = !(opts && opts.fetch);   // 테스트(가짜 KOPIS)에서는 기억해 두지 않는다
    const ck = keyword + "|" + year;
    const hit = useCache && listCache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const byId = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = M.parseList(await kopis("/pblprfr", { service: key, stdate: `${year}0101`, eddate: `${year}1231`, cpage: String(page), rows: String(ROWS), shprfnm: keyword }));
      list.forEach((p) => { if (!byId.has(p.id)) byId.set(p.id, p); });
      if (list.length < ROWS) break;
    }
    const out = [...byId.values()];
    if (useCache) listCache.set(ck, { at: Date.now(), list: out });
    return out;
  }
  // 여러 낱말: 낱말마다 찾아 합친다 (한글·영문 이름을 함께 넣으면 둘 다 찾는다)
  // strict: 공연명에 그 낱말이 실제로 들어간 것만 남긴다 (KOPIS는 비슷한 이름도 함께 돌려준다)
  async function searchKeywords(key, keywords, year, stopWhenFound, strict) {
    const byId = new Map();
    for (const k of keywords) {
      (await searchYear(key, k, year)).forEach((p) => { if (!byId.has(p.id) && (!strict || M.titleHas(p.title, k))) byId.set(p.id, p); });
      if (stopWhenFound && byId.size) break;
    }
    return [...byId.values()];
  }
  function detail(key, id) {
    return kopis("/pblprfr/" + encodeURIComponent(id), { service: key }).then(M.parseDetail);
  }

  // 자동 흐름용: 공연명·다른 이름으로 공연일이 있는 해를 찾고, 상위 후보의 상세까지 붙여 돌려준다
  async function search(key, title, date, alts, venue) {
    const year = /^\d{4}/.test(date || "") ? Number(date.slice(0, 4)) : koreaToday().getFullYear();
    // 공연명 → 다른 이름들 → 공연명의 가장 긴 낱말 순으로, 찾을 때까지
    const keys = [title, ...alts, fallbackKeyword(title)].filter((k, i, a) => k && k.length >= 2 && a.indexOf(k) === i).slice(0, MAX_KEYWORDS);
    let list = await searchKeywords(key, keys, year, true);
    // 이름으로 못 찾으면: 그날(공연일을 알 때) 공연 중 공연장이 같은 것
    if (!list.length && venue && date) {
      const [stdate, eddate] = searchPeriod(date);
      const day = M.parseList(await kopis("/pblprfr", { service: key, stdate, eddate, cpage: "1", rows: "100" }));
      list = day.filter((p) => M.sameVenue(venue, p.venue));
    }
    const top = M.rankCandidates(list, title, date, { alts, venue }).slice(0, MAX_DETAILS);
    const details = await Promise.all(top.map((p) => detail(key, p.id).catch(() => null)));
    // 상세를 못 받은 공연은 목록 정보만이라도 쓴다
    return top.map((p, i) => details[i] || Object.assign({ prices: [], schedule: [], vendors: [] }, p));
  }

  return async function handler(req, res) {
    const q = new URL(req.url, "http://localhost").searchParams;
    const key = getKey();

    if (q.get("ping")) {
      const out = { ok: false, keyConfigured: !!key, kopisReachable: false };
      if (!key) {
        out.message = "KOPIS_API_KEY가 설정되지 않았어요. Vercel → Settings → Environment Variables에 넣고 다시 배포해주세요.";
        return send(res, 200, out);
      }
      try {
        const [s] = searchPeriod("");
        const list = M.parseList(await kopis("/pblprfr", { service: key, stdate: s, eddate: s, cpage: "1", rows: "5" }));
        out.ok = true;
        out.kopisReachable = true;
        out.todayCount = list.length;
        out.sample = list.slice(0, 3).map((p) => p.title);
        out.message = "KOPIS 연결 정상이에요.";
        // ?ping=1&range=1: 한 번에 조회할 수 있는 기간을 확인한다 (연도 검색 요청 수를 줄이기 위한 점검)
        if (q.get("range")) {
          const y = koreaToday().getFullYear();
          out.range = {};
          for (const [label, st, ed] of [["31일", `${y}0101`, `${y}0131`], ["92일", `${y}0101`, `${y}0402`], ["1년", `${y}0101`, `${y}1231`]]) {
            try {
              const list = M.parseList(await kopisOnce("/pblprfr", { service: key, stdate: st, eddate: ed, cpage: "1", rows: "100", shprfnm: "콘서트" }));
              out.range[label] = { ok: true, count: list.length };
            } catch (e) {
              out.range[label] = { ok: false, status: e.status || null, message: e.message };
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } catch (e) {
        out.message = "KOPIS 연결 실패: " + (e.name === "AbortError" ? "응답 시간 초과" : e.message);
      }
      return send(res, 200, out);
    }

    // 연도 + 아티스트 검색: 그해 공연 목록 (상세는 고를 때 ?id= 로)
    if (q.has("q")) {
      const pq = M.parseQuery((q.get("q") || "").slice(0, 80));
      const keywords = pq.groups.slice(0, 3);
      if (!keywords.length) return send(res, 400, { ok: false, error: "no_query", message: "아티스트나 공연 이름을 두 글자 이상 넣어주세요. 예: 2026 실리카겔" });
      if (!key) return send(res, 503, { ok: false, error: "no_key", message: "공식 정보 확인이 아직 설정되지 않았어요." });
      const year = pq.year || koreaToday().getFullYear();
      try {
        const list = await searchKeywords(key, keywords, year, false, true);
        list.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.title).localeCompare(String(b.title)));
        return send(res, 200, { ok: true, query: { year, keywords }, total: list.length, results: list.slice(0, MAX_RESULTS) }, true);
      } catch (e) {
        return send(res, 502, failure(e));
      }
    }
    if (q.has("id")) {
      const id = (q.get("id") || "").trim();
      if (!/^PF\d{3,12}$/.test(id)) return send(res, 400, { ok: false, error: "bad_id", message: "공연 ID가 올바르지 않아요." });
      if (!key) return send(res, 503, { ok: false, error: "no_key", message: "공식 정보 확인이 아직 설정되지 않았어요." });
      try {
        const d = await detail(key, id);
        if (!d) return send(res, 404, { ok: false, error: "not_found", message: "공연 정보를 찾지 못했어요." });
        return send(res, 200, { ok: true, detail: d }, true);
      } catch (e) {
        return send(res, 502, failure(e));
      }
    }

    const title = (q.get("title") || "").trim().slice(0, 80);
    const date = (q.get("date") || "").trim();
    const alts = (q.get("alt") || "").split(",").map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 3);
    const venue = (q.get("venue") || "").trim().slice(0, 60);
    if (title.length < 2) return send(res, 400, { ok: false, error: "no_title", message: "공연명을 두 글자 이상 넣어주세요." });
    if (!key) return send(res, 503, { ok: false, error: "no_key", message: "공식 정보 확인이 아직 설정되지 않았어요." });

    try {
      const candidates = await search(key, title, date, alts, venue);
      return send(res, 200, { ok: true, query: { title, date, alts, venue }, candidates }, true);
    } catch (e) {
      return send(res, 502, failure(e));
    }
  };
}
function failure(e) {
  const timeout = e && e.name === "AbortError";
  // status: KOPIS가 돌려준 HTTP 상태 (원인 확인용, 키는 들어가지 않는다)
  return { ok: false, error: timeout ? "timeout" : ((e && e.code) || "kopis_failed"), status: (e && e.status) || null,
    message: timeout ? "공연예술통합전산망 응답이 늦어요. 잠시 뒤 다시 시도해주세요." : "공연예술통합전산망에서 정보를 받지 못했어요." };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.searchPeriod = searchPeriod;
