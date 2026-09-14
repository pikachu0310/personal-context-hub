import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asset, headers } from "../src/runtime/http.js";

test("favicon and manifest assets retain their MIME types for GET and HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ido-http-assets-"));
  const files = [
    ["favicon.ico", "image/x-icon", Buffer.from([0, 0, 1, 0])],
    [
      "site.webmanifest",
      "application/manifest+json",
      Buffer.from('{"name":"IDO"}'),
    ],
    [
      "favicon.svg",
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
  ] as const;
  const server = createServer((req, res) => {
    headers(res);
    void asset(req, res, directory, req.url!);
  });
  try {
    for (const [name, , bytes] of files)
      await writeFile(join(directory, name), bytes);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const [name, mime, bytes] of files) {
      for (const method of ["GET", "HEAD"]) {
        const response: Response = await fetch(
          `http://127.0.0.1:${address.port}/${name}`,
          { method },
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), mime);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          method === "HEAD" ? Buffer.alloc(0) : bytes,
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
