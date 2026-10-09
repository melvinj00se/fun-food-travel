// Claude calls, made directly from the phone. The API key is the user's own,
// kept in this browser's storage only. Mirrors app/analyze.py on the server
// version - keep the two prompts in sync.

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";

const MODEL = "claude-opus-5-5";
// Server-side refusal fallback: if a safety classifier declines a request,
// the API re-runs it on Anthropic's recommended fallback model.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const DEMO_KEY = "demo";
export const CATEGORIES = ["product", "hotel", "car_rental", "experience", "restaurant", "place"];

export class AIError extends Error {}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    suggested_caption: { type: "string" },
    theme: { type: "string", enum: ["fun", "food", "travel", "mixed"] },
    location: {
      type: "object",
      properties: {
        name: { type: "string" },
        city: { type: "string" },
        region: { type: "string" },
        country: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] },
        evidence: { type: "string" },
        looks_like_private_home: { type: "boolean" },
      },
      required: ["name", "city", "region", "country", "confidence", "evidence", "looks_like_private_home"],
      additionalProperties: false,
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          brand: { type: "string" },
          description: { type: "string" },
          search_query: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          frame_index: { type: "integer" },
          source: { type: "string", enum: ["seen", "suggested"] },
        },
        required: ["name", "category", "brand", "description", "search_query", "confidence", "frame_index", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "suggested_caption", "theme", "location", "items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You analyse photos and video frames that a creator has uploaded to a \
"Fun, Food & Travel" sharing app. Your output is shown to the creator as suggestions \
they approve or reject before anything is published.

Identify:
1. Where the content was taken. Use landmarks, signage, menus, language, architecture, \
landscape, the creator's tags, and the approximate GPS if provided. Say what evidence you \
used. If you cannot tell, use confidence "unknown" and empty strings rather than guessing. \
Set looks_like_private_home to true if the scene appears to be someone's home, so the app \
can hide the location by default.
2. Things a viewer might want to buy or book, with source "seen":
   - product: anything visible that could be bought - clothing, footwear, hats, \
sunglasses, bags and backpacks, phones and cameras, drinkware, food and drink brands, \
cookware, souvenirs, sports and outdoor gear. Name the brand/model only when a logo, label \
or distinctive design makes it identifiable; otherwise describe it generically (e.g. \
"orange hard-shell carry-on suitcase") and leave brand empty.
   - hotel, car_rental, experience (tours, activities, tickets), restaurant, place.
   search_query must be what you would type into Amazon, eBay or Etsy (for products) or a \
travel site (for the rest) to find this or something very close.
   frame_index is the 0-based index of the image where the item is best seen.
3. Up to 4 extra products with source "suggested": things a viewer would find useful for \
this exact activity or place (e.g. water shoes and a waterproof phone pouch for a \
waterfall). Use frame_index 0 and confidence "medium" for these.

If audio is provided, also use it to:
- Identify spoken language and dialect (helps narrow location)
- Catch place names, street names, or transit announcements
- Note ambient sounds that suggest a specific environment (market, beach, train station, temple)
- Identify any brand or product names mentioned in speech

Rules: "seen" items must actually be visible or stated in the tags; never invent them. \
Do not identify people or describe their bodies. At most 12 seen items; prefer quality \
over quantity. Write the caption in the creator's voice, short and upbeat, no hashtags.`;

const LOCAL_INFO_PROMPT = (place, today) => `A traveller is looking at a post from ${place}. \
Today is ${today}. Search the web and find:

1. news: up to 5 current items (last few weeks or upcoming weeks) - events and festivals, \
travel advisories or transport disruptions, notable openings, practical tips. Skip crime and \
disaster stories unless they directly affect visitors right now (then use kind "advisory").
2. nearby: well-reviewed places close to ${place}, currently operating - up to 3 hotels \
(category "hotel"), 3 restaurants or cafes (category "restaurant"), 2 car rental companies \
with a local branch (category "car_rental") and 3 tours or activities (category \
"experience"). note is a few words on why it's worth it (e.g. "5-min walk, rooftop pool").

Reply with ONLY a JSON object, no other text:
{"news": [{"kind": "event|news|advisory|tip", "title": "...", "summary": "one sentence \
in your own words", "url": "source URL", "source": "publisher name"}],
 "nearby": [{"name": "...", "category": "hotel|restaurant|car_rental|experience", \
"note": "..."}]}`;

function uint8ToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function client(apiKey) {
  // The key is the phone owner's own and never leaves this device except to
  // call Anthropic, which is what the SDK's browser opt-in is for.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new AIError("Your Anthropic API key isn't valid. Check it in Settings.");
    } else if (err instanceof Anthropic.PermissionDeniedError) {
      throw new AIError("This API key doesn't have permission. Check your Anthropic Console.");
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new AIError("The AI is busy right now. Try again in a minute.");
    } else if (err instanceof Anthropic.APIConnectionError) {
      throw new AIError("Couldn't reach the AI. Check your internet connection.");
    } else if (err instanceof Anthropic.APIError) {
      // Out of credits shows up as a 400 with a billing message.
      throw new AIError(`AI service error (${err.status}): ${err.message}`);
    }
    throw err;
  }
}

