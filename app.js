// Fun, Food & Travel - phone-only version. Everything runs in the phone's
// browser: frames are sampled here, Claude is called directly with the
// owner's API key, and posts (with their photos/videos) are saved on the phone.

import { analyze, localInfo, DEMO_KEY } from "./ai.js";
import { makeLinks } from "./links.js";
import * as db from "./db.js";

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

// ---------- routing ----------

function route() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  let [view, id] = (location.hash.slice(1) || "new").split("/");
  if (!apiKey() && view !== "settings") view = "settings";
  for (const v of ["new", "posts", "post", "settings"]) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".tabs a")) {
    a.classList.toggle("active", a.dataset.tab === (view === "post" ? "posts" : view));
  }
  if (view === "settings") fillSettingsForm();
  if (view === "posts") renderPostList();
  if (view === "post") renderPost(id);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- Step 1: pick & sample ----------

$("files").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  frames = [];
  picked = [];
  gps = null;
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
  if (problems.length) msg += ` · couldn't read: ${problems.join(", ")}`;
  status("pick", msg);
});

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
      $("use-gps").checked ? gps : null);
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
    await db.savePost({
      id,
      created: Date.now(),
      caption: $("caption").value.trim(),
      place: $("show-place").checked ? $("place").value.trim() : "",
      items: [...collectItems("items"), ...collectItems("nearby")],
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

function resetNew() {
  frames = []; picked = []; gps = null; analysis = null;
  $("files").value = ""; $("thumbs").innerHTML = ""; $("tags").value = "";
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
}

function shareText(p) {
  const L = links();
  const lines = [p.caption];
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

$("share-post").addEventListener("click", async () => {
  const p = currentPost;
  if (!p) return;
  const text = shareText(p);
  const files = p.media.map((m) => new File([m.blob], m.name, { type: m.type }));
  try {
    if (navigator.canShare?.({ files, text })) {
      await navigator.share({ files, text });
    } else if (navigator.share) {
      await navigator.share({ title: p.caption, text });
    } else {
      await navigator.clipboard.writeText(text);
      status("post", "Post text and links copied. Paste them anywhere.");
    }
  } catch (err) {
    if (err.name === "AbortError") return; // user closed the share sheet
    // Some apps refuse big videos - fall back to sharing just the text.
    try { await navigator.share({ title: p.caption, text }); }
    catch (e2) { if (e2.name !== "AbortError") status("post", `Couldn't share: ${e2.message}`); }
  }
});

$("delete-post").addEventListener("click", async () => {
  if (!currentPost || !confirm("Delete this post from your phone?")) return;
  await db.deletePost(currentPost.id);
  location.hash = "#posts";
});

// ---------- helpers ----------

function status(step, msg) {
  $(`${step}-status`).textContent = msg;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("offline cache unavailable", err));
}
route();
