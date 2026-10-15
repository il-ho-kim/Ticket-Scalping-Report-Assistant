// 공연예술통합전산망(KOPIS) 응답을 정리하고, 사용자가 입력한 값과 공식 정보를 비교하는 규칙.
// 서버 함수(api/kopis.js), 브라우저(index.html), 테스트가 함께 쓴다.
// 브라우저에서는 window.KopisMatch, Node에서는 module.exports.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KopisMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- XML (KOPIS 응답은 단순한 XML이라 태그 단위로 읽는다) ----------
  function decode(s){
    return String(s || "")
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, function(m, n){ return String.fromCharCode(Number(n)); })
      .replace(/&amp;/g, "&")
      .trim();
  }
  function xmlTag(xml, tag){
    var m = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">").exec(xml || "");
    return m ? decode(m[1]) : "";
  }
  function xmlBlocks(xml, tag){
    var re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "g"), out = [], m;
    while ((m = re.exec(xml || ""))) out.push(m[1]);
    return out;
  }

  // ---------- 가격·공연 시간 문구 ----------
  // "R석 154,000원, S석 132,000원" / "전석 50,000원" / "VIP석 170,000원 / R석 140,000원"
  function parsePrices(text){
    var out = [], re = /([^,\/\n\d]*?)\s*(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/g, m;
    while ((m = re.exec(String(text || "")))){
      var grade = m[1].replace(/^[\s,·\/]+|[\s:：]+$/g, "").trim() || "전석";
      var won = Number(m[2].replace(/,/g, ""));
      if (won >= 1000 && !out.some(function(p){ return p.grade === grade && p.won === won; })) out.push({ grade: grade, won: won });
    }
    return out;
  }
  var DAY_INDEX = { "일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6 };
  // "화요일 ~ 금요일(20:00), 토요일 ~ 일요일(14:00,18:00), HOL(15:00)" → [{days:[2,3,4,5], times:["20:00"]}, ...]
  // HOL(공휴일)처럼 요일로 풀 수 없는 묶음은 days: null 로 둔다.
  function parseTimes(text){
    var out = [], re = /([^()]+)\(([^)]*)\)/g, m;
    while ((m = re.exec(String(text || "")))){
      var dayPart = m[1].replace(/^[\s,]+/, "");
      var times = (m[2].match(/\d{1,2}:\d{2}/g) || []).map(function(t){ return t.length === 4 ? "0" + t : t; });
      if (!times.length) continue;
      var days = [];
      dayPart.split(",").forEach(function(seg){
        var names = seg.match(/[월화수목금토일](?=요일)/g) || [];
        if (/~/.test(seg) && names.length === 2){
          var a = DAY_INDEX[names[0]], b = DAY_INDEX[names[1]];
          for (var i = 0; i < 7; i++){ var d = (a + i) % 7; days.push(d); if (d === b) break; }
        } else names.forEach(function(n){ days.push(DAY_INDEX[n]); });
      });
      out.push({ days: days.length ? days : null, times: times });
    }
    return out;
  }
  function weekday(dateStr){
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() : null;
  }
  // 그 날짜(YYYY-MM-DD)의 요일에 해당하는 공식 공연 시각들
  function timesOn(schedule, dateStr){
    var wd = weekday(dateStr), out = [];
    if (wd == null) return out;
    (schedule || []).forEach(function(s){
      if (s.days && s.days.indexOf(wd) !== -1) s.times.forEach(function(t){ if (out.indexOf(t) === -1) out.push(t); });
    });
    return out.sort();
  }
  function kopisDate(s){   // "2026.11.22" → "2026-11-22"
    var m = /(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(s || "");
    return m ? m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0") : "";
  }
  function inPeriod(dateStr, perf){
    var d = (dateStr || "").slice(0, 10);
    return !!d && !!perf.from && !!perf.to && d >= perf.from && d <= perf.to;
  }
  // 기간이 짧으면(일주일 이하) 날짜별 공연 시각 목록을 만든다: ["2026-11-21T18:00", ...]
  function sessions(perf){
    if (!perf.from || !perf.to) return [];
    var out = [], d = new Date(perf.from + "T00:00"), end = new Date(perf.to + "T00:00");
    if ((end - d) / 86400000 > 6) return [];
    for (; d <= end; d.setDate(d.getDate() + 1)){
      var ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      timesOn(perf.schedule, ds).forEach(function(t){ out.push(ds + "T" + t); });
    }
    return out;
  }

  // ---------- KOPIS 응답 → 정리된 공연 정보 ----------
  function parseList(xml){
    return xmlBlocks(xml, "db").map(function(b){
      return { id: xmlTag(b, "mt20id"), title: xmlTag(b, "prfnm"), from: kopisDate(xmlTag(b, "prfpdfrom")),
               to: kopisDate(xmlTag(b, "prfpdto")), venue: xmlTag(b, "fcltynm"), genre: xmlTag(b, "genrenm") };
    }).filter(function(p){ return p.id; });
  }
  function parseDetail(xml){
    var b = xmlBlocks(xml, "db")[0];
    if (!b) return null;
    var id = xmlTag(b, "mt20id");
    if (!id) return null;
    var priceText = xmlTag(b, "pcseguidance"), timeText = xmlTag(b, "dtguidance");
    return {
      id: id,
      title: xmlTag(b, "prfnm"),
      from: kopisDate(xmlTag(b, "prfpdfrom")),
      to: kopisDate(xmlTag(b, "prfpdto")),
      venue: xmlTag(b, "fcltynm"),
      genre: xmlTag(b, "genrenm"),
      state: xmlTag(b, "prfstate"),
      poster: xmlTag(b, "poster"),
      priceText: priceText,
      prices: parsePrices(priceText),
      timeText: timeText,
      schedule: parseTimes(timeText),
      vendors: xmlBlocks(b, "relate").map(function(r){ return { name: xmlTag(r, "relatenm"), url: xmlTag(r, "relateurl") }; })
                 .filter(function(v){ return v.name; })
    };
  }
  // KOPIS가 오류를 돌려줄 때(잘못된 키 등) 메시지를 꺼낸다
  function parseError(xml){
    var code = xmlTag(xml, "returncode"), msg = xmlTag(xml, "errmsg") || xmlTag(xml, "returnmsg");
    return (code && code !== "00") || msg ? { code: code, message: msg } : null;
  }

  // ---------- 비교 ----------
  function norm(s){
    return String(s || "").toLowerCase().normalize("NFKC")
      .replace(/[\s'"‘’“”`\[\]()<>〈〉《》「」『』\-–—_:·.,!?~]/g, "");
  }
  function bigrams(s){ var o = []; for (var i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; }
  // 0~1. 같으면 1, 한쪽이 다른 쪽을 포함하면 0.9, 아니면 글자쌍 겹침 비율
  function nameScore(a, b){
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.9;
    var x = bigrams(a), y = bigrams(b), hit = 0, used = {};
    x.forEach(function(g){ for (var i = 0; i < y.length; i++){ if (!used[i] && y[i] === g){ used[i] = true; hit++; break; } } });
    return x.length + y.length ? (2 * hit) / (x.length + y.length) : 0;
  }
  // 후보 정렬: 이름이 비슷한 순 → 공연일이 기간 안에 드는 것 우선
  function rankCandidates(list, title, dateStr){
    return list.map(function(p){
      var s = nameScore(title, p.title) + (dateStr && inPeriod(dateStr, p) ? 0.5 : 0);
      return { perf: p, score: s };
    }).sort(function(a, b){ return b.score - a.score; }).map(function(x){ return x.perf; });
  }
  // KOPIS 공연장 이름은 "세종문화회관 (세종문화회관 대극장)"처럼 시설명 (공연장명)으로 오기도 한다 → 한 이름으로 줄인다
  function venueName(v){
    v = String(v || "").trim();
    var m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(v);
    if (!m) return v;
    var outer = m[1].trim(), inner = m[2].trim();
    if (!outer) return inner;
    if (norm(inner).indexOf(norm(outer)) !== -1) return inner;
    if (norm(outer).indexOf(norm(inner)) !== -1) return outer;
    return outer + " " + inner;
  }
  function sameVenue(input, official){
    var a = norm(input), b = norm(official);
    return !!a && !!b && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
  }
  // 좌석 문구에서 등급을 꺼낸다: "2층 R석 B블록" → "R", "VIP석" → "VIP", "스탠딩 R구역" → "스탠딩"
  function seatGrade(seat){
    var s = String(seat || "");
    var m = /(VVIP|VIP|SR|OP|[RSAB]|프리미엄|스탠딩|지정|일반|플로어)\s*석/i.exec(s);
    if (m) return m[1].toUpperCase();
    if (/스탠딩/.test(s)) return "스탠딩";
    if (/플로어/.test(s)) return "플로어";
    return null;
  }
  function priceForGrade(prices, grade){
    if (!grade) return null;
    var g = norm(grade).replace(/석$/, "");
    for (var i = 0; i < prices.length; i++){
      if (norm(prices[i].grade).replace(/석$/, "") === g) return prices[i];
    }
    for (var j = 0; j < prices.length; j++){
      if (norm(prices[j].grade).indexOf(g.toLowerCase()) !== -1) return prices[j];
    }
    return null;
  }
  // KOPIS 예매처 이름 → 앱의 예매처 칩
  var VENDOR_RULES = [
    ["NOL티켓", /NOL|인터파크|interpark/i],
    ["YES24", /yes\s*24|예스\s*24/i],
    ["티켓링크", /티켓링크|ticketlink/i],
    ["멜론티켓", /멜론|melon/i],
    ["쿠팡플레이", /쿠팡|coupang/i]
  ];
  function appVendor(name){
    for (var i = 0; i < VENDOR_RULES.length; i++) if (VENDOR_RULES[i][1].test(name || "")) return VENDOR_RULES[i][0];
    return null;
  }
  function officialVendors(perf){
    var out = [];
    (perf.vendors || []).forEach(function(v){ var a = appVendor(v.name); if (a && out.indexOf(a) === -1) out.push(a); });
    return out;
  }

  // 입력값과 공식 정보를 항목별로 비교한다.
  // input: {title, venue, showDate("YYYY-MM-DDTHH:mm"), officialPrice(숫자 문자열), seat, vendor}
  // 결과 항목: {key, label, input, same, suggest, options:[{label, value}], note}
  //   suggest: [바꾸기]로 넣을 값 (없으면 버튼 없음), options: 골라서 넣을 수 있는 값들
  function compare(input, perf){
    var rows = [];
    var title = input.title || "";
    rows.push({ key: "title", label: "공연명", input: title, official: perf.title,
                same: norm(title) === norm(perf.title), suggest: perf.title });

    var venue = venueName(perf.venue);
    rows.push({ key: "venue", label: "공연 장소", input: input.venue || "", official: venue,
                same: sameVenue(input.venue, venue), suggest: venue });

    // 공연 일시
    var date = (input.showDate || "").slice(0, 10), time = (input.showDate || "").slice(11, 16);
    var dateRow = { key: "showDate", label: "공연 일시", input: input.showDate || "",
                    official: perf.from === perf.to ? perf.from : perf.from + " ~ " + perf.to,
                    same: false, options: [] };
    if (date && inPeriod(date, perf)){
      var ts = timesOn(perf.schedule, date);
      if (!ts.length || ts.indexOf(time) !== -1){ dateRow.same = true; }
      else {
        dateRow.note = "이 날 공식 공연 시각: " + ts.join(", ");
        dateRow.options = ts.map(function(t){ return { label: t, value: date + "T" + t }; });
        if (ts.length === 1) dateRow.suggest = date + "T" + ts[0];
      }
    } else {
      dateRow.note = date ? "입력한 날짜가 공식 공연 기간 밖이에요" : "공식 공연 기간이에요";
      dateRow.options = sessions(perf).map(function(s){ return { label: s.slice(5, 10).replace("-", "/") + " " + s.slice(11), value: s }; });
      if (dateRow.options.length === 1) dateRow.suggest = dateRow.options[0].value;
    }
    rows.push(dateRow);

    // 정가
    var price = Number(String(input.officialPrice || "").replace(/[^0-9]/g, "")) || 0;
    var prices = perf.prices || [];
    var priceRow = { key: "officialPrice", label: "정가", input: price ? String(price) : "",
                     official: perf.priceText || "", same: false,
                     options: prices.map(function(p){ return { label: p.grade + " " + p.won.toLocaleString("ko-KR") + "원", value: String(p.won) }; }) };
    var graded = priceForGrade(prices, seatGrade(input.seat));
    if (graded){
      priceRow.same = price === graded.won;
      priceRow.suggest = String(graded.won);
      priceRow.note = "입력한 좌석(" + graded.grade + ") 기준";
    } else if (prices.length){
      priceRow.same = prices.some(function(p){ return p.won === price; });
      if (prices.length === 1) priceRow.suggest = String(prices[0].won);
      else if (!priceRow.same) priceRow.note = "좌석 등급을 골라주세요";
    } else {
      priceRow.same = true;   // 공식 가격 정보가 없으면 비교하지 않는다
      priceRow.note = "공식 가격 정보가 없어요";
    }
    rows.push(priceRow);

    // 예매처
    var vendors = officialVendors(perf);
    if (vendors.length){
      rows.push({ key: "vendor", label: "예매처", input: input.vendor || "", official: vendors.join(", "),
                  same: !!input.vendor && vendors.indexOf(input.vendor) !== -1,
                  suggest: vendors.length === 1 ? vendors[0] : undefined,
                  options: vendors.map(function(v){ return { label: v, value: v }; }) });
    }
    return rows;
  }

  return {
    xmlTag: xmlTag, xmlBlocks: xmlBlocks, parseList: parseList, parseDetail: parseDetail, parseError: parseError,
    parsePrices: parsePrices, parseTimes: parseTimes, timesOn: timesOn, sessions: sessions, inPeriod: inPeriod,
    nameScore: nameScore, rankCandidates: rankCandidates, seatGrade: seatGrade, priceForGrade: priceForGrade,
    appVendor: appVendor, venueName: venueName, compare: compare
  };
});
