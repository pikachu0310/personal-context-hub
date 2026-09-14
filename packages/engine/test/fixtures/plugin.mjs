// Independent protocol peer: deliberately imports no Engine implementation.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
const id = "fixture";
const pending = new Map();
const outputs = [];
function send(value) {
  process.send({ v: 2, ...value });
}
function request(operation, input, context) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    send({ type: "request", id, operation, input, context });
  });
}
const server = createServer(async (req, res) => {
  try {
    const result = await request("state", {}, req.headers["x-ido-context"]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 401;
    res.end(error.message);
  }
});
process.on("message", (frame) => {
  if (frame.type === "reply") {
    const waiter = pending.get(frame.id);
    pending.delete(frame.id);
    if (waiter) {
      if (frame.error) waiter.reject(new Error(frame.error));
      else waiter.resolve(frame.result);
    }
    return;
  }
  if (frame.type !== "request") return;
  void (async () => {
    switch (frame.operation) {
      case "inspect":
        return {
          id,
          version: "0.2.0",
          protocol: 2,
          title: "Test adapter",
          fields: [{ key: "credential", label: "Credential", secret: true }],
          capabilities: ["text", "audio", "web", "activity"],
          web: { basePath: `/plugins/${id}`, publicPaths: [] },
        };
      case "validate":
        return { config: frame.input.config };
      case "configure":
        return {};
      case "start": {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        return { port: server.address().port };
      }
      case "output":
        outputs.push(frame.input.output);
        return {};
      case "event":
        outputs.push(frame.input.event);
        return {};
      case "test.outputs":
        return outputs;
      case "test.invalidate":
        send({ type: "invalidate" });
        return {};
      case "test.request":
        return request(
          frame.input.operation,
          frame.input.input,
          frame.input.context,
        );
      default:
        throw new Error("UNKNOWN_OPERATION");
    }
  })().then(
    (result) => send({ type: "reply", id: frame.id, result }),
    (error) => send({ type: "reply", id: frame.id, error: error.message }),
  );
});
process.on("disconnect", () => {
  server.close();
  process.exit();
});
