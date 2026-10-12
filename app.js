// Fun, Food & Travel - phone-only version. Everything runs in the phone's
// browser: frames are sampled here, Claude is called directly with the
// owner's API key, and posts (with their photos/videos) are saved on the phone.

import { analyze, localInfo, DEMO_KEY } from "./ai.js";
import { makeLinks } from "./links.js";
import * as db from "./db.js";
import { renderShareBar } from "./social.js";
import { buildIndex, search as localSearch, smartSearch, getPost as searchGetPost, getAllPosts, fetchPlanImages } from "./search.js";
import * as cloud from "./cloud.js";

const MAX_FRAMES = 12;
const FRAMES_PER_VIDEO = 6;
const MAX_SIDE = 1280;
const GALLERY_SIDE = 2048;
const COVER_SIDE = 600;
const MAX_VIDEO_MB = 2048;

const VIDEO_TYPES = { mov: "video/quicktime", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm" };
const BADGES = { seen: "In your post", suggested: "Pack for this trip", nearby: "Nearby" };
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
let frames = [];
let picked = [];
let gps = null;
let analysis = null;
let objectUrls = [];

// ---------- settings ----------

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
  $("supabase-url").value = s.supabaseUrl || "";
  $("supabase-key").value = s.supabaseKey || "";
  $("id-amazon").value = s.ids?.amazon || "";
  $("id-ebay").value = s.ids?.ebay || "";
  $("id-booking").value = s.ids?.booking || "";
  $("id-gyg").value = s.ids?.gyg || "";
  $("welcome").hidden = !!s.apiKey;
}

$("save-settings").addEventListener("click", async () => {
  const key = $("api-key").value.trim();
  if (key && key !== DEMO_KEY && !key.startsWith("sk-ant-")) {
    return status("settings", "That doesn't look like an Anthropic key (they start with sk-ant-).");
  }
  const ok = saveSettings({
    apiKey: key,
    supabaseUrl: $("supabase-url").value.trim(),
    supabaseKey: $("supabase-key").value.trim(),
    ids: {
      amazon: $("id-amazon").value.trim(), ebay: $("id-ebay").value.trim(),
      booking: $("id-booking").value.trim(), gyg: $("id-gyg").value.trim(),
    },
  });
  if (!ok) return status("settings", "Couldn't save. Private browsing may be blocking storage.");
  if (cloud.isConfigured()) {
    status("settings", "Saved. Testing cloud connection…");
    try {
      await cloud.fetchPosts(1);
      status("settings", "Saved. Cloud connected!");
    } catch (err) {
      status("settings", `Saved, but cloud failed: ${err.message}`);
    }
  } else {
    status("settings", "Saved. (Cloud sharing not configured — posts stay on this device only.)");
  }
  if (key) location.hash = "#home";
});

$("sync-cloud").addEventListener("click", async () => {
  if (!cloud.isConfigured()) return status("settings", "Set up Supabase URL and key above first, then Save.");
  $("sync-cloud").disabled = true;
  status("settings", "Syncing all local posts and plans to cloud…");
  try {
    const posts = await db.listPosts();
    for (const p of posts) await cloud.uploadPost(p);
    const plans = await db.listPlans();
    for (const p of plans) await cloud.uploadPlan(p);
    status("settings", `Synced! ${posts.length} post${posts.length !== 1 ? "s" : ""} and ${plans.length} plan${plans.length !== 1 ? "s" : ""} backed up to cloud.`);
  } catch (err) {
    status("settings", `Sync failed: ${err.message}`);
  } finally {
    $("sync-cloud").disabled = false;
  }
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

const ALL_VIEWS = ["home", "new", "posts", "post", "search", "plans", "plan", "settings"];

function route() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  removeFabShare();
  let [view, id] = (location.hash.slice(1) || "home").split("/");
  if (!apiKey() && view !== "settings") view = "settings";
  for (const v of ALL_VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== view;
  }
  for (const a of document.querySelectorAll(".tabs a")) {
    const tab = a.dataset.tab;
    a.classList.toggle("active", tab === view || (view === "post" && tab === "posts") || (view === "plan" && tab === "plans"));
  }
  if (view === "settings") fillSettingsForm();
  if (view === "home") initHome();
  if (view === "posts") renderPostList();
  if (view === "post") renderPost(id);
  if (view === "plans") renderPlansList();
  if (view === "plan") renderSavedPlan(id);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// Fix iOS blank screen after sharing — re-render the current view
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const [view] = (location.hash.slice(1) || "home").split("/");
    if (view === "post" && currentPost) updatePostShareBar();
    else if (view === "home" || view === "posts" || view === "plans") route();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) route();
});

