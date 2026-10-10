// Fun, Food & Travel - phone-only version. Everything runs in the phone's
// browser: frames are sampled here, Claude is called directly with the
// owner's API key, and posts (with their photos/videos) are saved on the phone.

import { analyze, localInfo, DEMO_KEY } from "./ai.js";
import { makeLinks } from "./links.js";
import * as db from "./db.js";
import { renderShareBar } from "./social.js";
import { buildIndex, search as localSearch, smartSearch, getPost as searchGetPost, getAllPosts } from "./search.js";

const MAX_FRAMES = 12;
const FRAMES_PER_VIDEO = 6;
const MAX_SIDE = 1280;     // px sent to the AI
const GALLERY_SIDE = 2048; // px for saved photos
const COVER_SIDE = 600;    // px for the post list thumbnail
const MAX_VIDEO_MB = 500;

const VIDEO_TYPES = { mov: "video/quicktime", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm" };
const BADGES = { seen: "In your post", suggested: "Pack for this trip", nearby: "Nearby" };
// (heading, category, sources) in page order
const POST_SECTIONS = [
  ["Shop the look", "product", ["seen"]],
  ["Pack for this trip", "product", ["suggested"]],
  ["Stay", "hotel", ["seen", "nearby"]],
  ["Eat", "restaurant", ["seen", "nearby"]],
  ["Get around", "car_rental", ["seen", "nearby"]],
  ["Do", "experience", ["seen", "nearby"]],
  ["See", "place", ["seen", "nearby"]],
];

const $ = (id) => document.getElementById(id);
let frames = [];   // [{dataUrl, b64}] - what the AI sees
let picked = [];   // [{file, kind}] - what gets saved
let gps = null;    // {lat, lon} rounded
let analysis = null;
let objectUrls = []; // revoked when leaving a post view

// ---------- settings (this phone only) ----------

const SETTINGS_KEY = "fft-settings";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}
const apiKey = () => (loadSettings().apiKey || "").trim();
const links = () => makeLinks(loadSettings().ids || {});

function fillSettingsForm() {
  const s = loadSettings();
  $("api-key").value = s.apiKey || "";
  $("id-amazon").value = s.ids?.amazon || "";
  $("id-ebay").value = s.ids?.ebay || "";
  $("id-booking").value = s.ids?.booking || "";
  $("id-gyg").value = s.ids?.gyg || "";
  $("welcome").hidden = !!s.apiKey;
}

$("save-settings").addEventListener("click", () => {
  const key = $("api-key").value.trim();
  if (key && key !== DEMO_KEY && !key.startsWith("sk-ant-")) {
    return status("settings", "That doesn't look like an Anthropic key (they start with sk-ant-).");
  }
  const ok = saveSettings({
    apiKey: key,
    ids: {
      amazon: $("id-amazon").value.trim(), ebay: $("id-ebay").value.trim(),
      booking: $("id-booking").value.trim(), gyg: $("id-gyg").value.trim(),
    },
  });
  if (!ok) return status("settings", "Couldn't save. Private browsing may be blocking storage.");
  status("settings", "Saved.");
  if (key) location.hash = "#new";
});

// ---------- install prompt (Android + iPhone) ----------

let deferredInstallPrompt = null;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches
  || window.navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isAndroid = /Android/.test(navigator.userAgent);
const isIOSSafari = isIOS && typeof navigator.standalone !== "undefined"
  && !/CriOS|FxiOS|EdgiOS|FBAN|FBAV|Instagram|WhatsApp|GSA\//.test(navigator.userAgent);
const isInAppBrowser = isIOS && !isIOSSafari;
const bannerDismissed = () => { try { return localStorage.getItem("fft-install-dismissed"); } catch { return null; } };

function showInstallGuide(html) {
  const guide = $("install-guide");
  $("install-guide-content").innerHTML = html;
  guide.hidden = false;
  $("install-guide-close").onclick = () => { guide.hidden = true; };
}

