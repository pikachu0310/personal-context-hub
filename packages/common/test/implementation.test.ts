import test from "node:test";
import assert from "node:assert/strict";
import {
  implementationRemote,
  parsePreviewUrl,
  previewUrl,
  previewReference,
  previewMarkdown,
  previewPath,
} from "../src/contracts/implementation.js";
test("preview links round-trip one or two immutable references and reject ambiguous input", () => {
  for (const ids of [["a"], ["a", "b"]]) {
    const reference = { projectId: "project", implementationIds: ids };
    assert.deepEqual(parsePreviewUrl(previewUrl(reference)), reference);
  }
  for (const url of [
    "ido://projects/p/compare/a",
    "ido://projects/p/previews/a/b",
    "ido://projects/p/compare/a/a",
    "ido://projects/p/previews/a?command=evil",
    "ido://projects/p/previews/../a",
  ])
    assert.equal(parsePreviewUrl(url), undefined);
  assert.throws(() => previewReference({ implementationIds: ["a"] }));
  assert.throws(() =>
    previewReference({ projectId: "p", implementationIds: ["a", "b", "c"] }),
  );
  assert.match(
    previewMarkdown(
      { projectId: "p", implementationIds: ["a"] },
      "[x](bad)\nlink",
    ),
    /\\\[x\\\]/,
  );
});
test("Git identity cannot contain credentials, local paths or helper commands", () => {
  assert.equal(
    implementationRemote("git@example.com:team/repo.git"),
    "ssh://git@example.com/team/repo.git",
  );
  for (const remote of [
    "/tmp/repo",
    "file:///tmp/repo",
    "ext::sh -c bad",
    "https://token@example.com/repo",
    "https://example.com/repo?token=x",
    "ssh://git:password@example.com/repo",
    "https://example.com/../repo",
  ])
    assert.throws(() => implementationRemote(remote));
  assert.equal(
    previewPath("/settings?tab=profile#name"),
    "/settings?tab=profile#name",
  );
  for (const path of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/%5cexample.com",
    "/\nheader",
  ])
    assert.throws(() => previewPath(path));
});
