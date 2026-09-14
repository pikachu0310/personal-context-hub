// Serializable restrictions shared by Engine and Client. These values narrow
// an executor's local grant; they never supply identity, credentials or consent.
export interface ExecutionPolicy {
  sandboxMode?: "read-only" | "workspace-write";
  networkAccessEnabled?: boolean;
}
export interface WorkSource {
  id?: string;
  meetingId?: string;
  sequence?: number;
  authorId?: string;
  userId?: string;
  speakerName?: string;
  startedAt?: number;
  text: string;
}
export type ControlDelivery =
  "pending" | "queued" | "applied" | "stopped" | "uncertain" | "rejected";
export interface WorkReceipt {
  id: string;
  taskId: string;
  authorId: string;
  requestKey: string;
  type: "stop" | "steer" | "retry";
  controlVersion: number;
  specRevision: number;
  accepted: true;
  delivery: ControlDelivery;
}
export interface ClientControlReceipt {
  id: string;
  controlVersion: number;
  delivery: ControlDelivery;
}

export function normalizeExecutionPolicy(
  value: unknown,
): ExecutionPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Execution policy must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["sandboxMode", "networkAccessEnabled"].includes(key))
      throw new TypeError("Unsupported execution policy field");
  const result: ExecutionPolicy = {};
  if (input.sandboxMode !== undefined) {
    if (
      input.sandboxMode !== "read-only" &&
      input.sandboxMode !== "workspace-write"
    )
      throw new TypeError("Unsupported task sandbox mode");
    result.sandboxMode = input.sandboxMode;
  }
  if (input.networkAccessEnabled !== undefined) {
    if (typeof input.networkAccessEnabled !== "boolean")
      throw new TypeError("Task network policy must be a boolean");
    result.networkAccessEnabled = input.networkAccessEnabled;
  }
  return result;
}

export function restrictExecutionPolicy(...values: unknown[]): ExecutionPolicy {
  const policies = values
    .map(normalizeExecutionPolicy)
    .filter((value) => value !== undefined);
  const result: ExecutionPolicy = {};
  const sandboxes = policies.map((value) => value.sandboxMode);
  if (sandboxes.includes("read-only")) result.sandboxMode = "read-only";
  else if (sandboxes.includes("workspace-write"))
    result.sandboxMode = "workspace-write";
  const network = policies.map((value) => value.networkAccessEnabled);
  if (network.includes(false)) result.networkAccessEnabled = false;
  else if (network.includes(true)) result.networkAccessEnabled = true;
  return result;
}

export function requiresPolicySupport(
  policy: ExecutionPolicy | undefined,
): boolean {
  return (
    policy?.sandboxMode === "read-only" ||
    policy?.networkAccessEnabled === false
  );
}
