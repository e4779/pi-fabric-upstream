import { Interner, bit } from "./machine.js";
import { storageTransition } from "./generated/storage.js";
import type { MeshIdentity } from "../mesh/store.js";

const PLANS = ["Conflict", "Exhausted", "Unchanged", "PutNext", "DeleteNext"] as const;

export const storageRevision = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid Fabric mesh revision: expected a nonnegative safe integer");
  }
  return value;
};

const serialize = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Mesh values must be JSON-serializable");
  return json;
};

export type StorageTransition =
  | { kind: "put"; key: string; value: unknown; identity: MeshIdentity; version: number; highWater: number }
  | { kind: "delete"; key: string; version: number; highWater: number }
  | { kind: "unchanged" };

export interface CapturedStorageRequest {
  readonly key: string;
  readonly transition: (present: boolean, actualVersion: number, highWater: number) => StorageTransition;
}

const capture = (
  key: string,
  ifVersion: number | undefined,
  payload?: { value: string; identity: string },
): CapturedStorageRequest => {
  const expected = ifVersion === undefined ? undefined : storageRevision(ifVersion);
  // The JSON strings never escape this closure. Caller-owned objects (including
  // nested identity/value) are not retained across lock wait.
  return Object.freeze({
    key,
    transition(present: boolean, actualVersion: number, highWater: number): StorageTransition {
      const actual = storageRevision(actualVersion);
      const clock = storageRevision(highWater);
      if (clock < actual) throw new Error("Inconsistent Fabric mesh high-water revision");
      // Ids start at 1, so a forwarded 0 can never name a string.
      const names = new Interner(1);
      const out = storageTransition.step({}, storageTransition.init({}), {
        key: names.id(key), any: bit(expected === undefined), expected: expected ?? 0,
        put: bit(payload !== undefined), value: names.id(payload?.value ?? ""), identity: names.id(payload?.identity ?? ""),
        present: bit(present), version: actual, highWater: clock,
      }).scalars;
      // Representation conversion only; CAS, overflow and successor decisions are
      // performed by the executable proved reducer, not reproduced here.
      const plan = PLANS[out["out.plan"]!];
      switch (plan) {
        case "Conflict":
          throw new Error(`Mesh compare-and-swap failed for ${key}: expected version ${expected}, found ${actual}`);
        case "Exhausted":
          throw new Error(`Fabric mesh revision exhausted for ${key}`);
        case "Unchanged":
          return { kind: "unchanged" };
        case "PutNext":
          return {
            kind: "put", key: names.name(out["out.key"]!), value: JSON.parse(names.name(out["out.value"]!)),
            identity: JSON.parse(names.name(out["out.identity"]!)) as MeshIdentity,
            version: storageRevision(out["out.version"]), highWater: storageRevision(out["out.highWater"]),
          };
        case "DeleteNext":
          return { kind: "delete", key: names.name(out["out.key"]!), version: storageRevision(out["out.version"]), highWater: storageRevision(out["out.highWater"]) };
        default:
          throw new Error("Invalid verified storage plan");
      }
    },
  });
};

export const captureStoragePut = (input: {
  key: string; ifVersion?: number | undefined; value: unknown; identity: MeshIdentity;
}, maxValueBytes = Number.POSITIVE_INFINITY): CapturedStorageRequest => {
  const { key, ifVersion, value, identity } = input;
  // Capture scalars before serialization can invoke user-defined toJSON hooks.
  if (ifVersion !== undefined) storageRevision(ifVersion);
  const identityJson = serialize(identity);
  const valueJson = serialize(value);
  if (Buffer.byteLength(valueJson, "utf8") > maxValueBytes) {
    throw new Error(`Mesh state value exceeds ${maxValueBytes} bytes`);
  }
  return capture(key, ifVersion, { value: valueJson, identity: identityJson });
};

export const captureStorageDelete = (input: {
  key: string; ifVersion?: number | undefined;
}): CapturedStorageRequest => {
  const { key, ifVersion } = input;
  return capture(key, ifVersion);
};
