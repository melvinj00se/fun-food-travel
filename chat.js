import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
import * as db from "./db.js";
import * as cloud from "./cloud.js";
import { DEMO_KEY, MODEL, FALLBACK_BETA } from "./ai.js";
import { fetchPlanImages, buildPlanHTML } from "./search.js";

const CHAT_MODEL = "claude-sonnet-5-5";

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
    <div class="chat-header" id="chat-header">
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

  initDrag();

  addBotMessage("Hi! I'm your travel assistant. I can help you:\n\n• Select posts on Home and ask me to plan similar trips\n• Identify products and places from photos/videos\n• Find hotels, restaurants, activities with booking links\n• Save plans, download itineraries, and share them\n\nSelect posts on the Home tab or just ask me anything!");
}

function initDrag() {
  if (matchMedia("(max-width: 599px)").matches) return;
  const header = document.getElementById("chat-header");
  const panel = document.getElementById("chat-panel");
  let dragging = false, startX, startY, origX, origY;

  header.style.cursor = "grab";
  header.addEventListener("mousedown", (e) => {
    if (e.target.id === "chat-close") return;
    dragging = true;
    header.style.cursor = "grabbing";
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    origX = rect.left; origY = rect.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    panel.style.left = `${origX + dx}px`;
    panel.style.top = `${origY + dy}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; header.style.cursor = "grab"; }
  });
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
  const postMap = (p) => ({
    id: p.id, caption: p.caption, place: p.place,
    items: (p.items || []).slice(0, 5).map(i => ({ name: i.name, category: i.category, brand: i.brand })),
  });

  const selectedIds = window._fftSelectedPosts || new Set();
  const selectedPosts = selectedIds.size
    ? allPosts.filter(p => selectedIds.has(p.id)).map(postMap)
    : [];

  let viewingPost = null;
  let viewingPlan = null;
  const [view, viewId] = (location.hash.slice(1) || "home").split("/");
  if (view === "post" && viewId) {
    const p = allPosts.find(x => x.id === viewId) || await db.getPost(viewId);
    if (p) viewingPost = postMap(p);
  }
  if (view === "plan" && viewId) {
    const p = await db.getPlan(viewId);
    if (p) viewingPlan = { id: p.id, destination: p.destination, overview: p.overview?.slice(0, 200), sections: (p.sections || []).map(s => s.title) };
  }

  return {
    posts: allPosts.slice(0, 12).map(postMap),
    plans: plans.slice(0, 5).map(p => ({ id: p.id, destination: p.destination, overview: p.overview?.slice(0, 100) })),
    postCount: allPosts.length,
    planCount: plans.length,
    selectedPosts,
    viewingPost,
    viewingPlan,
    currentTab: view,
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
    const systemPrompt = `You are the Fun, Food & Travel assistant. Be concise and action-oriented.

CONTEXT: User has ${ctx.postCount} posts, ${ctx.planCount} plans. On "${ctx.currentTab}" tab.
${ctx.selectedPosts.length ? `SELECTED POSTS: ${JSON.stringify(ctx.selectedPosts)}` : ""}
${ctx.viewingPost ? `VIEWING POST: ${JSON.stringify(ctx.viewingPost)}` : ""}
${ctx.viewingPlan ? `VIEWING PLAN: ${JSON.stringify(ctx.viewingPlan)}` : ""}
${ctx.posts.length ? `Recent posts: ${JSON.stringify(ctx.posts)}` : ""}
${ctx.plans.length ? `Saved plans: ${JSON.stringify(ctx.plans)}` : ""}

RULES:
1. You HAVE web search — use it to find real booking links and current prices. You are NOT in a sandbox. You have full internet access via the web_search tool.
2. When the user asks to create/save a plan, OUTPUT THE JSON IMMEDIATELY in your response. Do not say "I'll work on it" — just do it. The app auto-saves JSON plans.
3. Keep responses under 500 words. Be direct, skip preamble.
4. When the selected posts or current post is visible in context above, USE that info directly — don't ask the user to describe it again.
5. For multi-part requests (save plan + download), produce the plan JSON first. The app handles download separately.
6. Include **clickable links** using markdown [text](url). Use **bold** for key info.
7. Format plan JSON at the end wrapped in \`\`\`json ... \`\`\` with structure: {"plan": {"destination": "...", "overview": "...", "sections": [{"title": "...", "items": [{"name": "...", "description": "...", "category": "flight|hotel|activity|restaurant|product", "price": "...", "link": "..."}]}], "budget": "..."}}`;

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

    const apiMessages = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role,
      content: m.content,
    }));

    showStatus("Searching the web…");

    let response = await client.beta.messages.create({
      model: CHAT_MODEL, max_tokens: 4096,
      betas: [FALLBACK_BETA], fallbacks: "default",
      system: systemPrompt,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      messages: apiMessages,
    });

    const statusMsgs = ["Gathering more details…", "Almost there…", "Finishing up…"];
    for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
      showStatus(statusMsgs[i] || "Still working…");
      response = await client.beta.messages.create({
        model: CHAT_MODEL, max_tokens: 4096,
        betas: [FALLBACK_BETA], fallbacks: "default",
        system: systemPrompt,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
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
            await autoSavePlan(parsed.plan);
          }
        } catch {}
      }
    } else {
      addBotMessage("The search took longer than expected. Please try rephrasing your request more specifically, or break it into smaller questions.");
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

async function autoSavePlan(plan) {
  const id = crypto.randomUUID();
  const planObj = {
    id, created: Date.now(),
    destination: plan.destination || "Travel Plan",
    overview: plan.overview || "",
    sections: plan.sections || [],
    budget: plan.budget || "",
    coverImages: [],
  };

  showStatus("Saving plan…");
  await db.savePlan(planObj);
  cloud.uploadPlan(planObj);
  hideStatus();

  renderMessage("bot", `Plan **"${planObj.destination}"** saved to your Plans tab!`);

  const container = document.getElementById("chat-messages");
  const actions = document.createElement("div");
  actions.className = "chat-plan-actions";

  const dlBtn = document.createElement("button");
  dlBtn.className = "chat-action-btn primary";
  dlBtn.textContent = "Download Itinerary";
  dlBtn.addEventListener("click", async () => {
    dlBtn.disabled = true;
    dlBtn.textContent = "Finding photos…";
    try {
      const images = await fetchPlanImages(apiKey(), planObj);
      const html = buildPlanHTML(planObj, images);
      const blob = new Blob([html], { type: "text/html" });
      const file = new File([blob], `${planObj.destination || "Travel-Plan"}.html`, { type: "text/html" });
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      if (isMobile && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: planObj.destination });
      } else {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        const a = document.createElement("a"); a.href = url; a.download = file.name; a.click();
      }
      dlBtn.textContent = "Downloaded!";
      renderMessage("bot", "Itinerary downloaded! Open it in your browser, then **Cmd+P** (or Ctrl+P) to save as PDF. Attach the file to email, WhatsApp, etc.");
    } catch (err) {
      dlBtn.textContent = "Download Itinerary";
      dlBtn.disabled = false;
      renderMessage("bot", `Couldn't generate itinerary: ${err.message}`);
    }
  });

  const viewBtn = document.createElement("button");
  viewBtn.className = "chat-action-btn";
  viewBtn.textContent = "View in Plans";
  viewBtn.addEventListener("click", () => {
    toggleChat();
    location.hash = `#plan/${id}`;
  });

  actions.append(dlBtn, viewBtn);
  container.append(actions);
  container.scrollTop = container.scrollHeight;
}

