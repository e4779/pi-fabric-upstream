import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * External surface bridge: fabric-as-engine access for a foreign surface
 * tool. In `surface: "external"` mode no model tool is registered; the
 * engine is reachable through three equal doors:
 *
 *   1. globalThis[Symbol.for("pi-fabric.external.v1")] — in-process
 *      consumers (extensions, tools implemented in TypeScript);
 *   2. a per-process unix socket speaking a line protocol — any process;
 *   3. process.env.FABRIC_SOCK, set here in the host process so every
 *      tool that spawns children with the inherited environment gets the
 *      socket path for free. Zero integration for the common case.
 *
 * Line protocol (one command per connection): the client sends each argv
 * element as one line, then half-closes; the server replies with `OK` or
 * `ERR <message>` followed by payload lines, then closes. Text only —
 * friendly to rg pipes by design.
 */

export interface ExternalBridgeHandle {
  version: number;
  socketPath: string;
  surface: string;
  close(): void;
}

export const EXTERNAL_BRIDGE_SYMBOL = Symbol.for("pi-fabric.external.v1");

interface BridgeStateView {
  bootstrapped: boolean;
  surface: string;
}

const HELP = ["commands:", "  ping            liveness + version + surface", "  status          engine state summary", "  help            this list"].join("\n");

export function startExternalBridge(options: {
  version: number;
  stateView: () => BridgeStateView;
  socketDir?: string;
  log?: (message: string) => void;
}): ExternalBridgeHandle {
  const dir = options.socketDir?.trim() || join(homedir(), ".pi", "agent", "sock");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, `fabric-${process.pid}.sock`);
  rmSync(socketPath, { force: true });

  const dispatch = (argv: string[]): { ok: boolean; lines: string[] } => {
    const view = options.stateView();
    switch (argv[0] ?? "") {
      case "ping":
        return {
          ok: true,
          lines: [
            `fabric-external ${options.version}`,
            `surface ${view.surface}`,
            `bootstrapped ${view.bootstrapped ? "true" : "false"}`,
          ],
        };
      case "status":
        return {
          ok: true,
          lines: [
            `surface ${view.surface}`,
            `bootstrapped ${view.bootstrapped ? "true" : "false"}`,
            `pid ${process.pid}`,
          ],
        };
      case "help":
        return { ok: true, lines: HELP.split("\n") };
      default:
        return { ok: false, lines: [`unknown command ${JSON.stringify(argv[0] ?? "")} — try help`] };
    }
  };

  const server = createServer((socket: Socket): void => {
    const lines: string[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      lines.push(...chunk.split("\n"));
    });
    socket.on("end", () => {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const head = dispatch(lines);
      const first = head.ok ? "OK" : `ERR ${head.lines.shift() ?? ""}`;
      socket.end([first, ...head.lines, ""].join("\n"));
    });
    socket.on("error", () => {
      /* client vanished mid-request: nothing to answer */
    });
  });

  const handle: ExternalBridgeHandle = {
    version: options.version,
    socketPath,
    surface: "external",
    close(): void {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      rmSync(socketPath, { force: true });
      if (process.env.FABRIC_SOCK === socketPath) delete process.env.FABRIC_SOCK;
      if ((globalThis as Record<symbol, unknown>)[EXTERNAL_BRIDGE_SYMBOL] === handle) {
        delete (globalThis as Record<symbol, unknown>)[EXTERNAL_BRIDGE_SYMBOL];
      }
    },
  };

  server.listen(socketPath, () => {
    // 0600 after the fact: the socket can drive the engine — same user only.
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      /* best effort */
    }
    process.env.FABRIC_SOCK = socketPath;
    const globals = globalThis as Record<symbol, unknown>;
    if (!globals[EXTERNAL_BRIDGE_SYMBOL]) globals[EXTERNAL_BRIDGE_SYMBOL] = handle;
    options.log?.(`fabric external bridge: ${socketPath}`);
  });

  return handle;
}