function showInstallBanner() {
  if (isStandalone || bannerDismissed()) return;
  const banner = $("install-banner");
  if (!banner) return;

  if (isIOS && isInAppBrowser) {
    $("install-hint").textContent = "Open this page in Safari to install";
    $("install-action").textContent = "Copy link";
    $("install-action").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        showInstallGuide(
          `<p class="ig-step"><strong>Link copied!</strong></p>
           <p class="ig-step">1. Open <strong>Safari</strong> on your iPhone</p>
           <p class="ig-step">2. Tap the address bar and <strong>paste</strong> the link</p>
           <p class="ig-step">3. Tap the <strong>Share button</strong> <span class="ig-icon">⬆︎</span> at the bottom</p>
           <p class="ig-step">4. Scroll down and tap <strong>“Add to Home Screen”</strong></p>
           <p class="ig-step">5. Tap <strong>“Add”</strong></p>`
        );
      } catch {
        showInstallGuide(
          `<p class="ig-step">Copy this link and open it in <strong>Safari</strong>:</p>
           <p class="ig-link">${location.href}</p>
           <p class="ig-step">Then: <strong>Share</strong> <span class="ig-icon">⬆︎</span> → <strong>“Add to Home Screen”</strong> → <strong>“Add”</strong></p>`
        );
      }
    });
  } else if (isIOS) {
    $("install-hint").textContent = 'Tap Share ⬆︎ then "Add to Home Screen"';
    $("install-action").textContent = "Show me";
    $("install-action").addEventListener("click", () => {
      showInstallGuide(
        `<p class="ig-step">1. Tap the <strong>Share button</strong> <span class="ig-icon">⬆︎</span> at the bottom of Safari</p>
         <p class="ig-step">2. Scroll down the share sheet</p>
         <p class="ig-step">3. Tap <strong>“Add to Home Screen”</strong></p>
         <p class="ig-step">4. Tap <strong>“Add”</strong> in the top right</p>
         <p class="ig-done">The app icon will appear on your Home Screen!</p>`
      );
    });
  } else if (deferredInstallPrompt) {
    $("install-action").addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      banner.hidden = true;
    });
  } else if (isAndroid) {
    $("install-hint").textContent = "Tap ⋮ menu then \"Add to Home screen\" or \"Install app\"";
    $("install-action").textContent = "Got it";
    $("install-action").addEventListener("click", () => { banner.hidden = true; });
  } else {
    return;
  }
  $("install-dismiss").addEventListener("click", () => {
    banner.hidden = true;
    $("install-guide").hidden = true;
    try { localStorage.setItem("fft-install-dismissed", "1"); } catch {}
  });
  banner.hidden = false;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const banner = $("install-banner");
  if (banner) banner.hidden = true;
});

// ---------- audio extraction ----------

let audioData = null;

async function extractAudio(videoFile, maxDurationSec = 30) {
  try {
    const arrayBuffer = await videoFile.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();
    const duration = Math.min(audioBuffer.duration, maxDurationSec);
    const numSamples = Math.floor(duration * 16000);
    const channelData = audioBuffer.getChannelData(0);
    const samples = channelData.slice(0, numSamples);
    return encodeWav(samples, 16000);
  } catch {
    return null;
  }
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const w = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  w(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Uint8Array(buffer);
}

// ---------- routing ----------

function route() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  let [view, id] = (location.hash.slice(1) || "new").split("/");
  if (!apiKey() && view !== "settings") view = "settings";
  for (const v of ["new", "posts", "post", "search", "settings"]) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".tabs a")) {
    a.classList.toggle("active", a.dataset.tab === (view === "post" ? "posts" : view));
  }
  if (view === "settings") fillSettingsForm();
  if (view === "posts") renderPostList();
  if (view === "post") renderPost(id);
  if (view === "search") initSearch();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- Step 1: pick & sample ----------

