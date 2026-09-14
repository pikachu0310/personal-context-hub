import { type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  type Command,
  type Mapping,
  type Project,
} from "../../../common/src/contracts/protocol.js";
import { Credentials } from "../../../common/src/runtime/credentials.js";
import { HttpError, send } from "../../../common/src/runtime/http.js";
import { atomic, json, secret } from "../../../common/src/runtime/platform.js";
import { connect } from "../connection/engine.js";
import { pair } from "../connection/pair.js";
import { pollPair } from "../connection/poll.js";
import { Executor } from "../execution/executor.js";
import { route } from "../http/routes.js";
import { ClientPreview } from "../preview/relay.js";

interface Settings {
  engineUrl?: string;
  deviceId?: string;
  publicKey?: string;
  mappings: Mapping[];
  slots: number;
  projects: Project[];
}
export class Client {
  settings: Settings = { mappings: [], slots: 1, projects: [] };
  credentials: Credentials;
  executor: Executor;
  preview: ClientPreview;
  csrf = secret();
  origin = "";
  generation = 0;
  connected = false;
  allow = false;
  stopping = false;
  ws?: WebSocket;
  reconnect?: NodeJS.Timeout;
  pairing?: { id: string; proof: string; url: string; fingerprint: string };
  pairTimer?: NodeJS.Timeout;
  status = "offline";
  login?: ChildProcess;
  loginStatus = "not checked";
  processing: Promise<unknown> = Promise.resolve();
  server = createServer(
    (req, res) =>
      void this.route(req, res).catch((e) => {
        if (!res.headersSent)
          send(res, e instanceof HttpError ? e.status : 400, {
            error: e instanceof HttpError ? e.message : "REQUEST_FAILED",
          });
      }),
  );
  constructor(
    readonly directory: string,
    readonly uiDirectory = join(dirname(fileURLToPath(import.meta.url)), "ui"),
  ) {
    this.credentials = new Credentials(directory, "ido-client");
    this.executor = new Executor(directory, (data) => this.emit(data));
    this.preview = new ClientPreview((data) => this.emit(data));
  }
  async start(port = 4320) {
    this.settings = await json(
      join(this.directory, "client.json"),
      this.settings,
    );
    await this.executor.load();
    if (!this.settings.publicKey) {
      const keys = generateKeyPairSync("ed25519");
      this.settings.publicKey = keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      await this.credentials.set(
        "device.privateKey",
        keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      );
      await this.save();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
    if (this.settings.deviceId) this.connect();
    return this;
  }
  save() {
    return atomic(join(this.directory, "client.json"), this.settings);
  }
  emit(data: Command) {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected)
      this.ws.send(JSON.stringify({ ...data, generation: this.generation }));
  }
  grants() {
    return this.allow
      ? this.settings.mappings.map(
          ({ directory, previewCommand, ...grant }) => grant,
        )
      : [];
  }
  ready() {
    this.emit({
      v: 1,
      type: "ready",
      executionPolicyVersion: 1,
      grants: this.grants(),
      slots: this.settings.slots,
    });
  }
  readonly connect = connect.bind(this);
  readonly pair = pair.bind(this);
  readonly pollPair = pollPair.bind(this);
  readonly route = route.bind(this);
  async close() {
    this.stopping = true;
    clearTimeout(this.reconnect);
    clearTimeout(this.pairTimer);
    this.login?.kill();
    this.ws?.close();
    this.preview.close();
    await this.executor.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
