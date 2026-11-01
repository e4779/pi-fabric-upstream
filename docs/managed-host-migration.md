# Managed-host migration: 0.119.7 → 0.127.1

## 0.127.1 follow-up

The factory contract remains **v2** and provider registration remains v1. No option changes or downstream workarounds are needed.

- Native discovery previews retain field descriptions, including usage rules such as page numbering and identifier provenance.
- Preview limits apply to rendered declarations. Long description text is shortened first, then dropped before structural information is sacrificed. Oversized enums, unions and tuples are cut by rendered size; short 13–40-value contracts remain complete when they fit.
- Deeper structural cuts and whole-input fallback remain last resorts. Every lossy preview carries a visible marker and points to `fabric.tools.describe({ ref })` for the exact unmodified `inputSchema`.
- Public factory declarations explicitly use the embedding application's peer SDK, not Fabric's private worker SDK alias, so older supported hosts can type-check the integration.
- Managed execution guidance appears once through its guidance slot. Host `guidance` appears once in the system prompt. Tool and `code` descriptions are concise, and `promptGuidelines` contains only independent execution advice. Stable guidance remains byte-identical across turns.

The host should continue to use the v2 options documented below. Applications should not interpret a visibly truncated preview as the authoritative validation schema.

## 0.127.0 changelog

The managed-host factory contract is **v2** (`FABRIC_MANAGED_HOST_VERSION === 2`). Provider registration is still v1. Existing `{ providers }` calls work; consumers that assert the factory version must update their assertion. This release adds optional foreground, guidance, skill-reader, CPU and compaction controls without enabling ambient configuration.

### Replacement map for downstream patch hunks

| Hunk | Upstream replacement |
| --- | --- |
| A1 - stale script store after tool receipts | Automatic: later non-store custom entries are allowed on the same branch; aborts, session/generation changes, messages, compaction, navigation and either store writer still invalidate the transaction. |
| A2 - truncated enum/union/tuple declarations | Automatic: bounded, visibly marked previews. Fetch exact `inputSchema` with `fabric.tools.describe({ ref })`; native `describeTool` returns a bounded declaration, not the raw schema. |
| A3 - nested validation paths | Automatic: prefer TypeBox `instancePath`, falling back to `path`. |
| A4 - exact tool discovery | Automatic: trimmed exact name/raw name/ref/final `__` segment takes precedence within the requested namespace. |
| A5 - Jev in managed mode | Automatic: managed configuration disables Jev. |
| B1 - direct foreground tools | `managedHost.foreground: ["ask_user_questions", "ai_todo_write", "run_delegated_task"]`; register and activate those names. |
| B2 - provider-accurate tool and prompt text | Automatic managed metadata; put application policy in `managedHost.guidance` or the existing execution-guidance slot. |
| B3 - skill reader | `managedHost.skillReader: "mcp.files.read"` (use the host's real callable name), or omit and own skill loading entirely. |
| B4 - MCP-only native discovery | Automatic MCP fallback when Pi/extension discovery has no actions. |
| B5 - uninterrupted guest CPU | Managed default is 1000 ms; explicitly use `managedHost.executor: { maxCpuSliceMs: 1000 }`. Ordinary sessions can set `executor.maxCpuSliceMs` (`0` disables it). |
| B6 - host-owned compaction | `managedHost.compaction: "pi"`; omitted retains `"fabric"`. |

Deliberately not upstreamed: application-specific counting, scope-completion and receipt-reconciliation prose; it belongs in host guidance. The undeclared external schema renderer and 64 KiB per-tool expansion are also not carried forward: Fabric keeps compact previews and exact schema discovery, without a new dependency. Auto-promoting every `model-only` registration is not required: the explicit host foreground list avoids accidentally exposing unrelated tools.

## Compatibility since 0.119.7

The public minimum remains Pi 1.0.0. Development and standard public-contract tests use Pi 1.3.0. A separate offline CLI smoke check passed with `pi-coding-agent`, `pi-agent-core`, `pi-ai` and `pi-codemode` all pinned to **1.0.2**, using the compiled bundle: v2 registration, a model-only foreground tool, MCP-only native discovery, visibly truncated declarations, all 20 raw enum values, a valid value past the preview cut, receipt-safe store/load across two scripts, and clean `agent_settled` with host-owned compaction. This is a focused compatibility check, not a claim that the entire test suite runs against 1.0.2. Fabric does **not** import the standalone `pi-codemode` package; its presence in an embedding application is independent.

Relevant intervening changes:

- Host SDK loading now resolves from the running Pi CLI or embedding entry, including mapped/compiled hosts. Managed installs need not place a second host SDK beside Fabric.
- External provider registration now contributes direct guest globals and schema-derived types; host provider names still pass closed-world authorization.
- Program-run events accept caller-supplied code. They execute in the current host's root capability view and policy; they do not widen managed provider authority.
- Interrupted read-only durable execution can rerun once in supported durable environments. Managed mode still does not enable native workers or agents.
- Child roster filtering and exact child-question names changed for native agents. Those facilities remain disabled in managed mode unless supplied by a host provider.
- Terminal-title, agent-panel, shell warming and background optimization work do not enable those native facilities in managed mode.

New deliberate changes in this release: the managed default CPU slice is bounded; Jev is disabled as documented; managed prompts no longer advertise unloaded coding providers or automatically contribute Fabric's coding skill tree. Host code should register desired skill resources itself. Native catalog declarations remain advisory, visibly incomplete when bounded; dispatch validates against the full schema.
