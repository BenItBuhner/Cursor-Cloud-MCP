import { describe, expect, it } from "vitest";
import { isInjectedTurn, parseSseEvents } from "../src/cursorApi.js";

const SAMPLE = `event: status
data: {"runId":"run-1","status":"RUNNING"}

event: assistant
data: {"text":"I'll update the README now."}

event: tool_call
data: {"callId":"call-1","name":"read_file","status":"running","args":{"path":"README.md"}}

event: tool_call
data: {"callId":"call-1","name":"read_file","status":"completed","result":{"success":{"content":"# P"}}}

event: result
data: {"runId":"run-1","status":"FINISHED","text":"Done."}

event: done
data: {}
`;

describe("parseSseEvents", () => {
  it("parses coordinator-style streams", () => {
    const events = parseSseEvents(SAMPLE);
    expect(events.map((e) => e.event)).toEqual([
      "status",
      "assistant",
      "tool_call",
      "tool_call",
      "result",
      "done",
    ]);
    expect(JSON.parse(events[1]!.data)).toMatchObject({ text: expect.any(String) });
  });
});

describe("isInjectedTurn", () => {
  it("detects system_notification wrappers", () => {
    expect(
      isInjectedTurn("<system_notification>\nThe following task has finished."),
    ).toBe(true);
    expect(isInjectedTurn("Add a README")).toBe(false);
  });
});
