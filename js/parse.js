// 게시글·캡처 텍스트에서 신고에 필요한 값을 찾는 내장 파서.
// 붙여넣은 글과 OCR로 읽은 캡처 글자 모두 이 파서를 거친다.
// 브라우저에서는 window.TicketParse, Node 테스트에서는 module.exports 로 쓴다.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TicketParse = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VENUE_SUFFIX = "아레나|체육관|경기장|스타디움|돔|아트홀|콘서트홀|아트센터|문화회관|예술의전당|월드컵경기장|오디토리움|컨벤션홀|씨어터|시어터|홀|극장|센터";
  var VENUE_STOPWORDS = ["장소", "공연장", "공연장소", "공연", "콘서트", "뮤지컬", "막콘", "첫콘", "양도", "판매", "서울", "부산", "대구", "인천", "광주", "대전"];
  // 앞의 것이 먼저 맞으면 그것으로 정한다. 앱 화면에만 나오는 문구(번개톡, 매너온도 등)도 단서로 쓴다.
  var PLATFORM_HINTS = [
    ["중고나라", /중고나라|joonggonara/i],
    ["번개장터", /번개장터|번장|bunjang|번개톡|번개페이/i],
    ["당근마켓", /당근마켓|당근|매너온도|daangn/i],
    ["티켓베이", /티켓베이|ticketbay/i],
    ["SNS", /트위터|twitter|엑스\(x\)|인스타|instagram|디엠|\bDM\b|카톡|오픈채팅|리포스트|재게시|마음에 들어요|조회수/i]
  ];
  var VENDOR_HINTS = [
    ["NOL티켓", /NOL\s*티켓|인터파크|interpark/i],
    ["YES24", /yes\s*24|예스\s*24/i],
    ["티켓링크", /티켓링크|ticketlink/i],
    ["멜론티켓", /멜론\s*티켓|melon\s*ticket/i],
    ["쿠팡플레이", /쿠팡\s*플레이|coupang\s*play/i],
    // 영문 뒤에 붙은 한글은 글자 인식이 자주 깨진다("NOL티켓" → "NOLE|Z!"). 대문자 NOL만 남아도 NOL티켓으로 본다.
    ["NOL티켓", /(^|[^A-Z])NOL/]
  ];
  var KNOWN_NAMES = ["중고나라","번개장터","당근마켓","당근","티켓베이","SNS","NOL티켓","YES24","티켓링크","멜론티켓","쿠팡플레이","인터파크","티켓","양도","판매"];

  // 가격 라벨. 앞쪽 라벨일수록 우선한다.
  var OFFICIAL_LABELS = /정가|원가|공식\s*판매가|티켓\s*금액|티켓값|티켓\s*가격/;
  var SALE_LABELS = /판매\s*가격|판매가|양도가|희망가|거래가|장당|가격/;
  // 이 라벨이 바로 앞에 붙은 금액은 판매가 후보에서 뺀다 (예매내역의 수수료·결제금액 등).
  var NOT_SALE_LABEL = /수수|결제\s*금액|티켓\s*금액|배송비|할인|포인트|쿠폰|정가|원가|공식\s*판매가/;

  var SHOW_DATE_LABELS = /공연\s*일시|공연\s*일자|공연\s*날짜|공연일|관람\s*일시|관람일|경기\s*일시|경기일|일시|날짜/;
  var POST_DATE_LABELS = /작성\s*일시|작성일|게시\s*일시|게시일|등록\s*일시|등록일|작성|게시|등록/;

  function pad2(x){ return String(x).padStart(2, "0"); }
  function fmtLocal(d){
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // ---------- OCR 글자 정리 ----------
  // Tesseract가 자주 틀리는 모양을 고친다. 붙여넣은 글에 써도 해가 없게, 확실한 경우만 고친다.
  function normalizeOcrText(text){
    var t = String(text || "");
    t = t.replace(/[ㆍᆞ•∙‧]/g, "·");                   // 가운뎃점 변형들 (NFKC가 ㆍ를 ᆞ로 바꾸므로 먼저 처리)
    if (t.normalize) t = t.normalize("NFKC");          // 전각 문자(Ｌ, ：) → 반각
    t = t
         .replace(/[‘’`´]/g, "'")
         .replace(/[“”]/g, "\"")
         .replace(/ /g, " ")
         .replace(/₩\s*/g, "");
    // 한 글자씩 띄어 읽힌 한글 (예: "아 이 유 콘 서 트" → "아이유콘서트"). 세 글자 이상 이어질 때만.
    t = t.replace(/(^|[^가-힣])((?:[가-힣] ){2,}[가-힣])(?![가-힣])/g, function(m, lead, run){
      return lead + run.replace(/ /g, "");
    });
    // 숫자 사이에 끼어든 O/o/l/I/| → 0/1  (예: "15O,OOO원" → "150,000원")
    t = t.replace(/[0-9OoIl|][0-9OoIl|,\.]*[0-9OoIl|](?=\s*(?:원|만))/g, function(tok){
      if ((tok.match(/[0-9]/g) || []).length < 2) return tok;
      return tok.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
    });
    // "&구역", "^구역" → "A구역" (A가 기호로 읽히는 경우)
    t = t.replace(/[&^](?=\s*(?:구역|블록|열))/g, "A");
    // 콜론이 0으로 읽힌 시각: "오전 11002 ·" → "오전 11:02 ·"
    t = t.replace(/(오전|오후)\s*(\d{1,2})[0Oo;.,](\d{2})(?=\s*·)/g, "$1 $2:$3");
    return t;
  }

  // ---------- 금액 ----------
  function wonToNumber(raw){
    var s = String(raw).replace(/\s/g, "");
    var man = /만원?$/.test(s);
    s = s.replace(/만원?$/, "").replace(/원$/, "");
    s = man ? s.replace(/,/g, "") : s.replace(/[,\.]/g, "");   // "150.000원" 처럼 쉼표가 마침표로 읽혀도 정수로 본다
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var v = parseFloat(s);
    if (man) v = v * 10000;
    if (!isFinite(v) || v < 1000) return null;   // 1,000원 미만은 좌석번호·수량 등 오인일 가능성이 높다
    return Math.round(v);
  }
  var AMOUNT_RE = /(\d[\d,\.]*)\s*(만\s*원?|원)?/g;
  // 라벨 뒤 같은 줄에서 처음 나오는 1,000원 이상 금액
  function firstAmount(s){
    AMOUNT_RE.lastIndex = 0;
    var m;
    while ((m = AMOUNT_RE.exec(s))){
      var v = wonToNumber(m[1] + (m[2] || ""));
      if (v) return v;
    }
    return null;
  }
  function labelledWon(t, labelRe){
    var re = new RegExp(labelRe.source, "g"), m;
    while ((m = re.exec(t))){
      var before = t.slice(Math.max(0, m.index - 4), m.index);
      // "공식 판매가"·"티켓정가"의 일부가 판매가 라벨로 오인되지 않게
      if (labelRe === SALE_LABELS && /공식\s*$|정가\s*$|\(\s*$/.test(before)) continue;
      var rest = t.slice(m.index + m[0].length).split("\n")[0].replace(/^[\s:：]+/, "").slice(0, 30);
      var v = firstAmount(rest);
      if (v) return v;
    }
    return null;
  }
  // 라벨 없는 "원"/"만원" 금액 (조회수 "1.2만" 같은 것은 뺀다).
  // 중고거래 앱의 큰 가격 표시처럼 한 줄에 "250,000"만 있는 경우도 금액으로 본다 ("원"은 글자 인식에서 자주 빠진다).
  // skipLabel: 금액 바로 앞에 이 라벨이 있으면 뺀다
  function looseAmounts(t, skipLabel){
    var out = [];
    t.split("\n").forEach(function(line){
      var lone = /^\s*(\d{1,3}(?:[,.]\d{3})+)\s*원?\s*$/.exec(line);
      if (lone){ var lv = wonToNumber(lone[1]); if (lv) out.push(lv); return; }
      var re = /(\d[\d,\.]*)\s*(만\s*원?|원)(?!\s*(?:조회|명|회|뷰|팔로|views))/g, m;
      while ((m = re.exec(line))){
        if (skipLabel && skipLabel.test(line.slice(0, m.index).replace(/\s+$/, "").slice(-10))) continue;
        var v = wonToNumber(m[1] + m[2]); if (v) out.push(v);
      }
    });
    return out.filter(function(v, i, a){ return a.indexOf(v) === i; }).sort(function(a, b){ return a - b; });
  }

  // ---------- 날짜 ----------
  function hourFrom(ampm, hh){
    hh = Number(hh);
    if ((ampm === "오후" || ampm === "저녁" || ampm === "밤") && hh < 12) hh += 12;
    if (ampm === "낮" && hh < 7) hh += 12;
    if (ampm === "오전" && hh === 12) hh = 0;
    return hh;
  }
  // 요일 괄호는 글자 인식이 자주 틀리므로 "(E)"처럼 아무 1~2글자나 받는다
  var TIME_AFTER = /^\s*\.?\s*(?:\(\s*[^)\n\d]{1,2}\s*\)|[월화수목금토일](?:요일)?)?\s*(오전|오후|낮|저녁|밤)?\s*(\d{1,2})\s*(?::|시)\s*(\d{2})?/;
  // X 게시 시각 "오후 3:24 · 2026년 10월 8일". 오전/오후가 깨져 읽혀도("RF 3:24 -2026H") 시각은 쓴다.
  var TIME_BEFORE = /(오전|오후|[A-Za-z가-힣]{1,3})?\s*(\d{1,2}):(\d{2})\s*[·\-]?\s*(?:20\d{2}\S?\s*)?$/;

  // 텍스트의 모든 날짜를 찾아 {value, kind: "show"|"post"|null, past} 목록으로 돌려준다.
  function findDates(t, now){
    var out = [];
    var masked = t;
    function lineAt(idx){
      var s = t.lastIndexOf("\n", idx - 1) + 1, e = t.indexOf("\n", idx);
      return { start: s, text: t.slice(s, e === -1 ? t.length : e) };
    }
    function add(m, y, mo, d, explicitYear){
      mo = Number(mo); d = Number(d);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return;
      var end = m.index + m[0].length;
      var line = lineAt(m.index);
      var after = t.slice(end, end + 20).split("\n")[0];
      var before = t.slice(line.start, m.index);
      var hh = 0, mm = 0, hasTime = false;
      var ta = TIME_AFTER.exec(after);
      if (ta){ hh = hourFrom(ta[1], ta[2]); mm = ta[3] != null ? Number(ta[3]) : 0; hasTime = true; }
      else {
        var tb = TIME_BEFORE.exec(before);
        if (tb){
          hh = hourFrom(tb[1], tb[2]); mm = Number(tb[3]); hasTime = true;
          // 오전/오후를 못 읽었으면, 캡처 시각보다 늦지 않은 쪽 중 가까운 시각으로 본다 (게시 시각은 캡처 전이다)
          if (tb[1] !== "오전" && tb[1] !== "오후" && hh < 12){
            var pm = new Date(Number(y || now.getFullYear()), mo - 1, d, hh + 12, mm);
            if (pm <= now) hh += 12;
          }
        }
      }
      if (hh > 23 || mm > 59){ hh = 0; mm = 0; hasTime = false; }
      var year = Number(y || now.getFullYear());
      var date = new Date(year, mo - 1, d, hh, mm);
      var kind = null;
      if (POST_DATE_LABELS.test(before.slice(-12))) kind = "post";
      else if (SHOW_DATE_LABELS.test(before.slice(-12))) kind = "show";
      else if (/(오전|오후)\s*\d{1,2}:\d{2}/.test(before) || /조회/.test(line.text)) kind = "post";   // X 게시 시각 줄, "작성자 · 날짜 · 조회 56" 줄
      // 연도 없는 날짜: 공연일은 앞으로의 날짜, 게시일은 지난 날짜로 맞춘다.
      if (!explicitYear){
        if (kind === "post" && date > now) date.setFullYear(year - 1);
        else if (kind !== "post" && date < new Date(now.getTime() - 86400000)) date.setFullYear(year + 1);
      }
      out.push({ value: fmtLocal(date), kind: kind, past: date <= now, hasTime: hasTime, index: m.index });
      masked = masked.slice(0, m.index) + m[0].replace(/[^\n]/g, " ") + masked.slice(end);
    }
    var m, re;
    re = /(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})\s*일?/g;
    while ((m = re.exec(t))) add(m, m[1], m[2], m[3], true);
    re = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    while ((m = re.exec(masked))) add(m, null, m[1], m[2], false);
    re = /(^|[^\d\/.,:])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d\/])/g;
    while ((m = re.exec(masked))){
      var shifted = { index: m.index + m[1].length, 0: m[0].slice(m[1].length) };
      add(shifted, null, m[2], m[3], false);
    }
    out.sort(function(a, b){ return a.index - b.index; });
    return out;
  }
  // "3시간 전", "2일 전", "방금 전" → 캡처 시각 기준 게시일시
  function findRelativePost(t, now){
    if (/방금\s*전?/.test(t)) return fmtLocal(now);
    var m = /(\d{1,3})\s*(초|분|시간|일|주|개월|달)\s*전/.exec(t);
    if (!m) return null;
    var n = Number(m[1]), d = new Date(now.getTime());
    if (m[2] === "초") d = new Date(now.getTime() - n * 1000);
    else if (m[2] === "분") d = new Date(now.getTime() - n * 60000);
    else if (m[2] === "시간") d = new Date(now.getTime() - n * 3600000);
    else if (m[2] === "일") d.setDate(d.getDate() - n);
    else if (m[2] === "주") d.setDate(d.getDate() - n * 7);
    else d.setMonth(d.getMonth() - n);
    return fmtLocal(d);
  }

  // ---------- 장소 ----------
  function labelledRest(t, labelRe, maxLen){
    var re = new RegExp("(?:^|\\n|\\s)(?:" + labelRe.source + ")\\s*[:：]?\\s*([^\\n]+)"), m = re.exec(t);
    if (!m) return null;
    var v = m[1].trim().slice(0, maxLen || 40);
    return v.length >= 2 ? v : null;
  }
  // 장소: 접미사(아레나·체육관·돔 등)를 찾은 뒤 왼쪽으로 한글/영문만 이어붙인다.
  // 숫자·시각·조사에서 끊기므로 "8시 고척스카이돔" 같은 오염이 생기지 않는다.
  function findVenue(text){
    var labelled = labelledRest(text, /공연\s*장소|공연장|장소|경기장소/, 30);
    if (labelled){
      labelled = labelled.replace(/\s*(?:에서|입니다|이에요|예요).*$/, "").trim();
      if (labelled.length >= 2) return labelled;
    }
    var re = new RegExp("(?:" + VENUE_SUFFIX + ")");
    var t = String(text), guard = 0;
    while (guard++ < 40){
      var m = re.exec(t);
      if (!m) return null;
      var end = m.index + m[0].length;
      var i = m.index;
      while (i > 0 && /[가-힣A-Za-z]/.test(t.charAt(i - 1))) i--;
      var core = t.slice(i, end).trim();
      if (core.length >= 2){
        // 바로 앞 단어가 장소 이름의 일부일 수 있다 (예: "벡스코 오디토리움", "블루스퀘어 마스터카드홀")
        var mb = /(?:^|[\s(])([가-힣A-Za-z]{2,10})[ \t]$/.exec(t.slice(Math.max(0, i - 16), i));
        if (mb && VENUE_STOPWORDS.indexOf(mb[1]) === -1) core = mb[1] + " " + core;
        if (core.replace(/\s/g, "").length >= 3) return core;
      }
      t = t.slice(end);
    }
    return null;
  }

  // ---------- 좌석 ----------
  function findSeat(t){
    var labelled = labelledRest(t, /좌석\s*번호|좌석\s*정보|좌석/, 30);
    if (labelled && /\d|구역|블록|열|석/.test(labelled)) return labelled.replace(/\s+/g, " ").trim();
    var core = /[A-Za-z0-9가-힣]{1,4}\s*(?:구역|블록)(?:\s*\d{1,3}\s*열)?(?:\s*\d{1,4}\s*번대?)?/.exec(t)
            || /\d{1,3}\s*열\s*\d{1,3}\s*번/.exec(t);
    if (!core) return null;
    var start = core.index, seat = core[0];
    // 왼쪽으로 "플로어", "스탠딩", "2층", "R석" 같은 단어를 최대 두 개까지 붙인다
    for (var k = 0; k < 2; k++){
      var mb = /(플로어|스탠딩|\d{1,2}\s*층|[A-Za-z가-힣]{1,4}석)\s+$/.exec(t.slice(Math.max(0, start - 12), start));
      if (!mb || /^좌석$/.test(mb[1])) break;
      seat = mb[1] + " " + seat;
      start -= mb[0].length;
    }
    return seat.replace(/\s+/g, " ").trim();
  }

  // ---------- 공연명 ----------
  function isKnownName(c){
    var s = String(c).replace(/\s/g, "");
    return KNOWN_NAMES.indexOf(s) !== -1;
  }
  function tidyTitle(line){
    return line
      .replace(/^\s*[\[\(【][^\]\)】\n]{1,14}[\]\)】]\s*/, "")   // 앞머리 말머리표 [중고나라] 등
      .replace(/^[\s\-·•#]+/, "")
      .replace(/\s*(?:양도합니다|판매합니다|양도해요|판매해요|양도|판매|팝니다|팔아요|구합니다|구해요)\s*[.!~]*\s*$/, "")
      .trim()
      .slice(0, 60);
  }
  function findTitle(text){
    var labelled = labelledRest(text, /공연\s*명|공연\s*제목|경기\s*명/, 60);
    if (labelled) return tidyTitle(labelled);
    var re = /['"『「\[<〈《]([^'"』」\]>〉》\n]{2,40})['"』」\]>〉》]/g, m;
    while ((m = re.exec(text))){
      var c = m[1].trim();
      if (isKnownName(c) || /^\d+$/.test(c)) continue;
      if (c.length >= 2) return c.slice(0, 60);
    }
    var lines = String(text).split(/\n+/);
    for (var i = 0; i < lines.length; i++){
      var line = lines[i];
      if (!/콘서트|투어|페스티벌|뮤지컬|내한|팬미팅|리사이틀|오페라|단독공연|공연/.test(line)) continue;
      if (/^\s*(?:공연\s*장소|공연장|장소|좌석|공연\s*일시|공연일)/.test(line)) continue;   // 라벨 줄은 제목이 아니다
      if (/\d{1,2}\s*[:시]/.test(line) || /20\d{2}\s*[.\-\/년]/.test(line) || /\d{1,2}\s*\/\s*\d{1,2}/.test(line)) continue;   // 날짜·시각 줄은 제목이 아니다
      var t2 = tidyTitle(line);
      if (t2.length >= 2) return t2;
    }
    return null;
  }

  // ---------- 전체 ----------
  // opts.now: 캡처 시각(Date). "3시간 전" 같은 상대 시각과 연도 없는 날짜를 이 시각 기준으로 푼다.
  function localParse(text, opts){
    var out = {};
    if (!text) return out;
    var now = (opts && opts.now instanceof Date && !isNaN(opts.now)) ? opts.now : new Date();
    var t = normalizeOcrText(text);

    var mUrl = t.match(/https?:\/\/[^\s"'<>()]+/);
    if (mUrl) out.url = mUrl[0];

    // @아이디 (메일 주소 a@b.com 은 뺀다)
    var mAt = /(^|[^A-Za-z0-9._%+\-])(@[A-Za-z0-9_.\-]{2,30})/.exec(t);
    if (mAt && !/\.[a-z]{2,}$/i.test(mAt[2])) out.sellerHandle = mAt[2];

    out.officialPrice = labelledWon(t, OFFICIAL_LABELS);
    out.price = labelledWon(t, SALE_LABELS);
    if (out.price == null){
      // 웃돈 거래를 신고하는 것이므로 정가를 알면 정가보다 비싼 금액만 판매가 후보로 본다 (수수료 등 제외)
      var rest = looseAmounts(t, NOT_SALE_LABEL).filter(function(v){ return out.officialPrice == null || v > out.officialPrice; });
      if (rest.length) out.price = rest[rest.length - 1];
    }
    if (out.officialPrice == null){
      // 라벨이 없을 때만: 웃돈 거래는 보통 '정가 < 판매가'라서 가장 작은 금액을 정가로 본다.
      var all = looseAmounts(t);
      if (all.length >= 2 && all[0] !== out.price) out.officialPrice = all[0];
    }
    if (out.price == null) delete out.price;
    if (out.officialPrice == null) delete out.officialPrice;

    var dates = findDates(t, now);
    var show = dates.filter(function(d){ return d.kind === "show"; })[0]
            || dates.filter(function(d){ return d.kind === null && !d.past; })[0];
    if (show) out.showDate = show.value;
    var post = dates.filter(function(d){ return d.kind === "post"; })[0]
            || dates.filter(function(d){ return d.kind === null && d.past && d.hasTime; })[0];
    if (post) out.postDate = post.value;
    else {
      var rel = findRelativePost(t, now);
      if (rel) out.postDate = rel;
    }

    var venue = findVenue(t);
    if (venue) out.venue = venue;

    var seat = findSeat(t);
    if (seat) out.seat = seat;

    var title = findTitle(t);
    if (title) out.title = title;

    for (var a = 0; a < PLATFORM_HINTS.length; a++){ if (PLATFORM_HINTS[a][1].test(t)){ out.platform = PLATFORM_HINTS[a][0]; break; } }
    for (var b = 0; b < VENDOR_HINTS.length; b++){ if (VENDOR_HINTS[b][1].test(t)){ out.vendor = VENDOR_HINTS[b][0]; break; } }

    return out;
  }

  return {
    localParse: localParse,
    normalizeOcrText: normalizeOcrText,
    wonToNumber: wonToNumber,
    findDates: findDates
  };
});
