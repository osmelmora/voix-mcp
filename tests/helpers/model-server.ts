import { KOKORO_MODEL } from "../../src/providers/kokoro/model.ts";

/** Enough for the downloader to report progress (it reports every 2 MB). */
const STALLED_BYTES = 3 * 1024 * 1024;

/**
 * Serves the start of a model download, then stalls forever, so a download only ends when the
 * client goes away. Point VOIX_MODEL_URL at `server.url`.
 */
export const serveStalledModel = () => {
  let requests = 0;
  let aborted = 0;

  const server = Bun.serve({
    fetch: (request) => {
      requests += 1;
      request.signal.addEventListener("abort", () => {
        aborted += 1;
      });

      return new Response(
        new ReadableStream({
          // Never resolves: the body stays open until the client goes away.
          pull: () => Promise.withResolvers<undefined>().promise,
          start: (controller) => {
            controller.enqueue(new Uint8Array(STALLED_BYTES));
          },
        }),
        { headers: { "content-length": String(KOKORO_MODEL.size) } }
      );
    },
    port: 0,
  });

  return { aborted: () => aborted, requests: () => requests, server };
};
