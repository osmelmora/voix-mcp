import { STARTUP_CHECK_PREFIX } from "../../src/audio/player.ts";

/** Body of a fake player that passes the silent startup check, then fails while playing speech. */
export const failsAfterStartupCheck = (code: number) =>
  `case "$1" in *${STARTUP_CHECK_PREFIX}*) exit 0 ;; esac\n/bin/sleep 0.2\nexit ${code}`;