// ---------- Home tab (landing) ----------

let homeSelectedPosts = new Set();

async function initHome() {
  await buildIndex();
  await renderHomeFeed();
  await renderHomePostGrid();
}

async function renderHomeFeed() {
  const localPosts = await db.listPosts();
  let posts;

  if (cloud.isConfigured()) {
    status("home", "Loading posts from all users…");
    try {
      const cloudPosts = await cloud.fetchPosts(200);
      const localIds = new Set(localPosts.map((p) => p.id));
      const merged = [...localPosts];
      for (const cp of cloudPosts) {
        if (!localIds.has(cp.id)) merged.push(cp);
      }
      merged.sort((a, b) => b.created - a.created);
      posts = merged;
      status("home", "");
    } catch {
      posts = localPosts;
      status("home", "Couldn't reach cloud — showing local posts only.");
    }
  } else {
    posts = localPosts;
  }

  const feed = $("home-feed");
  feed.innerHTML = "";
  $("home-empty").hidden = posts.length > 0;
  $("home-feed-heading").hidden = !posts.length;

  for (const p of posts) {
    const card = el("div", { class: "feed-card" });
    if (p.cover) card.append(el("img", { src: p.cover, alt: "", class: "feed-thumb" }));
    const info = el("div", { class: "feed-info" });
    info.append(el("p", { class: "feed-title" }, p.caption || "Untitled post"));
    const metaParts = [];
    if (p.place) metaParts.push(`📍 ${p.place}`);
    metaParts.push(new Date(p.created).toLocaleDateString());
    info.append(el("p", { class: "feed-meta" }, metaParts.join(" · ")));
    if (p.items?.length) {
      const itemNames = p.items.slice(0, 4).map((i) => i.name).join(", ");
      info.append(el("p", { class: "feed-items" }, itemNames + (p.items.length > 4 ? ` +${p.items.length - 4} more` : "")));
    }
    card.append(info);
    card.addEventListener("click", () => { location.hash = `#post/${p.id}`; });
    feed.append(card);
  }
}

async function renderHomePostGrid() {
  const grid = $("home-post-grid");
  if (!grid) return;
  grid.innerHTML = "";
  homeSelectedPosts.clear();
  const localPosts = getAllPosts();
  let posts = localPosts;
  if (cloud.isConfigured() && !localPosts.length) {
    try {
      const cloudPosts = await cloud.fetchPosts(12);
      const localIds = new Set(localPosts.map((p) => p.id));
      posts = [...localPosts];
      for (const cp of cloudPosts) {
        if (!localIds.has(cp.id)) posts.push(cp);
      }
    } catch {}
  }
  if (!posts.length) { $("home-post-select").hidden = true; return; }
  $("home-post-select").hidden = false;
  for (const p of posts.slice(0, 12)) {
    const card = el("div", { class: "select-card" });
    if (p.cover) card.append(el("img", { src: p.cover, alt: "" }));
    const label = el("div", { class: "select-label" });
    label.textContent = p.caption?.slice(0, 40) || "Untitled";
    card.append(label);
    card.addEventListener("click", () => {
      if (homeSelectedPosts.has(p.id)) { homeSelectedPosts.delete(p.id); card.classList.remove("selected"); }
      else { homeSelectedPosts.add(p.id); card.classList.add("selected"); }
      $("home-plan-similar").disabled = homeSelectedPosts.size === 0;
    });
    grid.append(card);
  }
}

