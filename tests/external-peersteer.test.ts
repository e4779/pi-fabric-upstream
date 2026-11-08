import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import {
  clearActivePeerControl,
  FabricRuntimeState,
  getActivePeerControl,
  publishActivePeerControl,
  type FabricPeerControl,
  type FabricPeerControlOperation,
} from "../src/fabric-runtime-state.js";
import type { FabricPeerInfo } from "../src/topology/types.js";
import {
  createPeerControlCommand,
  PEER_COMMAND_HELP,
  peerLine,
} from "../src/extension.js";
import {
  composeCommands,
  startExternalBridge,
  type ExternalBridgeHandle,
} from "../src/external/bridge.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-peersteer-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const peer = (label: string, id: string, status: "running" | "idle" = "running"): FabricPeerInfo => ({
  id,
  name: label,
  label,
  kind: "peer",
  status,
  runner: "pi",
  transport: "host",
  cwd: "/repo",
  sessionId: label,
  startedAt: 1,
  updatedAt: 2,
  pendingMessages: false,
  local: false,
});

interface RecordedRequest {
  targetId: string;
  operation: FabricPeerControlOperation;
  message?: string;
}

/** Fake control plane injected through the peerControl() accessor seam. */
const fakeControl = (behavior: (request: RecordedRequest) => void | Promise<void> = () => undefined) => {
  const requests: RecordedRequest[] = [];
  const control: FabricPeerControl = {
    request: async (targetId, operation, message) => {
      const request: RecordedRequest = { targetId, operation, ...(message === undefined ? {} : { message }) };
      requests.push(request);
      await behavior(request);
      return { messageId: `ack-${requests.length}` };
    },
  };
  return { control, requests };
};

/** Runtime-style source: peers plus the accessor, exactly like the wiring reads it. */
const source = (peers: FabricPeerInfo[], control: FabricPeerControl | undefined) => ({
  peerInfos: () => peers,
  peerControl: () => control,
});

describe("peerControl accessor", () => {
  it("is undefined while the engine is down (never initialized)", () => {
    const runtime = new FabricRuntimeState({} as ExtensionAPI, new CapturedToolCatalog());
    expect(runtime.peerControl()).toBeUndefined();
    expect(getActivePeerControl()).toBeUndefined();
  });

  it("the published runtime answers live: retraction turns the seam off", () => {
    const first = new FabricRuntimeState({} as ExtensionAPI, new CapturedToolCatalog());
    const second = new FabricRuntimeState({} as ExtensionAPI, new CapturedToolCatalog());
    publishActivePeerControl(first);
    // Engine still down on both: the seam resolves through peerControl(), so it
    // answers undefined until a real control plane exists.
    expect(getActivePeerControl()).toBeUndefined();
    publishActivePeerControl(second);
    clearActivePeerControl(first); // identity-checked: stale teardown keeps the live one
    expect(getActivePeerControl()).toBeUndefined();
    clearActivePeerControl(second);
    expect(getActivePeerControl()).toBeUndefined();
  });
});

