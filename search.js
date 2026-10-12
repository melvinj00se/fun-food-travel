import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.min.js";
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
import * as db from "./db.js";
import { DEMO_KEY, MODEL, FALLBACK_BETA } from "./ai.js";
let index = null;
let postCache = [];

export async function buildIndex() {
  postCache = await db.listPosts();
  index = new MiniSearch({
    fields: ["caption", "place", "itemNames", "itemDescriptions", "itemBrands", "tags", "locationFull"],
    storeFields: ["id", "caption", "place", "cover", "created", "sourceUrl", "itemNames", "itemBrands"],
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { itemNames: 3, itemBrands: 3, place: 2, caption: 1.5, tags: 1 } },
  });
  const docs = postCache.map((p) => ({
    id: p.id,
    caption: p.caption || "",
    place: p.place || "",
    cover: p.cover || "",
    created: p.created,
    sourceUrl: p.sourceUrl || "",
    tags: p.tags || "",
    itemNames: (p.items || []).map((i) => i.name).join(" "),
    itemDescriptions: (p.items || []).map((i) => i.description).join(" "),
    itemBrands: (p.items || []).map((i) => i.brand).filter(Boolean).join(" "),
    locationFull: p.location ? [p.location.name, p.location.city, p.location.region, p.location.country].filter(Boolean).join(" ") : "",
  }));
  index.addAll(docs);
}

export function search(query) {
  if (!index) return [];
  return index.search(query);
}

export function getPost(id) {
  return postCache.find((p) => p.id === id);
}

export function getAllPosts() {
  return postCache;
}

export async function smartSearch(apiKey, query, selectedPostIds, userLocation) {
  if (apiKey === DEMO_KEY) return demoSearch(query);

  const localResults = search(query);
  const matchedPosts = localResults.slice(0, 6).map((r) => getPost(r.id)).filter(Boolean);

  if (selectedPostIds?.length) {
    const selected = selectedPostIds.map((id) => getPost(id)).filter(Boolean);
    return planFromPosts(apiKey, selected, query, userLocation);
  }

  if (userLocation) {
    const allPosts = getAllPosts();
    if (allPosts.length) {
      return planFromPosts(apiKey, allPosts.slice(0, 6), query, userLocation);
    }
  }

  if (matchedPosts.length) {
    return { type: "results", posts: matchedPosts, query };
  }

  return planFromQuery(apiKey, query, userLocation);
}

async function planFromPosts(apiKey, posts, query, userLocation) {
  const context = posts.map((p) => ({
    caption: p.caption,
    place: p.place,
    location: p.location,
    items: (p.items || []).map((i) => ({ name: i.name, category: i.category, brand: i.brand, description: i.description })),
  }));

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const locationContext = userLocation
    ? `\n\nIMPORTANT: The user's current GPS location is approximately ${userLocation.lat}, ${userLocation.lon}. They want activities, food, experiences, and products SIMILAR to what's shown in these posts but available NEAR THEIR CURRENT LOCATION. First check if any of the post content matches their area. Then search the web for similar experiences, restaurants, activities, hotels, and products near their coordinates. The plan should be centered around their current location, not the original post locations.`
    : "";
  const prompt = `Based on these travel/experience posts, create a complete vacation/experience plan.

Posts: ${JSON.stringify(context)}

User request: "${query}"${locationContext}

Create a detailed "Pack your Plan" with these sections, using web search to find current prices and booking links:
1. Destination overview
2. ${userLocation ? "Getting around locally" : "Flights & getting there"}
3. Where to stay (hotels with links)
4. Things to do (activities, tours with links)
5. Where to eat (restaurants)
6. What to pack/buy (products from the posts + suggestions)
7. Estimated budget

Reply ONLY with JSON: {"plan": {"destination": "...", "overview": "...", "sections": [{"title": "...", "items": [{"name": "...", "description": "...", "category": "flight|hotel|activity|restaurant|product", "price": "...", "link": "..."}]}], "budget": "..."}}`;

  const response = await client.beta.messages.create({
    model: MODEL, max_tokens: 16000,
    betas: [FALLBACK_BETA], fallbacks: "default",
    output_config: { effort: "high" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
    messages: [{ role: "user", content: prompt }],
  });

  let text = "";
  for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
    const cont = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000,
      betas: [FALLBACK_BETA], fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: response.content }],
    });
    text = cont.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (!text) text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return { type: "plan", plan: parsed.plan, posts, query };
    } catch {}
  }
  return { type: "plan", plan: { destination: "Your trip", overview: text, sections: [], budget: "" }, posts, query };
}

