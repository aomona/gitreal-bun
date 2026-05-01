#!/usr/bin/env bun
// index.ts – entrypoint with signal handling and version flag (mirrors cmd/git-real/main.go)
import { run } from "./cli.ts";

// Build-time variables injected via `bun build --define`
declare const __VERSION__: string;
declare const __COMMIT__: string;
declare const __DATE__: string;

const version =
  typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
const commit =
  typeof __COMMIT__ !== "undefined" ? __COMMIT__ : "none";
const date =
  typeof __DATE__ !== "undefined" ? __DATE__ : "unknown";

function printVersion(): void {
  process.stdout.write(`git-real ${version} (${commit}, built ${date})\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle --version / -V before dispatching
  for (const arg of args) {
    if (arg === "--version" || arg === "-V") {
      printVersion();
      process.exit(0);
    }
  }

  const controller = new AbortController();
  const { signal } = controller;

  // Honor SIGINT (Ctrl-C) and SIGTERM
  const onSignal = () => {
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const code = await run(signal, args);
    process.exit(code);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main();