/** frames: base64 JPEGs; gps: {lat, lon} rounded, or null; audio: Uint8Array WAV, or null. */
export async function analyze(apiKey, frames, tags, gps, audio) {
  if (apiKey === DEMO_KEY) return demoResult(frames.length);

  const content = [];
  frames.forEach((data, i) => {
    content.push({ type: "text", text: `Image ${i}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  });

  if (audio) {
    const audioB64 = uint8ToBase64(audio);
    content.push({ type: "input_audio", source: { type: "base64", media_type: "audio/wav", data: audioB64 } });
    content.push({ type: "text", text: "Audio from the video is included above. Listen for spoken language, place names, announcements, ambient sounds, and any brand/product mentions." });
  }

  const context = [`Creator tags/notes: ${tags.trim() || "(none)"}`];
  if (gps) context.push(`Approximate GPS from photo metadata: ${gps.lat}, ${gps.lon}`);
  content.push({ type: "text", text: context.join("\n") });

  const response = await call(() => client(apiKey).beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  }));
  if (response.stop_reason === "refusal") throw new AIError("The AI declined to analyse this content.");
  if (response.stop_reason === "max_tokens") throw new AIError("The analysis was cut off. Try fewer photos.");
  const text = response.content.find((b) => b.type === "text").text;
  return JSON.parse(text);
}

/** Current news plus nearby hotels/food/cars/tours, via Claude's web search. */
export async function localInfo(apiKey, place) {
  if (apiKey === DEMO_KEY) return demoLocalInfo(place);

  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: "user", content: LOCAL_INFO_PROMPT(place, today) }];
  let response;
  for (let i = 0; i < 4; i++) { // resume if a long search turn pauses
    response = await call(() => client(apiKey).beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      messages,
    }));
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  if (response.stop_reason === "refusal") throw new AIError("The AI declined to look up this location.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new AIError("Couldn't read the nearby results. Tap Refresh to try again.");
  return JSON.parse(match[0]);
}

function demoResult(nFrames) {
  return {
    summary: "DEMO MODE - sample result. Add your Anthropic API key in Settings for real analysis.",
    suggested_caption: "Golden hour on the Amalfi Coast, gelato in hand.",
    theme: "travel",
    location: {
      name: "Positano", city: "Positano", region: "Campania", country: "Italy",
      confidence: "medium", evidence: "Demo data", looks_like_private_home: false,
    },
    items: [
      { name: "Straw sun hat", category: "product", brand: "", description: "Wide-brim woven straw hat",
        search_query: "wide brim straw sun hat women", confidence: "high", frame_index: 0, source: "seen" },
      { name: "Polarized sunglasses", category: "product", brand: "Ray-Ban", description: "Classic wayfarer style",
        search_query: "Ray-Ban Wayfarer polarized", confidence: "medium", frame_index: Math.min(1, nFrames - 1), source: "seen" },
      { name: "Reef-safe sunscreen", category: "product", brand: "", description: "For long sunny days on the coast",
        search_query: "reef safe sunscreen SPF 50", confidence: "medium", frame_index: 0, source: "suggested" },
    ],
  };
}

function demoLocalInfo(place) {
  return {
    news: [{ kind: "tip", title: `DEMO: Best time to visit ${place}`,
             summary: "Demo item - real results come from live web search.",
             url: "https://example.com", source: "Demo" }],
    nearby: [
      { name: "Demo Seaview Hotel", category: "hotel", note: "Demo - sea views" },
      { name: "Demo Trattoria", category: "restaurant", note: "Demo - local seafood" },
      { name: "Hertz", category: "car_rental", note: "Demo - town branch" },
      { name: "Sunset boat cruise", category: "experience", note: "Demo - 2 hours" },
    ],
  };
}
