import { createHash } from "node:crypto";

/** Scalar guards shared by provider parsers; no provider state or I/O. */
export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export const text = (value: unknown, limit = 256): string => typeof value === "string" ? value.slice(0, limit) : "";
export const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
export const callKey = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
export const validStart = (start: number | null, at: number): number | null => start !== null && at - start >= 100 && at - start <= 900_000 ? start : null;
