import { describe, it, expect } from "vitest";
import { parseSSELines } from "./sse.js";

/** Create a mock Response with a ReadableStream body. */
function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });

  return new Response(stream);
}

async function collect(resp: Response): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const event of parseSSELines(resp)) {
    results.push(event);
  }
  return results;
}

describe("parseSSELines", () => {
  it("parses a single SSE event", async () => {
    const resp = mockResponse(['data: {"type":"hello"}\n\n']);
    const events = await collect(resp);
    expect(events).toEqual([{ type: "hello" }]);
  });

  it("parses multiple events", async () => {
    const resp = mockResponse([
      'data: {"a":1}\ndata: {"b":2}\n\n',
    ]);
    const events = await collect(resp);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles events split across chunks", async () => {
    const resp = mockResponse([
      'data: {"sp',
      'lit":"value"}\n\n',
    ]);
    const events = await collect(resp);
    expect(events).toEqual([{ split: "value" }]);
  });

  it("skips [DONE] sentinel", async () => {
    const resp = mockResponse([
      'data: {"a":1}\ndata: [DONE]\n\n',
    ]);
    const events = await collect(resp);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("skips malformed JSON", async () => {
    const resp = mockResponse([
      'data: not-json\ndata: {"ok":true}\n\n',
    ]);
    const events = await collect(resp);
    expect(events).toEqual([{ ok: true }]);
  });

  it("ignores non-data lines", async () => {
    const resp = mockResponse([
      'event: message\ndata: {"a":1}\nid: 123\n\n',
    ]);
    const events = await collect(resp);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("handles empty body", async () => {
    const resp = mockResponse([""]);
    const events = await collect(resp);
    expect(events).toEqual([]);
  });

  it("throws on missing body", async () => {
    const resp = new Response(null);
    await expect(collect(resp)).rejects.toThrow("No response body");
  });
});
