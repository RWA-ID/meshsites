/**
 * IndexedDB store of CAR files keyed by root CID, shared by the simulator,
 * the viewer page and the service worker (same origin). Only CARs that
 * verified are written; the service worker re-verifies on read anyway.
 */
const DB = 'meshsites';
const STORE = 'cars';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export interface StoredCar {
  root: string;
  car: Uint8Array;
  label: string;
  savedAt: number;
}

export const putCar = (c: StoredCar) => tx('readwrite', (s) => s.put(c, c.root));
export const getCar = (root: string) => tx<StoredCar | undefined>('readonly', (s) => s.get(root));
export const listCars = () => tx<StoredCar[]>('readonly', (s) => s.getAll());
export const deleteCar = (root: string) => tx('readwrite', (s) => s.delete(root));
