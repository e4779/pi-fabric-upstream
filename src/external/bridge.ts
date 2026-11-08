import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

export interface ExternalCommandResult {
  ok: boolean;
  lines: string[];
}

/**
 * Optional async command extension, tried before the builtins. Return
 * undefined to fall through; the first line of a failed result is what the
 * client sees after `ERR`.
 */
export type ExternalCommandHandler = (argv: string[]) => Promise<ExternalCommandResult | undefined>;

/** First handler to claim the argv wins; undefined falls through to the next. */
export const composeCommands = (
  ...handlers: ExternalCommandHandler[]
): ExternalCommandHandler => {
  return async (argv: string[]) => {
    for (const handler of handlers) {
      const result = await handler(argv);
      if (result !== undefined) return result;
    }
    return undefined;
  };
};

const helpLines = (hasCommands: boolean): string[] => [
  "commands:",
  "  ping            liveness + version + surface",
  "  status          engine state summary",
  ...(hasCommands
    ? [
        "  agent           worker: promptFile=… blocks; submit/status/wait/",
        "                  result/stop/steer/follow/list run it detached",
        "  recall          search session memory (query=<terms> …)",
        "  vcc             session file views: summary/branch/entries/entry",
      ]
    : []),
  "  help            this list",
];

/** Per-connection argv budget: a runaway client must not grow host memory. */
const MAX_MESSAGE_BYTES = 1 << 20;

/** Remove fabric-<pid>.sock leftovers whose process is gone (ESRCH only:
 * EPERM means alive under another uid). Never touches live sessions. */
const reapStaleSockets = (dir: string, log?: (message: string) => void): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^fabric-(\d+)\.sock$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    try {
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      else throw new Error("not a pid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      try {
        rmSync(join(dir, name));
        log?.(`reaped stale socket ${name} (pid ${pid} gone)`);
      } catch {
        /* best effort */
      }
    }
  }
};

export function startExternalBridge(options: {
  version: number;
  stateView: () => BridgeStateView;
  socketDir?: string;
  log?: (message: string) => void;
  /** Async commands beyond the builtins; see ExternalCommandHandler. */
  commands?: ExternalCommandHandler;
}): ExternalBridgeHandle {
  const dir = options.socketDir?.trim() || join(homedir(), ".pi", "agent", "sock");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort: platforms ignoring dir modes */
  }
  reapStaleSockets(dir, options.log);
  const socketPath = join(dir, `fabric-${process.pid}.sock`);
  rmSync(socketPath, { force: true });

  const dispatch = async (argv: string[]): Promise<{ ok: boolean; lines: string[] }> => {
    if (options.commands) {
      const handled = await options.commands(argv);
      if (handled) return handled;
    }
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
        return { ok: true, lines: helpLines(options.commands !== undefined) };
      default:
        return { ok: false, lines: [`unknown command ${JSON.stringify(argv[0] ?? "")} — try help`] };
    }
  };

  // allowHalfOpen: the reply may be computed asynchronously; with the
  // default false, bun (and node's auto-FIN window) can close the writable
  // side before a microtask gets to write — seen live as empty replies.
  // We half-close explicitly once the reply is out.
  const server = createServer({ allowHalfOpen: true }, (socket: Socket): void => {
    const lines: string[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      // Accumulate and split on complete lines only: a TCP/socket write can
      // be split anywhere, and a naive per-chunk split turns one argv
      // element into two silently wrong ones (council finding #1).
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
        socket.end(`ERR message exceeds ${MAX_MESSAGE_BYTES} bytes\n`, () => socket.destroy());
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("end", () => {
      if (buffer !== "") lines.push(buffer); // final unterminated line
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      void dispatch(lines).then(
        (head) => {
          const first = head.ok ? "OK" : `ERR ${head.lines.shift() ?? ""}`;
          socket.end([first, ...head.lines, ""].join("\n"));
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          socket.end(`ERR ${message}\n`);
        },
      );
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

  // An unhandled 'error' (EADDRINUSE, EMFILE, EACCES) takes down the whole
  // host process, not just the bridge (council finding #2): degrade to a
  // logged, closed bridge instead.
  server.on("error", (error) => {
    options.log?.(`fabric external bridge error: ${error.message}`);
    try {
      server.close();
    } catch {
      /* already closed */
    }
    rmSync(socketPath, { force: true });
    if (process.env.FABRIC_SOCK === socketPath) delete process.env.FABRIC_SOCK;
  });

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
