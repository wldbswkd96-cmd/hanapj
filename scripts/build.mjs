// wlf-screening/index.html 은 아티팩트용 본문 조각(doctype/head 없음)이다.
// Vercel 정적 배포용으로 아티팩트 게시 시와 같은 문서 골격을 씌워 dist/index.html 로 낸다.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const body = await readFile(new URL("../wlf-screening/index.html", import.meta.url), "utf8");
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.5 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>
${body}
</body></html>
`;
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/index.html", import.meta.url), html);
console.log("dist/index.html written");
