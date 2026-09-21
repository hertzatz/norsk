// Norsk translate relay (Cloudflare Worker).
// Keeps the Google Translate and Azure Speech keys secret, and caps daily use so the free tiers are never exceeded.
//
//   GET /translate?q=<text>&from=fr|en|no|auto&to=no|fr|en   -> {"text": "...", "from": "fr"}
//   GET /tts?q=<norwegian text>&voice=pernille|finn&rate=100|85|70|55 -> audio/mpeg (spoken at that % speed)
//
// Only requests coming from the app (ALLOWED_ORIGINS) are served. Answers carry a 30-day Cache-Control, so the
// browser replays a sentence it already asked for without a new request (the Cache API is a no-op on workers.dev).

const ALLOWED_ORIGINS = ["https://hertzatz.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const MAX_CHARS = 200;                       // per request
const DAILY_CHARS = { translate: 15000, tts: 15000 };   // ≈ 450 000 a month, under both free tiers (500 000)
const VOICES = { pernille: "nb-NO-PernilleNeural", finn: "nb-NO-FinnNeural" };
const LANGS = new Set(["fr", "en", "no", "auto"]);

function originOf(request) {
  const o = request.headers.get("Origin");
  if (o) return o;
  const ref = request.headers.get("Referer");    // <audio src> sends a Referer, not an Origin
  try { return ref ? new URL(ref).origin : ""; } catch { return ""; }
}

function cors(origin) {
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

// Daily character counter in KV (one key per service and day). Approximate, which is fine for a safety cap.
async function takeQuota(env, kind, n) {
  const key = `${kind}:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.LIMITS.get(key)) || "0", 10);
  if (used + n > DAILY_CHARS[kind]) return false;
  await env.LIMITS.put(key, String(used + n), { expirationTtl: 3 * 86400 });
  return true;
}

async function translate(env, q, from, to) {
  const params = new URLSearchParams({ q, target: to, format: "text" });
  if (from !== "auto") params.set("source", from);
  const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_TRANSLATE_KEY}`, {
    method: "POST", body: params,
  });
  if (!r.ok) throw new Error(`google ${r.status}`);
  const t = (await r.json()).data.translations[0];
  return { text: t.translatedText, from: t.detectedSourceLanguage || from };
}

const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

const RATES = { "100": "+0%", "85": "-15%", "70": "-30%", "55": "-45%" };

async function speak(env, q, voice, rate) {
  const ssml = `<speak version='1.0' xml:lang='nb-NO'><voice name='${VOICES[voice]}'>` +
    `<prosody rate='${RATES[rate]}'>${xmlEscape(q)}</prosody></voice></speak>`;
  const r = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "norsk-app",
    },
    body: ssml,
  });
  if (!r.ok) throw new Error(`azure ${r.status}`);
  return r.arrayBuffer();
}

export default {
  async fetch(request, env) {
    const origin = originOf(request);
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors(origin), "Access-Control-Allow-Methods": "GET" } });
    }
    if (request.method !== "GET") return json({ error: "method" }, 405, origin);

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ error: "empty" }, 400, origin);
    if (q.length > MAX_CHARS) return json({ error: "too_long", max: MAX_CHARS }, 400, origin);

    try {
      let res;
      if (url.pathname === "/translate") {
        const from = url.searchParams.get("from") || "auto", to = url.searchParams.get("to") || "no";
        if (!LANGS.has(from) || !LANGS.has(to) || to === "auto") return json({ error: "lang" }, 400, origin);
        if (!(await takeQuota(env, "translate", q.length))) return json({ error: "daily_limit" }, 429, origin);
        res = json(await translate(env, q, from, to), 200, origin);
      } else if (url.pathname === "/tts") {
        const voice = VOICES[url.searchParams.get("voice")] ? url.searchParams.get("voice") : "pernille";
        const rate = RATES[url.searchParams.get("rate")] ? url.searchParams.get("rate") : "100";
        if (!(await takeQuota(env, "tts", q.length))) return json({ error: "daily_limit" }, 429, origin);
        res = new Response(await speak(env, q, voice, rate), { headers: { "Content-Type": "audio/mpeg", ...cors(origin) } });
      } else {
        return json({ error: "not_found" }, 404, origin);
      }
      res.headers.set("Cache-Control", "public, max-age=2592000");   // 30 days in the browser
      return res;
    } catch (e) {
      return json({ error: "upstream", detail: String(e.message || e) }, 502, origin);
    }
  },
};
