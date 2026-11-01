import type { FabricComponentLoader } from "../components/loader.js";
import { FabricComponentControl, type ComponentChangeRequest } from "../components/control.js";
import { validationMessage } from "../core/action-arguments.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

const entrySchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    component: { type: "string", minLength: 1, maxLength: 128 },
    config: {}, disabled: { type: "boolean" },
  },
  required: ["id", "component"], additionalProperties: false,
};
const changeProperties = {
  scope: { type: "string", enum: ["session", "global", "project"], description: "Defaults to session: no file writes. Persistent scope must be explicit." },
  entries: { type: "array", items: entrySchema, maxItems: 256, description: "Upsert complete entries by id; other entries are preserved." },
  remove: { type: "array", items: { type: "string" }, maxItems: 256 },
  reset: { type: "array", items: { type: "string" }, maxItems: 256, description: "Session only: remove overlays and use trusted file configuration for these IDs." },
};
const descriptors: FabricActionDescriptor[] = [
  {
    name: "list",
    description: "List registered component definitions and configured component instances.",
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "status",
    description: "Inspect one component's lifecycle state, committed capability target, and cleanup diagnostics.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "graph",
    description: "Inspect component requirement/provision edges and detected dependency cycles.",
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "describe",
    description: "Inspect a registered component definition, its config JSON Schema, declared requirements/provisions, and instances, even before activation.",
    inputSchema: { type: "object", properties: { component: { type: "string", minLength: 1 } }, required: ["component"], additionalProperties: false },
    risk: "read", effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "plan",
    description: "Validate a component configuration change without activation or file writes. Returns a request and revision for apply, changes, trust provenance, and warnings. A plan is not approval or a connectivity check.",
    inputSchema: { type: "object", properties: changeProperties, additionalProperties: false },
    risk: "read", effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "apply",
    description: "Apply a validated component change without reloading Fabric. Pass the planned request plus expectedRevision. Session scope is ephemeral; global/project scopes write only components atomically. Runs pinned to retired generations may drain; this is not immediate revocation. Trusted host code may execute during activation. Unavailable to committed guest views.",
    inputSchema: { type: "object", properties: { ...changeProperties, expectedRevision: { type: "string", minLength: 1 } }, required: ["expectedRevision"], additionalProperties: false },
    risk: "execute", effect: { kind: "emission", resources: ["fabric:components", "fabric:configuration"], ordering: "ordered" },
  },
  {
    name: "reconcile",
    description: "Re-read trusted component configuration and reconcile changed instances without restarting unrelated providers. Session overrides remain. Invalid edits retain the last applied state. Unavailable to committed guest views.",
    inputSchema: { type: "object", additionalProperties: false },
    risk: "execute", effect: { kind: "transactional", resources: ["fabric:components"], ordering: "ordered" },
  },
  {
    name: "reload",
    description: "Restart one component, or all loaded components, with rollback to the previous revision on activation failure.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    risk: "execute",
    effect: { kind: "transactional", resources: ["fabric:components"], ordering: "ordered" },
  },
];

export class ComponentsProvider implements FabricProvider {
  readonly name = "components";
  readonly description =
    "Supervised component lifecycle, exact capability dependencies, effect cleanup, and reload diagnostics.";

  constructor(readonly loader: FabricComponentLoader, readonly control = new FabricComponentControl(loader)) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.normalize("NFKC").trim().toLowerCase();
    const filtered = query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
    return request.limit === undefined
      ? filtered.slice()
      : filtered.slice(0, Math.max(1, Math.min(request.limit, 100)));
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const descriptor = descriptors.find(action => action.name === actionName);
    if (descriptor) {
      const invalid = validationMessage(descriptor.inputSchema, args);
      if (invalid) throw new Error(`Invalid components.${actionName} arguments: ${invalid}`);
    }
    if (["apply", "reconcile"].includes(actionName) && context.capabilityView) {
      throw new Error("Component configuration changes require an unrestricted host caller, not a committed guest capability view");
    }
    context.signal?.throwIfAborted();
    switch (actionName) {
      case "list":
        return {
          definitions: this.loader.definitions(),
          components: this.loader.list(),
          configuration: this.control.configuration(),
        };
      case "describe":
        return this.loader.describe(args.component as string);
      case "plan":
        return this.control.plan(args as ComponentChangeRequest);
      case "apply":
        return this.control.apply({ ...args as ComponentChangeRequest, expectedRevision: args.expectedRevision as string }, context.signal);
      case "reconcile":
        return this.control.reconcile();
      case "status": {
        const id = args.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("components.status requires id");
        return this.loader.status(id);
      }
      case "graph":
        return this.loader.graph();
      case "reload": {
        const id = args.id;
        if (id !== undefined && (typeof id !== "string" || !id.trim())) {
          throw new Error("components.reload id must be a non-empty string");
        }
        return this.control.reload(typeof id === "string" ? id : undefined);
      }
      default:
        throw new Error(`Unknown components action: ${actionName}`);
    }
  }
}
