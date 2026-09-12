/**
 * Input hardening for the public, unauthenticated telemetry endpoints (CCT-08).
 *
 * These endpoints accept anonymous POSTs from the CLI and the website, so they
 * cannot require auth without breaking that flow (and any shared token would
 * ship in the client anyway). What they CAN do is refuse oversized bodies and
 * bound every free-form field before it reaches the database, so the endpoints
 * can't be used to write unbounded junk / exhaust storage.
 */

/** Raised when a request body exceeds the allowed size. */
export class PayloadTooLargeError extends Error {
  constructor(message = 'Request body too large') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Read and JSON-parse a request body, rejecting anything larger than `maxBytes`.
 * Uses Content-Length when present and always re-checks the actual bytes read
 * (the header is advisory and can lie).
 */
export async function readJsonLimited(request: Request, maxBytes = 16 * 1024): Promise<any> {
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared && declared > maxBytes) {
    throw new PayloadTooLargeError();
  }
  const text = await request.text();
  // Byte length, not char length — multibyte chars must count fully.
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new PayloadTooLargeError();
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Coerce a value to a trimmed string capped at `max` chars, or `null` when it is
 * missing/empty/not a primitive string.
 */
export function clampStr(value: unknown, max = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Like clampStr but returns `fallback` instead of null when absent. */
export function clampStrOr(value: unknown, fallback: string, max = 255): string {
  return clampStr(value, max) ?? fallback;
}

/** Coerce to a bounded integer, or `null` when not a finite number in range. */
export function clampInt(value: unknown, min = 0, max = 2_147_483_647): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

/**
 * Serialize a value to JSON only if it stays under `maxBytes`; otherwise `null`.
 * Guards against a huge nested object being stringified into one DB column.
 */
export function clampJson(value: unknown, maxBytes = 4 * 1024): string | null {
  if (value === null || value === undefined) return null;
  let str: string;
  try {
    str = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!str || new TextEncoder().encode(str).length > maxBytes) return null;
  return str;
}
