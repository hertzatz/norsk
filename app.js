"use strict";

const state = { level: 300, lang: "both", voice: "alt", speed: 1, view: "phrases", theme: "", list: "", pos: "", hideTr: false, only: false, q: "", sq: "", vq: "",
  scroll: {}, shown: 50 };   // scroll: the place reached in each view · shown: how many sentences were listed
let WORDS = [], SENTENCES = [], BY_ID = {}, SENT_BY_ID = {};
const PAGE = 50;

// ---------- storage (per-device convenience only) ----------
function load() {
  try { Object.assign(state, JSON.parse(localStorage.getItem("norsk.settings") || "{}")); } catch (e) {}
  state.q = "";
  state.sq = "";
  state.vq = "";
  if (!state.scroll || typeof state.scroll !== "object") state.scroll = {};
  state.shown = Math.min(Math.max(PAGE, state.shown | 0), 5000);
}
function save() {
  try {
    const { level, lang, voice, speed, view, theme, list, pos, hideTr, only, scroll, shown } = state;
    localStorage.setItem("norsk.settings", JSON.stringify({ level, lang, voice, speed, view, theme, list, pos, hideTr, only, scroll, shown }));
  } catch (e) {}
}

// The place reached in each view is kept in the browser, so you come back where you were,
// even after closing the tab. A new filter starts the view again from the top.
let scrollTimer = 0, restoringScroll = false;
function rememberScroll() {
  if (restoringScroll) return;
  state.scroll[state.view] = Math.round(window.scrollY);
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(save, 400);
}
function restoreScroll() {
  const y = state.scroll[state.view] || 0;
  restoringScroll = true;
  requestAnimationFrame(() => {
    window.scrollTo(0, y);
    requestAnimationFrame(() => { restoringScroll = false; });
  });
}
function resetList() {
  state.shown = PAGE;
  state.scroll[state.view] = 0;
}

// ---------- audio ----------
// Must stay identical to slug() in tools/gen_audio.py
function slug(text) {
  let t = text.toLowerCase().trim().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");
  t = t.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  let out = "";
  for (const ch of t) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (out && !out.endsWith("_")) out += "_";
  }
  return out.replace(/^_+|_+$/g, "").slice(0, 80);
}

const player = new Audio();
let playingEl = null;
// Only one thing is marked as read at a time, and the mark stays after the sound ends:
// it moves away only when something else is read. A word also lifts the card it sits in.
let readCard = null;
function markRead(el, cls = "playing") {
  const card = el ? el.closest(".sent, .word") : null;
  [playingEl, readCard].forEach((old) => {
    if (old && old !== el && old !== card) old.classList.remove("playing", "drilling");
  });
  playingEl = el; readCard = card;
  if (card) card.classList.add("playing");
  if (el) el.classList.add(cls);
}

function speakFallback(text, rate) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "nb-NO";
  u.rate = rate;
  speechSynthesis.speak(u);
}

// "alt" = both voices: Pernille and Finn take turns, one voice per play
let nextVoice = "pernille";
function voiceFor() {
  if (state.voice !== "alt") return state.voice;
  const v = nextVoice;
  nextVoice = v === "pernille" ? "finn" : "pernille";
  return v;
}

// All audio lives in the Cloudflare R2 bucket norsk-app: <voice>/<folder>/<file>.mp3
// folders: w (words), s100 / s085 / s070 / s055 (sentences at that % of normal speed), verb (drills).
// Served from the local audio/ folder when the site is opened through localhost (same layout, same names).
const LOCAL_AUDIO = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const AUDIO_BASE = LOCAL_AUDIO ? "audio" : "https://pub-9c5fcccd9b314f969fcb77df05b56023.r2.dev";
const SPEED_DIR = { 1: "s100", 0.85: "s085", 0.7: "s070", 0.55: "s055" };
const audioUrl = (voice, dir, file) => `${AUDIO_BASE}/${voice}/${dir}/${file}.mp3`;

// Each play gets a number; only the latest one may fall back, and only once (the error event and the
// rejected play() promise can both fire; a click that interrupts the previous sound is not an error).
let playSeq = 0;
function play(src, text, el = null, rate = state.speed, fallback = null) {
  const seq = ++playSeq;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (typeof drillStop === "function" && (drillQueue.length || !drill.paused)) drillStop();
  markRead(el);
  let failed = false;
  const fail = () => {
    if (failed || seq !== playSeq) return;
    failed = true;
    fallback ? fallback() : speakFallback(text, rate);
  };
  player.onerror = fail;
  player.src = src;
  player.preservesPitch = true;
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
  player.play().catch((e) => { if (e && e.name !== "AbortError") fail(); });
}
function playWord(text, el, key = text) {
  const voice = voiceFor(key);
  play(audioUrl(voice, "w", slug(text)), text, el, state.speed,
       () => play(ttsUrl(text, voice), text, el, 1));   // no prepared file: spoken by Azure through the Worker
}
function playSentence(s, el) {
  const voice = voiceFor(s.id);
  const dir = SPEED_DIR[state.speed] || "s100";
  // the slower speeds are spoken slowly by the voice itself, so they play at rate 1;
  // if one is missing, the normal file is slowed down by the browser instead
  if (dir === "s100") return play(audioUrl(voice, dir, s.id), s.no, el);
  play(audioUrl(voice, dir, s.id), s.no, el, 1, () => play(audioUrl(voice, "s100", s.id), s.no, el));
}

// ---------- translation bar (Cloudflare Worker: Google Translate + Azure Speech, keys kept there) ----------
const TR_BASE = "https://norsk-translate.valentin-besnardiere.workers.dev";
const trUrl = (path, params) => `${TR_BASE}/${path}?${new URLSearchParams(params)}`;
const ttsUrl = (text, voice) => trUrl("tts", { q: text, voice, rate: String(Math.round(state.speed * 100)) });

