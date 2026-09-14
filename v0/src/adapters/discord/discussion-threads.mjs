// Participant IDs come from Discord input attribution, never from model text.
export function taskParticipantIds(task) {
  return [
    ...new Set(
      (task.sourceStatements ?? [])
        .map((statement) => statement.userId)
        .filter((id) => /^\d{17,20}$/.test(String(id))),
    ),
  ];
}

export function createThreadParticipantJoiner() {
  const joined = new Map();
  return async (thread, userIds = []) => {
    if (!thread.members?.add) return;
    const known = joined.get(thread.id) ?? new Set();
    joined.set(thread.id, known);
    for (const userId of [...new Set(userIds)].filter((id) =>
      /^\d{17,20}$/.test(String(id)),
    )) {
      if (known.has(userId)) continue;
      // Adding an existing member is idempotent; failure must not discard the answer.
      try {
        await thread.members.add(userId);
        known.add(userId);
      } catch {
        /* A user may have left the guild or be unable to join. */
      }
    }
    if (joined.size > 100) joined.delete(joined.keys().next().value);
  };
}

export function createDiscordDiscussionRouter({
  textChannel,
  botUserId,
  createMessagePayload,
  getTask = () => undefined,
  now = () => new Date(),
}) {
  const join = createThreadParticipantJoiner();
  const daily = new Map();
  let serial = Promise.resolve();
  const resolveDaily = async () => {
    const date = now().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const name = `会議の回答 ${date}`;
    if (daily.has(name)) return daily.get(name);
    const find = (collection) =>
      (collection?.threads ?? collection)?.find?.(
        (thread) =>
          thread.name === name &&
          thread.ownerId === botUserId &&
          String(thread.parentId) === String(textChannel.id),
      );
    let thread = find(await textChannel.threads?.fetchActive?.());
    if (!thread)
      thread = find(
        await textChannel.threads?.fetchArchived?.({
          type: "public",
          fetchAll: true,
        }),
      );
    if (thread?.archived) await thread.setArchived(false);
    if (!thread) {
      const starter = await textChannel.send(
        createMessagePayload(
          `💬 **${name}**\n会話への回答と確認結果は、このスレッドにまとめます。関係する発言者をスレッドへ追加します。`,
          { idempotencyKey: `discussion-entry:${textChannel.id}:${date}` },
        ),
      );
      try {
        thread = await starter.startThread({ name, autoArchiveDuration: 1440 });
      } catch (error) {
        const existing = await textChannel.client?.channels
          ?.fetch(starter.id)
          .catch(() => undefined);
        if (!existing?.isThread?.() || existing.parentId !== textChannel.id)
          throw error;
        thread = existing;
      }
    }
    daily.clear();
    daily.set(name, thread);
    return thread;
  };
  return (content, options = {}) => {
    const operation = serial.then(async () => {
      if (options.signal?.aborted) throw options.signal.reason;
      const task = options.taskId ? getTask(options.taskId) : undefined;
      let thread;
      if (task?.threadId) {
        const candidate = await textChannel.client?.channels?.fetch(
          task.threadId,
        );
        if (candidate?.isThread?.() && candidate.parentId === textChannel.id)
          thread = candidate;
      }
      thread ??= await resolveDaily();
      await join(thread, options.participantUserIds ?? []);
      return thread.send(createMessagePayload(content, options));
    });
    serial = operation.catch(() => undefined);
    return operation;
  };
}
