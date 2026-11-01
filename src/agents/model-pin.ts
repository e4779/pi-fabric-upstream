/** The parent passes the pinned `provider/id` here; only the worker sets it. */
export const MODEL_PIN_ENV = "PI_FABRIC_MODEL_PIN";
/** Exit status of a child that stopped itself because the model was not the pin. */
export const MODEL_PIN_EXIT_CODE = 71;
/** Prefix of the single stderr line that names the violation for the worker. */
export const MODEL_PIN_MARKER = "[pi-fabric] model-pin-violation ";

export interface ModelPinViolation {
  pinned: string;
  /** `provider/id` of the model that was about to run, `payload model "<id>"` for a rewritten request, or "none". */
  actual: string;
}

/** Every pin failure starts with this text; the worker builds it, never a model id. */
const MODEL_PIN_FAILURE_PREFIX = "Fabric exact model pin violated: ";

/**
 * Whether a run ended on a pin violation. Such a run is never retried or resumed,
 * whatever else its error text says: a model id can spell `missing credentials`.
 * Decided from the child's exit status and the fixed prefix, not from free text.
 */
export const isModelPinFailure = (record: { exitCode?: number | null; error?: string }): boolean =>
  record.exitCode === MODEL_PIN_EXIT_CODE ||
  (typeof record.error === "string" && record.error.startsWith(MODEL_PIN_FAILURE_PREFIX));

/** Fixed run error; the worker builds it from the stderr marker. */
export const modelPinFailure = (violation: ModelPinViolation): string =>
  `${MODEL_PIN_FAILURE_PREFIX}only ${violation.pinned} may run, but ${violation.actual} was about to run. ` +
  "The provider call was stopped before any request was sent.";

/** Parse the marker line out of a child's stderr; undefined when absent or malformed. */
export const parseModelPinViolation = (stderr: string): ModelPinViolation | undefined => {
  const start = stderr.lastIndexOf(MODEL_PIN_MARKER);
  if (start < 0) return undefined;
  const line = stderr.slice(start + MODEL_PIN_MARKER.length).split("\n", 1)[0] ?? "";
  try {
    const value = JSON.parse(line) as Partial<ModelPinViolation>;
    return typeof value.pinned === "string" && typeof value.actual === "string"
      ? { pinned: value.pinned, actual: value.actual }
      : undefined;
  } catch {
    return undefined;
  }
};
