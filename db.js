// Posts and plans stored on this phone in IndexedDB.

const DB_NAME = "fun-food-travel";
const DB_VERSION = 2;
const POSTS = "posts";
const PLANS = "plans";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(POSTS)) db.createObjectStore(POSTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PLANS)) db.createObjectStore(PLANS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Not enough storage space on this phone."));
  });
}

export const savePost = (post) => run(POSTS, "readwrite", (s) => s.put(post));
export const getPost = (id) => run(POSTS, "readonly", (s) => s.get(id));
export const deletePost = (id) => run(POSTS, "readwrite", (s) => s.delete(id));
export async function listPosts() {
  const all = await run(POSTS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.created - a.created);
}

export const savePlan = (plan) => run(PLANS, "readwrite", (s) => s.put(plan));
export const getPlan = (id) => run(PLANS, "readonly", (s) => s.get(id));
export const deletePlan = (id) => run(PLANS, "readwrite", (s) => s.delete(id));
export async function listPlans() {
  const all = await run(PLANS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.created - a.created);
}

// Ask the browser not to clear our data when space is low. Home-screen apps
// on iPhone are already exempt from Safari's 7-day cleanup.
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
