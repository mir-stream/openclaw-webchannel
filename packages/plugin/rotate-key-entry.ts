#!/usr/bin/env node
/**
 * Bin entry for `openclaw-webchannel-rotate-key` (#158).
 *
 * Deliberately the thinnest possible shell: argv in, exit code out. It exists
 * as its own entrypoint so the offline rotation command is a separate PROCESS
 * from the gateway — it can neither open a NATS transport nor install a
 * register subscription, and nothing in the running gateway can reach it.
 */

import {
  runRotateConversationKeyCli,
  type RotateCliStreams,
} from "./src/rotate-conversation-key-cli.js";

const streams: RotateCliStreams = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

process.exitCode = runRotateConversationKeyCli(process.argv.slice(2), streams);