async function homeSearch() {
  const query = $("home-search-query").value.trim();
  if (!query) return;
  $("home-search-go").disabled = true;
  $("home-search-results").innerHTML = "";
  $("home-search-plan").hidden = true;
  removeFabShare();

  let userLocation = null;
  if (queryNeedsLocation(query)) {
    status("home", "Getting your location…");
    userLocation = await getUserLocation();
    if (!userLocation) {
      status("home", "Couldn't get your location. Please enable location access and try again.");
      $("home-search-go").disabled = false;
      return;
    }
    status("home", "Searching around your location…");
  } else {
    status("home", "Searching…");
  }

  try {
    const result = await smartSearch(apiKey(), query, null, userLocation);
    renderSearchResult(result, "home");
    status("home", "");
  } catch (err) {
    status("home", err.message);
  } finally {
    $("home-search-go").disabled = false;
  }
}

$("home-search-go").addEventListener("click", homeSearch);
$("home-search-query").addEventListener("keydown", (e) => { if (e.key === "Enter") homeSearch(); });

$("home-plan-similar").addEventListener("click", async () => {
  if (!homeSelectedPosts.size) return;
  $("home-plan-similar").disabled = true;
  removeFabShare();
  const query = $("home-search-query").value.trim() || "plan a vacation with all details similar to shown";

  let userLocation = null;
  if (queryNeedsLocation(query)) {
    status("home", "Getting your location…");
    userLocation = await getUserLocation();
    if (!userLocation) {
      status("home", "Couldn't get your location. Please enable location access and try again.");
      $("home-plan-similar").disabled = false;
      return;
    }
    status("home", "Planning around your location…");
  } else {
    status("home", "Planning your trip based on selected videos…");
  }

  try {
    const result = await smartSearch(apiKey(), query, [...homeSelectedPosts], userLocation);
    renderSearchResult(result, "home");
    status("home", "");
  } catch (err) {
    status("home", err.message);
  } finally {
    $("home-plan-similar").disabled = false;
  }
});

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
    await img.decode();
    return fitCanvas(img, img.naturalWidth, img.naturalHeight, maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitFor(el, event, ms = 60000) {
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
  const loadTimeout = Math.max(60000, file.size / 50000);
  try {
    const loaded = waitFor(v, "loadeddata", loadTimeout);
    v.load();
    await loaded;
    const out = [];
    for (let k = 0; k < n; k++) {
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
    return { lat: +g.latitude.toFixed(2), lon: +g.longitude.toFixed(2) };
  } catch {
    return null;
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
    const post = {
      id, created: Date.now(),
      caption: $("caption").value.trim(),
      place: $("show-place").checked ? $("place").value.trim() : "",
      sourceUrl: sourceUrl || "",
      location: analysis?.location || null,
      tags: $("tags").value.trim(),
      items: collectedItems, itemFrames,
      allFrames: allFrameDataUrls.slice(0, 6),
      news: [...$("local").children]
        .filter((li) => li.querySelector(".keep").checked)
        .map((li) => JSON.parse(li.dataset.json)),
      media, cover,
    };
    await db.savePost(post);
    db.requestPersistence();
    cloud.uploadPost(post);
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
  const localPosts = await db.listPosts();
  let posts;

  if (cloud.isConfigured()) {
    try {
      const cloudPosts = await cloud.fetchPosts(200);
      const localIds = new Set(localPosts.map((p) => p.id));
      const merged = [...localPosts];
      for (const cp of cloudPosts) {
        if (!localIds.has(cp.id)) merged.push(cp);
      }
      merged.sort((a, b) => b.created - a.created);
      posts = merged;
    } catch {
      posts = localPosts;
    }
  } else {
    posts = localPosts;
  }

  $("posts-empty").hidden = posts.length > 0;
  $("post-list").innerHTML = "";
  for (const p of posts) {
    const li = document.createElement("li");
    li.innerHTML = `<a class="post-row"><img alt=""><div><strong></strong><p class="small muted"></p></div></a>`;
    li.querySelector("a").href = `#post/${p.id}`;
    if (p.cover) li.querySelector("img").src = p.cover;
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
  if (!currentPost && cloud.isConfigured()) {
    currentPost = await cloud.fetchPost(id);
  }
  if (!currentPost) {
    body.append(el("p", { class: "muted" }, "This post isn't available."));
    return;
  }
  const p = currentPost;
  const isCloudOnly = !!p._cloud;
  const L = links();

  if (!isCloudOnly && p.media?.length) {
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
  } else if (p.cover) {
    body.append(el("img", { src: p.cover, alt: p.caption || "", class: "sr-cover", style: "width:100%;border-radius:12px;margin-bottom:12px" }));
  }

  body.append(el("h1", {}, p.caption));
  if (p.sourceUrl) {
    const srcP = el("p", { class: "source" });
    srcP.append(el("a", { href: p.sourceUrl, target: "_blank", rel: "noopener", class: "source-link" }, `🔗 ${p.sourceUrl}`));
    body.append(srcP);
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
  ctx.fillStyle = "#e84393";
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
    addFrame(makeLinkPlaceholder(url, host));
    $("analyze").disabled = false;
    $("tags").value = ($("tags").value ? $("tags").value + " " : "") + url;
    status("pick", `${host} link imported. Tap Analyze — AI will use web search to find details. You can also add photos for better results.`);
  } catch {
    status("pick", "That doesn't look like a valid URL.");
  }
});

// ---------- geolocation ----------

const LOCATION_KEYWORDS = /\b(my location|near me|around me|current location|my area|nearby|close to me|where i am)\b/i;

function queryNeedsLocation(query) {
  return LOCATION_KEYWORDS.test(query);
}

function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}

// ---------- floating share button ----------

let fabShareBtn = null;

function showFabShare(planText) {
  removeFabShare();
  fabShareBtn = el("button", { class: "fab-share" });
  fabShareBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>Share`;
  fabShareBtn.addEventListener("click", async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pack your Plan", text: planText });
      } else {
        await navigator.clipboard.writeText(planText);
        const active = location.hash.startsWith("#home") ? "home" : "search";
        status(active, "Plan copied to clipboard!");
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        const active = location.hash.startsWith("#home") ? "home" : "search";
        status(active, `Couldn't share: ${err.message}`);
      }
    }
  });
  document.body.append(fabShareBtn);
}