async function planFromQuery(apiKey, query, userLocation) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const locationContext = userLocation
    ? `\n\nThe user's current GPS location is approximately ${userLocation.lat}, ${userLocation.lon}. Focus results around this location.`
    : "";

  const prompt = `User is searching for: "${query}"${locationContext}

Search the web and find relevant results. If this is about a product (like a watch, clothing, gear), find 3 real options with images, prices, and buy links. If this is about travel or experiences, create a "Pack your Plan" travel plan.

Reply ONLY with JSON:
For products: {"type": "products", "items": [{"name": "...", "brand": "...", "description": "...", "price": "...", "link": "...", "image_url": "..."}]}
For travel: {"type": "travel", "plan": {"destination": "...", "overview": "...", "sections": [{"title": "...", "items": [{"name": "...", "description": "...", "category": "flight|hotel|activity|restaurant|product", "price": "...", "link": "..."}]}], "budget": "..."}}`;

  let response = await client.beta.messages.create({
    model: MODEL, max_tokens: 16000,
    betas: [FALLBACK_BETA], fallbacks: "default",
    output_config: { effort: "high" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
    messages: [{ role: "user", content: prompt }],
  });

  for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
    response = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000,
      betas: [FALLBACK_BETA], fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: response.content }],
    });
  }

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.type === "products") return { type: "products", items: parsed.items, query };
      if (parsed.type === "travel" || parsed.plan) return { type: "plan", plan: parsed.plan || parsed, query };
    } catch {}
  }
  return { type: "text", response: text, query };
}

function demoSearch(query) {
  return {
    type: "text",
    response: `DEMO: Searching for "${query}". Add your API key in Settings for real results.`,
    query,
  };
}

export async function fetchPlanImages(apiKey, plan) {
  if (apiKey === DEMO_KEY) return {};

  const items = [];
  if (plan.destination) items.push({ key: "destination", term: plan.destination });
  for (let si = 0; si < (plan.sections || []).length; si++) {
    for (let ii = 0; ii < (plan.sections[si].items || []).length; ii++) {
      const item = plan.sections[si].items[ii];
      items.push({ key: `${si}-${ii}`, term: `${item.name} ${plan.destination || ""}`.trim() });
    }
  }
  const searchItems = items.slice(0, 16);

  const prompt = `I need real photos for a travel plan document. For each item below, search the web and find ONE direct image URL — a real photo of that specific place, hotel, food, activity, or product.

${searchItems.map((s, i) => `${i + 1}. ${s.term}`).join("\n")}

Reply ONLY with JSON — an array in the same order:
[{"index": 1, "image": "https://example.com/photo.jpg"}, ...]

Rules:
- Use direct image URLs (ending in .jpg, .jpeg, .png, .webp, or from image CDNs)
- Prefer images from Wikipedia/Wikimedia Commons, official tourism sites, or booking sites
- If you can't find an image for an item, set "image" to ""
- Return exactly ${searchItems.length} entries`;

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let response = await client.beta.messages.create({
    model: MODEL, max_tokens: 4000,
    betas: [FALLBACK_BETA], fallbacks: "default",
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
    messages: [{ role: "user", content: prompt }],
  });
  for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
    response = await client.beta.messages.create({
      model: MODEL, max_tokens: 4000,
      betas: [FALLBACK_BETA], fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: response.content }],
    });
  }

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\[[\s\S]*\]/);
  const imageMap = {};
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      arr.forEach((entry, idx) => {
        if (entry.image && searchItems[idx]) imageMap[searchItems[idx].key] = entry.image;
      });
    } catch {}
  }
  return imageMap;
}