async function handleFiles(ev) {
  const files = [...ev.target.files];
  if (!files.length) return;
  frames = [];
  picked = [];
  gps = null;
  audioData = null;
  $("thumbs").innerHTML = "";
  $("analyze").disabled = true;
  status("pick", "Preparing your media…");

  const problems = [];
  for (const file of files) {
    const isVideo = file.type.startsWith("video/") || videoType(file);
    try {
      if (isVideo) {
        if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`over ${MAX_VIDEO_MB} MB`);
        const room = Math.min(FRAMES_PER_VIDEO, MAX_FRAMES - frames.length);
        if (room > 0) for (const canvas of await sampleVideo(file, room)) addFrame(canvas);
        picked.push({ file, kind: "video" });
        if (!audioData) audioData = await extractAudio(file);
      } else {
        if (!gps) gps = await readGps(file);
        const canvas = await drawImage(file, MAX_SIDE);
        if (frames.length < MAX_FRAMES) addFrame(canvas);
        picked.push({ file, kind: "image" });
      }
    } catch (err) {
      console.warn(file.name, err);
      problems.push(`${file.name} (${err.message})`);
    }
  }
  $("analyze").disabled = frames.length === 0;
  let msg = `${picked.length} item${picked.length === 1 ? "" : "s"} ready (${frames.length} frames for the AI)`;
  if (gps) msg += " · location found in photo";
  if (audioData) msg += " · audio extracted for analysis";
  if (problems.length) msg += ` · couldn't read: ${problems.join(", ")}`;
  status("pick", msg);
}

for (const id of ["files", "camera-photo", "camera-video"]) {
  $(id).addEventListener("change", handleFiles);
}

function videoType(file) {
  if (Object.values(VIDEO_TYPES).includes(file.type)) return file.type;
  const ext = file.name.split(".").pop().toLowerCase();
  return VIDEO_TYPES[ext] || null;
}

function addFrame(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  frames.push({ dataUrl, b64: dataUrl.split(",")[1] });
  const img = document.createElement("img");
  img.src = dataUrl;
  $("thumbs").append(img);
}

function fitCanvas(source, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c;
}

async function drawImage(blob, maxSide) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // iPhone Safari converts HEIC for us
    return fitCanvas(img, img.naturalWidth, img.naturalHeight, maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitFor(el, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    el.addEventListener(event, () => { clearTimeout(t); resolve(); }, { once: true });
    el.addEventListener("error", () => { clearTimeout(t); reject(new Error("video can't be decoded here")); }, { once: true });
  });
}

