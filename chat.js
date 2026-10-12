import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
import * as db from "./db.js";
import * as cloud from "./cloud.js";
import { DEMO_KEY } from "./ai.js";

const MODEL = "claude-sonnet-4-5-20250514";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let chatOpen = false;
let messages = [];
let processing = false;
let selectedMedia = null;

function apiKey() {
  try { return JSON.parse(localStorage.getItem("fft-settings"))?.apiKey || ""; }
  catch { return ""; }
}

export function initChat() {
  if (document.getElementById("chat-bubble")) return;

  const bubble = document.createElement("button");
  bubble.id = "chat-bubble";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`;
  bubble.addEventListener("click", toggleChat);
  document.body.append(bubble);

  const panel = document.createElement("div");
  panel.id = "chat-panel";
  panel.classList.add("chat-panel-closed");
  panel.innerHTML = `
    <div class="chat-header">
      <span class="chat-title">FFT Assistant</span>
      <button id="chat-close" aria-label="Close chat">&times;</button>
    </div>
    <div id="chat-messages"></div>
    <div class="chat-input-area">
      <label class="chat-attach-btn" aria-label="Attach image or video">
        <input id="chat-file" type="file" accept="image/*,video/*,.mov,.mp4" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      </label>
      <input id="chat-input" type="text" placeholder="Ask anything about travel, food, products…">
      <button id="chat-send" aria-label="Send">
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div id="chat-media-preview" hidden></div>
  `;
  document.body.append(panel);

  document.getElementById("chat-close").addEventListener("click", toggleChat);
  document.getElementById("chat-send").addEventListener("click", sendMessage);
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById("chat-file").addEventListener("change", handleFileAttach);

  addBotMessage("Hi! I'm your travel assistant. I can help you:\n\n• Plan trips based on your posts or a location\n• Identify products and places from photos/videos\n• Find hotels, restaurants, activities with booking links\n• Save plans and share them\n\nWhat would you like to explore?");
}

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById("chat-panel").classList.toggle("chat-panel-closed", !chatOpen);
  document.getElementById("chat-bubble").classList.toggle("chat-bubble-hidden", chatOpen);
  if (chatOpen) {
    document.getElementById("chat-input").focus();
    document.getElementById("chat-messages").scrollTop = 999999;
  }
}

function addBotMessage(text) {
  messages.push({ role: "assistant", content: text });
  renderMessages();
}

function addUserMessage(text, mediaPreview) {
  const display = mediaPreview ? `📎 [Media attached]\n${text}` : text;
  renderMessage("user", display);
}

function renderMessages() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = "";
  for (const m of messages) {
    if (m.role === "system") continue;
    renderMessage(m.role === "user" ? "user" : "bot", typeof m.content === "string" ? m.content : "[media message]", container);
  }
  container.scrollTop = container.scrollHeight;
}

function renderMessage(role, text, container) {
  if (!container) container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `chat-msg chat-msg-${role === "user" ? "user" : "bot"}`;
  div.innerHTML = formatMessage(text);
  container.append(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function formatMessage(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(.*?)\]\((https?:\/\/.*?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(https?:\/\/[^\s<]+)/g, (url, match) => {
      if (text.includes(`(${match})`)) return match;
      return `<a href="${match}" target="_blank" rel="noopener">${match}</a>`;
    })
    .replace(/\n/g, "<br>");
}

function showStatus(text) {
  let el = document.getElementById("chat-status");
  if (!el) {
    el = document.createElement("div");
    el.id = "chat-status";
    el.className = "chat-msg chat-msg-status";
    document.getElementById("chat-messages").append(el);
  }
  el.textContent = text;
  document.getElementById("chat-messages").scrollTop = 999999;
}

function hideStatus() {
  document.getElementById("chat-status")?.remove();
}

async function handleFileAttach(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const preview = document.getElementById("chat-media-preview");

  if (file.size > 20 * 1024 * 1024) {
    preview.hidden = false;
    preview.innerHTML = `<span class="chat-preview-text">File too large (max 20MB). Try a shorter video.</span>`;
    selectedMedia = null;
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    selectedMedia = { data: reader.result, type: file.type, name: file.name };
    preview.hidden = false;
    if (file.type.startsWith("image/")) {
      preview.innerHTML = `<img src="${reader.result}" class="chat-preview-img"><button class="chat-preview-remove">&times;</button>`;
    } else {
      preview.innerHTML = `<span class="chat-preview-text">📎 ${file.name}</span><button class="chat-preview-remove">&times;</button>`;
    }
    preview.querySelector(".chat-preview-remove")?.addEventListener("click", () => {
      selectedMedia = null;
      preview.hidden = true;
      preview.innerHTML = "";
    });
  };
  reader.readAsDataURL(file);
}

async function getContext() {
  const posts = await db.listPosts();
  let cloudPosts = [];
  if (cloud.isConfigured()) {
    try { cloudPosts = await cloud.fetchPosts(20); } catch {}
  }
  const localIds = new Set(posts.map(p => p.id));
  const allPosts = [...posts];
  for (const cp of cloudPosts) {
    if (!localIds.has(cp.id)) allPosts.push(cp);
  }

  const plans = await db.listPlans();
  return {
    posts: allPosts.slice(0, 12).map(p => ({
      id: p.id, caption: p.caption, place: p.place,
      items: (p.items || []).slice(0, 5).map(i => ({ name: i.name, category: i.category, brand: i.brand })),
    })),
    plans: plans.slice(0, 5).map(p => ({ id: p.id, destination: p.destination, overview: p.overview?.slice(0, 100) })),
    postCount: allPosts.length,
    planCount: plans.length,
  };
}

async function sendMessage() {
  if (processing) return;
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text && !selectedMedia) return;

  const key = apiKey();
  if (!key || key === DEMO_KEY) {
    addBotMessage("Please add your Anthropic API key in Settings first.");
    return;
  }

  processing = true;
  input.value = "";
  document.getElementById("chat-send").disabled = true;

  addUserMessage(text || "What's in this image/video?", selectedMedia);

  const userContent = [];
  if (selectedMedia) {
    const base64 = selectedMedia.data.split(",")[1];
    const mediaType = selectedMedia.type || "image/jpeg";
    if (mediaType.startsWith("image/")) {
      userContent.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
    }
    const preview = document.getElementById("chat-media-preview");
    preview.hidden = true;
    preview.innerHTML = "";
    selectedMedia = null;
  }
  userContent.push({ type: "text", text: text || "What's in this image/video? Identify the location, products, brands, and anything interesting." });

  messages.push({ role: "user", content: userContent.length === 1 ? userContent[0].text : userContent });

  showStatus("Thinking…");

  try {
    const ctx = await getContext();
    const systemPrompt = `You are the Fun, Food & Travel assistant — a friendly, knowledgeable travel and lifestyle AI.

CONTEXT: The user has ${ctx.postCount} posts and ${ctx.planCount} saved plans in the app.
${ctx.posts.length ? `Recent posts: ${JSON.stringify(ctx.posts)}` : "No posts yet."}
${ctx.plans.length ? `Saved plans: ${JSON.stringify(ctx.plans)}` : "No saved plans."}

CAPABILITIES:
1. **Travel planning**: Recommend destinations, activities, hotels, restaurants with real booking links. Use web search to find current prices.
2. **Product identification**: Identify products, brands, gear from photos. Find purchase links.
3. **Location identification**: Identify places from photos/videos. Suggest nearby activities.
4. **Plan creation**: Create detailed "Pack your Plan" itineraries with sections for flights, hotels, activities, restaurants, products, budget.
5. **Recommendations**: Suggest similar destinations, activities, products based on the user's posts.

RESPONSE FORMAT:
- Be conversational and helpful
- Include **clickable links** for bookings, products, etc. using markdown: [text](url)
- Use **bold** for important info
- When creating a plan, format it clearly with sections
- If you need more info, ask follow-up questions
- Keep responses concise but informative
- When the user wants to save a plan, format it as JSON at the end wrapped in \`\`\`json ... \`\`\` with structure: {"plan": {"destination": "...", "overview": "...", "sections": [{"title": "...", "items": [{"name": "...", "description": "...", "category": "flight|hotel|activity|restaurant|product", "price": "...", "link": "..."}]}], "budget": "..."}}

LOCATION: If the user asks about "around me" or "near me", ask them to share their location or specify a city.`;

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

    const apiMessages = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role,
      content: m.content,
    }));

    showStatus("Searching and planning…");

    let response = await client.beta.messages.create({
      model: MODEL, max_tokens: 4096,
      betas: [FALLBACK_BETA], fallbacks: "default",
      system: systemPrompt,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: apiMessages,
    });

    for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
      showStatus("Still searching…");
      response = await client.beta.messages.create({
        model: MODEL, max_tokens: 4096,
        betas: [FALLBACK_BETA], fallbacks: "default",
        system: systemPrompt,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages: [...apiMessages, { role: "assistant", content: response.content }],
      });
    }

    const botText = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    hideStatus();

    if (botText) {
      messages.push({ role: "assistant", content: botText });
      renderMessage("bot", botText);

      const jsonMatch = botText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.plan) {
            showPlanAction(parsed.plan);
          }
        } catch {}
      }
    } else {
      addBotMessage("I couldn't generate a response. Please try again.");
    }

  } catch (err) {
    hideStatus();
    addBotMessage(`Sorry, something went wrong: ${err.message}`);
  } finally {
    processing = false;
    document.getElementById("chat-send").disabled = false;
    document.getElementById("chat-input").focus();
  }
}

function showPlanAction(plan) {
  const container = document.getElementById("chat-messages");
  const actions = document.createElement("div");
  actions.className = "chat-plan-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "chat-action-btn primary";
  saveBtn.textContent = "Save Plan";
  saveBtn.addEventListener("click", async () => {
    const id = crypto.randomUUID();
    const planObj = {
      id, created: Date.now(),
      destination: plan.destination || "Travel Plan",
      overview: plan.overview || "",
      sections: plan.sections || [],
      budget: plan.budget || "",
      coverImages: [],
    };
    await db.savePlan(planObj);
    cloud.uploadPlan(planObj);
    saveBtn.textContent = "Saved!";
    saveBtn.disabled = true;
    addBotMessage(`Plan saved! Go to the **Plans** tab to view it, download the travel itinerary, or share it.`);
  });

  const viewBtn = document.createElement("button");
  viewBtn.className = "chat-action-btn";
  viewBtn.textContent = "View in Plans";
  viewBtn.addEventListener("click", () => {
    toggleChat();
    location.hash = "#plans";
  });

  actions.append(saveBtn, viewBtn);
  container.append(actions);
  container.scrollTop = container.scrollHeight;
}
