// Engine-owned work policy restricts the executor's existing authority. It does not grant
// credentials, network access or permission for an external operation.
export function normalizeExecutionPolicy(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Task execution policy must be an object");
  const policy = {};
  for (const key of Object.keys(value)) {
    if (!["sandboxMode", "networkAccessEnabled"].includes(key))
      throw new TypeError(`Unsupported task execution policy field: ${key}`);
  }
  if (value.sandboxMode !== undefined) {
    if (!["read-only", "workspace-write"].includes(value.sandboxMode))
      throw new TypeError("Unsupported task sandbox mode");
    policy.sandboxMode = value.sandboxMode;
  }
  if (value.networkAccessEnabled !== undefined) {
    if (typeof value.networkAccessEnabled !== "boolean")
      throw new TypeError("Task network policy must be a boolean");
    policy.networkAccessEnabled = value.networkAccessEnabled;
  }
  return policy;
}

// Previous restrictions remain in force when continuing a task. Widening the
// scope requires a new authorized task, rather than reusing its old thread.
export function restrictExecutionPolicy(...values) {
  const policies = values.map(normalizeExecutionPolicy).filter(Boolean);
  const result = {};
  const sandboxes = policies.map((policy) => policy.sandboxMode);
  if (sandboxes.includes("read-only")) result.sandboxMode = "read-only";
  else if (sandboxes.includes("workspace-write"))
    result.sandboxMode = "workspace-write";
  const network = policies.map((policy) => policy.networkAccessEnabled);
  if (network.includes(false)) result.networkAccessEnabled = false;
  else if (network.includes(true)) result.networkAccessEnabled = true;
  return result;
}