function removeFabShare() {
  if (fabShareBtn) { fabShareBtn.remove(); fabShareBtn = null; }
}

// ---------- search results (shared by Home and Search views) ----------

let lastPlanData = null;
let lastPlanPosts = null;

function renderSearchResult(result, ctx = "home") {
  const container = $(ctx === "home" ? "home-search-results" : "search-results");
  const planContainer = $(ctx === "home" ? "home-search-plan" : "search-plan");
  container.innerHTML = "";
  planContainer.hidden = true;

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
      meta.append(el("a", { href: `#post/${post.id}`, class: "btn small" }, "View full post"));
      row.append(left, right);
      container.append(row, meta);
    }
    if (!result.posts.length) status(ctx, "No matching posts found. Try a different search.");
  } else if (result.type === "plan") {
    renderPlan(result.plan, result.posts, ctx);
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

function renderPlan(plan, posts, ctx = "home") {
  const container = $(ctx === "home" ? "home-search-plan" : "search-plan");
  container.innerHTML = "";
  container.hidden = false;
  lastPlanData = plan;
  lastPlanPosts = posts;

  container.append(el("h2", { class: "plan-title" }, "🎒 Pack your Plan"));
  if (plan.destination) container.append(el("h3", {}, plan.destination));
  if (plan.overview) container.append(el("p", { class: "plan-overview" }, plan.overview));

  const shareLines = ["🎒 Pack your Plan"];
  if (plan.destination) shareLines.push(plan.destination);
  if (plan.overview) shareLines.push("", plan.overview);

  for (const section of plan.sections || []) {
    container.append(el("h3", { class: "plan-section-title" }, section.title));
    shareLines.push("", `--- ${section.title} ---`);
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
      let line = `• ${item.name}`;
      if (item.price) line += ` — ${item.price}`;
      if (item.link) line += ` ${item.link}`;
      shareLines.push(line);
    }
    container.append(list);
  }
  if (plan.budget) {
    container.append(el("div", { class: "plan-budget" }, `💰 Estimated budget: ${plan.budget}`));
    shareLines.push("", `💰 Estimated budget: ${plan.budget}`);
  }
  shareLines.push("", "Created with Fun, Food & Travel");

  const actions = el("div", { class: "plan-actions" });
  const saveBtn = el("button", { class: "primary" }, "Save Plan");
  saveBtn.addEventListener("click", () => savePlanToDb(plan, posts, ctx));
  actions.append(saveBtn);
  container.append(actions);

  showFabShare(shareLines.join("\n"));
}

