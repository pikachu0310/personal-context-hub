import { randomUUID } from "node:crypto";

// Provider-independent, durable input scheduling. A receipt means model input
// delivery, never task execution or audio playback. Unknown deliveries stop
// here; reconnecting must not silently replay a potentially accepted request.
export class CoordinatorInbox {
  constructor({
    createRuntime,
    buildObservation,
    onResponse,
    checkpoint = async () => {},
    onError = () => {},
    initialState = {},
    maximumBatchEvents = 20,
    maximumBatchCharacters = 16_000,
  }) {
    if (!Number.isInteger(maximumBatchEvents) || maximumBatchEvents < 1)
      throw new TypeError("maximumBatchEvents must be a positive integer");
    if (!Number.isInteger(maximumBatchCharacters) || maximumBatchCharacters < 1)
      throw new TypeError("maximumBatchCharacters must be a positive integer");
    Object.assign(this, {
      createRuntime,
      buildObservation,
      onResponse,
      checkpoint,
      onError,
      maximumBatchEvents,
      maximumBatchCharacters,
    });
    this.pending = structuredClone(initialState.pending ?? []);
    this.receipts = new Set(initialState.receipts ?? []);
    this.urgentIds = new Set(initialState.urgentIds ?? []);
    this.handle = structuredClone(initialState.handle);
    this.active = structuredClone(initialState.active);
    if (this.active && !["response", "prepared"].includes(this.active.status))
      this.active.status = "uncertain";
    this.writes = Promise.resolve();
    this.changes = Promise.resolve();
    this.inputs = Promise.resolve();
    this.controller = new AbortController();
    this.closed = false;
    this.dirty = false;
  }

  get busy() {
    return Boolean(this.running);
  }
  get uncertain() {
    return this.active?.status === "uncertain";
  }

  snapshot() {
    return structuredClone({
      pending: this.pending,
      active: this.active,
      handle: this.handle,
      receipts: [...this.receipts].slice(-1000),
      urgentIds: [...this.urgentIds],
    });
  }

  persist() {
    const state = this.snapshot();
    const operation = this.writes.then(() => this.checkpoint(state));
    this.writes = operation.catch(() => {});
    return operation;
  }

  // Mutations and their snapshots share a lane. Serializing file writes alone
  // permits a concurrent submit to persist an already-completed active batch.
  change(mutate = () => {}) {
    const operation = this.changes.then(async () => {
      mutate();
      this.dirty = true;
      await this.persist();
      this.dirty = false;
    });
    this.changes = operation.catch(() => {});
    return operation;
  }

  report(error) {
    try {
      Promise.resolve(this.onError(error)).catch(() => {});
    } catch {
      /* observer */
    }
  }

  submit(events, { urgent = false, start = false } = {}) {
    const operation = this.inputs.then(async () => {
      if (this.closed) return false;
      // Validate the entire submission before changing state. Oversized events
      // need an excerpt/reference at the producer, never silent text truncation.
      const copies = events.map((event) => {
        if (!event?.id || typeof event.id !== "string")
          throw new TypeError("Coordinator input requires an event id");
        if (JSON.stringify(event).length + 2 > this.maximumBatchCharacters)
          throw new RangeError(
            "Coordinator input exceeds maximum batch characters",
          );
        return structuredClone(event);
      });
      await this.change(() => {
        const known = new Set([
          ...this.receipts,
          ...this.pending.map((event) => event.id),
          ...(this.active?.events ?? []).map((event) => event.id),
          ...(this.active?.steering ?? []).map((event) => event.id),
        ]);
        for (const event of copies) {
          if (!known.has(event.id)) {
            this.pending.push(event);
            known.add(event.id);
          }
          if (urgent && this.pending.some((pending) => pending.id === event.id))
            this.urgentIds.add(event.id);
        }
      });
      if (urgent && this.acceptingSteer) void this.steerPending();
      else if (start || urgent) void this.flush();
      return true;
    });
    this.inputs = operation.catch(() => {});
    return operation;
  }

  takeBatch() {
    let characters = 2,
      count = 0;
    for (const event of this.pending) {
      const size = JSON.stringify(event).length;
      if (size + 2 > this.maximumBatchCharacters)
        throw new RangeError(
          "Saved coordinator input exceeds maximum batch characters",
        );
      if (
        count &&
        (count >= this.maximumBatchEvents ||
          characters + size + 1 > this.maximumBatchCharacters)
      )
        break;
      characters += size + (count ? 1 : 0);
      count++;
    }
    return this.pending.splice(0, count);
  }

  async runtime() {
    if (!this.preparing) {
      this.preparing = Promise.resolve()
        .then(() =>
          this.createRuntime({
            threadId: this.handle?.threadId,
            onCheckpoint: (handle) =>
              this.change(() => {
                this.handle = structuredClone(handle);
              }),
          }),
        )
        .then((runtime) => (this.prepared = runtime))
        .catch((error) => {
          this.preparing = undefined;
          throw error;
        });
    }
    return this.preparing;
  }

  flush() {
    if (this.closed || this.uncertain) return Promise.resolve(false);
    this.flushRequested = true;
    if (this.running) return this.running;
    const running = this.drain()
      .catch((error) => {
        this.flushRequested = false;
        this.report(error);
        return false;
      })
      .finally(() => {
        if (this.running === running) this.running = undefined;
        // A submit can request a drain after its final empty-queue check but
        // before this cleanup microtask. Preserve that wakeup.
        if (this.flushRequested && !this.closed && !this.uncertain)
          return this.flush();
      });
    this.running = running;
    return running;
  }

