import { STARTUP_CHECK_PREFIX } from "../../src/audio/player.ts";

export const failsAfterStartupCheck = (code: number) =>
  `case "$1" in *${STARTUP_CHECK_PREFIX}*) exit 0 ;; esac\n/bin/sleep 0.2\nexit ${code}`;

export const playsFor = (seconds: number) =>
  `case "$1" in *${STARTUP_CHECK_PREFIX}*) exit 0 ;; esac\n/bin/sleep ${seconds}\nexit 0`;