async function sampleVideo(file, n) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  try {
    const loaded = waitFor(v, "loadeddata");
    v.load();
    await loaded;
    const out = [];
    for (let k = 0; k < n; k++) {
      // Evenly spaced, avoiding the very first/last frame (often black).
      const seeked = waitFor(v, "seeked");
      v.currentTime = (v.duration * (k + 0.5)) / n;
      await seeked;
      out.push(fitCanvas(v, v.videoWidth, v.videoHeight, MAX_SIDE));
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readGps(file) {
  if (!$("use-gps").checked || !window.exifr) return null;
  try {
    const g = await exifr.gps(file);
    if (!g || g.latitude == null) return null;
    // Round to 2 decimals (~1 km) so we never keep an exact home address.
    return { lat: +g.latitude.toFixed(2), lon: +g.longitude.toFixed(2) };
  } catch {
    return null; // many shared photos have location stripped - that's fine
  }
}

$("analyze").addEventListener("click", async () => {
  $("analyze").disabled = true;
  status("pick", "AI is looking at your photos… (about 20–40 seconds)");
  try {
    analysis = await analyze(apiKey(), frames.map((f) => f.b64), $("tags").value,
      $("use-gps").checked ? gps : null, audioData);
    showReview();
    if ($("place").value.trim()) loadLocal();
  } catch (err) {
    status("pick", err.message);
  } finally {
    $("analyze").disabled = false;
  }
});

// ---------- Step 2: review ----------

function showStep(step) {
  $("step-pick").hidden = step !== "pick";
  $("step-review").hidden = step !== "review";
  window.scrollTo(0, 0);
}

function showReview() {
  const loc = analysis.location;
  const place = [loc.name !== loc.city ? loc.name : "", loc.city, loc.country].filter(Boolean).join(", ");
  $("summary").textContent = analysis.summary;
  $("place").value = place;
  $("place-evidence").textContent = loc.evidence ? `How we know (${loc.confidence} confidence): ${loc.evidence}` : "";
  // Hide location by default when it might be someone's home or is a guess.
  $("show-place").checked = !!place && !loc.looks_like_private_home && loc.confidence !== "unknown";
  if (loc.looks_like_private_home) {
    $("place-evidence").textContent += " · Looks like a private home, so it's hidden by default.";
  }
  $("caption").value = analysis.suggested_caption;
  for (const id of ["items", "nearby", "local"]) $(id).innerHTML = "";
  status("local", place ? "" : "Add a location above, then tap Refresh below.");
  for (const item of analysis.items) addItemRow(item, "items");
  showStep("review");
}

function addItemRow(item, listId) {
  const li = $("item-tpl").content.firstElementChild.cloneNode(true);
  li.querySelector(".keep").checked = item.confidence !== "low";
  li.querySelector(".name").value = item.brand && !item.name.includes(item.brand) ? `${item.brand} ${item.name}` : item.name;
  li.querySelector(".category").value = item.category;
  li.querySelector(".query").value = item.search_query;
  li.querySelector(".badge").textContent = BADGES[item.source] || "Added by you";
  li.dataset.description = item.description || "";
  li.dataset.brand = item.brand || "";
  li.dataset.source = item.source || "seen";
  const frame = item.source === "seen" ? frames[item.frame_index] || frames[0] : null;
  if (frame) li.querySelector(".thumb").src = frame.dataUrl;
  else li.querySelector(".thumb").remove();
  $(listId).append(li);
  return li;
}

$("add-item").addEventListener("click", () => {
  const li = addItemRow({ name: "", category: "product", search_query: "", source: "seen" }, "items");
  li.querySelector(".badge").textContent = "Added by you";
  li.querySelector(".keep").checked = true;
  li.querySelector(".name").focus();
});

async function loadLocal() {
  const place = $("place").value.trim();
  if (!place) return status("local", "Add a location first.");
  $("get-local").disabled = true;
  status("local", `Searching the web for hotels, food, car rentals, tours and news near ${place}… (up to a minute)`);
  try {
    const res = await localInfo(apiKey(), place);
    $("nearby").innerHTML = "";
    for (const n of res.nearby || []) {
      addItemRow({ name: n.name, category: n.category, description: n.note, search_query: n.name,
                   source: "nearby", confidence: "medium" }, "nearby");
    }
    $("local").innerHTML = "";
    for (const n of (res.news || []).filter((n) => safeUrl(n.url))) {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `<input type="checkbox" class="keep" checked>
        <div class="grow"><span class="kind"></span> <a target="_blank" rel="noopener"></a>
        <p class="small muted"></p></div>`;
      li.querySelector(".kind").textContent = n.kind;
      li.querySelector("a").textContent = n.title;
      li.querySelector("a").href = n.url;
      li.querySelector("p").textContent = `${n.summary} — ${n.source}`;
      li.dataset.json = JSON.stringify(n);
      $("local").append(li);
    }
    const found = (res.nearby || []).length + (res.news || []).length;
    status("local", found ? "" : "Nothing found for this location.");
  } catch (err) {
    status("local", err.message);
  } finally {
    $("get-local").disabled = false;
  }
}

$("get-local").addEventListener("click", loadLocal);
$("back").addEventListener("click", () => showStep("pick"));

function collectItems(listId) {
  return [...$(listId).children]
    .filter((li) => li.querySelector(".keep").checked && li.querySelector(".name").value.trim())
    .map((li) => ({
      name: li.querySelector(".name").value.trim(),
      category: li.querySelector(".category").value,
      brand: li.dataset.brand,
      description: li.dataset.description,
      search_query: li.querySelector(".query").value.trim(),
      source: li.dataset.source,
    }));
}

$("publish").addEventListener("click", async () => {
  $("publish").disabled = true;
  try {
    status("review", "Saving to your phone…");
    const media = [];
    for (const p of picked) {
      if (p.kind === "image") {
        // Re-drawing the photo also strips its metadata (including exact GPS).
        const canvas = await drawImage(p.file, GALLERY_SIDE);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
        media.push({ kind: "image", type: "image/jpeg", name: "photo.jpg", blob });
      } else {
        const type = videoType(p.file) || p.file.type || "video/mp4";
        media.push({ kind: "video", type, name: p.file.name, blob: p.file });
      }
    }
    const coverImg = new Image();
    coverImg.src = frames[0].dataUrl;
    await coverImg.decode();
    const cover = fitCanvas(coverImg, coverImg.naturalWidth, coverImg.naturalHeight, COVER_SIDE)
      .toDataURL("image/jpeg", 0.8);

    const id = crypto.randomUUID();
    const sourceUrl = $("social-link").value.trim() || extractUrlFromTags($("tags").value);
    const collectedItems = [...collectItems("items"), ...collectItems("nearby")];
    const itemFrames = {};
    for (const item of collectedItems) {
      const frameIdx = analysis?.items?.find((ai) => ai.name === item.name)?.frame_index;
      if (frameIdx != null && frames[frameIdx]) itemFrames[item.name] = frames[frameIdx].dataUrl;
      else if (frames[0]) itemFrames[item.name] = frames[0].dataUrl;
    }
    const allFrameDataUrls = frames.map((f) => f.dataUrl);
    await db.savePost({
      id,
      created: Date.now(),
      caption: $("caption").value.trim(),
      place: $("show-place").checked ? $("place").value.trim() : "",
      sourceUrl: sourceUrl || "",
      location: analysis?.location || null,
      tags: $("tags").value.trim(),
      items: collectedItems,
      itemFrames,
      allFrames: allFrameDataUrls.slice(0, 6),
      news: [...$("local").children]
        .filter((li) => li.querySelector(".keep").checked)
        .map((li) => JSON.parse(li.dataset.json)),
      media,
      cover,
    });
    db.requestPersistence();
    resetNew();
    location.hash = `#post/${id}`;
  } catch (err) {
    status("review", `Couldn't save: ${err.message}`);
  } finally {
    $("publish").disabled = false;
  }
});

function extractUrlFromTags(text) {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : "";
}

function resetNew() {
  frames = []; picked = []; gps = null; analysis = null; audioData = null;
  $("files").value = ""; $("camera-photo").value = ""; $("camera-video").value = "";
  $("thumbs").innerHTML = ""; $("tags").value = ""; $("social-link").value = "";
  $("analyze").disabled = true;
  status("pick", ""); status("review", "");
  showStep("pick");
}

// ---------- My posts ----------

async function renderPostList() {
  const posts = await db.listPosts();
  $("posts-empty").hidden = posts.length > 0;
  $("post-list").innerHTML = "";
  for (const p of posts) {
    const li = document.createElement("li");
    li.innerHTML = `<a class="post-row"><img alt=""><div><strong></strong><p class="small muted"></p></div></a>`;
    li.querySelector("a").href = `#post/${p.id}`;
    li.querySelector("img").src = p.cover;
    li.querySelector("strong").textContent = p.caption || "Untitled post";
    li.querySelector("p").textContent = [p.place, new Date(p.created).toLocaleDateString()].filter(Boolean).join(" · ");
    $("post-list").append(li);
  }
}

// ---------- One post ----------

let currentPost = null;

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function safeUrl(url) {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

function linkButtons(list, extraClass = "") {
  const div = el("div", { class: `links ${extraClass}`.trim() });
  for (const l of list) div.append(el("a", { class: "btn", href: l.url, target: "_blank", rel: "noopener" }, l.label));
  return div;
}

async function renderPost(id) {
  const body = $("post-body");
  body.innerHTML = "";
  status("post", "");
  currentPost = await db.getPost(id);
  if (!currentPost) {
    body.append(el("p", { class: "muted" }, "This post isn't on this phone."));
    return;
  }
  const p = currentPost;
  const L = links();

  const gallery = el("div", { class: "gallery" });
  for (const m of p.media) {
    const url = URL.createObjectURL(m.blob);
    objectUrls.push(url);
    if (m.kind === "video") {
      gallery.append(el("video", { src: url, controls: "", playsinline: "", preload: "metadata" }));
    } else {
      gallery.append(el("img", { src: url, alt: "" }));
    }
  }
  body.append(gallery);
  if (p.media.length > 1) body.append(el("p", { class: "gallery-count" }, `${p.media.length} photos & videos — swipe`));

  body.append(el("h1", {}, p.caption));
  if (p.sourceUrl) {
    const srcLink = el("a", { href: p.sourceUrl, target: "_blank", rel: "noopener", class: "source-link" }, `🔗 ${p.sourceUrl}`);
    body.append(el("p", { class: "source" }, srcLink));
  }
  if (p.place) {
    body.append(el("p", { class: "place" }, `📍 ${p.place}`));
    body.append(linkButtons(L.forPlace(p.place), "explore"));
  }

  for (const [heading, cat, sources] of POST_SECTIONS) {
    const items = p.items.filter((i) => i.category === cat && sources.includes(i.source || "seen"));
    if (!items.length) continue;
    body.append(el("h2", {}, heading));
    const ul = el("ul", { class: "cards" });
    for (const item of items) {
      const li = el("li", { class: "card" });
      const top = el("div");
      top.append(el("strong", {}, item.name));
      if (item.brand) top.append(" ", el("span", { class: "brand" }, item.brand));
      if (item.description) top.append(el("p", {}, item.description));
      li.append(top, linkButtons(L.forItem(item, p.place)));
      ul.append(li);
    }
    body.append(ul);
  }

  const news = p.news.filter((n) => safeUrl(n.url));
  if (news.length) {
    body.append(el("h2", {}, "Good to know"));
    const ul = el("ul", { class: "cards" });
    for (const n of news) {
      const li = el("li", { class: "card" });
      const div = el("div");
      div.append(el("span", { class: "kind" }, n.kind), " ",
        el("a", { href: n.url, target: "_blank", rel: "noopener" }, n.title));
      const para = el("p", {}, `${n.summary} `);
      para.append(el("span", { class: "src" }, n.source));
      div.append(para);
      li.append(div);
      ul.append(li);
    }
    body.append(ul);
  }
  body.append(el("p", { class: "disclosure" },
    "Some links are affiliate links. If you buy or book through them, the creator may earn a commission at no extra cost to you."));
  updatePostShareBar();
}

function shareText(p) {
  const L = links();
  const lines = [p.caption];
  if (p.sourceUrl) lines.push("", `🔗 ${p.sourceUrl}`);
  if (p.place) lines.push(`📍 ${p.place}`);
  for (const [heading, cat, sources] of POST_SECTIONS) {
    const items = p.items.filter((i) => i.category === cat && sources.includes(i.source || "seen"));
    if (!items.length) continue;
    lines.push("", `${heading}:`);
    for (const item of items) lines.push(`• ${item.name}: ${L.forItem(item, p.place)[0].url}`);
  }
  lines.push("", "(Some links are affiliate links.)");
  return lines.join("\n");
}

$("share-preview").addEventListener("click", async () => {
  const caption = $("caption").value.trim();
  const place = $("place").value.trim();
  const text = [caption, place ? `📍 ${place}` : "", "", "Created with Fun, Food & Travel"].filter(Boolean).join("\n");
  try {
    if (navigator.share) {
      await navigator.share({ title: caption || "Preview", text });
    } else {
      await navigator.clipboard?.writeText(text);
      status("review", "Preview text copied to clipboard.");
    }
  } catch (err) {
    if (err.name !== "AbortError") status("review", `Couldn't share: ${err.message}`);
  }
});

$("share-post").addEventListener("click", async () => {
  const p = currentPost;
  if (!p) return;
  const text = shareText(p);
  const shareableMedia = p.media.filter((m) => m.blob.size < 20 * 1024 * 1024);
  let files = shareableMedia.map((m) => new File([m.blob], m.name, { type: m.type }));
  if (!files.length && p.cover) {
    try {
      const resp = await fetch(p.cover);
      const blob = await resp.blob();
      files = [new File([blob], "cover.jpg", { type: "image/jpeg" })];
    } catch {}
  }
  try {
    if (files.length && navigator.canShare?.({ files, text })) {
      await navigator.share({ files, text });
    } else if (navigator.share) {
      await navigator.share({ title: p.caption, text });
    } else {
      await navigator.clipboard.writeText(text);
      status("post", "Post text and links copied. Paste them anywhere.");
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    try { await navigator.share({ title: p.caption, text }); }
    catch (e2) { if (e2.name !== "AbortError") status("post", `Couldn't share: ${e2.message}`); }
  }
});

$("delete-post").addEventListener("click", async () => {
  if (!currentPost || !confirm("Delete this post from your phone?")) return;
  await db.deletePost(currentPost.id);
  location.hash = "#posts";
});

// ---------- social share bar in post view ----------

function updatePostShareBar() {
  const bar = $("post-share-bar");
  if (!bar || !currentPost) return;
  bar.innerHTML = "";
  const text = shareText(currentPost);
  bar.append(renderShareBar(text, currentPost.sourceUrl, currentPost.cover));
}

// ---------- social link import ----------

function makeLinkPlaceholder(url, host) {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 480;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fffaf5";
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = "#e8590c";
  ctx.font = "bold 28px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(host, 320, 200);
  ctx.fillStyle = "#1f1a17";
  ctx.font = "18px sans-serif";
  const short = url.length > 60 ? url.slice(0, 57) + "…" : url;
  ctx.fillText(short, 320, 250);
  ctx.fillStyle = "#6b625c";
  ctx.font = "16px sans-serif";
  ctx.fillText("Shared link — AI will search the web for details", 320, 310);
  return c;
}

$("import-link").addEventListener("click", async () => {
  const url = $("social-link").value.trim();
  if (!url) return status("pick", "Paste a URL first.");
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace("www.", "");
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      let videoId = parsed.searchParams.get("v");
      if (!videoId && host.includes("youtu.be")) videoId = parsed.pathname.slice(1);
      if (videoId) {
        const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        status("pick", "Fetching YouTube thumbnail…");
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = thumbUrl;
          await img.decode();
          const canvas = fitCanvas(img, img.naturalWidth, img.naturalHeight, MAX_SIDE);
          addFrame(canvas);
          picked.push({ file: await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85)), kind: "image" });
        } catch {
          addFrame(makeLinkPlaceholder(url, host));
        }
        $("analyze").disabled = false;
        $("tags").value = ($("tags").value ? $("tags").value + " " : "") + url;
        status("pick", "YouTube link imported. Add more media or tap Analyze.");
        return;
      }
    }
    // For any other link: create a placeholder frame so Analyze works
    addFrame(makeLinkPlaceholder(url, host));
    $("analyze").disabled = false;
    $("tags").value = ($("tags").value ? $("tags").value + " " : "") + url;
    status("pick", `${host} link imported. Tap Analyze — AI will use web search to find details. You can also add photos for better results.`);
  } catch {
    status("pick", "That doesn't look like a valid URL.");
  }
});

