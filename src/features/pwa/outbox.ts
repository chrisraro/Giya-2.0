export interface OfflineReceiptItem {
  idempotencyKey: string;
  businessId: string;
  amountCentavos: number;
  createdAt: string;
}

const memoryOutbox: OfflineReceiptItem[] = [];

export async function queueOfflineReceipt(item: OfflineReceiptItem): Promise<void> {
  if (typeof window !== "undefined" && "indexedDB" in window) {
    try {
      const db = await openDB();
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put(item);
      return;
    } catch {
      // Fallback memory store
    }
  }
  memoryOutbox.push(item);
}

export async function getOfflineOutbox(): Promise<OfflineReceiptItem[]> {
  if (typeof window !== "undefined" && "indexedDB" in window) {
    try {
      const db = await openDB();
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([...memoryOutbox]);
      });
    } catch {
      return [...memoryOutbox];
    }
  }
  return [...memoryOutbox];
}

export async function clearOfflineItem(idempotencyKey: string): Promise<void> {
  if (typeof window !== "undefined" && "indexedDB" in window) {
    try {
      const db = await openDB();
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(idempotencyKey);
    } catch {
      // memory fallback
      const idx = memoryOutbox.findIndex((i) => i.idempotencyKey === idempotencyKey);
      if (idx !== -1) memoryOutbox.splice(idx, 1);
    }
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("giya-offline-db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "idempotencyKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
