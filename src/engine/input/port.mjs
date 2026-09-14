// Identity and authorization metadata come from a trusted adapter, never from
// recognized text. IDs are opaque strings scoped by the adapter/session.
export function normalizeInput(event) {
  if (!event || !["audio", "text"].includes(event.type))
    throw new TypeError("input type must be audio or text");
  if (event.type === "audio" && !Buffer.isBuffer(event.audio))
    throw new TypeError("audio must be a PCM WAV Buffer");
  if (event.type === "text" && typeof event.text !== "string")
    throw new TypeError("text must be a string");
  if (
    event.priority !== undefined &&
    !["normal", "immediate"].includes(event.priority)
  )
    throw new TypeError("input priority must be normal or immediate");
  return {
    ...event,
    metadata: {
      ...event.metadata,
      ...(event.priority !== undefined ? { priority: event.priority } : {}),
      ...(event.id !== undefined ? { inputId: event.id } : {}),
      ...(event.sessionId !== undefined ? { meetingId: event.sessionId } : {}),
      ...(event.actor !== undefined
        ? { userId: event.actor.id, speakerName: event.actor.name }
        : {}),
    },
  };
}
export function createInputPort(session) {
  const accept = (event) => {
    const input = normalizeInput(event);
    if (
      input.metadata.meetingId &&
      session.meetingId &&
      input.metadata.meetingId !== session.meetingId
    )
      throw new Error("Input belongs to a different meeting");
    return input.type === "audio"
      ? session.enqueue(input.audio, input.metadata)
      : session.addText(input.text, input.metadata);
  };
  return {
    accept,
    enqueue: (audio, metadata) => accept({ type: "audio", audio, metadata }),
    addText: (text, metadata) => accept({ type: "text", text, metadata }),
    ...(session.beginUtterance
      ? {
          beginUtterance: (id, metadata) =>
            session.beginUtterance(id, metadata),
        }
      : {}),
    ...(session.finishUtterance
      ? {
          finishUtterance: (id, count, options) =>
            session.finishUtterance(id, count, options),
        }
      : {}),
  };
}
