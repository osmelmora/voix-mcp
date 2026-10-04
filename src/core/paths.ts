import os from "node:os";
import path from "node:path";

/** Root of everything voix stores on disk. Override with VOIX_HOME. */
export const voixHome = (): string =>
  process.env.VOIX_HOME ?? path.join(os.homedir(), ".cache", "voix");

export const modelsDir = (): string => path.join(voixHome(), "models");
