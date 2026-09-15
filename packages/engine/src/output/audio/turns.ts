import { randomUUID } from "node:crypto";
import { VOICE_TIMING } from "@ido/common/runtime/audio-signal";
import type {
  SpeechReview,
  SpeechDecision,
} from "@ido/common/contracts/coordinator";

export interface SpeechCandidate {
  id: string;
  text: string;
  generatedText?: string;
  sourceIds: string[];
  targets: Array<{ text: string; resultId?: string; runRevision?: number }>;
  provider: "text-speech" | "live";
  state: "queued" | "playing" | "interrupted";
  revision: number;
  needsReview: boolean;
  interruptedAt?: number;
  reviewedRevision?: number;
}
export interface SpeechTurnOptions {
  valid(): boolean;
  ready(): boolean;
  quietUntil(): number;
  conversation(): SpeechReview["conversation"];
  resultsValid(candidate: SpeechCandidate): boolean;
  review?(
    review: SpeechReview,
    signal: AbortSignal,
  ): Promise<SpeechDecision | null | undefined>;
  stop(): Promise<void>;
  replace(candidate: SpeechCandidate): void;
  state?(id: string, state: string): void;
  error?(error: unknown): void;
}

// Ephemeral audio intent. It never executes model tasks or restores playback.
export class SpeechTurns {
  candidate?: SpeechCandidate;
  revision = 0;
  handledRevision = -1;
  private timer?: NodeJS.Timeout;
  private reviewing?: AbortController;
  private closed = false;
  constructor(private readonly options: SpeechTurnOptions) {}
  offer(
    input: Pick<SpeechCandidate, "text" | "sourceIds" | "targets" | "provider">,
  ) {
    this.discard();
    const candidate: SpeechCandidate = {
      text: input.text,
      sourceIds: [...input.sourceIds],
      targets: input.targets.map((target) => ({ ...target })),
      provider: input.provider,
      id: randomUUID(),
      state: "queued",
      revision: this.revision,
      needsReview: false,
    };
    this.candidate = candidate;
    this.notify("queued");
    this.wake();
    return candidate;
  }
  private notify(state: string) {
    if (this.candidate) this.options.state?.(this.candidate.id, state);
  }
  discard() {
    this.reviewing?.abort();
    this.reviewing = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.notify("discarded");
    this.candidate = undefined;
  }
  close() {
    this.closed = true;
    this.discard();
  }
  changed(message = false) {
    this.revision++;
    this.reviewing?.abort();
    this.reviewing = undefined;
    if (this.candidate && (message || this.candidate.needsReview))
      this.candidate.needsReview = true;
    this.wake();
  }
  get blocked() {
    return (
      !!this.candidate &&
      (this.candidate.state === "interrupted" || this.candidate.needsReview)
    );
  }
  canStart(candidate = this.candidate) {
    return (
      !!candidate &&
      candidate === this.candidate &&
      !this.closed &&
      this.options.valid() &&
      this.options.resultsValid(candidate) &&
      !candidate.needsReview &&
      candidate.state !== "interrupted" &&
      this.options.ready() &&
      Date.now() >= this.options.quietUntil()
    );
  }
  playing(candidate: SpeechCandidate) {
    if (this.candidate !== candidate) return;
    candidate.state = "playing";
    this.notify("playing");
  }
  completed(candidate: SpeechCandidate) {
    if (this.candidate !== candidate || candidate.state !== "playing") return;
    this.notify("completed");
    this.candidate = undefined;
    this.discard();
  }
  async interrupt() {
    const candidate = this.candidate;
    if (!candidate || candidate.state === "interrupted") return;
    candidate.state = "interrupted";
    candidate.interruptedAt = Date.now();
    candidate.needsReview = true;
    this.notify("interrupted");
    this.changed();
    await this.options.stop();
    this.wake();
  }
  wake() {
    clearTimeout(this.timer);
    if (this.closed || !this.candidate) return;
    this.timer = setTimeout(() => {
      void this.tick().catch((error) => this.options.error?.(error));
    }, 25);
    this.timer.unref();
  }
  private async tick() {
    const candidate = this.candidate;
    if (!candidate || this.closed) return;
    if (
      !this.options.valid() ||
      !this.options.resultsValid(candidate) ||
      (candidate.interruptedAt !== undefined &&
        Date.now() - candidate.interruptedAt >= VOICE_TIMING.candidateTtlMs)
    ) {
      this.discard();
      await this.options.stop().catch((error) => this.options.error?.(error));
      return;
    }
    this.wake(); // Expiry/authorization still apply while a model call is pending.
    if (
      !candidate.needsReview ||
      this.reviewing ||
      !this.options.ready() ||
      Date.now() < this.options.quietUntil() ||
      candidate.reviewedRevision === this.revision
    )
      return;
    const revision = this.revision;
    candidate.reviewedRevision = revision;
    const controller = new AbortController();
    this.reviewing = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref();
    const review: SpeechReview = {
      candidateId: candidate.id,
      revision,
      state: candidate.state,
      text: (candidate.text || candidate.generatedText || "").slice(0, 4000),
      sourceIds: candidate.sourceIds.slice(-20),
      targets: candidate.targets.filter((target) => target.resultId).slice(-8),
      provider: candidate.provider,
      conversation: this.options.conversation(),
    };
    while (
      JSON.stringify(review).length > 14000 &&
      review.conversation.length > 1
    )
      review.conversation.shift();
    try {
      const decision = await Promise.race([
        this.options.review?.(review, controller.signal) ??
          Promise.resolve(undefined),
        new Promise<undefined>((resolve) =>
          controller.signal.addEventListener(
            "abort",
            () => resolve(undefined),
            { once: true },
          ),
        ),
      ]);
      if (
        this.candidate !== candidate ||
        this.revision !== revision ||
        this.closed ||
        !this.options.valid()
      )
        return;
      if (
        !decision ||
        controller.signal.aborted ||
        decision.candidateId !== candidate.id ||
        decision.revision !== revision
      ) {
        if (candidate.state !== "playing") {
          this.discard();
          await this.options.stop();
        } else candidate.needsReview = false;
        return;
      }
      if (!this.options.ready() || Date.now() < this.options.quietUntil())
        return;
      if (
        decision.action === "continue" &&
        (candidate.state === "playing" ||
          (candidate.state === "queued" &&
            candidate.provider === "text-speech"))
      ) {
        candidate.needsReview = false;
        candidate.revision = revision;
        return;
      }
      this.handledRevision = revision;
      if (decision.action === "replace" && decision.text?.trim()) {
        // Fence the old provider before assigning a new candidate identity.
        await this.options.stop();
        if (
          this.candidate !== candidate ||
          revision !== this.revision ||
          !this.options.valid()
        )
          return;
        const replacement = this.offer({ ...candidate, text: decision.text });
        this.options.replace(replacement);
      } else {
        this.discard();
        await this.options.stop();
      }
    } catch (error) {
      if (this.candidate === candidate && this.revision === revision) {
        if (candidate.state !== "playing") {
          this.discard();
          await this.options.stop();
        } else candidate.needsReview = false;
        this.options.error?.(error);
      }
    } finally {
      clearTimeout(timeout);
      if (this.reviewing === controller) this.reviewing = undefined;
    }
  }
}
