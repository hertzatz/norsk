"use strict";

const state = { level: 300, lang: "both", voice: "alt", speed: 1, view: "phrases", theme: "", list: "", pos: "", hideTr: false, only: false, q: "", sq: "", vq: "" };
let WORDS = [], SENTENCES = [], BY_ID = {}, SENT_BY_ID = {};
const PAGE = 50;
let shown = PAGE;

// ---------- storage (per-device convenience only) ----------
function load() {
  try { Object.assign(state, JSON.parse(localStorage.getItem("norsk.settings") || "{}")); } catch (e) {}
  state.q = "";
  state.sq = "";
  state.vq = "";
}
function save() {
  try {
    const { level, lang, voice, speed, view, theme, list, pos, hideTr, only } = state;
    localStorage.setItem("norsk.settings", JSON.stringify({ level, lang, voice, speed, view, theme, list, pos, hideTr, only }));
  } catch (e) {}
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

function play(src, text, el = null) {
  const rate = state.speed;
  if (playingEl) playingEl.classList.remove("playing");
  playingEl = el;
  if (el) el.classList.add("playing");
  player.onerror = () => speakFallback(text, rate);
  player.onended = () => { if (el) el.classList.remove("playing"); };
  player.src = src;
  player.preservesPitch = true;
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
  player.play().catch(() => speakFallback(text, rate));
}
const playWord = (text, el, key = text) => play(`audio/${voiceFor(key)}/w/${slug(text)}.mp3`, text, el);
const playSentence = (s, el) => play(`audio/${voiceFor(s.id)}/s/${s.id}.mp3`, s.no, el);

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

function formsLine(w) {
  const f = w.forms;
  if (!f) return "";
  if (w.pos === "noun") return [f.def, f.pl, f.defpl].map(first).join(" · ");
  if (w.pos === "npl") return f.defpl ? first(f.defpl) : "";
  if (w.pos === "verb") return `pres. ${first(f.pres)} · past ${first(f.past)} · perf. har ${first(f.perf)}` +
    (MODALS.has(w.lemma) ? "" : ` · fut. skal ${f.inf}`);
  if (w.pos === "adj") {
    const parts = [f.neut, f.pl].map(first);
    if (f.comp && f.comp !== f.base) parts.push(first(f.comp), first(f.sup));
    return parts.join(" · ");
  }
  return "";
}

function glossHTML(w) {
  const fr = `<div><span class="lang">FR</span>${esc(w.fr)}</div>`;
  const en = `<div><span class="lang">EN</span>${esc(w.en)}</div>`;
  return state.lang === "fr" ? fr : state.lang === "en" ? en : fr + en;
}

function lemmaHTML(w) {
  const art = w.pos === "noun" && w.gender ? `<span class="art">${ART[w.gender]}</span> ` : "";
  const verb = w.pos === "verb" ? `<span class="art">å</span> ` : "";
  return art + verb + esc(w.lemma);
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
  const w = wordForForm(text);
  if (w) showPop(el, { t: text, w: w.id });
  else pop.hidden = true;
}

// Wrap the Norwegian examples (<i>…</i>) of a note box into clickable words
function makeClickable(root) {
  root.querySelectorAll("i").forEach((i) => {
    if (i.querySelector(".vf")) return;
    i.innerHTML = i.textContent.split(/(\s+|[,.;:!?…()«»"]+)/).map((part) =>
      /^[\wæøåÆØÅ-]+$/.test(part) ? `<span class="vf" data-t="${esc(part)}">${esc(part)}</span>` : esc(part)).join("");
  });
}

const sentencesWith = (id) => SENTENCES.filter((s) => s.tokens.some((t) => t.w === id))
  .sort((a, b) => a.level - b.level || a.no.length - b.no.length);

// ---------- sentence card (used in the list and in the sheet) ----------
function sentenceHTML(s, hitId = null) {
  const toks = s.tokens.map((t, i) => {
    if (!t.w && !t.name) return esc(t.t);
    const cls = ["tok", t.name && "name", t.x && "extra", hitId && t.w === hitId && "hit"].filter(Boolean).join(" ");
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
      <div class="meta">level ${s.level}${s.theme ? " · " + esc(s.themeLabel || s.theme) : ""}</div>
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
        <div class="forms">${esc(formsLine(w))}</div>
        <div class="gloss">${glossHTML(w)}</div>
      </div>
      <button class="more" aria-label="See sentences">📚 ${countFor(w.id)}<span> sentences</span></button>
    </li>`).join("") : `<li class="empty">No words found.</li>`;
}

// ---------- sentences view ----------
function filteredSentences() {
  const q = fold(state.sq.trim());
  return SENTENCES.filter((s) => sentInLevel(s) && (!state.theme || s.theme === state.theme) &&
    (!q || fold(s.no).includes(q) || fold(s.fr).includes(q) || fold(s.en).includes(q)));
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
  box.innerHTML = list.slice(0, shown).map((s) => sentenceHTML(s)).join("") +
    (list.length > shown ? `<button class="load-more" id="loadMore">Show more (${list.length - shown} left)</button>` : "");
}

// ---------- verbs view ----------
const VERB_GROUPS = [
  ["irr", "Irregular verbs", "Learn by heart: the past and the participle change (gå → gikk → gått)."],
  ["v1", "Regular, group 1: -a / -et", "snakke → snakka (snakket) → har snakka. The largest group."],
  ["v2", "Regular, group 2: -te / -t", "spise → spiste → har spist."],
  ["v3", "Regular, group 3: -de / -dd", "prøve → prøvde → har prøvd · bo → bodde → har bodd."],
];

// A clickable form; "/" alternatives become separate clickable forms
function vf(text) {
  return (text || "").split("/").map((x) => x.trim()).filter(Boolean)
    .map((x) => `<span class="vf" data-t="${esc(x)}">${esc(x)}</span>`).join(" / ");
}

// "har vært / vart" -> each Norwegian word clickable, keeping separators
function vfRow(text) {
  return String(text).split(/(\s+|\/|·|!)/).map((part) =>
    /^[\wæøåÆØÅ-]+$/.test(part) ? `<span class="vf" data-t="${esc(part)}">${esc(part)}</span>` : esc(part)).join("");
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
        <td class="inf">${vfRow("å " + f.inf)}</td>
        <td>${vf(f.pres)}</td>
        <td>${vf(f.past)}</td>
        <td>${vfRow("har " + f.perf)}</td>
        <td>${modal ? "—" : vfRow("skal " + f.inf)}</td>
        <td>${modal ? "—" : vf(imperative(f.inf))}</td>
        <td><button class="more" data-id="${esc(w.id)}">📚 ${countFor(w.id)}</button></td>
      </tr>`;
    }).join("");
    return `<h2 class="vh">${title} <span class="badge">${list.length}</span></h2>
      <p class="hint">${help}</p>
      <div class="table-wrap"><table class="vt">
        <thead><tr><th>Meaning</th><th>Infinitive</th><th>Present</th><th>Past</th><th>Perfect</th><th>Future</th><th>Imperative</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }).join("") || `<p class="empty">No verbs found.</p>`;
}

// ---------- pronouns view ----------
const PERSONAL = [
  ["1st sg.", "jeg", "meg", "min / mi / mitt / mine", "je, moi · mon, ma, mes", "I, me · my"],
  ["2nd sg.", "du", "deg", "din / di / ditt / dine", "tu, toi · ton, ta, tes", "you · your"],
  ["3rd sg. masc.", "han", "ham", "hans", "il, lui · son, sa, ses (à lui)", "he, him · his"],
  ["3rd sg. fem.", "hun", "henne", "hennes", "elle · son, sa, ses (à elle)", "she, her · her"],
  ["3rd sg. thing", "den / det", "den / det", "dens", "il, elle (chose) · son", "it · its"],
  ["1st pl.", "vi", "oss", "vår / vårt / våre", "nous · notre, nos", "we, us · our"],
  ["2nd pl.", "dere", "dere", "deres", "vous · votre, vos", "you · your"],
  ["3rd pl.", "de", "dem", "deres", "ils, elles, eux · leur, leurs", "they, them · their"],
  ["reflexive", "—", "seg", "sin / si / sitt / sine", "se · son, sa, ses (à soi)", "himself… · his own"],
  ["general", "man", "en", "ens", "on", "one"],
];

// "min / mi / mitt / mine" -> four cells; an invariable possessive fills all four
function possCells(poss) {
  const parts = poss.split("/").map((x) => x.trim());
  const four = parts.length === 4 ? parts : parts.length === 3 ? [parts[0], parts[0], parts[1], parts[2]]
    : parts.length === 2 ? [parts[0], parts[0], parts[1], "—"] : [parts[0], parts[0], parts[0], parts[0]];
  return four.map((x) => `<td>${x === "—" ? "—" : vf(x)}</td>`).join("");
}

function renderPronouns() {
  const personal = PERSONAL.map(([p, subj, obj, poss, fr, en]) => `<tr>
      <td class="gl">${state.lang === "en" ? en : state.lang === "fr" ? fr : `${fr}<br><span class="muted">${en}</span>`}<br><span class="muted">${p}</span></td>
      <td class="inf">${subj === "—" ? "—" : vf(subj)}</td><td>${vf(obj)}</td>${possCells(poss)}</tr>`).join("");
  const others = WORDS.filter((w) => (w.pos === "pron" || w.pos === "det") && inLevel(w))
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  document.getElementById("pronouns").innerHTML = `
    <h2 class="vh">Personal and possessive pronouns</h2>
    <div class="table-wrap"><table class="vt">
      <thead>
        <tr><th rowspan="2">Meaning</th><th rowspan="2">Subject</th><th rowspan="2">Object</th><th colspan="4" class="grp">Possessive, by the owned noun</th></tr>
        <tr><th>Masculine</th><th>Feminine</th><th>Neuter</th><th>Plural</th></tr>
      </thead>
      <tbody>${personal}</tbody></table></div>
    <div class="note-box">
      <p><b>Possessif après le nom</b> (le plus courant à l'oral) : <i>bilen min</i> (ma voiture), <i>huset vårt</i> (notre maison).</p>
      <p><b>Accord :</b> <i>min</i> (masc.), <i>mi</i> (fém.), <i>mitt</i> (neutre), <i>mine</i> (pluriel) : <i>bilen min, kona mi, huset mitt, barna mine</i>.</p>
      <p><b>sin ou hans ?</b> <i>Han elsker kona si</i> = sa propre femme · <i>Han elsker kona hans</i> = la femme d'un autre homme.</p>
      <p>Tap a form to hear it.</p>
    </div>
    <h2 class="vh">Possessive agreement</h2>
    <div class="note-box">
      <p>Le possessif s'accorde avec <b>la chose possédée</b> (son genre et son nombre en norvégien), pas avec le possesseur.
         Le genre norvégien n'est pas le genre français : <i>ei bok</i> (féminin), <i>et hus</i> (neutre).
         L'article affiché devant chaque nom (onglet Mots) donne le genre.</p>
    </div>
    <div class="table-wrap"><table class="vt">
      <thead><tr><th>Meaning</th><th>Masculine (en)</th><th>Feminine (ei)</th><th>Neuter (et)</th><th>Plural</th></tr></thead>
      <tbody>
        ${[["mon, ma, mes", "min"], ["ton, ta, tes", "din"], ["son, sa, ses (à soi)", "sin"], ["notre, nos", "vår"],
           ["son, sa, ses (à lui)", "hans"], ["son, sa, ses (à elle)", "hennes"], ["votre ; leur", "deres"]]
          .map(([fr, key]) => `<tr><td class="gl">${fr}</td>${AGREE[key].map((x) => `<td>${vf(x)}</td>`).join("")}</tr>`).join("")}
        <tr><td class="gl muted">example</td><td><i>bilen ${vf("din")}</i><br><span class="muted">ta voiture</span></td>
          <td><i>boka ${vf("di")}</i><br><span class="muted">ton livre</span></td>
          <td><i>huset ${vf("ditt")}</i><br><span class="muted">ta maison</span></td>
          <td><i>barna ${vf("dine")}</i><br><span class="muted">tes enfants</span></td></tr>
      </tbody></table></div>
    <div class="note-box">
      <p><b>Après le nom</b> (le plus courant) : le nom prend sa forme définie : <i>bilen min</i>, pas <i>bil min</i>.
         <b>Devant le nom</b>, c'est plus insistant : <i>min bil</i> = MA voiture.</p>
      <p><b>hans, hennes, deres</b> ne changent jamais : <i>bilen hans, huset hans, barna hans</i>.</p>
      <p>À l'écrit, le féminin <i>mi / di / si</i> est souvent remplacé par <i>min / din / sin</i> (<i>boken min</i>) ; à l'oral dans ta région, on dit plutôt <i>boka mi</i>.</p>
    </div>
    <h2 class="vh">Other pronouns and determiners <span class="badge">${others.length}</span></h2>
    <div class="table-wrap"><table class="vt">
      <thead><tr><th>Meaning</th><th>Word</th><th>Forms</th><th></th></tr></thead>
      <tbody>${others.map((w) => `<tr>
        <td class="gl">${glossCell(w)}</td>
        <td class="inf">${vf(w.lemma)}</td>
        <td>${w.variants.filter((v) => v !== w.lemma.toLowerCase()).map((v) => vf(v)).join(", ")}</td>
        <td><button class="more" data-id="${esc(w.id)}">📚 ${countFor(w.id)}</button></td></tr>`).join("")}</tbody></table></div>`;
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
    ${rows.length ? `<table class="ftable">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${vfRow(v)}</td></tr>`).join("")}</table>` : ""}
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
  document.getElementById("sheetTitle").innerHTML = `<span class="vf" data-t="${esc(w.lemma)}">${lemmaHTML(w)}</span>`;
  document.getElementById("sheetBody").innerHTML = `
    <div class="gloss">${glossHTML(w)}</div>
    ${rows.length ? `<table class="ftable">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${vfRow(v)}</td></tr>`).join("")}</table>` : ""}
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
    playSentence(s, btn);
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
  seg("levelSeg", (b) => { state.level = +b.dataset.level; shown = PAGE; render(); });
  seg("langSeg", (b) => { state.lang = b.dataset.lang; render(); });
  seg("voiceSeg", (b) => { state.voice = b.dataset.voice; syncControls(); save(); });
  seg("speedSeg", (b) => { state.speed = +b.dataset.speed; player.playbackRate = state.speed; syncControls(); save(); });
  document.querySelector(".tabs").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.view = b.dataset.view; render(); window.scrollTo(0, 0);
  };
  document.getElementById("search").oninput = (e) => { state.q = e.target.value; renderWords(); };
  document.getElementById("verbSearch").oninput = (e) => { state.vq = e.target.value; renderVerbs(); };
  document.addEventListener("click", (e) => {
    const more = e.target.closest(".more");
    if (more && !e.target.closest(".word")) return openSheet(more.dataset.id);
    const form = e.target.closest(".vf");
    if (form) { tapWord(form, form.dataset.t); e.stopPropagation(); }
  });
  document.querySelectorAll(".note-box").forEach(makeClickable);
  document.getElementById("sentSearch").oninput = (e) => { state.sq = e.target.value; shown = PAGE; renderSentences(); };
  document.getElementById("listSel").onchange = (e) => { state.list = e.target.value; render(); };
  document.getElementById("posSel").onchange = (e) => { state.pos = e.target.value; render(); };
  document.getElementById("themeSel").onchange = (e) => { state.theme = e.target.value; shown = PAGE; render(); };
  document.getElementById("hideTr").onchange = (e) => { state.hideTr = e.target.checked; render(); };
  document.getElementById("onlyLevel").onchange = (e) => { state.only = e.target.checked; shown = PAGE; render(); };

  const words = document.getElementById("words");
  words.onclick = (e) => {
    const li = e.target.closest(".word"); if (!li) return;
    if (e.target.closest(".more")) return openSheet(li.dataset.id);
    const w = BY_ID[li.dataset.id];
    if (w) playWord(w.lemma, li.querySelector(".play"));
  };
  words.ondblclick = (e) => {
    const li = e.target.closest(".word"); if (li) openSheet(li.dataset.id);
  };

  const sentences = document.getElementById("sentences");
  sentences.onclick = (e) => {
    if (e.target.id === "loadMore") { shown += PAGE; renderSentences(); return; }
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
}

async function init() {
  load();
  const [w, s] = await Promise.all([
    fetch("data/words.json").then((r) => r.json()),
    fetch("data/sentences.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  WORDS = w; SENTENCES = s;
  const hash = location.hash.slice(1);  // #phrases, #mots, #verbes, #pronoms open that tab directly
  if (["phrases", "mots", "verbes", "pronoms"].includes(hash)) state.view = hash;
  WORDS.forEach((x) => (BY_ID[x.id] = x));
  SENTENCES.forEach((x) => (SENT_BY_ID[x.id] = x));
  fillSelects();
  // A saved filter that no longer exists (renamed group or theme) falls back to "all"
  const has = (id, v) => [...document.getElementById(id).options].some((o) => o.value === v);
  if (!has("listSel", state.list)) state.list = "";
  if (!has("themeSel", state.theme)) state.theme = "";
  if (!has("posSel", state.pos)) state.pos = "";
  bind();
  render();
}

init();
