/**
 * Shared SSE (Server-Sent Events) stream parser.
 * Both Claude and OpenAI providers use SSE framing with identical structure.
 * Uses indexOf loop instead of split to avoid re-scanning the buffer prefix on every chunk.
 */
export async function* parseSSELines(resp: Response): AsyncGenerator<unknown> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let start = 0;
      let idx: number;
      while ((idx = buffer.indexOf("\n", start)) !== -1) {
        const line = buffer.slice(start, idx);
        start = idx + 1;

        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        try {
          yield JSON.parse(data);
        } catch (e) {
          // Skip malformed/partial JSON, re-throw anything else
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
      buffer = buffer.slice(start);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
