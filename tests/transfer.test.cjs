const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

function harness(respond, saved = new Map()) {
  const calls = [];
  class Request {
    upload = {};
    open(method, path) {
      this.method = method;
      this.path = path;
    }
    setRequestHeader() {}
    send(body) {
      calls.push({ method: this.method, path: this.path, body });
      queueMicrotask(() => {
        if (this.aborted) return;
        const result = respond(this, body);
        if (result === "network-error") return this.onerror();
        this.status = result.status;
        this.responseText = result.json ? JSON.stringify(result.json) : "";
        this.onload();
      });
    }
    abort() {
      this.aborted = true;
      this.onabort();
    }
  }
  const context = vm.createContext({
    AbortController,
    DOMException,
    Blob,
    performance,
    setTimeout,
    clearTimeout,
    XMLHttpRequest: Request,
    sessionStorage: {
      getItem: (key) => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: (key) => saved.delete(key),
    },
  });
  const Transfer = vm.runInContext(
    readFileSync("static/transfer.js", "utf8") + "\nAppDistroTransfer;",
    context,
  );
  const file = new Blob(["abcdefgh"]);
  Object.assign(file, { name: "app.apk", lastModified: 123 });
  const transfer = new Transfer(file, "test-token", () => {});
  transfer.wait = async () => {};
  return { transfer, calls, saved };
}

test("retries a lost part response with the identical bytes and path", async () => {
  let attempts = 0;
  const { transfer, calls } = harness(() =>
    ++attempts === 1 ? "network-error" : { status: 204 },
  );
  const part = new Blob(["data"]);
  await transfer.request("PUT", "/api/transfers/test/parts/0", part);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, calls[1].path);
  assert.equal(await calls[0].body.text(), await calls[1].body.text());
});

test("authorization errors are not retried", async () => {
  const { transfer, calls } = harness(() => ({ status: 403 }));
  await assert.rejects(transfer.request("GET", "/api/transfers/test"), {
    status: 403,
  });
  assert.equal(calls.length, 1);
});

test("resume sends only missing parts and survives a lost completion response", async () => {
  let completionAttempts = 0;
  const state = {
    session_id: "saved-session",
    chunk_size: 4,
    received: [0],
    status: "uploading",
  };
  const build = { upload_id: "build-id" };
  const { transfer, calls, saved } = harness((request) => {
    if (request.method === "GET") return { status: 200, json: state };
    if (request.method === "PUT") return { status: 204 };
    if (request.path.endsWith("/complete")) {
      state.status = "complete";
      state.build = build;
      return ++completionAttempts === 1
        ? "network-error"
        : { status: 202, json: state };
    }
    throw new Error("Unexpected request " + request.path);
  });
  saved.set(
    transfer.storageKey,
    JSON.stringify({ id: state.session_id, time: Date.now() }),
  );
  assert.equal((await transfer.run()).upload_id, build.upload_id);
  const parts = calls.filter((call) => call.method === "PUT");
  assert.equal(parts.length, 1);
  assert.ok(parts[0].path.endsWith("/parts/1"));
  assert.equal(await parts[0].body.text(), "efgh");
  assert.equal(completionAttempts, 2);
  assert.equal(saved.size, 0);
});
