import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.min.js";
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
import * as db from "./db.js";
import { DEMO_KEY } from "./ai.js";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
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