export function buildPlanHTML(plan, images = {}) {
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const heroImg = images.destination
    ? `<div style="width:100%;height:240px;border-radius:16px;overflow:hidden;margin:16px 0">
         <img src="${esc(images.destination)}" alt="${esc(plan.destination)}"
              style="width:100%;height:100%;object-fit:cover"
              onerror="this.parentElement.style.display='none'">
       </div>`
    : "";

  let sections = "";
  for (let si = 0; si < (plan.sections || []).length; si++) {
    const s = plan.sections[si];
    let items = "";
    for (let ii = 0; ii < (s.items || []).length; ii++) {
      const it = s.items[ii];
      const imgUrl = images[`${si}-${ii}`];
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
<div style="margin:32px 0 16px;padding:20px;text-align:center;background:linear-gradient(135deg,#fdf2f8,#fff1f2);border-radius:14px;border:1px solid #fce7f3">
  <p style="margin:0 0 12px;font-weight:700;font-size:0.95rem;color:#1a1a2e">Share this itinerary</p>
  <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap">
    <a href="https://wa.me/?text=${encodeURIComponent(`🎒 Check out my travel plan: ${plan.destination}\n${plan.overview || ""}`)}" target="_blank" rel="noopener"
       style="display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;background:#25D366;color:#fff;text-decoration:none;font-weight:700;font-size:0.88rem">
       <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17.47 14.38c-.29-.14-1.7-.84-1.96-.93-.26-.1-.45-.14-.64.14-.19.29-.73.93-.9 1.12-.17.2-.33.22-.61.07-.29-.14-1.21-.45-2.3-1.43-.85-.76-1.43-1.7-1.6-1.98-.16-.29-.02-.44.12-.58.13-.13.29-.33.43-.5.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.5-.07-.14-.64-1.55-.88-2.12-.23-.56-.47-.48-.64-.49h-.55c-.19 0-.5.07-.76.36-.26.29-1 .98-1 2.38s1.02 2.76 1.17 2.95c.14.19 2.01 3.07 4.88 4.3.68.3 1.22.47 1.63.6.69.22 1.31.19 1.8.12.55-.08 1.7-.7 1.94-1.37.24-.67.24-1.25.17-1.37-.07-.12-.26-.19-.55-.33zM12 2C6.48 2 2 6.48 2 12c0 1.77.46 3.44 1.28 4.89L2 22l5.23-1.25A9.96 9.96 0 0012 22c5.52 0 10-4.48 10-10S17.52 2 12 2z"/></svg>
       WhatsApp</a>
    <a href="mailto:?subject=${encodeURIComponent(`🎒 ${plan.destination} — Travel Itinerary`)}&body=${encodeURIComponent(`Check out my travel plan for ${plan.destination}!\n\n${plan.overview || ""}\n\nCreated with Fun, Food & Travel`)}" target="_blank"
       style="display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;background:#EA4335;color:#fff;text-decoration:none;font-weight:700;font-size:0.88rem">
       <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
       Email</a>
    <a href="https://www.facebook.com/sharer/sharer.php?quote=${encodeURIComponent(`🎒 ${plan.destination} Travel Itinerary`)}" target="_blank" rel="noopener"
       style="display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;background:#1877F2;color:#fff;text-decoration:none;font-weight:700;font-size:0.88rem">
       <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M24 12.07C24 5.41 18.63 0 12 0S0 5.41 0 12.07c0 6.02 4.39 11.01 10.13 11.93v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.33l-.53 3.49h-2.8v8.44C19.61 23.08 24 18.09 24 12.07z"/></svg>
       Facebook</a>
    <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(`🎒 Check out my travel plan: ${plan.destination}`)}" target="_blank" rel="noopener"
       style="display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;background:#000;color:#fff;text-decoration:none;font-weight:700;font-size:0.88rem">
       <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
       X</a>
  </div>
  <p style="margin:12px 0 0;font-size:0.78rem;color:#9ca3af">Tip: Save as PDF with Cmd+P (Mac) or Ctrl+P (Windows), then share the file</p>
</div>
<div style="padding:16px;text-align:center;border-top:1px solid #e5e7eb">
  <p style="font-size:0.75rem;color:#9ca3af;margin:0">Created with Fun, Food &amp; Travel</p>
  <p style="font-size:0.7rem;color:#d1d5db;margin:4px 0 0">Photos sourced from the web. Prices are estimates — confirm on each site before booking.</p>
</div>
</div>
</body>
</html>`;
}
