// 합성 캡처 생성기: tests/fixtures/templates/*.html 을 휴대폰 화면 크기로 렌더링해
// tests/fixtures/captures/ 에 PNG(원본 화질)와 JPG(저화질 재압축본)로 저장한다.
// 실행: npm run fixtures
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "fixtures/templates");
const out = join(here, "fixtures/captures");

const browser = await chromium.launch();
for (const file of readdirSync(templates).filter((f) => f.endsWith(".html"))) {
  const name = basename(file, ".html");
  const url = pathToFileURL(join(templates, file)).href;
  // 원본: iPhone급 해상도(배율 3)
  const hi = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await hi.goto(url);
  await hi.evaluate(() => document.fonts.ready);
  await hi.screenshot({ path: join(out, `${name}.png`) });
  await hi.close();
  // 저화질: 배율 2 + JPEG 품질 60 (메신저로 한 번 전달된 캡처 정도)
  const lo = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await lo.goto(url);
  await lo.evaluate(() => document.fonts.ready);
  await lo.screenshot({ path: join(out, `${name}.lowq.jpg`), type: "jpeg", quality: 60 });
  await lo.close();
  console.log("rendered", name);
}
await browser.close();
