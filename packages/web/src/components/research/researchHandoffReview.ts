import { useCallback, useSyncExternalStore } from "react";

const KEY = "brainpilot.researchHandoffReviewIds";
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}

function readIds(): Set<string> {
  const session = storage();
  if (!session) return new Set();
  try {
    const value = JSON.parse(session.getItem(KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

const pending = readIds();

function updateStorage() {
  try { storage()?.setItem(KEY, JSON.stringify([...pending])); } catch { /* private mode */ }
  listeners.forEach((listener) => listener());
}

export const researchHandoffReview = {
  mark(sessionId: string) { pending.add(sessionId); updateStorage(); },
  clear(sessionId: string) { if (pending.delete(sessionId)) updateStorage(); },
  has(sessionId: string | null) { return sessionId !== null && pending.has(sessionId); },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useResearchHandoffReview(sessionId: string | null): boolean {
  const getSnapshot = useCallback(() => researchHandoffReview.has(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
