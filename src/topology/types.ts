import type { FabricAgentRunner, FabricAgentTransport } from "../config.js";
import type { MeshIdentity } from "../mesh/store.js";
import type { AgentUsage } from "../agents/types.js";

/** `provider`: work a Fabric provider registered through `context.participants`. */
export type FabricParticipantKind = "root" | "agent" | "actor" | "provider";
export type FabricParticipantResidency = "session" | "durable";
export type FabricParticipantScope = "local" | "lineage" | "project";
export type FabricParticipantCapability =
  | "steer"
  | "followUp"
  | "stop"
  | "ask"
  | "actor-bindings"
  | "attach"
  | "fabric";

export interface FabricParticipantRecord {
  format: 1;
  id: string;
  kind: FabricParticipantKind;
  rootId: string;
  ownerHostId: string;
  ownerIdentityId: string;
  /**
   * Control-plane incarnation of the owner process that wrote this record.
   * Requesters copy it onto control commands so a restarted owner can refuse
   * commands meant for its previous process. Absent on older records.
   */
  ownerIncarnation?: string;
  parentId?: string;
  name: string;
  /**
   * Project-scoped Linear-style label (e.g. "PQS-2") minted once per root
   * participant via the mesh peer sequence. Never reused after a peer leaves.
   */
  label?: string;
  status: string;
  residency?: FabricParticipantResidency;
  /** Absent only for `provider` participants, which have no agent runner. */
  runner?: FabricAgentRunner;
  /** Registering provider name for `provider` participants. */
  provider?: string;
  transport: FabricAgentTransport | "host" | "hosted";
  capabilities: FabricParticipantCapability[];
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pendingMessages?: boolean;
  currentTool?: string;
  turns?: number;
  toolCalls?: number;
  usage?: AgentUsage;
  actorQueued?: number;
  actorMessages?: number;
  controlProtocol: "v1" | "legacy";
}

export interface FabricParticipantInfo extends FabricParticipantRecord {
  local: boolean;
  stale: boolean;
}

export interface FabricHostRecord {
  format: 1;
  id: string;
  rootId: string;
  identity: MeshIdentity;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface FabricParticipantListOptions {
  scope?: FabricParticipantScope;
  kinds?: FabricParticipantKind[];
  includeStale?: boolean;
}

/**
 * A root session that is no longer live. `stopped`: it closed cleanly and
 * left a tombstone. `lost`: its owner lease expired without one (a crash).
 */
export interface FabricDepartedParticipant {
  format: 1;
  id: string;
  kind: "root";
  rootId: string;
  ownerHostId: string;
  ownerIdentityId: string;
  ownerIncarnation?: string;
  name: string;
  label?: string;
  cwd?: string;
  sessionId?: string;
  status: "stopped" | "lost";
  startedAt: number;
  /** When the session stopped, or its last heartbeat before it was lost. */
  lastSeenAt: number;
}

export interface FabricDepartedListOptions {
  /** Most entries returned, newest first. Defaults to the configured tombstone limit, or 32 when that limit is 0. */
  limit?: number;
}

export interface FabricPeerInfo {
  id: string;
  name: string;
  /** Minted peer label when the owning host publishes one. */
  label?: string;
  kind: "peer";
  status: "idle" | "running";
  runner: "pi";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}

export interface FabricParticipantSource {
  list(options?: FabricParticipantListOptions, now?: number): FabricParticipantInfo[];
  get(id: string, now?: number): FabricParticipantInfo | undefined;
  self(now?: number): FabricParticipantInfo;
  /** All live root Pi session agents, including the current lineage root. */
  sessions?(now?: number): FabricParticipantInfo[];
  peers(now?: number): FabricPeerInfo[];
  /** Stopped and lost root sessions; opt-in, never part of live discovery. */
  departed?(options?: FabricDepartedListOptions, now?: number): FabricDepartedParticipant[];
  refresh(): Promise<void>;
  scheduleRefresh(): void;
}
