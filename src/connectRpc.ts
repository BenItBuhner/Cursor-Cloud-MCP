/**
 * Connect-JSON protocol helpers.
 *
 * Mirrors app/src/main/java/com/cursorforandroid/data/api/ConnectRpc.kt:
 * unary = POST /<Service>/<Method> with JSON body, headers
 * `Authorization: Bearer <token>` + `Connect-Protocol-Version: 1`.
 * Streaming = same path, `Content-Type: application/connect+json`,
 * single enveloped message (flags byte + u32be length + JSON).
 */
export class ConnectRpcError extends Error {
  constructor(
    message: string,
    readonly httpCode: number,
    readonly code?: string,
    readonly path?: string,
    readonly retryAfterMillis?: number,
  ) {
    super(message);
    this.name = "ConnectRpcError";
  }
  get isUnauthenticated(): boolean {
    return this.httpCode === 401 || this.code === "unauthenticated";
  }
  get isRateLimited(): boolean {
    return this.httpCode === 429 || this.code === "resource_exhausted";
  }
}

export function connectPath(service: string, method: string): string {
  return `/${service}/${method}`;
}

export function connectUrl(
  baseUrl: string,
  service: string,
  method: string,
): string {
  return `${baseUrl.replace(/\/+$/, "")}${connectPath(service, method)}`;
}

/** One enveloped Connect streaming message. */
export function envelope(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags & 0xff;
  out[1] = (payload.length >>> 24) & 0xff;
  out[2] = (payload.length >>> 16) & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, 5);
  return out;
}

export interface ConnectFrame {
  flags: number;
  data: Uint8Array;
  isEndStream: boolean;
}

export const END_STREAM_FLAG = 0b10;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function readFrame(
  buf: Uint8Array,
  offset: number,
): { frame: ConnectFrame; nextOffset: number } | null {
  if (offset >= buf.length) return null;
  if (buf.length - offset < 5) {
    throw new ConnectRpcError(
      "Connect frame ended after fewer than its 5 header bytes.",
      0,
      "unreadable_answer",
    );
  }
  const flags = buf[offset]!;
  const length =
    (buf[offset + 1]! << 24) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 8) |
    buf[offset + 4]!;
  if (length < 0 || length > MAX_FRAME_BYTES) {
    throw new ConnectRpcError(
      `Connect frame declared ${length} bytes.`,
      0,
      "unreadable_answer",
    );
  }
  if (buf.length - offset - 5 < length) {
    throw new ConnectRpcError(
      `Connect frame ended after fewer than its ${length} bytes.`,
      0,
      "unreadable_answer",
    );
  }
  const data = buf.slice(offset + 5, offset + 5 + length);
  return {
    frame: { flags, data, isEndStream: (flags & END_STREAM_FLAG) !== 0 },
    nextOffset: offset + 5 + length,
  };
}

export function parseConnectErrorBody(text: string): {
  code?: string;
  message?: string;
} {
  try {
    const obj = JSON.parse(text) as { code?: unknown; message?: unknown };
    return {
      code: typeof obj.code === "string" ? obj.code : undefined,
      message: typeof obj.message === "string" ? obj.message : undefined,
    };
  } catch {
    return {};
  }
}

export async function throwForConnectResponse(
  res: Response,
  path: string,
): Promise<never> {
  const retryAfter = res.headers.get("retry-after");
  const text = await res.text().catch(() => "");
  const parsed = parseConnectErrorBody(text);
  throw new ConnectRpcError(
    parsed.message || `Connect call ${path} failed with HTTP ${res.status}.`,
    res.status,
    parsed.code,
    path,
    retryAfter ? Number(retryAfter) * 1000 : undefined,
  );
}
