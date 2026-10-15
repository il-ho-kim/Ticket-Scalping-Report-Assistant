// Vercel 서버 함수: 공연예술통합전산망(KOPIS) 오픈 API 중계.
// KOPIS 키는 웹페이지에 넣으면 누구나 볼 수 있고, KOPIS는 브라우저에서 바로 부를 수도 없어서(http, 교차 출처 차단)
// 이 함수가 대신 불러 정리된 JSON으로 돌려준다. 키는 Vercel 환경변수 KOPIS_API_KEY 에만 둔다.
//
//   GET /api/kopis?title=공연명&date=2026-11-22   → { ok, candidates:[공연 정보...] }
//   GET /api/kopis?ping=1                          → 키 설정·KOPIS 연결 점검 (키 값은 보여주지 않는다)
"use strict";

const M = require("../js/kopis-match.js");

const BASE = "http://www.kopis.or.kr/openApi/restful";
const MAX_DETAILS = 5;
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

  async function kopis(path, params) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await doFetch(url.toString(), { signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error("KOPIS 응답 " + r.status), { code: "kopis_http" });
      const err = M.parseError(text);
      if (err) throw Object.assign(new Error(err.message || "KOPIS 오류 " + err.code), { code: "kopis_error" });
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function search(key, title, date) {
    const [stdate, eddate] = searchPeriod(date);
    const base = { service: key, stdate, eddate, cpage: "1", rows: "20" };
    let list = M.parseList(await kopis("/pblprfr", { ...base, shprfnm: title }));
    if (!list.length) {
      const kw = fallbackKeyword(title);
      if (kw) list = M.parseList(await kopis("/pblprfr", { ...base, shprfnm: kw }));
    }
    const top = M.rankCandidates(list, title, date).slice(0, MAX_DETAILS);
    const details = await Promise.all(top.map((p) =>
      kopis("/pblprfr/" + encodeURIComponent(p.id), { service: key })
        .then(M.parseDetail)
        .catch(() => null)));
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
      } catch (e) {
        out.message = "KOPIS 연결 실패: " + (e.name === "AbortError" ? "응답 시간 초과" : e.message);
      }
      return send(res, 200, out);
    }

    const title = (q.get("title") || "").trim().slice(0, 80);
    const date = (q.get("date") || "").trim();
    if (title.length < 2) return send(res, 400, { ok: false, error: "no_title", message: "공연명을 두 글자 이상 넣어주세요." });
    if (!key) return send(res, 503, { ok: false, error: "no_key", message: "공식 정보 확인이 아직 설정되지 않았어요." });

    try {
      const candidates = await search(key, title, date);
      return send(res, 200, { ok: true, query: { title, date }, candidates }, true);
    } catch (e) {
      const timeout = e.name === "AbortError";
      return send(res, 502, { ok: false, error: timeout ? "timeout" : (e.code || "kopis_failed"),
        message: timeout ? "공연예술통합전산망 응답이 늦어요. 잠시 뒤 다시 시도해주세요." : "공연예술통합전산망에서 정보를 받지 못했어요." });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.searchPeriod = searchPeriod;
