// Conversation orchestration and work execution have separate lifetimes.
// Only serializable observations, resume handles and callbacks cross this port.
export function bindCoordinator(backend) {
  if (typeof backend?.createCoordinator !== "function")
    throw new TypeError("coordinator backend must implement createCoordinator");
  return {
    async createCoordinator({ meetingId, threadId, onCheckpoint } = {}) {
      if (typeof meetingId !== "string" || !meetingId.trim())
        throw new TypeError("coordinator meetingId is required");
      if (threadId !== undefined && typeof threadId !== "string")
        throw new TypeError("coordinator threadId must be a string");
      const runtime = await backend.createCoordinator({
        meetingId,
        threadId,
        onCheckpoint: async (state) => {
          if (state.meetingId !== meetingId)
            throw new Error(
              "Coordinator checkpoint belongs to a different meeting",
            );
          await onCheckpoint?.(structuredClone(state));
        },
      });
      for (const method of ["run", "steer", "interrupt", "close"])
        if (typeof runtime?.[method] !== "function") {
          await runtime?.close?.();
          throw new TypeError(`coordinator runtime must implement ${method}`);
        }
      const observation = (value) => {
        if (value?.meetingId && value.meetingId !== meetingId)
          throw new Error("Coordinator input belongs to a different meeting");
        return structuredClone({ ...value, meetingId });
      };
      return {
        run: (value, options) => runtime.run(observation(value), options),
        steer: (value) => runtime.steer(observation(value)),
        interrupt: () => runtime.interrupt(),
        close: () => runtime.close(),
      };
    },
  };
}
