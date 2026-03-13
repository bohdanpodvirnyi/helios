import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createMouseFilter, type MouseEvent } from "./mouse-filter.js";

function makeFakeStdin(): NodeJS.ReadStream {
  const pt = new PassThrough();
  (pt as any).isTTY = true;
  (pt as any).setRawMode = vi.fn().mockReturnValue(pt);
  (pt as any).ref = vi.fn().mockReturnValue(pt);
  (pt as any).unref = vi.fn().mockReturnValue(pt);
  return pt as unknown as NodeJS.ReadStream;
}

/** Collect all output from the filteredStdin into a buffer. */
function collectOutput(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    // Use a short timeout to collect — streams are synchronous in tests
    setTimeout(() => resolve(Buffer.concat(chunks).toString()), 50);
  });
}

/** Push data into the fake stdin and wait a tick for processing. */
function pushData(stdin: NodeJS.ReadStream, data: string): Promise<void> {
  return new Promise((resolve) => {
    (stdin as unknown as PassThrough).write(data, () => {
      // Give the transform a tick to process
      setTimeout(resolve, 20);
    });
  });
}

describe("createMouseFilter", () => {
  let stdin: NodeJS.ReadStream;

  beforeEach(() => {
    stdin = makeFakeStdin();
  });

  describe("data filtering", () => {
    it("passes non-mouse data through unchanged", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      await pushData(stdin, "hello world");
      const result = await output;
      expect(result).toBe("hello world");
    });

    it("passes regular escape sequences through", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      // Arrow key escape sequence (not mouse)
      await pushData(stdin, "\x1b[A");
      const result = await output;
      expect(result).toBe("\x1b[A");
    });

    it("strips SGR mouse press sequences", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      // SGR mouse: button 0, x=10, y=20, press (M)
      await pushData(stdin, "\x1b[<0;10;20M");
      const result = await output;
      expect(result).toBe("");
    });

    it("strips SGR mouse release sequences", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      // SGR mouse: button 0, x=10, y=20, release (m)
      await pushData(stdin, "\x1b[<0;10;20m");
      const result = await output;
      expect(result).toBe("");
    });

    it("outputs only text from mixed data with mouse events", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      // Text, mouse event, more text
      await pushData(stdin, "before\x1b[<0;10;20Mafter");
      const result = await output;
      expect(result).toBe("beforeafter");
    });

    it("strips multiple mouse sequences from mixed data", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      await pushData(stdin, "a\x1b[<0;1;1Mb\x1b[<0;2;2mc");
      const result = await output;
      expect(result).toBe("abc");
    });

    it("handles empty chunks correctly", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      await pushData(stdin, "");
      const result = await output;
      // Empty string write may or may not produce output
      expect(typeof result).toBe("string");
    });

    it("handles chunks with only mouse sequences (no text output)", async () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const output = collectOutput(filteredStdin);

      await pushData(stdin, "\x1b[<64;10;20M\x1b[<65;10;20M");
      const result = await output;
      expect(result).toBe("");
    });
  });

  describe("mouse event emission", () => {
    it("emits scroll_up for button 64", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));

      // Drain filteredStdin to prevent backpressure
      filteredStdin.on("data", () => {});

      await pushData(stdin, "\x1b[<64;15;25M");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("scroll_up");
      expect(events[0].x).toBe(15);
      expect(events[0].y).toBe(25);
      expect(events[0].button).toBe(64);
    });

    it("emits scroll_down for button 65", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      await pushData(stdin, "\x1b[<65;5;10M");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("scroll_down");
      expect(events[0].x).toBe(5);
      expect(events[0].y).toBe(10);
      expect(events[0].button).toBe(65);
    });

    it("emits click for regular button press", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      // button 0, press (M)
      await pushData(stdin, "\x1b[<0;10;20M");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("click");
      expect(events[0].button).toBe(0);
    });

    it("emits release for button release", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      // button 0, release (m)
      await pushData(stdin, "\x1b[<0;10;20m");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("release");
      expect(events[0].button).toBe(0);
    });

    it("emits move for buttons 32-63", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      // button 32 = mouse move
      await pushData(stdin, "\x1b[<32;10;20M");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("move");
      expect(events[0].button).toBe(32);
    });

    it("does not emit scroll for regular button events", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      // button 0 press and release
      await pushData(stdin, "\x1b[<0;10;20M\x1b[<0;10;20m");
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e.type).not.toBe("scroll_up");
        expect(e.type).not.toBe("scroll_down");
      }
    });

    it("parses correct coordinates from mouse events", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      await pushData(stdin, "\x1b[<0;123;456M");
      expect(events).toHaveLength(1);
      expect(events[0].x).toBe(123);
      expect(events[0].y).toBe(456);
    });

    it("emits multiple events for multiple mouse sequences in one chunk", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      await pushData(stdin, "\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<64;1;1M");
      expect(events).toHaveLength(3);
      for (const e of events) {
        expect(e.type).toBe("scroll_up");
      }
    });

    it("does not emit events for non-mouse data", async () => {
      const { filteredStdin, mouseEmitter } = createMouseFilter(stdin);
      const events: MouseEvent[] = [];
      mouseEmitter.on("mouse", (e: MouseEvent) => events.push(e));
      filteredStdin.on("data", () => {});

      await pushData(stdin, "just some text\x1b[Aarrow key");
      expect(events).toHaveLength(0);
    });
  });

  describe("TTY proxying", () => {
    it("copies isTTY from source stdin", () => {
      const { filteredStdin } = createMouseFilter(stdin);
      expect((filteredStdin as any).isTTY).toBe(true);
    });

    it("proxies setRawMode to the source stdin", () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const result = (filteredStdin as any).setRawMode(true);
      expect((stdin as any).setRawMode).toHaveBeenCalledWith(true);
      expect(result).toBe(filteredStdin);
    });

    it("proxies setEncoding to the source stdin", () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const setEncodingSpy = vi.spyOn(stdin, "setEncoding" as any);
      (filteredStdin as any).setEncoding("utf8");
      expect(setEncodingSpy).toHaveBeenCalledWith("utf8");
    });

    it("proxies ref to the source stdin", () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const result = (filteredStdin as any).ref();
      expect((stdin as any).ref).toHaveBeenCalled();
      expect(result).toBe(filteredStdin);
    });

    it("proxies unref to the source stdin", () => {
      const { filteredStdin } = createMouseFilter(stdin);
      const result = (filteredStdin as any).unref();
      expect((stdin as any).unref).toHaveBeenCalled();
      expect(result).toBe(filteredStdin);
    });
  });
});
