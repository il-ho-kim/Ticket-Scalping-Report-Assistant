// 캡처에서 읽은 값과 판매글(티켓베이 등) 정보를 대조하는 규칙.
// 판정은 두 가지뿐: 같은 글 / 다른 글. 서버 함수(api/listing.js), 화면(index.html), 테스트가 같이 쓴다.
// 브라우저에서는 window.ListingMatch, Node에서는 module.exports.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ListingMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function digits(v){ var s = String(v == null ? "" : v).replace(/[^0-9]/g, ""); return s ? Number(s) : null; }
  function won(n){ return n == null ? "" : Number(n).toLocaleString("ko-KR") + "원"; }
  function day(v){ var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? m[0] : ""; }
  function md(v){ var d = day(v); return d ? Number(d.slice(5, 7)) + "/" + Number(d.slice(8, 10)) : ""; }
  function norm(s){ return String(s || "").toUpperCase().replace(/\s+/g, ""); }

  // 좌석 문구 → {floor, grade, area, row, num}
  // "2층 (2F) S석 23구역 11열 7번", "플로어 A구역 12열 7번", "23구역(존/블럭) 11ROW"
  function parseSeat(text){
    var s = String(text || "");
    var out = {};
    var f = /(\d{1,2})\s*층/.exec(s) || /(\d)\s*F\b/i.exec(s);
    if (f) out.floor = f[1];
    else if (/플로어|floor/i.test(s)) out.floor = "플로어";
    var g = /(VVIP|VIP|SR|OP|[RSAB])\s*석/i.exec(s);
    if (g) out.grade = g[1].toUpperCase();
    var a = /([A-Za-z]{1,4}\d{0,2}|\d{1,3})\s*(?:구역|블록|블럭|존|zone)/i.exec(s);   // "ONE구역"처럼 영문 구역명도 있다
    if (a) out.area = norm(a[1]);
    var r = /(\d{1,3})\s*(?:열|ROW|row)/.exec(s);
    if (r) out.row = String(Number(r[1]));
    var n = /(\d{1,3})\s*번(?!대)/.exec(s);
    if (n) out.num = String(Number(n[1]));
    return out;
  }
  function seatText(seat){
    var p = [];
    if (seat.floor) p.push(seat.floor === "플로어" ? "플로어" : seat.floor + "층");
    if (seat.grade) p.push(seat.grade + "석");
    if (seat.area) p.push(seat.area + "구역");
    if (seat.row) p.push(seat.row + "열");
    if (seat.num) p.push(seat.num + "번");
    return p.join(" ");
  }

  // capture: {listingNumber, price, showDate("YYYY-MM-DDTHH:mm"), seat(문구), title, postDate}
  // listing: {id, url, title, performDate, price, totalPrice, seat:{floor,grade,area,row,num}, seatText, createdAt}
  // 결과: {same, checks:[{key,label,capture,listing,ok,decisive}], reasons:[문장]}
  //   decisive(판정에 쓰는 항목): 상품번호(보이면 그것만으로 결정), 판매가, 공연일, 좌석
  //   참고 항목(판정에 안 씀): 공연명, 게시 시각 — 글자 인식 오차로 판정이 흔들리지 않게
  function compare(capture, listing, opts){
    var checks = [], reasons = [];
    var nameScore = opts && opts.nameScore;

    // 상품번호가 캡처에 보이면 그것만으로 결정한다
    var cn = String(capture.listingNumber || "").replace(/\D/g, "");
    if (cn){
      var okId = cn === String(listing.id);
      checks.push({ key: "id", label: "상품번호", capture: cn, listing: String(listing.id), ok: okId, decisive: true });
      if (!okId) reasons.push("상품번호가 달라요: 캡처 " + cn + " / 글 " + listing.id);
      return finish();
    }

    // 판매가: 장당 가격 또는 총액 중 하나와 같으면 맞음
    var cp = digits(capture.price);
    if (cp == null) reasons.push("캡처에서 판매가를 확인할 수 없어요");
    else {
      var okP = cp === listing.price || (listing.totalPrice != null && cp === listing.totalPrice);
      checks.push({ key: "price", label: "판매가", capture: won(cp), listing: won(listing.price), ok: okP, decisive: true });
      if (!okP) reasons.push("판매가가 달라요: 캡처 " + won(cp) + " / 글 " + won(listing.price));
    }

    // 공연일: 같은 날
    var cd = day(capture.showDate), ld = day(listing.performDate);
    if (!cd) reasons.push("캡처에서 공연일을 확인할 수 없어요");
    else {
      var okD = !!ld && cd === ld;
      checks.push({ key: "showDate", label: "공연일", capture: md(cd), listing: md(ld) || "(정보 없음)", ok: okD, decisive: true });
      if (!okD) reasons.push("공연일이 달라요: 캡처 " + md(cd) + " / 글 " + (md(ld) || "정보 없음"));
    }

    // 좌석: 양쪽에 다 있는 부분(층·등급·구역·열·번호)만 비교
    var cs = parseSeat(capture.seat), ls = listing.seat || {};
    var parts = [["area", "구역"], ["row", "열"], ["num", "번호"], ["grade", "등급"], ["floor", "층"]];
    var compared = parts.filter(function(p){ return cs[p[0]] && ls[p[0]]; });
    if (compared.length){
      var bad = compared.filter(function(p){ return norm(cs[p[0]]) !== norm(ls[p[0]]); });
      var okS = bad.length === 0;
      checks.push({ key: "seat", label: "좌석", capture: seatText(cs), listing: listing.seatText || seatText(ls), ok: okS, decisive: true });
      if (!okS) reasons.push("좌석이 달라요(" + bad.map(function(p){ return p[1]; }).join("·") + "): 캡처 " + seatText(cs) + " / 글 " + (listing.seatText || seatText(ls)));
    }

    // 참고: 공연명
    if (capture.title && listing.title && nameScore){
      checks.push({ key: "title", label: "공연명", capture: capture.title, listing: listing.title,
                    ok: nameScore(capture.title, listing.title) >= 0.5, decisive: false });
    }
    // 참고: 게시 시각 (상대 시각 "2일 전" 등은 하루 단위라 26시간까지 허용)
    if (capture.postDate && listing.createdAt){
      var diff = Math.abs(new Date(capture.postDate) - new Date(listing.createdAt)) / 3600000;
      checks.push({ key: "postDate", label: "게시 시각", capture: capture.postDate.replace("T", " "),
                    listing: String(listing.createdAt).slice(0, 16).replace("T", " "), ok: diff <= 26, decisive: false });
    }
    return finish();

    function finish(){
      var decisive = checks.filter(function(c){ return c.decisive; });
      var same = reasons.length === 0 && decisive.length > 0 && decisive.every(function(c){ return c.ok; });
      return { same: same, checks: checks, reasons: reasons };
    }
  }

  return { parseSeat: parseSeat, seatText: seatText, compare: compare };
});
