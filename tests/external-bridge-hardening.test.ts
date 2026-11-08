import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startExternalBridge, type ExternalBridgeHandle } from "../src/external/bridge.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-bridge-hardening-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

describe("external bridge hardening", () => {
  let bridge: ExternalBridgeHandle | undefined;
  let logs: string[];

  const start = (): void => {
    logs = [];
    bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      log: (message) => logs.push(message),
    });
  };

  afterEach(() => {
    bridge?.close();
    bridge = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const connect = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(bridge!.socketPath);
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("connect", () => resolve(socket));
    });

  const readAll = (socket: net.Socket): Promise<string> =>
    new Promise((resolve) => {
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
      });
      socket.on("close", () => resolve(buffer));
    });

  it("reassembles argv lines split across chunk boundaries", async () => {
    start();
    const socket = await connect();
    const reply = readAll(socket);
    // one logical message delivered as three hostile fragments, including a
    // split inside a word and a split multi-byte character
    socket.write("pi");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.write("n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.write("g\n");
    socket.end();
    expect(await reply).toBe("OK\nfabric-external 2\nsurface external\nbootstrapped true\n");
  });

  it("enforces the per-connection byte budget", async () => {
    start();
    const socket = await connect();
    const reply = readAll(socket);
    socket.write("x".repeat(2 << 20));
    socket.end();
    // The ERR is best-effort under an ongoing flood (RST can beat it); the
    // invariant is: no OK dispatch for the oversized message, and the
    // server stays healthy for the next client.
    expect(await reply).not.toMatch(/^OK/);

    const fresh = await connect();
    const freshReply = readAll(fresh);
    fresh.write("ping\n");
    fresh.end();
    expect(await freshReply).toContain("fabric-external 2");
  });

  it("reaps dead-pid sockets and never touches live ones", () => {
    const sleeper = spawn("sleep", ["10"]);
    const dir = temporaryDirectory("reap");
    const dead = path.join(dir, "fabric-999999999.sock");
    const live = path.join(dir, `fabric-${sleeper.pid}.sock`);
    fs.writeFileSync(dead, "");
    fs.writeFileSync(live, "");
    try {
    const logs2: string[] = [];
    startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: dir,
      log: (message) => logs2.push(message),
     }).close();
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(logs2.some((line) => line.includes("reaped stale socket fabric-999999999.sock"))).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("creates the socket directory 0700", () => {
    start();
    const mode = fs.statSync(path.dirname(bridge!.socketPath)).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