async function savePlanToDb(plan, posts, ctx) {
  const id = crypto.randomUUID();
  const coverImages = (posts || []).filter((p) => p.cover).map((p) => p.cover).slice(0, 4);
  const planObj = {
    id, created: Date.now(),
    destination: plan.destination || "Travel Plan",
    overview: plan.overview || "",
    sections: plan.sections || [],
    budget: plan.budget || "",
    coverImages,
    postIds: (posts || []).map((p) => p.id),
  };
  await db.savePlan(planObj);
  db.requestPersistence();
  cloud.uploadPlan(planObj);
  status(ctx, "Plan saved! Find it in the Plans tab.");
}

// ---------- Pack the Plan tab ----------

async function renderPlansList() {
  const localPlans = await db.listPlans();
  let plans;

  if (cloud.isConfigured()) {
    try {
      const cloudPlans = await cloud.fetchPlans(200);
      const localIds = new Set(localPlans.map((p) => p.id));
      const merged = [...localPlans];
      for (const cp of cloudPlans) {
        if (!localIds.has(cp.id)) merged.push(cp);
      }
      merged.sort((a, b) => b.created - a.created);
      plans = merged;
    } catch {
      plans = localPlans;
    }
  } else {
    plans = localPlans;
  }

  $("plans-empty").hidden = plans.length > 0;
  const list = $("plans-list");
  list.innerHTML = "";
  for (const p of plans) {
    const card = el("div", { class: "plan-card" });
    card.append(el("p", { class: "plan-card-title" }, `🎒 ${p.destination}`));
    if (p.overview) {
      const short = p.overview.length > 120 ? p.overview.slice(0, 117) + "…" : p.overview;
      card.append(el("p", { class: "plan-card-overview" }, short));
    }
    card.append(el("p", { class: "plan-card-date" }, new Date(p.created).toLocaleDateString()));
    card.addEventListener("click", () => { location.hash = `#plan/${p.id}`; });
    list.append(card);
  }
}

