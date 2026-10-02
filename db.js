// Posts (including photo/video files) stored on this phone in IndexedDB.

const DB_NAME = "fun-food-travel";
const STORE = "posts";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Not enough storage space on this phone."));
  });
}

export const savePost = (post) => run("readwrite", (s) => s.put(post));
export const getPost = (id) => run("readonly", (s) => s.get(id));
export const deletePost = (id) => run("readwrite", (s) => s.delete(id));
export async function listPosts() {
  const all = await run("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.created - a.created);
}

// Ask the browser not to clear our data when space is low. Home-screen apps
// on iPhone are already exempt from Safari's 7-day cleanup.
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
