/**
 * 每一轮对话的讲次范围和引用编号。
 * 工具在同一次请求的异步调用链里读取，不把范围交给模型自行放宽。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface Citation {
  n: number;
  title: string;
  locator: string;
  quote: string;
  url: string;
}

interface TurnScope {
  /** null 表示不限定讲次，检索全库 */
  lectures: string[] | null;
  citations: Citation[];
}

const store = new AsyncLocalStorage<TurnScope>();

export function runWithScope<T>(lectures: string[] | null, fn: () => Promise<T>): Promise<T> {
  return store.run({ lectures, citations: [] }, fn);
}

export function scopedLectures(): string[] | null {
  return store.getStore()?.lectures ?? null;
}

export function addCitation(item: Omit<Citation, "n">): number {
  const bag = store.getStore()?.citations;
  if (!bag) return 0;
  const quote = item.quote.trim();
  const found = bag.find((c) => c.title === item.title && c.locator === item.locator && c.quote === quote);
  if (found) return found.n;
  const n = bag.length + 1;
  bag.push({ ...item, quote, n });
  return n;
}

export function citationSnapshot(): Citation[] {
  return [...(store.getStore()?.citations ?? [])];
}
