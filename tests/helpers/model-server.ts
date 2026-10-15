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
    // The default idle timeout would end the stalled response after 10 seconds.
    idleTimeout: 0,
    port: 0,
  });

  return { aborted: () => aborted, requests: () => requests, server };
};

/** Answers every model request with 404, so each download fails as soon as it starts. */
export const serveMissingModel = () => {
  let requests = 0;

  const server = Bun.serve({
    fetch: () => {
      requests += 1;

      return new Response("not found", { status: 404 });
    },
    port: 0,
  });

  return { requests: () => requests, server };
};

/**
 * Serves `bodies[i]` to the i-th request in two halves: the first at once, the second only after `release(i)`, so a
 * test can hold several downloads open at chosen points. `started(i)` resolves once request i has its first half.
 */
export const serveGatedModels = (bodies: readonly Uint8Array[]) => {
  const started = bodies.map(() => Promise.withResolvers<undefined>());
  const released = bodies.map(() => Promise.withResolvers<undefined>());
  let requests = 0;

  const server = Bun.serve({
    fetch: () => {
      const index = requests;
      requests += 1;
      const body = bodies[index];

      if (body === undefined) {
        return new Response("not found", { status: 404 });
      }

      const half = Math.floor(body.byteLength / 2);

      return new Response(
        new ReadableStream({
          start: async (controller) => {
            controller.enqueue(body.slice(0, half));
            started[index]?.resolve();
            await released[index]?.promise;
            controller.enqueue(body.slice(half));
            controller.close();
          },
        }),
        { headers: { "content-length": String(body.byteLength) } }
      );
    },
    idleTimeout: 0,
    port: 0,
  });

  return {
    release: (index: number) => released[index]?.resolve(),
    server,
    started: (index: number) => started[index]?.promise,
  };
};