async function renderSavedPlan(id) {
  const body = $("plan-body");
  body.innerHTML = "";
  status("plan", "");
  let plan = await db.getPlan(id);
  if (!plan && cloud.isConfigured()) {
    try { plan = await cloud.fetchPlan(id); } catch {}
  }
  if (!plan) {
    body.append(el("p", { class: "muted" }, "Plan not found."));
    return;
  }

  body.append(el("h2", { class: "plan-title" }, `🎒 ${plan.destination}`));
  if (plan.overview) body.append(el("p", { class: "plan-overview" }, plan.overview));

  if (plan.coverImages?.length) {
    const thumbRow = el("div", { class: "thumbs" });
    for (const src of plan.coverImages) thumbRow.append(el("img", { src, alt: "" }));
    body.append(thumbRow);
  }

  for (const section of plan.sections || []) {
    body.append(el("h3", { class: "plan-section-title" }, section.title));
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
    body.append(list);
  }
  if (plan.budget) {
    body.append(el("div", { class: "plan-budget" }, `💰 Estimated budget: ${plan.budget}`));
  }

  // Build shareable text for this plan
  const text = planShareText(plan);
  lastPlanData = plan;

  // Social share bar
  const bar = $("plan-share-bar");
  if (bar) { bar.innerHTML = ""; bar.append(renderShareBar(text, null, null)); }

  // Share — use clipboard on desktop, native share on mobile only
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  $("share-plan-doc").onclick = async () => {
    try {
      if (isMobile && navigator.share) {
        await navigator.share({ title: `🎒 ${plan.destination}`, text });
      } else {
        await navigator.clipboard.writeText(text);
        status("plan", "Plan copied! Use the social icons above to share on WhatsApp, Facebook, X, email, etc.");
        $("plan-share-bar")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (err) {
      if (err.name !== "AbortError") status("plan", `Couldn't share: ${err.message}`);
    }
  };

  // Generate rich travel document with images
  $("download-plan-doc").onclick = async () => {
    $("download-plan-doc").disabled = true;
    status("plan", "Finding photos for your travel plan… (30–60 seconds)");
    try {
      const images = await fetchPlanImages(apiKey(), plan);
      const html = buildPlanHTML(plan, images);
      const blob = new Blob([html], { type: "text/html" });
      const file = new File([blob], `${plan.destination || "Travel-Plan"}.html`, { type: "text/html" });
      if (isMobile && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: plan.destination });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name; a.click();
        URL.revokeObjectURL(url);
      }
      status("plan", "Travel itinerary ready with photos and booking links!");
    } catch (err) {
      status("plan", `Couldn't generate document: ${err.message}`);
    } finally {
      $("download-plan-doc").disabled = false;
    }
  };

  $("delete-plan").onclick = async () => {
    if (!confirm("Delete this plan?")) return;
    await db.deletePlan(plan.id);
    location.hash = "#plans";
  };
}

function planShareText(plan) {
  const lines = [`🎒 Pack your Plan: ${plan.destination}`];
  if (plan.overview) lines.push("", plan.overview);
  for (const s of plan.sections || []) {
    lines.push("", `--- ${s.title} ---`);
    for (const it of s.items || []) {
      let line = `• ${it.name}`;
      if (it.price) line += ` — ${it.price}`;
      if (it.description) line += `\n  ${it.description}`;
      if (it.link) line += `\n  ${it.link}`;
      lines.push(line);
    }
  }
  if (plan.budget) lines.push("", `💰 ${plan.budget}`);
  lines.push("", "Created with Fun, Food & Travel");
  return lines.join("\n");
}

