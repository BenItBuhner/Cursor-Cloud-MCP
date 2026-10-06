import { describe, expect, it } from "vitest";
import {
  connectPath,
  connectUrl,
  envelope,
  parseConnectErrorBody,
  readFrame,
} from "../src/connectRpc.js";

describe("connectRpc", () => {
  it("builds PascalCase paths", () => {
    expect(connectPath("aiserver.v1.BackgroundComposerService", "StreamConversation")).toBe(
      "/aiserver.v1.BackgroundComposerService/StreamConversation",
    );
    expect(connectUrl("https://api2.cursor.sh/", "a.B", "M")).toBe(
      "https://api2.cursor.sh/a.B/M",
    );
  });

  it("envelopes and reads frames", () => {
    const payload = new TextEncoder().encode('{"bcId":"bc-1"}');
    const bytes = envelope(0, payload);
    expect(bytes[0]).toBe(0);
    const len = (bytes[1]! << 24) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!;
    expect(len).toBe(payload.length);
    const next = readFrame(bytes, 0)!;
    expect(next.frame.isEndStream).toBe(false);
    expect(new TextDecoder().decode(next.frame.data)).toBe('{"bcId":"bc-1"}');
    expect(next.nextOffset).toBe(bytes.length);
    expect(readFrame(bytes, bytes.length)).toBeNull();
  });

  it("flags end-stream frames", () => {
    const bytes = envelope(0b10, new TextEncoder().encode("{}"));
    expect(readFrame(bytes, 0)!.frame.isEndStream).toBe(true);
  });

  it("parses Connect error bodies", () => {
    expect(parseConnectErrorBody('{"code":"unauthenticated","message":"no"}')).toEqual({
      code: "unauthenticated",
      message: "no",
    });
    expect(parseConnectErrorBody("not json")).toEqual({});
  });
});
