#!/usr/bin/env node
// Only the two initial-turn clocks (acknowledged task, handled task) are
// accelerated. No production flag, environment override, recovery clock,
// overall deadline or kill timer changes.
const realSetTimeout = globalThis.setTimeout;
const accelerated = new Set([300_000, 60_000]);
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, accelerated.has(delay) ? 250 : delay, ...args);
await import("../../dist/worker.js");
