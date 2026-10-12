// Shared cloud storage for cross-device, cross-user post & plan sharing.
// Uses Supabase REST API (PostgREST) directly — no SDK dependency.

const SETTINGS_KEY = "fft-settings";

function cfg() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return { url: s?.supabaseUrl?.replace(/\/+$/, ""), key: s?.supabaseKey };
  } catch { return {}; }
}

export function isConfigured() {
  const c = cfg();
  return !!(c.url && c.key);
}

async function rest(path, opts = {}) {
  const c = cfg();
  if (!c.url || !c.key) return null;
  const res = await fetch(`${c.url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Permission denied (${res.status}). Check Supabase anon key and RLS policies.`);
    }
    if (res.status === 404) {
      throw new Error(`Table not found (404). Create shared_posts and shared_plans tables in Supabase.`);
    }
    throw new Error(`Cloud ${res.status}: ${body.slice(0, 200)}`);
  }
  if (opts.prefer?.includes("return=minimal")) return true;
  return res.json();
}

export async function uploadPost(post) {
  if (!isConfigured()) return;
  try {
    await rest("shared_posts", {
      method: "POST",
      prefer: "return=minimal,resolution=merge-duplicates",
      body: JSON.stringify({
        id: post.id,
        created: post.created,
        caption: post.caption || "",
        place: post.place || "",
        source_url: post.sourceUrl || "",
        cover: post.cover || "",
        items: post.items || [],
        location: post.location || null,
        tags: post.tags || "",
        news: post.news || [],
      }),
    });
  } catch (err) {
    console.warn("Cloud upload failed:", err);
  }
}

export async function fetchPosts(limit = 200) {
  if (!isConfigured()) return [];
  try {
    const rows = await rest(`shared_posts?order=created.desc&limit=${limit}`);
    return (rows || []).map((r) => ({
      id: r.id,
      created: r.created,
      caption: r.caption,
      place: r.place,
      sourceUrl: r.source_url,
      cover: r.cover,
      items: r.items || [],
      location: r.location,
      tags: r.tags,
      news: r.news || [],
      _cloud: true,
    }));
  } catch (err) {
    console.warn("Cloud fetch failed:", err);
    return [];
  }
}

export async function fetchPost(id) {
  if (!isConfigured()) return null;
  try {
    const rows = await rest(`shared_posts?id=eq.${id}&limit=1`);
    if (!rows?.length) return null;
    const r = rows[0];
    return {
      id: r.id, created: r.created, caption: r.caption, place: r.place,
      sourceUrl: r.source_url, cover: r.cover, items: r.items || [],
      location: r.location, tags: r.tags, news: r.news || [], _cloud: true,
    };
  } catch { return null; }
}

export async function fetchPlans(limit = 200) {
  if (!isConfigured()) return [];
  try {
    const rows = await rest(`shared_plans?order=created.desc&limit=${limit}`);
    return (rows || []).map((r) => ({
      id: r.id,
      created: r.created,
      destination: r.destination,
      overview: r.overview,
      sections: r.sections || [],
      budget: r.budget,
      coverImages: r.cover_images || [],
      _cloud: true,
    }));
  } catch (err) {
    console.warn("Cloud plans fetch failed:", err);
    return [];
  }
}

export async function fetchPlan(id) {
  if (!isConfigured()) return null;
  try {
    const rows = await rest(`shared_plans?id=eq.${id}&limit=1`);
    if (!rows?.length) return null;
    const r = rows[0];
    return {
      id: r.id, created: r.created, destination: r.destination,
      overview: r.overview, sections: r.sections || [],
      budget: r.budget, coverImages: r.cover_images || [], _cloud: true,
    };
  } catch { return null; }
}

export async function uploadPlan(plan) {
  if (!isConfigured()) return;
  try {
    await rest("shared_plans", {
      method: "POST",
      prefer: "return=minimal,resolution=merge-duplicates",
      body: JSON.stringify({
        id: plan.id,
        created: plan.created,
        destination: plan.destination || "",
        overview: plan.overview || "",
        sections: plan.sections || [],
        budget: plan.budget || "",
        cover_images: plan.coverImages || [],
      }),
    });
  } catch (err) {
    console.warn("Cloud plan upload failed:", err);
  }
}
