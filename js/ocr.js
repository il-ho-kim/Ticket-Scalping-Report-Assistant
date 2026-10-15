// 캡처 이미지의 글자를 브라우저 안에서 읽는다 (Tesseract.js). 이미지는 기기 밖으로 나가지 않는다.
// 라이브러리와 한국어·영어 글자 데이터는 처음 읽을 때 CDN에서 받고, 이후에는 브라우저 저장소(IndexedDB)에 남은 것을 쓴다.
// 테스트 등에서 경로를 바꾸려면 이 파일보다 먼저 window.TICKET_OCR_CONFIG = { scriptUrl, workerPath, corePath, langPath } 를 둔다.
(function(){
  "use strict";

  var VERSION = "7.0.0";
  var config = Object.assign({
    scriptUrl: "https://cdn.jsdelivr.net/npm/tesseract.js@" + VERSION + "/dist/tesseract.min.js",
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@" + VERSION + "/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@" + VERSION,
    langPath: null,   // null이면 언어별 jsdelivr 경로(@tesseract.js-data/<lang>/4.0.0_best_int)를 쓴다
    langs: ["kor", "eng"],
    // 전처리: 짧은 변이 upscaleBelow보다 작으면 upscale배로 키우고, 감마(gamma>1)로 회색 글씨를 진하게 만든다.
    // 한 장을 passes에 적힌 방식대로 여러 번 읽는다. 1번은 기본, 2번은 회색 글씨용(감마 2).
    // 실제 티켓베이 앱 캡처는 라벨·공연명·상품번호 라벨이 회색이라 기본 방식으로는 통째로 건너뛰고,
    // 반대로 감마를 주면 합성 캡처의 일부 글씨가 깨져서, 두 결과를 함께 쓴다(앞 결과 우선, 빈 항목만 뒤 결과로 채움).
    upscaleBelow: 1000, upscale: 2, gamma: 1,
    passes: [{}, { gamma: 2, upscaleBelow: 0 }]
  }, window.TICKET_OCR_CONFIG || {});

  var scriptPromise = null, workerPromise = null;
  var progressCb = null;   // 지금 진행 중인 작업의 진행률 콜백 (워커 logger는 생성 시 한 번만 정해지므로 여기로 돌린다)

  function loadScript(){
    if (window.Tesseract) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = config.scriptUrl;
      s.async = true;
      s.onload = function(){ window.Tesseract ? resolve() : reject(new Error("tesseract_missing")); };
      s.onerror = function(){ scriptPromise = null; reject(new Error("script_load_failed")); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function getWorker(){
    if (workerPromise) return workerPromise;
    workerPromise = loadScript().then(function(){
      var opts = {
        workerPath: config.workerPath,
        corePath: config.corePath,
        logger: function(m){ if (progressCb) progressCb(m); }
      };
      if (config.langPath) opts.langPath = config.langPath;
      return window.Tesseract.createWorker(config.langs, 1 /* LSTM */, opts);
    }).then(function(worker){
      return worker.setParameters({
        tessedit_pageseg_mode: "3",          // 자동 레이아웃 분석 — 합성 캡처 비교에서 11(희소 텍스트)보다 줄이 덜 끊겼다
        preserve_interword_spaces: "1"
      }).then(function(){ return worker; });
    });
    workerPromise.catch(function(){ workerPromise = null; });   // 실패하면 다음에 다시 시도할 수 있게
    return workerPromise;
  }

  function loadImage(file){
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("image_decode_failed")); };
      img.src = url;
    });
  }

  // 회색조로 바꾸고, 작은 캡처는 키우고, 다크모드(어두운 바탕)는 반전한다. 이진화는 하지 않는다 —
  // Tesseract의 LSTM 인식기는 회색조에서 더 잘 읽는다.
  function preprocess(img, pass){
    var opt = Object.assign({ upscaleBelow: config.upscaleBelow, upscale: config.upscale, gamma: config.gamma }, pass);
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(w, h) < opt.upscaleBelow ? opt.upscale : 1;
    var maxSide = 4000;
    if (Math.max(w, h) * scale > maxSide) scale = maxSide / Math.max(w, h);
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cw, ch);
    var data = ctx.getImageData(0, 0, cw, ch), px = data.data, sum = 0, n = px.length / 4;
    for (var i = 0; i < px.length; i += 4){
      var y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = y;
      sum += y;
    }
    var dark = sum / n < 110;
    var lut = new Uint8ClampedArray(256);
    for (var k = 0; k < 256; k++){ var v = dark ? 255 - k : k; lut[k] = Math.round(255 * Math.pow(v / 255, opt.gamma)); }
    for (var j = 0; j < px.length; j += 4){ px[j] = px[j + 1] = px[j + 2] = lut[Math.round(px[j])]; }
    ctx.putImageData(data, 0, 0);
    return { canvas: canvas, dark: dark, scale: scale };
  }

  // files: File 목록. onProgress({phase: "prepare"|"read", index, total, progress})
  // 결과: [{texts:[방식별 글자], text(합친 것), lastModified, dark}]
  function recognize(files, onProgress){
    var total = files.length, current = 0, results = [];
    progressCb = function(m){
      if (!onProgress) return;
      if (m.status === "recognizing text") onProgress({ phase: "read", index: current, total: total, progress: m.progress || 0 });
      else onProgress({ phase: "prepare", index: current, total: total, progress: m.progress || 0, status: m.status });
    };
    if (onProgress) onProgress({ phase: "prepare", index: 0, total: total, progress: 0 });
    return getWorker().then(function(worker){
      var chain = Promise.resolve();
      files.forEach(function(file, i){
        chain = chain.then(function(){
          current = i;
          if (onProgress) onProgress({ phase: "read", index: i, total: total, progress: 0 });
          return loadImage(file).then(function(img){
            var passes = (config.passes && config.passes.length) ? config.passes : [{}];
            var texts = [], dark = false, p = Promise.resolve();
            passes.forEach(function(pass){
              p = p.then(function(){
                var pre = preprocess(img, pass);
                dark = pre.dark;
                return worker.recognize(pre.canvas).then(function(res){ texts.push((res.data && res.data.text) || ""); });
              });
            });
            return p.then(function(){
              results.push({ texts: texts, text: texts.join("\n\n"), lastModified: file.lastModified || Date.now(), dark: dark });
            });
          });
        });
      });
      return chain;
    }).then(function(){ progressCb = null; return results; },
            function(err){ progressCb = null; throw err; });
  }

  window.TicketOCR = { recognize: recognize, config: config, preprocess: preprocess };
})();