async function trFetch(q, from, to) {
  const r = await fetch(trUrl("translate", { q, from, to }));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
// Norwegian text -> clickable words (same popover and sounds as everywhere else)
const clickableNo = (text) => esc(text).split(/(\s+|[,.;:!?¿¡"«»()]+)/).map((part) =>
  /^[\wæøåÆØÅ-]+$/.test(part) ? vfSpan(part) : part).join("");

async function translateBar(q) {
  const out = document.getElementById("trOut");
  out.innerHTML = `<span class="muted">…</span>`;
  try {
    // anything typed goes to Norwegian; if it already was Norwegian, translate it to French (or English)
    let no = await trFetch(q, "auto", "no"), other = "";
    if (no.from === "no") {
      const lang = state.lang === "en" ? "en" : "fr";
      other = `<span class="tr-other"> · ${esc((await trFetch(q, "no", lang)).text)}</span>`;
      no = { text: q };
    }
    out.innerHTML = `
      <button class="play" id="trPlay" aria-label="Play">▶</button>
      <span class="tr-no">${clickableNo(no.text)}${other}</span>
      <button class="tr-close" id="trClose" aria-label="Clear">✕</button>`;
    document.getElementById("trPlay").onclick = (e) => play(ttsUrl(no.text, voiceFor(no.text)), no.text, e.currentTarget, 1);
    document.getElementById("trClose").onclick = () => {
      out.innerHTML = `<span class="muted">→ norsk</span>`; document.getElementById("trInput").value = "";
    };
  } catch (err) {
    out.innerHTML = `<span class="muted">${String(err.message) === "daily_limit"
      ? "Daily translation limit reached (free quota protection). Try again tomorrow."
      : "Translation unavailable right now."}</span>`;
  }
}

// ---------- verb drills: French then Norwegian, one track per verb (<voice>/verb/<id>.mp3) ----------
const drill = new Audio();
let drillQueue = [], drillIdx = 0, drillCls = null, drillId = null;
// the ▶ of the row being read shows ⏸ while it plays
function drillIcons() {
  document.querySelectorAll("#verbs .drill").forEach((b) => {
    b.textContent = b.dataset.id === drillId && !drill.paused ? "⏸" : "▶";
  });
}
drill.onplay = drill.onpause = drillIcons;
function drillMark(id) {
  const btn = id && document.querySelector(`#verbs .drill[data-id="${CSS.escape(id)}"]`);
  const tr = btn ? btn.closest("tr") : null;
  if (id && !tr) return;                       // that row is not on screen: keep the current mark
  markRead(tr, "drilling");
  if (tr) tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function drillPlay(id) {
  player.pause();
  drillId = id;
  drillMark(id);
  drill.src = audioUrl(voiceFor(id), "verb", id);
  drill.play().catch(() => {});
}
// row button: play, pause, resume
function drillToggle(id) {
  if (id === drillId && drill.src) {
    if (!drill.paused) return drill.pause();
    if (drill.currentTime > 0 && !drill.ended) return drill.play();
  }
  drillQueue = []; drillCls = null;
  drillPlay(id);
}
function drillStop() {
  drill.pause(); drill.currentTime = 0;
  drillQueue = []; drillCls = null; drillId = null; drillIcons();   // the row stays marked where you stopped
}
drill.onended = () => {
  if (drillQueue.length && drillIdx < drillQueue.length - 1) return drillPlay(drillQueue[++drillIdx]);
  drillQueue = []; drillCls = null; drillId = null; drillIcons();   // the row stays marked where you stopped
};
function drillGroup(cls, act) {
  if (act === "pause") return drill.pause();
  if (act === "stop") return drillStop();
  if (drillCls === cls && drill.paused && drillQueue.length) return drill.play();   // resume
  const table = document.querySelector(`#verbs .drill-ctrl[data-cls="${cls}"]`).closest("h2").nextElementSibling.nextElementSibling;
  drillQueue = [...table.querySelectorAll(".drill")].map((b) => b.dataset.id);
  drillIdx = 0; drillCls = cls;
  if (drillQueue.length) drillPlay(drillQueue[0]);
}

// ---------- helpers ----------
const ART = { m: "en", f: "ei", n: "et" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const first = (s) => (s || "").split("/")[0];
const alts = (s) => (s || "").split("/").join(" / ");
// Search key: lower case, accents removed (être -> etre, høsten -> hosten, å -> a)
const fold = (s) => (s || "").toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae")
  .normalize("NFD").replace(/[̀-ͯ]/g, "");

// Word categories (grammatical classes), in display order; several data codes can share one category
const CATEGORIES = [
  ["noun", "Nouns", ["noun", "npl", "prop"]],
  ["verb", "Verbs", ["verb", "inf"]],
  ["adj", "Adjectives", ["adj"]],
  ["adv", "Adverbs", ["adv"]],
  ["pron", "Pronouns", ["pron"]],
  ["det", "Determiners", ["det"]],
  ["prep", "Prepositions", ["prep"]],
  ["konj", "Conjunctions", ["konj"]],
  ["int", "Interjections", ["int"]],
  ["num", "Numbers", ["num"]],
  ["expr", "Expressions", ["expr"]],
];
const CAT_OF = {};
CATEGORIES.forEach(([key, label, codes]) => codes.forEach((c) => (CAT_OF[c] = { key, label })));
const catLabel = (w) => (CAT_OF[w.pos] || { label: w.pos }).label;

// Colour code, used on every Norwegian word of the app (legend under each toolbar):
// nouns by gender (m blue, f pink, n neuter green), verbs by class (irregular red, 1 yellow, 2 orange, 3 purple).
function wordColor(w) {
  if (!w) return "";
  if (w.pos === "noun" || w.pos === "npl") return w.gender ? "g-" + w.gender : "";
  if (w.pos === "verb") return "v-" + (w.vclass || "irr");   // "å" (pos inf) stays neutral
  return "";
}
// A written form -> the word it belongs to. When the caller knows the word (its own row, its own card),
// that word wins: "visst" in the adverb row is the adverb, not the participle of vite.
function ownerOf(text, w = null) {
  const key = text.toLowerCase().trim();
  if (w && (w.variants.includes(key) || w.variants.includes(key.replace(/^(å|en|ei|et|har|skal|vil) /, "")))) return w;
  return wordForForm(text);
}
// The clickable span of a form: coloured like its word, and carrying that word's id for the popover
function vfSpan(text, w = null) {
  const owner = ownerOf(text, w);
  const cls = ["vf", wordColor(owner)].filter(Boolean).join(" ");
  return `<span class="${cls}" data-t="${esc(text)}"${owner ? ` data-w="${esc(owner.id)}"` : ""}>${esc(text)}</span>`;
}

const LEGEND = `<p class="legend">
  <b class="g-m">en masculin</b><b class="g-f">ei f&eacute;minin</b><b class="g-n">et neutre</b>
  <b class="v-irr">verbe irr&eacute;gulier</b><b class="v-v1">v. groupe 1</b><b class="v-v2">v. groupe 2</b><b class="v-v3">v. groupe 3</b></p>`;

const MODALS = new Set(["kunne", "ville", "skulle", "måtte", "burde"]);

// Determiners that agree with the noun: masculine (en), feminine (ei), neuter (et), plural
const AGREE = {
  min: ["min", "mi", "mitt", "mine"], din: ["din", "di", "ditt", "dine"], sin: ["sin", "si", "sitt", "sine"],
  vår: ["vår", "vår", "vårt", "våre"], hans: ["hans", "hans", "hans", "hans"], hennes: ["hennes", "hennes", "hennes", "hennes"],
  deres: ["deres", "deres", "deres", "deres"], en: ["en", "ei", "et", "—"], denne: ["denne", "denne", "dette", "disse"],
  annen: ["annen", "anna", "annet", "andre"], egen: ["egen", "egen", "eget", "egne"], hver: ["hver", "hver", "hvert", "—"],
  all: ["all", "all", "alt", "alle"], hvilken: ["hvilken", "hvilken", "hvilket", "hvilke"],
};
const AGREE_LABELS = ["Masculine (en)", "Feminine (ei)", "Neuter (et)", "Plural"];
function imperative(inf) {
  if (!inf.endsWith("e") || inf.length < 3 || !/[aeiouyæøå]/.test(inf.slice(0, -1))) return inf;
  let imp = inf.slice(0, -1);
  if (imp.endsWith("mm")) imp = imp.slice(0, -1);
  return imp;
}

// Labelled forms of a word: [label, value] rows
function formRows(w) {
  const f = w.forms || {};
  if (w.pos === "verb") {
    if (w.lemma.endsWith("s") && f.pres === f.inf) {  // deponent verbs: synes, finnes...
      return [["Infinitive", "å " + f.inf], ["Present", alts(f.pres)], ["Past", alts(f.past)],
              ["Perfect", "har " + alts(f.perf)]];
    }
    const rows = [["Infinitive", "å " + f.inf], ["Present", alts(f.pres)], ["Past", alts(f.past)],
                  ["Perfect", "har " + alts(f.perf)]];
    if (!MODALS.has(w.lemma)) {
      rows.push(["Future", `skal ${f.inf} · vil ${f.inf}`], ["Imperative", imperative(f.inf) + "!"]);
    }
    if (!w.lemma.includes(" ") && w.variants.includes(w.lemma + "s")) rows.push(["-s form", w.lemma + "s"]);
    return rows;
  }
  if (w.pos === "noun") {
    return [["Indefinite", `${ART[w.gender] || ""} ${alts(f.indef)}`.trim()], ["Definite", alts(f.def)],
            ["Plural", alts(f.pl)], ["Definite plural", alts(f.defpl)]];
  }
  if (w.pos === "npl") return [["Plural", alts(f.pl)], ["Definite plural", alts(f.defpl)]];
  if ((w.pos === "det" || w.pos === "pron") && AGREE[w.lemma]) {
    return AGREE[w.lemma].map((form, i) => [AGREE_LABELS[i], form]);
  }
  if (w.pos === "adj") {
    const rows = [["Masc. / fem.", alts(f.base)], ["Neuter", alts(f.neut)], ["Plural / definite", alts(f.pl)]];
    if (f.comp && f.comp !== f.base) rows.push(["Comparative", alts(f.comp)], ["Superlative", alts(f.sup)]);
    return rows;
  }
  return [];
}

// Forms line of a word card: every form is clickable (plays + popover), labels stay plain
function formsLine(w) {
  const f = w.forms;
  if (!f) return "";
  const c = (x) => x ? vf(first(x), w) : "";
  if (w.pos === "noun") return [f.def, f.pl, f.defpl].map(c).filter(Boolean).join(" · ");
  if (w.pos === "npl") return c(f.defpl);
  if (w.pos === "verb") return `pres. ${c(f.pres)} · past ${c(f.past)} · perf. ${vf("har " + first(f.perf), w)}` +
    (MODALS.has(w.lemma) ? "" : ` · fut. ${vf("skal " + f.inf, w)}`);
  if (w.pos === "adj") {
    const parts = [f.neut, f.pl].map(c);
    if (f.comp && f.comp !== f.base) parts.push(c(f.comp), c(f.sup));
    return parts.filter(Boolean).join(" · ");
  }
  return "";
}

function glossHTML(w) {
  const fr = `<div><span class="lang">FR</span>${esc(w.fr)}</div>`;
  const en = `<div><span class="lang">EN</span>${esc(w.en)}</div>`;
  return state.lang === "fr" ? fr : state.lang === "en" ? en : fr + en;
}

function lemmaHTML(w) {
  const c = wordColor(w);
  const art = w.pos === "noun" && w.gender ? `<span class="art ${c}">${ART[w.gender]}</span> ` : "";
  const verb = w.pos === "verb" ? `<span class="art">å</span> ` : "";
  return art + verb + `<span class="vf ${c}" data-t="${esc(w.lemma)}" data-w="${esc(w.id)}">${esc(w.lemma)}</span>`;
}

// Level filter: up to the selected level, or exactly that level when "Only this level" is ticked
const inLevel = (w) => state.only ? w.level === state.level : w.level <= state.level;
const sentInLevel = (s) => state.only ? s.level === state.level : s.level <= state.level;

// Number of sentences per word id, computed once
let COUNT = null;
function countFor(id) {
  if (!COUNT) {
    COUNT = {};
    SENTENCES.forEach((s) => new Set(s.tokens.map((t) => t.w).filter(Boolean)).forEach((w) => (COUNT[w] = (COUNT[w] || 0) + 1)));
  }
  return COUNT[id] || 0;
}

// form -> word (lowest level wins), so any Norwegian word on the page can open a popover
let FORM_INDEX = null;
function wordForForm(text) {
  if (!FORM_INDEX) {
    FORM_INDEX = {};
    [...WORDS].sort((a, b) => b.level - a.level || (b.rank || 9999) - (a.rank || 9999))
      .forEach((w) => w.variants.forEach((v) => (FORM_INDEX[v] = w)));
  }
  const key = text.toLowerCase().trim();
  return FORM_INDEX[key] || FORM_INDEX[key.replace(/^(å|en|ei|et|har|skal|vil) /, "")] || null;
}

// Every Norwegian word anywhere (tables, note boxes, titles): play it and show its popover
function tapWord(el, text) {
  playWord(text, el);
  const w = (el.dataset.w && BY_ID[el.dataset.w]) || wordForForm(text);
  if (w) showPop(el, { t: text, w: w.id });
  else pop.hidden = true;
}

// Wrap the Norwegian examples (<i>…</i>) of a note box into clickable words
function makeClickable(root) {
  root.querySelectorAll("i").forEach((i) => {
    if (i.querySelector(".vf")) return;
    i.innerHTML = i.textContent.split(/(\s+|[,.;:!?…()«»"]+)/).map((part) =>
      /^[\wæøåÆØÅ-]+$/.test(part) ? vfSpan(part) : esc(part)).join("");
  });
}

const sentencesWith = (id) => SENTENCES.filter((s) => s.tokens.some((t) => t.w === id))
  .sort((a, b) => a.level - b.level || a.no.length - b.no.length);

// ---------- sentence card (used in the list and in the sheet) ----------
function sentenceHTML(s, hitId = null, showPass = false) {
  const toks = s.tokens.map((t, i) => {
    if (!t.w && !t.name) return esc(t.t);
    const cls = ["tok", wordColor(BY_ID[t.w]), t.name && "name", t.x && "extra",
                 hitId && t.w === hitId && "hit"].filter(Boolean).join(" ");
    return `<span class="${cls}" data-i="${i}">${esc(t.t)}</span>`;
  }).join("");
  const fr = `<div class="tr"><span class="lang">FR</span>${esc(s.fr)}</div>`;
  const en = `<div class="tr"><span class="lang">EN</span>${esc(s.en)}</div>`;
  const tr = state.lang === "fr" ? fr : state.lang === "en" ? en : fr + en;
  return `
    <article class="sent" data-id="${esc(s.id)}">
      <div class="row">
        <div class="no">${toks}</div>
        <button class="play" aria-label="Play sentence">▶</button>
      </div>
      ${tr}
      <div class="meta">level ${s.level}${s.theme ? " · " + esc(s.themeLabel || s.theme) : ""}${!showPass ? "" : s._new ? ` · <b>${s._new} new word${s._new > 1 ? "s" : ""}</b>` : s._pass ? ` · pass ${s._pass}` : ""}</div>
    </article>`;
}

// ---------- words view ----------
function renderWords() {
  const q = fold(state.q.trim());
  const list = WORDS.filter((w) => {
    if (!inLevel(w)) return false;
    if (state.list === "core" && w.list !== "core") return false;
    if (state.list.startsWith("g:") && w.group !== state.list.slice(2)) return false;
    if (state.pos && (CAT_OF[w.pos] || {}).key !== state.pos) return false;
    if (!q) return true;
    return w.variants.some((v) => fold(v).includes(q)) || fold(w.fr).includes(q) || fold(w.en).includes(q);
  });
  document.getElementById("wordCount").textContent = `${list.length} words · double-click: see sentences`;
  const ul = document.getElementById("words");
  ul.innerHTML = list.length ? list.map((w) => `
    <li class="word" data-id="${esc(w.id)}">
      <button class="play" aria-label="Play">🔊</button>
      <div class="main">
        <div class="lemma">${lemmaHTML(w)}<span class="badge cat">${esc(catLabel(w))}</span>${w.rank ? `<span class="badge">#${w.rank}</span>` : ""}</div>
        <div class="forms">${formsLine(w)}</div>
        <div class="gloss">${glossHTML(w)}</div>
      </div>
      <button class="more" aria-label="See sentences">📚 ${countFor(w.id)}<span> sentences</span></button>
    </li>`).join("") : `<li class="empty">No words found.</li>`;
}

// ---------- sentences view ----------
function filteredSentences() {
  const q = fold(state.sq.trim());
  return orderForCoverage(SENTENCES.filter((s) => sentInLevel(s) && (!state.theme || s.theme === state.theme) &&
    (!q || fold(s.no).includes(q) || fold(s.fr).includes(q) || fold(s.en).includes(q))));
}

// Order the list so that every word of the level is met as early as possible:
// pass 1 covers each word once, pass 2 a second time, ... up to TARGET times (greedy, lazy max-heap).
const TARGET = 5;
function orderForCoverage(list) {
  const target = new Set(WORDS.filter(inLevel).map((w) => w.id));
  const ids = list.map((s) => [...new Set(s.tokens.filter((t) => t.w && target.has(t.w)).map((t) => t.w))]);
  const count = {};
  const done = new Uint8Array(list.length);
  const out = [];
  const heap = []; // [score, index]
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (r < heap.length && heap[r][0] > heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (let k = 1; k <= TARGET; k++) {
    const score = (i) => ids[i].reduce((n, id) => n + ((count[id] || 0) < k ? 1 : 0), 0);
    heap.length = 0;
    for (let i = 0; i < list.length; i++) if (!done[i]) { const sc = score(i); if (sc) push([sc, i]); }
    while (heap.length) {
      const [sc, i] = pop();
      const now = score(i);
      if (!now) continue;
      if (heap.length && now < heap[0][0]) { push([now, i]); continue; }
      done[i] = 1; list[i]._new = k === 1 ? now : 0; list[i]._pass = k; out.push(list[i]);
      ids[i].forEach((id) => (count[id] = (count[id] || 0) + 1));
    }
  }
  for (let i = 0; i < list.length; i++) if (!done[i]) { list[i]._new = 0; list[i]._pass = 0; out.push(list[i]); }
  return out;
}

function renderSentences() {
  const box = document.getElementById("sentences");
  box.classList.toggle("hide-tr", state.hideTr);
  const list = filteredSentences();
  document.getElementById("sentCount").textContent = `${list.length} sentences`;
  if (!list.length) {
    box.innerHTML = `<p class="empty">No sentences for this level yet.</p>`;
    return;
  }
  box.innerHTML = list.slice(0, state.shown).map((s) => sentenceHTML(s, null, true)).join("") +
    (list.length > state.shown ? `<button class="load-more" id="loadMore">Show more (${list.length - state.shown} left)</button>` : "");
}

// ---------- verbs view ----------
const VERB_GROUPS = [
  ["irr", "Irregular verbs", "Learn by heart: the past and the participle change (gå → gikk → gått)."],
  ["v1", "Regular, group 1: -a / -et", "snakke → snakka (snakket) → har snakka. The largest group."],
  ["v2", "Regular, group 2: -te / -t", "spise → spiste → har spist."],
  ["v3", "Regular, group 3: -de / -dd", "prøve → prøvde → har prøvd · bo → bodde → har bodd."],
];

// A clickable form; "/" alternatives become separate clickable forms
function vf(text, w = null) {
  return (text || "").split("/").map((x) => x.trim()).filter(Boolean).map((x) => vfSpan(x, w)).join(" / ");
}

// "har vært / vart" -> each Norwegian word clickable, keeping separators
function vfRow(text, w = null) {
  return String(text).split(/(\s+|\/|·|!)/).map((part) =>
    /^[\wæøåÆØÅ-]+$/.test(part) ? vfSpan(part, w) : esc(part)).join("");
}

function glossCell(w) {
  return state.lang === "en" ? esc(w.en) : state.lang === "fr" ? esc(w.fr)
    : `${esc(w.fr)}<br><span class="muted">${esc(w.en)}</span>`;
}

function renderVerbs() {
  const q = fold(state.vq.trim());
  const verbs = WORDS.filter((w) => w.pos === "verb" && inLevel(w) &&
    (!q || w.variants.some((v) => fold(v).includes(q)) || fold(w.fr).includes(q) || fold(w.en).includes(q)))
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  document.getElementById("verbs").innerHTML = VERB_GROUPS.map(([cls, title, help]) => {
    const list = verbs.filter((w) => (w.vclass || "irr") === cls);
    if (!list.length) return "";
    const rows = list.map((w) => {
      const f = w.forms, modal = MODALS.has(w.lemma);
      return `<tr>
        <td class="gl">${glossCell(w)}</td>
        <td class="inf">${vfRow("å " + f.inf, w)}</td>
        <td>${vf(f.pres, w)}</td>
        <td>${vf(f.past, w)}</td>
        <td>${vfRow("har " + f.perf, w)}</td>
        <td>${modal ? "—" : vfRow("skal " + f.inf, w)}</td>
        <td>${modal ? "—" : vf(imperative(f.inf), w)}</td>
        <td><button class="more" data-id="${esc(w.id)}">📚 ${countFor(w.id)}</button></td>
        <td class="drill-cell"><button class="drill" data-id="${esc(w.id)}" aria-label="Listen FR / NO">▶</button></td>
      </tr>`;
    }).join("");
    return `<h2 class="vh drill-head">${title} <span class="badge">${list.length}</span>
        <span class="drill-ctrl" data-cls="${cls}">
          <button data-act="play" aria-label="Play all">▶</button><button data-act="pause" aria-label="Pause">⏸</button><button data-act="stop" aria-label="Stop">⏹</button>
        </span></h2>
      <p class="hint">${help}</p>
      <div class="table-wrap"><table class="vt">
        <thead><tr><th>Meaning</th><th>Infinitive</th><th>Present</th><th>Past</th><th>Perfect</th><th>Future</th><th>Imperative</th><th></th><th class="drill-cell"></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }).join("") || `<p class="empty">No verbs found.</p>`;
  drillIcons();   // keep ⏸ on the row being read after a re-render (search, level change)
}

// ---------- pronouns view ----------
// Personal pronouns: [label, subject, object] where each form is [norsk, fr, en]
const PERSONAL = [
  ["1re sg.", ["jeg", "je", "I"], ["meg", "me, moi", "me"]],
  ["2e sg.", ["du", "tu", "you"], ["deg", "te, toi", "you"]],
  ["3e sg. masc.", ["han", "il", "he"], ["ham / han", "le, lui", "him"]],
  ["3e sg. fém.", ["hun", "elle", "she"], ["henne", "la, lui", "her"]],
  ["3e sg. chose", ["den / det", "il, elle", "it"], ["den / det", "le, la", "it"]],
  ["1re pl.", ["vi", "nous", "we"], ["oss", "nous", "us"]],
  ["2e pl.", ["dere", "vous", "you"], ["dere", "vous", "you"]],
  ["3e pl.", ["de", "ils, elles", "they"], ["dem", "les, eux", "them"]],
  ["réfléchi", ["—", "", ""], ["seg", "se, soi", "himself, herself…"]],
  ["indéfini", ["man", "on", "one"], ["en", "on (objet)", "one"]],
];

// Possessives: [owner, [[form, fr, en], …]]; one form = invariable
const POSSESS = [
  [["jeg", "je", "I"], [["min", "mon", "my"], ["mi", "ma", "my"], ["mitt", "mon", "my"], ["mine", "mes", "my"]]],
  [["du", "tu", "you"], [["din", "ton", "your"], ["di", "ta", "your"], ["ditt", "ton", "your"], ["dine", "tes", "your"]]],
  [["han", "il", "he"], [["hans", "son, sa, ses (à lui)", "his"]]],
  [["hun", "elle", "she"], [["hennes", "son, sa, ses (à elle)", "her"]]],
  [["den / det", "la chose", "it"], [["dens / dets", "son, sa (de la chose)", "its"]]],
  [["vi", "nous", "we"], [["vår", "notre", "our"], ["vår", "notre", "our"], ["vårt", "notre", "our"], ["våre", "nos", "our"]]],
  [["dere", "vous", "you"], [["deres", "votre, vos", "your"]]],
  [["de", "ils, elles", "they"], [["deres", "leur, leurs", "their"]]],
  [["seg", "le sujet", "the subject"], [["sin", "son", "his/her own"], ["si", "sa", "his/her own"], ["sitt", "son", "his/her own"], ["sine", "ses", "his/her own"]]],
  [["man", "on", "one"], [["ens", "son, sa (de on)", "one's"]]],
];

// A cell: the Norwegian form, its translation underneath
const gl = (fr, en) => state.lang === "en" ? en : state.lang === "fr" ? fr : (en && fr !== en ? `${fr}<br>${en}` : fr);
function pcell(no, fr, en, cls = "") {
  if (no === "—") return `<td class="${cls}">—</td>`;
  return `<td class="${cls}">${vf(no)}<br><span class="muted">${gl(fr, en)}</span></td>`;
}

function renderPronouns() {
  const personal = PERSONAL.map(([label, [s, sfr, sen], [o, ofr, oen]]) => `<tr>
      <td class="gl muted">${label}</td>${pcell(s, sfr, sen, "inf")}${pcell(o, ofr, oen)}</tr>`).join("");
  const possessive = POSSESS.map(([[own, ofr, oen], forms]) => `<tr>
      ${pcell(own, ofr, oen, "inf")}
      ${forms.length === 4 ? forms.map(([f, ffr, fen]) => pcell(f, ffr, fen)).join("")
        : `<td colspan="4">${vf(forms[0][0])}<br><span class="muted">${gl(forms[0][1], forms[0][2])} — ne change jamais</span></td>`}
      </tr>`).join("");
  const others = WORDS.filter((w) => (w.pos === "pron" || w.pos === "det") && inLevel(w))
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  const adverbs = WORDS.filter((w) => w.pos === "adv" && inLevel(w))
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  // Meaning | word | its other forms (mye → mer, mest; fortsatt → fremdeles) | sentences
  const wordTable = (list) => `<div class="table-wrap"><table class="vt">
      <thead><tr><th>Meaning</th><th>Word</th><th>Forms</th><th></th></tr></thead>
      <tbody>${list.map((w) => `<tr>
        <td class="gl">${glossCell(w)}</td>
        <td class="inf">${vf(w.lemma, w)}</td>
        <td>${w.variants.filter((v) => v !== w.lemma.toLowerCase()).map((v) => vf(v, w)).join(", ")}</td>
        <td><button class="more" data-id="${esc(w.id)}">📚 ${countFor(w.id)}</button></td></tr>`).join("")}</tbody></table></div>`;
  document.getElementById("pronouns").innerHTML = `
    <h2 class="vh">Personal pronouns</h2>
    <div class="table-wrap"><table class="vt">
      <thead><tr><th></th><th>Subject <span class="muted">jeg ser…</span></th><th>Object <span class="muted">…ser meg</span></th></tr></thead>
      <tbody>${personal}</tbody></table></div>
    <div class="note-box">
      <p><b>Objet :</b> <i>ham</i> à l'écrit, mais <i>han</i> est très courant à l'oral (<i>Jeg så han i går</i>).
         De même <i>dem</i> à l'écrit, <i>dom</i> dans beaucoup de dialectes.</p>
      <p><b>den ou det ?</b> <i>den</i> pour un nom masculin ou féminin (<i>bilen → den</i>), <i>det</i> pour un neutre (<i>huset → det</i>).</p>
    </div>

    <h2 class="vh">Possessives</h2>
    <div class="note-box">
      <p>Le possessif s'accorde avec <b>la chose possédée</b>, pas avec le possesseur : <i>bilen min</i>, <i>boka mi</i>, <i>huset mitt</i>, <i>barna mine</i>.</p>
    </div>
    <div class="table-wrap"><table class="vt">
      <thead><tr><th>Owner</th>
        <th>Masculine<br><span class="muted">bilen …</span></th>
        <th>Feminine<br><span class="muted">boka …</span></th>
        <th>Neuter<br><span class="muted">huset …</span></th>
        <th>Plural<br><span class="muted">barna …</span></th></tr></thead>
      <tbody>${possessive}</tbody></table></div>
    <div class="note-box">
      <p><b>Après le nom</b> (le plus courant à l'oral) : le nom prend sa forme définie, <i>bilen min</i>, et non <i>bil min</i>.
         <b>Devant le nom</b>, c'est insistant : <i>min bil</i> = MA voiture.</p>
      <p><b>sin ou hans ?</b> <i>Han elsker kona si</i> = sa propre femme · <i>Han elsker kona hans</i> = la femme d'un autre.</p>
      <p>À l'écrit, le féminin <i>mi / di / si</i> est souvent remplacé par <i>min / din / sin</i> (<i>boken min</i>) ; à l'oral dans ta région, on dit <i>boka mi</i>.</p>
      <p>Tap a form to hear it.</p>
    </div>

    <h2 class="vh">Other pronouns and determiners <span class="badge">${others.length}</span></h2>
    ${wordTable(others)}

    <h2 class="vh">Adverbs <span class="badge">${adverbs.length}</span></h2>
    ${wordTable(adverbs)}`;
}

// ---------- popover ----------
const pop = document.getElementById("pop");
function showPop(anchor, tok) {
  const w = BY_ID[tok.w];
  if (!w) { pop.hidden = true; return; }
  const rows = formRows(w);
  const n = sentencesWith(w.id).length;
  pop.innerHTML = `
    <div class="lemma">${lemmaHTML(w)} <span class="badge cat">${esc(catLabel(w))}</span></div>
    <div class="gloss">${glossHTML(w)}</div>
    ${rows.length ? `<table class="ftable">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${vfRow(v, w)}</td></tr>`).join("")}</table>` : ""}
    ${w.pos === "verb" && (tok.t || "").toLowerCase() === w.lemma + "s" ? `<div class="note"><b>${esc(tok.t.toLowerCase())}</b> = forme en <b>-s</b> de <i>${esc(w.lemma)}</i> :
      réciproque (<i>vi ses</i> = on se voit, <i>vi møtes</i> = on se retrouve) ou passif (<i>døra lukkes</i> = la porte est fermée).</div>` : ""}
    ${tok.x ? `<div class="note">Bonus word: level ${w.level}</div>` : ""}
    <button class="pop-more" data-id="${esc(w.id)}">📚 See sentences (${n})</button>`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(16, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 16);
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 70) top = Math.max(8, r.top - ph - 8);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

// ---------- sheet: all sentences containing a word ----------
const sheet = document.getElementById("sheet");
function openSheet(id) {
  const w = BY_ID[id];
  if (!w) return;
  pop.hidden = true;
  const all = sentencesWith(id);
  const here = all.filter((s) => s.level <= state.level);
  const above = all.filter((s) => s.level > state.level);
  const rows = formRows(w);
  document.getElementById("sheetTitle").innerHTML = lemmaHTML(w);
  document.getElementById("sheetBody").innerHTML = `
    <div class="gloss">${glossHTML(w)}</div>
    ${rows.length ? `<table class="ftable">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${vfRow(v, w)}</td></tr>`).join("")}</table>` : ""}
    <p class="count">${here.length} sentence${here.length > 1 ? "s" : ""} at level ${state.level}</p>
    <div class="sheet-list ${state.hideTr ? "hide-tr" : ""}">
      ${here.map((s) => sentenceHTML(s, id)).join("") || `<p class="empty">No sentences at this level.</p>`}
      ${above.length ? `<p class="count">At higher levels: ${above.length}</p>` + above.map((s) => sentenceHTML(s, id)).join("") : ""}
    </div>`;
  sheet.hidden = false;
  document.body.classList.add("noscroll");
  document.getElementById("sheetBody").scrollTop = 0;
}
function closeSheet() {
  sheet.hidden = true;
  document.body.classList.remove("noscroll");
}

// ---------- controls ----------
function syncControls() {
  document.querySelectorAll("#levelSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.level === state.level));
  document.querySelectorAll("#langSeg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === state.lang));
  document.querySelectorAll("#voiceSeg button").forEach((b) => b.classList.toggle("on", b.dataset.voice === state.voice));
  document.querySelectorAll("#speedSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.speed === state.speed));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + state.view));
  document.getElementById("hideTr").checked = state.hideTr;
  document.getElementById("onlyLevel").checked = state.only;
  document.getElementById("themeSel").value = state.theme;
  document.getElementById("listSel").value = state.list;
  document.getElementById("posSel").value = state.pos;
}

function render() {
  syncControls();
  pop.hidden = true;
  if (state.view === "mots") renderWords();
  if (state.view === "phrases") renderSentences();
  if (state.view === "verbes") renderVerbs();
  if (state.view === "pronoms") renderPronouns();
  document.querySelectorAll(".note-box").forEach(makeClickable);
  save();
}

function fillSelects() {
  const groupsOf = (lst) => [...new Set(WORDS.filter((w) => w.list === lst && w.group).map((w) => w.group))];
  document.getElementById("listSel").innerHTML =
    `<option value="">All words</option><option value="core">Most frequent</option>` +
    `<optgroup label="Essentials">` +
    groupsOf("essentials").map((g) => `<option value="g:${esc(g)}">${esc(g)}</option>`).join("") +
    `</optgroup><optgroup label="Work and local life">` +
    groupsOf("theme").map((g) => `<option value="g:${esc(g)}">${esc(g)}</option>`).join("") + `</optgroup>`;
  document.getElementById("posSel").innerHTML = `<option value="">All categories</option>` +
    CATEGORIES.map(([key, label]) => `<option value="${key}">${label}</option>`).join("");
  const themes = new Map();
  SENTENCES.forEach((s) => s.theme && themes.set(s.theme, s.themeLabel || s.theme));
  document.getElementById("themeSel").innerHTML = `<option value="">All themes</option>` +
    [...themes].map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
}

// Clicks inside any list of sentence cards (main list or sheet)
function onSentenceClick(e) {
  const art = e.target.closest(".sent"); if (!art) return;
  const s = SENT_BY_ID[art.dataset.id];
  const tokEl = e.target.closest(".tok");
  const btn = e.target.closest(".play");
  const tr = e.target.closest(".tr");
  if (tokEl) {
    const tok = s.tokens[+tokEl.dataset.i];
    playWord(tok.t, tokEl, s.id);
    showPop(tokEl, tok);
    e.stopPropagation();
  } else if (btn) {
    playSentence(s, btn.closest(".sent") || btn);   // the whole card lifts while it is read
  } else if (tr && tr.closest(".hide-tr")) {
    tr.classList.toggle("shown");
  }
}
function onSentenceDblClick(e) {
  const tokEl = e.target.closest(".tok"); if (!tokEl) return;
  const s = SENT_BY_ID[tokEl.closest(".sent").dataset.id];
  const tok = s.tokens[+tokEl.dataset.i];
  if (tok.w) openSheet(tok.w);
}

function bind() {
  const seg = (id, fn) => (document.getElementById(id).onclick = (e) => {
    const b = e.target.closest("button"); if (b) fn(b);
  });
  seg("levelSeg", (b) => { state.level = +b.dataset.level; resetList(); render(); });
  seg("langSeg", (b) => { state.lang = b.dataset.lang; render(); });
  seg("voiceSeg", (b) => { state.voice = b.dataset.voice; syncControls(); save(); });
  seg("speedSeg", (b) => { state.speed = +b.dataset.speed; if (!/\/s0\d\d\//.test(player.src)) player.playbackRate = state.speed; syncControls(); save(); });
  document.querySelector(".tabs").onclick = (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;   // only the 4 tab buttons (not ➜ ▶ ✕ of the translation lines)
    rememberScroll();                                  // keep the place in the view we leave
    state.view = b.dataset.view; render(); restoreScroll();
  };
  document.getElementById("search").oninput = (e) => { state.q = e.target.value; renderWords(); };
  document.getElementById("verbSearch").oninput = (e) => { state.vq = e.target.value; renderVerbs(); };
  document.addEventListener("click", (e) => {
    const d = e.target.closest(".drill");
    if (d) return drillToggle(d.dataset.id);
    const ctrl = e.target.closest(".drill-ctrl button");
    if (ctrl) return drillGroup(ctrl.closest(".drill-ctrl").dataset.cls, ctrl.dataset.act);
    const more = e.target.closest(".more");
    if (more && !e.target.closest(".word")) return openSheet(more.dataset.id);
    const form = e.target.closest(".vf");
    if (form) { tapWord(form, form.dataset.t); e.stopPropagation(); }
  });
  document.querySelectorAll(".note-box").forEach(makeClickable);
  document.getElementById("trForm").onsubmit = (e) => {
    e.preventDefault();
    const q = document.getElementById("trInput").value.trim();
    if (q) translateBar(q);
  };
  // the bottom bar grows with the translation line: keep the page content clear of it
  const bar = document.querySelector(".tabs");
  new ResizeObserver(() => { document.body.style.paddingBottom = bar.offsetHeight + 12 + "px"; }).observe(bar);
  document.getElementById("sentSearch").oninput = (e) => { state.sq = e.target.value; resetList(); renderSentences(); };
  document.getElementById("listSel").onchange = (e) => { state.list = e.target.value; render(); };
  document.getElementById("posSel").onchange = (e) => { state.pos = e.target.value; render(); };
  document.getElementById("themeSel").onchange = (e) => { state.theme = e.target.value; resetList(); render(); };
  document.getElementById("hideTr").onchange = (e) => { state.hideTr = e.target.checked; render(); };
  document.getElementById("onlyLevel").onchange = (e) => { state.only = e.target.checked; resetList(); render(); };

  const words = document.getElementById("words");
  words.onclick = (e) => {
    const li = e.target.closest(".word"); if (!li) return;
    if (e.target.closest(".vf")) return; // a form: handled by the global word handler
    if (e.target.closest(".more")) return openSheet(li.dataset.id);
    const w = BY_ID[li.dataset.id];
    if (w) playWord(w.lemma, li);   // the whole card lifts, as when the ▶ of a sentence is pressed
  };
  words.ondblclick = (e) => {
    const li = e.target.closest(".word"); if (li) openSheet(li.dataset.id);
  };

  const sentences = document.getElementById("sentences");
  sentences.onclick = (e) => {
    if (e.target.id === "loadMore") { state.shown += PAGE; save(); renderSentences(); return; }
    onSentenceClick(e);
  };
  sentences.ondblclick = onSentenceDblClick;
  const sheetBody = document.getElementById("sheetBody");
  sheetBody.onclick = onSentenceClick;
  sheetBody.ondblclick = onSentenceDblClick;

  pop.onclick = (e) => {
    const b = e.target.closest(".pop-more"); if (b) openSheet(b.dataset.id);
    const form = e.target.closest(".vf");
    if (form) { playWord(form.dataset.t, form); e.stopPropagation(); }
  };
  document.getElementById("sheetClose").onclick = closeSheet;
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); pop.hidden = true; } });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tok") && !e.target.closest(".vf") && !e.target.closest(".pop")) pop.hidden = true;
  });
  window.addEventListener("scroll", () => { pop.hidden = true; }, { passive: true });
  sheetBody.addEventListener("scroll", () => { pop.hidden = true; }, { passive: true });
  window.addEventListener("scroll", rememberScroll, { passive: true });
  window.addEventListener("pagehide", () => { rememberScroll(); save(); });
}

async function init() {
  load();
  const [w, s] = await Promise.all([
    fetch("data/words.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/sentences.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  WORDS = w; SENTENCES = s;
  const hash = location.hash.slice(1);  // #phrases, #mots, #verbes, #pronoms open that tab directly
  if (["phrases", "mots", "verbes", "pronoms"].includes(hash)) state.view = hash;
  WORDS.forEach((x) => (BY_ID[x.id] = x));
  SENTENCES.forEach((x) => (SENT_BY_ID[x.id] = x));
  fillSelects();
  document.querySelectorAll(".legend-slot").forEach((el) => (el.innerHTML = LEGEND));
  // A saved filter that no longer exists (renamed group or theme) falls back to "all"
  const has = (id, v) => [...document.getElementById(id).options].some((o) => o.value === v);
  if (!has("listSel", state.list)) state.list = "";
  if (!has("themeSel", state.theme)) state.theme = "";
  if (!has("posSel", state.pos)) state.pos = "";
  bind();
  render();
  restoreScroll();   // back where you left off
}

init();