function buildPlanHTML(plan, images = {}) {
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const heroImg = images.destination
    ? `<div style="width:100%;height:240px;border-radius:16px;overflow:hidden;margin:16px 0">
         <img src="${esc(images.destination)}" alt="${esc(plan.destination)}"
              style="width:100%;height:100%;object-fit:cover"
              onerror="this.parentElement.style.display='none'">
       </div>`
    : "";

  let sections = "";
  let itemIdx = 0;
  for (let si = 0; si < (plan.sections || []).length; si++) {
    const s = plan.sections[si];
    let items = "";
    for (let ii = 0; ii < (s.items || []).length; ii++) {
      const it = s.items[ii];
      const imgKey = `${si}-${ii}`;
      const imgUrl = images[imgKey];
      const imgHtml = imgUrl
        ? `<img src="${esc(imgUrl)}" alt="${esc(it.name)}"
               style="width:100%;height:180px;object-fit:cover;border-radius:10px 10px 0 0;display:block"
               onerror="this.style.display='none'">`
        : "";
      const priceHtml = it.price
        ? `<span style="display:inline-block;background:linear-gradient(135deg,#e8590c,#e84393);color:#fff;padding:3px 10px;border-radius:20px;font-size:0.82rem;font-weight:700;margin-left:8px">${esc(it.price)}</span>`
        : "";
      const descHtml = it.description
        ? `<p style="color:#6b7280;font-size:0.88rem;margin:6px 0 0;line-height:1.4">${esc(it.description)}</p>`
        : "";
      const linkHtml = it.link
        ? `<a href="${esc(it.link)}" target="_blank" rel="noopener"
              style="display:inline-block;margin-top:10px;padding:8px 20px;border-radius:8px;background:linear-gradient(135deg,#e8590c,#e84393);color:#fff;text-decoration:none;font-size:0.88rem;font-weight:700;letter-spacing:0.3px">Book / Buy &rarr;</a>`
        : "";

      items += `<li style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin:10px 0;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
        ${imgHtml}
        <div style="padding:14px">
          <strong style="font-size:1rem">${esc(it.name)}</strong>${priceHtml}
          ${descHtml}${linkHtml}
        </div>
      </li>`;
      itemIdx++;
    }
    sections += `<h3 style="margin:28px 0 10px;font-size:1.15rem;color:#1a1a2e;border-bottom:2px solid #e84393;padding-bottom:6px">${esc(s.title)}</h3>
      <ul style="list-style:none;padding:0;margin:0">${items}</ul>`;
  }

  const budgetHtml = plan.budget
    ? `<div style="margin:28px 0;padding:18px;border-radius:14px;background:linear-gradient(135deg,#fdf2f8,#fff1f2);border:1px solid #fce7f3;font-weight:700;font-size:1.05rem;text-align:center;color:#1a1a2e">
         💰 ${esc(plan.budget)}
       </div>`
    : "";

  const coverHtml = (plan.coverImages || [])
    .map((src) => `<img src="${src}" alt="" style="width:100px;height:75px;object-fit:cover;border-radius:8px" onerror="this.style.display='none'">`)
    .join("");
  const coverRow = coverHtml
    ? `<div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap">${coverHtml}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎒 ${esc(plan.destination)} — Travel Itinerary</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 0; color: #1a1a2e; background: #fafafa; }
  a { color: #e84393; }
  @media print { body { background: #fff; } }
</style>
</head>
<body>
<div style="background:linear-gradient(135deg,#e8590c,#e84393,#d63384);padding:32px 24px 24px;color:#fff;border-radius:0 0 24px 24px">
  <p style="margin:0;font-size:0.85rem;opacity:0.9;letter-spacing:1px;text-transform:uppercase">Travel Itinerary</p>
  <h1 style="margin:8px 0 0;font-size:1.8rem;font-weight:800">🎒 ${esc(plan.destination)}</h1>
</div>
<div style="padding:20px 16px">
${heroImg}
${coverRow}
<p style="color:#4b5563;line-height:1.6;font-size:0.95rem">${esc(plan.overview || "")}</p>
${sections}
${budgetHtml}
<div style="margin-top:32px;padding:16px;text-align:center;border-top:1px solid #e5e7eb">
  <p style="font-size:0.75rem;color:#9ca3af;margin:0">Created with Fun, Food &amp; Travel</p>
  <p style="font-size:0.7rem;color:#d1d5db;margin:4px 0 0">Photos sourced from the web. Prices are estimates — confirm on each site before booking.</p>
</div>
</div>
</body>
</html>`;
}

// ---------- helpers ----------

function status(step, msg) {
  const el = $(`${step}-status`);
  if (el) el.textContent = msg;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("offline cache unavailable", err));
}

async function syncAllToCloud() {
  if (!cloud.isConfigured()) return;
  try {
    const posts = await db.listPosts();
    for (const p of posts) await cloud.uploadPost(p);
    const plans = await db.listPlans();
    for (const p of plans) await cloud.uploadPlan(p);
    if (posts.length || plans.length) console.log(`Cloud sync: ${posts.length} posts, ${plans.length} plans`);
  } catch (err) {
    console.warn("Cloud sync failed:", err);
  }
}

route();
syncAllToCloud();