// ---------- search ----------

let selectedSearchPosts = new Set();

async function initSearch() {
  await buildIndex();
  renderPostSelectGrid();
}

function renderPostSelectGrid() {
  const grid = $("search-post-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const posts = getAllPosts();
  if (!posts.length) { $("search-post-select").hidden = true; return; }
  $("search-post-select").hidden = false;
  for (const p of posts.slice(0, 12)) {
    const card = el("div", { class: "select-card" });
    if (p.cover) card.append(el("img", { src: p.cover, alt: "" }));
    const label = el("div", { class: "select-label" });
    label.textContent = p.caption?.slice(0, 40) || "Untitled";
    card.append(label);
    card.addEventListener("click", () => {
      if (selectedSearchPosts.has(p.id)) { selectedSearchPosts.delete(p.id); card.classList.remove("selected"); }
      else { selectedSearchPosts.add(p.id); card.classList.add("selected"); }
      $("plan-similar").disabled = selectedSearchPosts.size === 0;
    });
    grid.append(card);
  }
}

$("plan-similar").addEventListener("click", async () => {
  if (!selectedSearchPosts.size) return;
  $("plan-similar").disabled = true;
  status("search", "Planning your trip based on selected videos…");
  try {
    const result = await smartSearch(apiKey(), "plan a vacation with all details similar to shown", [...selectedSearchPosts]);
    renderSearchResult(result);
    status("search", "");
  } catch (err) {
    status("search", err.message);
  } finally {
    $("plan-similar").disabled = false;
  }
});

$("search-go").addEventListener("click", async () => {
  const query = $("search-query").value.trim();
  if (!query) return;
  $("search-go").disabled = true;
  status("search", "Searching…");
  $("search-results").innerHTML = "";
  $("search-plan").hidden = true;

  try {
    const result = await smartSearch(apiKey(), query, null);
    renderSearchResult(result);
    status("search", "");
  } catch (err) {
    status("search", err.message);
  } finally {
    $("search-go").disabled = false;
  }
});

function renderSearchResult(result) {
  const container = $("search-results");
  container.innerHTML = "";
  $("search-plan").hidden = true;

  if (result.type === "results") {
    const L = links();
    for (const post of result.posts) {
      const row = el("div", { class: "sr-row" });
      const left = el("div", { class: "sr-frames" });
      const itemFrameEntries = Object.entries(post.itemFrames || {}).slice(0, 3);
      if (itemFrameEntries.length) {
        for (const [name, dataUrl] of itemFrameEntries) {
          const frame = el("div", { class: "sr-frame" });
          frame.append(el("img", { src: dataUrl, alt: name }));
          frame.append(el("span", { class: "sr-frame-label" }, name));
          left.append(frame);
        }
      } else if (post.allFrames?.length) {
        for (const dataUrl of post.allFrames.slice(0, 3)) {
          const frame = el("div", { class: "sr-frame" });
          frame.append(el("img", { src: dataUrl, alt: "" }));
          left.append(frame);
        }
      }
      const right = el("div", { class: "sr-video" });
      if (post.cover) {
        const coverImg = el("img", { src: post.cover, alt: post.caption || "", class: "sr-cover" });
        coverImg.addEventListener("click", () => { location.hash = `#post/${post.id}`; });
        right.append(coverImg);
      }
      if (post.sourceUrl) right.append(el("a", { href: post.sourceUrl, target: "_blank", class: "sr-source small" }, "🔗 Watch original"));
      const meta = el("div", { class: "sr-meta" });
      meta.append(el("strong", {}, post.caption || "Untitled"));
      if (post.place) meta.append(el("p", { class: "small muted" }, `📍 ${post.place}`));
      const viewBtn = el("a", { href: `#post/${post.id}`, class: "btn small" }, "View full post");
      meta.append(viewBtn);
      row.append(left, right);
      container.append(row, meta);
    }
    if (!result.posts.length) status("search", "No matching posts found. Try a different search.");
  } else if (result.type === "plan") {
    renderPlan(result.plan, result.posts);
  } else if (result.type === "products") {
    for (const item of result.items || []) {
      const card = el("div", { class: "product-card" });
      card.append(el("strong", {}, item.name));
      if (item.brand) card.append(el("span", { class: "brand" }, ` by ${item.brand}`));
      card.append(el("p", { class: "small" }, item.description || ""));
      if (item.price) card.append(el("p", { class: "price" }, item.price));
      if (item.link) card.append(el("a", { href: item.link, target: "_blank", class: "btn small" }, "Buy / View"));
      container.append(card);
    }
  } else if (result.type === "text") {
    const resp = el("div", { class: "chat-response" });
    resp.textContent = result.response;
    container.append(resp);
  }
}

function renderPlan(plan, posts) {
  const container = $("search-plan");
  container.innerHTML = "";
  container.hidden = false;

  container.append(el("h2", { class: "plan-title" }, "🎒 Pack your Plan"));
  if (plan.destination) container.append(el("h3", {}, plan.destination));
  if (plan.overview) container.append(el("p", { class: "plan-overview" }, plan.overview));

  const L = links();
  for (const section of plan.sections || []) {
    container.append(el("h3", { class: "plan-section-title" }, section.title));
    const list = el("ul", { class: "plan-items" });
    for (const item of section.items || []) {
      const li = el("li", { class: "plan-item" });
      const top = el("div", { class: "plan-item-top" });
      top.append(el("strong", {}, item.name));
      if (item.price) top.append(el("span", { class: "plan-price" }, ` ${item.price}`));
      li.append(top);
      if (item.description) li.append(el("p", { class: "small muted" }, item.description));
      if (item.link) li.append(el("a", { href: item.link, target: "_blank", rel: "noopener", class: "btn small" }, "Book / Buy"));
      list.append(li);
    }
    container.append(list);
  }
  if (plan.budget) {
    container.append(el("div", { class: "plan-budget" }, `💰 Estimated budget: ${plan.budget}`));
  }
}

$("search-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("search-go").click();
});

// ---------- helpers ----------

function status(step, msg) {
  $(`${step}-status`).textContent = msg;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("offline cache unavailable", err));
}
route();
showInstallBanner();
