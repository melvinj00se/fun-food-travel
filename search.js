// Search: local full-text over IndexedDB posts + Claude web search for
// semantic queries (trip planning, product discovery).

import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.min.js";
import * as db from "./db.js";
import { localInfo, DEMO_KEY } from "./ai.js";

let index = null;

export async function buildIndex() {
  const posts = await db.listPosts();
  index = new MiniSearch({
    fields: ["caption", "place", "itemNames", "itemDescriptions"],
    storeFields: ["id", "caption", "place", "cover", "created"],
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { place: 2, caption: 1.5 } },
  });
  const docs = posts.map((p) => ({
    id: p.id,
    caption: p.caption || "",
    place: p.place || "",
    cover: p.cover || "",
    created: p.created,
    itemNames: (p.items || []).map((i) => i.name).join(" "),
    itemDescriptions: (p.items || []).map((i) => i.description).join(" "),
  }));
  index.addAll(docs);
}

export function search(query) {
  if (!index) return [];
  return index.search(query);
}

/**
 * For queries that go beyond the user's saved posts — trip planning,
 * product discovery, destination comparison — use Claude's web search
 * to find relevant information and format it as actionable cards.
 */
export async function semanticSearch(apiKey, query) {
  if (apiKey === DEMO_KEY) return demoSearch(query);

  const info = await localInfo(apiKey, query);
  const suggestions = [];
  for (const n of info.nearby || []) {
    suggestions.push({
      name: n.name,
      category: n.category,
      description: n.note,
      place: query,
      search_query: n.name,
    });
  }
  const newsItems = (info.news || []).map((n) => `${n.title}: ${n.summary}`);
  const response = newsItems.length
    ? `Here's what we found for "${query}":\n\n${newsItems.join("\n\n")}`
    : `We found ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} for "${query}".`;

  return { response, suggestions };
}

function demoSearch(query) {
  return {
    response: `DEMO: Searching for "${query}". Add your API key in Settings for real results.`,
    suggestions: [
      { name: "Demo Dive Center", category: "experience", description: "PADI-certified, coral reef tours", place: query, search_query: "scuba diving" },
      { name: "Demo Resort & Spa", category: "hotel", description: "Beachfront, pool, restaurant", place: query, search_query: "beach resort" },
    ],
  };
}
