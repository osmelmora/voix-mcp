import { describe, expect, test } from "bun:test";

import { Option } from "effect";

import { nextProgress } from "../src/mcp.ts";

const downloading = (received: number, total: number) => ({
  downloading: Option.some({ received, total }),
  installed: false,
  loaded: false,
  modelPath: "/tmp/model",
});

describe("nextProgress", () => {
  test("keeps download progress at or below total when the byte count stalls at complete", () => {
    const status = downloading(100, 100);

    expect(nextProgress(0, status)).toEqual({
      message: "Downloading the speech model",
      progress: 100,
      total: 100,
    });

    expect(nextProgress(100, status)).toEqual({
      message: "Waiting for speech to finish",
      progress: 101,
    });
  });

  test("still forces a strict increase while the download is incomplete", () => {
    expect(nextProgress(50, downloading(50, 100))).toEqual({
      message: "Downloading the speech model",
      progress: 51,
      total: 100,
    });
  });
});