describe("peer command resolution and submission", () => {
  const peers = [
    peer("FAB-2", "aaaaaaa1-1111-4111-8111-111111111111"),
    peer("FAB-3", "aaaaaaa2-2222-4222-8222-222222222222"),
    peer("main-fork", "bbbbbbbb-3333-4333-8333-333333333333", "idle"),
  ];

  it("resolves an exact label and submits steer with the textFile contents", async () => {
    const textFile = path.join(temporaryDirectory("text"), "steer.txt");
    fs.writeFileSync(textFile, "pivot to the left");
    const fake = fakeControl();
    const handler = createPeerControlCommand(source(peers, fake.control));
    const reply = await handler(["peer", "steer", "FAB-2", `textFile=${textFile}`]);
    expect(reply?.ok).toBe(true);
    expect(reply?.lines[0]).toBe("messageId=ack-1");
    expect(reply?.lines[1]).toContain("FAB-2");
    expect(fake.requests).toEqual([
      { targetId: "aaaaaaa1-1111-4111-8111-111111111111", operation: "steer", message: "pivot to the left" },
    ]);
  });

  it("follow maps to the followUp operation", async () => {
    const textFile = path.join(temporaryDirectory("text"), "follow.txt");
    fs.writeFileSync(textFile, "after this run");
    const fake = fakeControl();
    const handler = createPeerControlCommand(source(peers, fake.control));
    const reply = await handler(["peer", "follow", "FAB-3", `textFile=${textFile}`]);
    expect(reply?.ok).toBe(true);
    expect(fake.requests).toEqual([
      { targetId: "aaaaaaa2-2222-4222-8222-222222222222", operation: "followUp", message: "after this run" },
    ]);
  });

  it("stop needs no textFile and resolves by id prefix", async () => {
    const fake = fakeControl();
    const handler = createPeerControlCommand(source(peers, fake.control));
    const reply = await handler(["peer", "stop", "bbbbbbbb"]);
    expect(reply?.ok).toBe(true);
    expect(fake.requests).toEqual([
      { targetId: "bbbbbbbb-3333-4333-8333-333333333333", operation: "stop" },
    ]);
  });

  it("an ambiguous id prefix lists every candidate", async () => {
    const fake = fakeControl();
    const handler = createPeerControlCommand(source(peers, fake.control));
    const reply = await handler(["peer", "stop", "aaaaaaa"]);
    expect(reply?.ok).toBe(false);
    expect(reply?.lines[0]).toContain("ambiguous peer aaaaaaa");
    expect(reply?.lines[0]).toContain("FAB-2");
    expect(reply?.lines[0]).toContain("FAB-3");
    expect(fake.requests).toEqual([]);
  });

  it("an unknown peer answers ERR with the peers list", async () => {
    const fake = fakeControl();
    const handler = createPeerControlCommand(source(peers, fake.control));
    const reply = await handler(["peer", "steer", "FAB-9", "textFile=/dev/null"]);
    expect(reply?.ok).toBe(false);
    expect(reply?.lines[0]).toBe("unknown peer FAB-9");
    expect(reply?.lines.slice(1)).toEqual(peers.map(peerLine));
    expect(fake.requests).toEqual([]);
  });

  it("no peers at all still answers ERR, with a (no peers) hint", async () => {
    const handler = createPeerControlCommand(source([], fakeControl().control));
    const reply = await handler(["peer", "stop", "FAB-2"]);
    expect(reply?.ok).toBe(false);
    expect(reply?.lines).toEqual(["unknown peer FAB-2", "(no peers)"]);
  });

  it("steer and follow demand textFile and surface read failures", async () => {
    const handler = createPeerControlCommand(source(peers, fakeControl().control));
    await expect(handler(["peer", "steer", "FAB-2"])).rejects.toThrow(/textFile=/);
    await expect(handler(["peer", "steer", "FAB-2", "textFile="])).rejects.toThrow(/non-empty textFile/);
    await expect(handler(["peer", "steer", "FAB-2", `textFile=${path.join(temporaryDirectory("gone"), "x.txt")}`]))
      .rejects.toThrow(/cannot read textFile/);
  });

  it("bad verbs fall back to usage; engine-down rejects before resolution", async () => {
    const handler = createPeerControlCommand(source(peers, fakeControl().control));
    await expect(handler(["peer", "nudge", "FAB-2"])).rejects.toThrow(PEER_COMMAND_HELP);
    const down = createPeerControlCommand(source(peers, undefined));
    await expect(down(["peer", "steer", "FAB-2", "textFile=/dev/null"])).rejects.toThrow(/engine is down/);
  });

  it("control-plane failures surface verbatim", async () => {
    const fake = fakeControl(() => {
      throw new Error("Timed out waiting for the remote Fabric owner to acknowledge");
    });
    const handler = createPeerControlCommand(source(peers, fake.control));
    await expect(handler(["peer", "stop", "FAB-2"])).rejects.toThrow(/Timed out waiting/);
  });

  it("non-peer argv falls through", async () => {
    const handler = createPeerControlCommand(source(peers, fakeControl().control));
    expect(await handler(["peers"])).toBeUndefined();
    expect(await handler(["agent", "list"])).toBeUndefined();
  });
});

describe("peer command over the bridge socket", () => {
  let bridge: ExternalBridgeHandle | undefined;
  let fake: ReturnType<typeof fakeControl>;
  let peers: FabricPeerInfo[];
  let textFile: string;
  // The accessor seam itself: flipping this to undefined is engine-down.
  let control: FabricPeerControl | undefined;

  beforeEach(() => {
    fake = fakeControl();
    control = fake.control;
    peers = [
      peer("FAB-2", "aaaaaaa1-1111-4111-8111-111111111111"),
      peer("FAB-3", "aaaaaaa2-2222-4222-8222-222222222222"),
    ];
    textFile = path.join(temporaryDirectory("text"), "msg.txt");
    fs.writeFileSync(textFile, "socket steer");
    bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: composeCommands(
        createPeerControlCommand({
          peerInfos: () => peers,
          peerControl: () => control,
        }),
      ),
    });
  });

  afterEach(() => {
    bridge?.close();
    bridge = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const speak = (payload: string[]): Promise<{ status: string; lines: string[] }> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(bridge!.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${[...payload, ""].join("\n")}`);
        socket.end();
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
      });
      socket.on("close", () => {
        const parts = buffer.replace(/\n$/, "").split("\n");
        const status = parts.shift() ?? "";
        resolve({ status, lines: parts });
      });
    });

  it("steer rides the socket: OK, messageId, and the control plane sees the text", async () => {
    const reply = await speak(["peer", "steer", "FAB-2", `textFile=${textFile}`]);
    expect(reply.status).toBe("OK");
    expect(reply.lines[0]).toMatch(/^messageId=ack-\d+$/);
    expect(reply.lines[1]).toContain("FAB-2");
    expect(fake.requests).toEqual([
      { targetId: "aaaaaaa1-1111-4111-8111-111111111111", operation: "steer", message: "socket steer" },
    ]);
  });

  it("unknown peers and engine-down come back as ERR over the socket", async () => {
    const unknown = await speak(["peer", "stop", "zzzzzzzz"]);
    expect(unknown.status).toBe("ERR unknown peer zzzzzzzz");
    expect(unknown.lines).toEqual(peers.map(peerLine));

    control = undefined; // engine down: the accessor seam goes dark
    const down = await speak(["peer", "steer", "FAB-3", `textFile=${textFile}`]);
    expect(down.status).toBe("ERR peer control is unavailable: the fabric engine is down");
  });
});

describe("peerLine keeps the peers listing format", () => {
  it("label, status, model, pending, and the 8-char id", () => {
    expect(peerLine(peer("FAB-2", "abcd1234-ffff-4cbe-9f1f-3c2d5a6b7c8d"))).toBe("FAB-2 running id=abcd1234");
    expect(
      peerLine({ ...peer("FAB-3", "abcd5678-ffff-4cbe-9f1f-3c2d5a6b7c8d"), model: "claude-x", pendingMessages: true }),
    ).toBe("FAB-3 running model=claude-x pending id=abcd5678");
  });
});