  async drain() {
    let processed = false;
    this.flushRequested = false;
    while (!this.closed && !this.uncertain) {
      await this.inputs;
      await this.changes;
      if (this.closed || this.uncertain) break;
      this.flushRequested = false;
      if (!this.active) {
        if (!this.pending.length) {
          if (this.dirty) await this.change();
          break;
        }
        await this.change(() => {
          this.active = {
            id: randomUUID(),
            events: this.takeBatch(),
            status: "prepared",
          };
        });
      }
      const batch = this.active;
      try {
        if (batch.status !== "response") {
          const runtime = await this.runtime();
          if (this.closed) break;
          const observation = this.buildObservation(batch.events);
          await this.change(() => {
            batch.status = "sending";
            for (const event of batch.events) this.urgentIds.delete(event.id);
          });
          if (this.closed) {
            await this.change(() => {
              batch.status = "prepared";
            });
            break;
          }
          // From this point even a synchronous provider failure is potentially
          // accepted. Only an explicit reconciliation permits a retry.
          this.acceptingSteer = true;
          try {
            const response = runtime.run(observation, {
              signal: this.controller.signal,
            });
            if (this.pending.some((event) => this.urgentIds.has(event.id)))
              void this.steerPending();
            batch.response = await response;
          } catch (error) {
            await this.change(() => {
              batch.status = "uncertain";
            });
            throw error;
          } finally {
            this.acceptingSteer = false;
            await this.steering;
          }
          if (this.uncertain) return false;
          await this.change(() => {
            batch.status = "response";
          });
        }
        if (this.closed) break;
        if (this.dirty) await this.change();
        await this.onResponse(batch.response, structuredClone(batch));
        await this.change(() => {
          for (const event of batch.events) this.receipts.add(event.id);
          this.receipts = new Set([...this.receipts].slice(-1000));
          this.active = undefined;
        });
        processed = true;
      } catch (error) {
        // Preparation and saved responses can retry without another ambiguous
        // model call. A failed pre-send checkpoint is also definitely unsent.
        if (
          batch.status === "sending" &&
          !this.acceptingSteer &&
          !batch.response
        )
          batch.status = "prepared";
        throw error;
      }
    }
    return processed;
  }

  steerPending() {
    if (this.steering) return this.steering;
    const steering = this.sendSteering()
      .catch((error) => this.report(error))
      .finally(() => {
        if (this.steering === steering) this.steering = undefined;
        if (
          this.acceptingSteer &&
          !this.uncertain &&
          this.pending.some((event) => this.urgentIds.has(event.id))
        )
          void this.steerPending();
      });
    this.steering = steering;
    return steering;
  }

  async sendSteering() {
    while (
      !this.closed &&
      this.acceptingSteer &&
      !this.uncertain &&
      this.pending.some((event) => this.urgentIds.has(event.id))
    ) {
      const batch = this.active;
      let events,
        sent = false;
      try {
        await this.change(() => {
          events = this.takeBatch();
          batch.steering = events;
        });
        if (this.closed || !this.acceptingSteer) {
          await this.change(() => {
            this.pending.unshift(...events);
            delete batch.steering;
          });
          return;
        }
        const observation = this.buildObservation(events);
        sent = true;
        const accepted = await this.prepared.steer(observation);
        if (!accepted) this.acceptingSteer = false;
        await this.change(() => {
          if (accepted) {
            batch.events.push(...events);
            for (const event of events) this.urgentIds.delete(event.id);
          } else this.pending.unshift(...events);
          delete batch.steering;
        });
        if (!accepted) return;
      } catch (error) {
        this.acceptingSteer = false;
        if (sent) {
          await this.change(() => {
            batch.status = "uncertain";
          });
        } else if (events) {
          await this.change(() => {
            this.pending.unshift(...events);
            delete batch.steering;
          });
        }
        throw error;
      }
    }
  }

  // Caller reconciles provider history or obtains a deliberate retry decision.
  async resolveUncertain({ retry }) {
    if (typeof retry !== "boolean")
      throw new TypeError("retry decision is required");
    await this.inputs;
    if (this.closed || !this.uncertain || this.running) return false;
    let resolved = false;
    await this.change(() => {
      if (this.closed || !this.uncertain || this.running) return;
      const events = [...this.active.events, ...(this.active.steering ?? [])];
      if (retry) this.pending.unshift(...events);
      else
        for (const event of events) {
          this.receipts.add(event.id);
          this.urgentIds.delete(event.id);
        }
      this.active = undefined;
      resolved = true;
    });
    return resolved;
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort();
    this.closing = (async () => {
      // A runtime can appear after close was requested during preparation.
      // Interrupt it before waiting for a provider run that may ignore signal.
      await this.preparing?.catch(() => {});
      try {
        await this.prepared?.interrupt?.();
      } catch (error) {
        this.report(error);
      }
      await this.running;
      await this.steering;
      try {
        await this.prepared?.close?.();
      } finally {
        await this.inputs;
        await this.change();
      }
    })();
    return this.closing;
  }
}
