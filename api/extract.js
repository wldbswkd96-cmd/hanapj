// Vercel 서버리스 함수: 품의서에서 계약업체명·대표자명을 Claude로 추출한다.
// 아티팩트 밖(Vercel 배포)에서는 브라우저가 Claude를 직접 부를 수 없으므로 이 엔드포인트를 쓴다.
//   GET  /api/extract                       -> { ok }   (ANTHROPIC_API_KEY 설정 여부)
//   POST /api/extract { text }              -> { company, ceos, evidence, confidence }
//   POST /api/extract { docs: [{id, text}] } -> { results: [{ id, company, ceos }] }
//   POST /api/extract { images: [base64 jpeg] } -> { text, company, ceos, evidence, confidence }  (스캔본 품의서)
// 선택: WLF_ACCESS_KEY 를 설정하면 요청 헤더 x-wlf-key 가 일치해야 호출된다.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const MODEL = "claude-opus-5-5";
const MAX_TEXT = 20000;
const MAX_DOCS = 30;

const Single = z.object({
  company: z.string().nullable(),
  ceos: z.array(z.string()),
  evidence: z.string(),
  confidence: z.number(),
});
const Ocr = Single.extend({ text: z.string() });
const MAX_IMAGES = 5;
const MAX_IMAGE_B64 = 1_500_000;
const Batch = z.object({
  results: z.array(z.object({ id: z.string(), company: z.string().nullable(), ceos: z.array(z.string()) })),
});

const RULES = `규칙:
- 원문에 적힌 문자열을 그대로 복사합니다. 철자, 띄어쓰기, 법인격 표기((주), 주식회사, ㈜)를 바꾸지 마세요.
- 기안자, 결재자, 당행 직원, 계약이 끝나는 기존 업체는 제외합니다. 이번에 계약하는 업체만 추출합니다.
- 공동대표이면 모두 넣습니다.
- 찾을 수 없으면 company는 null, ceos는 빈 배열입니다.`;

function singlePrompt(text) {
  return `당신은 은행 준법지원부 AML 담당자를 돕는 정보 추출기입니다.
아래 '계약체결 품의서'에서 이번 계약의 상대방(계약업체)의 상호와 대표자 성명을 추출하세요.

${RULES}
- evidence에는 근거가 된 원문 한 줄을 그대로 넣고, confidence는 0~1 사이 숫자로 답합니다.

<품의서>
${text}
</품의서>`;
}

function batchPrompt(docs) {
  return `당신은 은행 준법지원부 AML 담당자를 돕는 정보 추출기입니다.
아래 품의서 발췌 각각에서 이번 계약 상대방(계약업체)의 상호와 대표자 성명을 추출하고, 각 문서의 id와 함께 results에 넣으세요.

${RULES}

${docs.map((d) => `<doc id="${d.id}">\n${d.text}\n</doc>`).join("\n\n")}`;
}

function ocrContent(images) {
  return [
    ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
    {
      type: "text",
      text: `당신은 은행 준법지원부 AML 담당자를 돕는 정보 추출기입니다. 위 이미지는 '계약체결 품의서' 스캔 페이지입니다.
1) text: 페이지의 글자를 줄바꿈을 살려 원문 그대로 옮겨 적습니다.
2) 이번 계약의 상대방(계약업체)의 상호(company)와 대표자 성명(ceos)을 추출합니다. 옮겨 적은 text에 있는 문자열을 그대로 씁니다.

${RULES}
- evidence에는 근거가 된 원문 한 줄을 그대로 넣고, confidence는 0~1 사이 숫자로 답합니다.`,
    },
  ];
}

let client;
async function ask(prompt, schema) {
  client ??= new Anthropic();
  const msg = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    // 안전 분류기 거절 시 서버 측에서 권장 모델로 재시도
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: prompt }],
  });
  if (msg.stop_reason === "refusal") throw Object.assign(new Error("refused"), { code: "refusal" });
  if (msg.stop_reason === "max_tokens" || !msg.parsed_output) throw Object.assign(new Error("incomplete"), { code: "incomplete" });
  return msg.parsed_output;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (req.method === "GET") return res.status(200).json({ ok: hasKey, model: MODEL });
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!hasKey) return res.status(503).json({ error: "not_configured", message: "ANTHROPIC_API_KEY 환경 변수가 없습니다." });
  const accessKey = process.env.WLF_ACCESS_KEY;
  if (accessKey && req.headers["x-wlf-key"] !== accessKey) return res.status(401).json({ error: "unauthorized" });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  try {
    if (Array.isArray(body.images)) {
      const images = body.images.slice(0, MAX_IMAGES).filter((b) => typeof b === "string" && b.length > 0);
      if (!images.length) return res.status(400).json({ error: "bad_request" });
      if (images.some((b) => b.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(b))) return res.status(413).json({ error: "too_large" });
      return res.status(200).json(await ask(ocrContent(images), Ocr));
    }
    if (Array.isArray(body.docs)) {
      const docs = body.docs.slice(0, MAX_DOCS).map((d) => ({ id: String(d.id).slice(0, 40), text: String(d.text || "").slice(0, MAX_TEXT) }));
      if (!docs.length) return res.status(400).json({ error: "bad_request" });
      return res.status(200).json(await ask(batchPrompt(docs), Batch));
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return res.status(400).json({ error: "bad_request", message: "text가 비어 있습니다." });
    if (text.length > MAX_TEXT) return res.status(413).json({ error: "too_large", message: `본문은 ${MAX_TEXT}자 이하여야 합니다.` });
    return res.status(200).json(await ask(singlePrompt(text), Single));
  } catch (e) {
    if (e.code === "refusal") return res.status(422).json({ error: "refusal" });
    if (e.code === "incomplete") return res.status(502).json({ error: "incomplete" });
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limited" });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "not_configured" });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: "upstream_error", status: e.status ?? null });
    console.error(e);
    return res.status(500).json({ error: "internal_error" });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
