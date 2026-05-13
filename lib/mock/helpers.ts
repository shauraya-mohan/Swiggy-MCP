import type { SwiggyErr, SwiggyOk } from "./types";

export function ok<T>(data: T, message?: string): SwiggyOk<T> {
  return message ? { success: true, data, message } : { success: true, data };
}

export function err(message: string, code?: string): SwiggyErr {
  return code
    ? { success: false, error: { message, code } }
    : { success: false, error: { message } };
}

// Adds realistic-feeling latency so the agent doesn't get suspiciously instant
// answers from the mock layer.
export function jitterDelay(min = 60, max = 180): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

export function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSpoken(deltaMin: number): string {
  if (deltaMin < 5) return "a few minutes";
  if (deltaMin < 12) return "about ten minutes";
  if (deltaMin < 18) return "about fifteen minutes";
  if (deltaMin < 25) return "about twenty minutes";
  if (deltaMin < 35) return "about thirty minutes";
  if (deltaMin < 50) return "about forty-five minutes";
  return "about an hour";
}

export function lowerIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
