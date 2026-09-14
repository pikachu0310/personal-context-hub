import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

export const DISCORD_RPC_OPCODES = Object.freeze({
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
});

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeDiscordRpcFrame(opcode, data) {
  const payload = Buffer.from(JSON.stringify(data), "utf8");
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

export class DiscordRpcFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Discord RPC frame is too large (${length} bytes).`);
      }
      if (this.buffer.length < 8 + length) break;
      const payload = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      frames.push({ opcode, data: JSON.parse(payload) });
    }
    return frames;
  }
}

function openPipe(path, netImpl) {
  return new Promise((resolve, reject) => {
    const socket = netImpl.createConnection(path);
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function rpcError(payload, fallback) {
  const error = new Error(payload?.message ?? fallback);
  if (payload?.code !== undefined) error.code = payload.code;
  error.data = payload;
  return error;
}

export class DiscordRpcTransport extends EventEmitter {
  constructor({
    netImpl = net,
    requestTimeoutMs = 15_000,
    connectTimeoutMs = 10_000,
    platform = process.platform,
  } = {}) {
    super();
    this.netImpl = netImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.platform = platform;
    this.socket = undefined;
    this.decoder = new DiscordRpcFrameDecoder();
    this.pending = new Map();
    this.connected = false;
    this.closing = false;
    this.readyData = undefined;
  }

  async connect(applicationId) {
    if (this.connected) return this.readyData;
    if (this.platform !== "win32") {
      throw new Error(
        "Discord RPC Reader must run with Windows Node beside the Discord desktop client.",
      );
    }

    let lastError;
    for (let index = 0; index < 10; index += 1) {
      try {
        this.socket = await openPipe(
          `\\\\?\\pipe\\discord-ipc-${index}`,
          this.netImpl,
        );
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.socket) {
      throw new Error(
        `Could not connect to the Discord desktop RPC pipe${
          lastError?.message ? `: ${lastError.message}` : ""
        }`,
      );
    }

    this.socket.on("data", (chunk) => this.#onData(chunk));
    this.socket.on("error", (error) => this.#onDisconnect(error));
    this.socket.on("close", () =>
      this.#onDisconnect(new Error("Discord RPC connection closed.")),
    );

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for Discord RPC READY."));
      }, this.connectTimeoutMs);
      timer.unref?.();
      this.once("ready", (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.once("connectError", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.socket.write(
      encodeDiscordRpcFrame(DISCORD_RPC_OPCODES.HANDSHAKE, {
        v: 1,
        client_id: applicationId,
      }),
    );
    this.readyData = await ready;
    this.connected = true;
    return this.readyData;
  }

  request(command, args = {}, event) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Discord RPC is not connected.");
    }
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`Discord RPC ${command} timed out.`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(nonce, { command, resolve, reject, timer });
      this.socket.write(
        encodeDiscordRpcFrame(DISCORD_RPC_OPCODES.FRAME, {
          cmd: command,
          args,
          ...(event ? { evt: event } : {}),
          nonce,
        }),
      );
    });
  }

  authorize({ applicationId, scopes, prompt = "consent" }) {
    return this.request("AUTHORIZE", {
      client_id: applicationId,
      scopes,
      prompt,
    });
  }

  authenticate(accessToken) {
    return this.request("AUTHENTICATE", { access_token: accessToken });
  }

  subscribe(event, args = {}) {
    return this.request("SUBSCRIBE", args, event);
  }

  unsubscribe(event, args = {}) {
    return this.request("UNSUBSCRIBE", args, event);
  }

  async close() {
    if (!this.socket || this.socket.destroyed) return;
    this.closing = true;
    this.socket.write(
      encodeDiscordRpcFrame(DISCORD_RPC_OPCODES.CLOSE, {}),
      () => this.socket.end(),
    );
  }

  #onData(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.#onDisconnect(error);
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) this.#onFrame(frame);
  }

  #onFrame({ opcode, data }) {
    if (opcode === DISCORD_RPC_OPCODES.PING) {
      this.socket?.write(encodeDiscordRpcFrame(DISCORD_RPC_OPCODES.PONG, data));
      return;
    }
    if (opcode === DISCORD_RPC_OPCODES.CLOSE) {
      this.#onDisconnect(rpcError(data, "Discord RPC closed the connection."));
      this.socket?.end();
      return;
    }
    if (opcode !== DISCORD_RPC_OPCODES.FRAME) return;

    if (data?.cmd === "DISPATCH" && data?.evt === "READY") {
      this.emit("ready", data.data);
      return;
    }

    if (data?.nonce && this.pending.has(data.nonce)) {
      const pending = this.pending.get(data.nonce);
      this.pending.delete(data.nonce);
      clearTimeout(pending.timer);
      if (data.evt === "ERROR") {
        pending.reject(
          rpcError(data.data, `Discord RPC ${pending.command} failed.`),
        );
      } else {
        pending.resolve(data.data);
      }
      return;
    }

    if (data?.evt) this.emit("dispatch", { event: data.evt, data: data.data });
  }

  #onDisconnect(error) {
    if (!this.connected && !this.closing) this.emit("connectError", error);
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.emit("disconnected", error);
  }
}
