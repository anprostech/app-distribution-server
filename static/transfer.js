/* Bounded requests, idempotent retries, and resume across refreshes in this tab. */
class AppDistroTransfer {
  constructor(file, token, onProgress) {
    this.file = file;
    this.token = token;
    this.onProgress = onProgress;
    this.controller = new AbortController();
    this.requests = new Set();
    this.storageKey = `appdistro.transfer:${file.name}:${file.size}:${file.lastModified}`;
    this.loaded = new Map();
  }
  abort() {
    this.controller.abort();
    this.requests.forEach((request) => request.abort());
  }
  async wait(milliseconds) {
    if (this.controller.signal.aborted)
      throw new DOMException("Paused", "AbortError");
    await new Promise((resolve, reject) => {
      const finish = () => {
        this.controller.signal.removeEventListener("abort", cancel);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      const cancel = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", cancel);
        reject(new DOMException("Paused", "AbortError"));
      };
      this.controller.signal.addEventListener("abort", cancel, { once: true });
    });
  }
  async request(method, path, body = null, onProgress = null) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.controller.signal.aborted)
        throw new DOMException("Paused", "AbortError");
      try {
        return await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          this.requests.add(request);
          request.open(method, path);
          request.timeout = 45000;
          request.setRequestHeader("X-Auth-Token", this.token);
          if (body)
            request.setRequestHeader(
              "Content-Type",
              body instanceof Blob
                ? "application/octet-stream"
                : "application/json",
            );
          const done = () => this.requests.delete(request);
          request.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) onProgress(event.loaded);
          };
          request.onload = () => {
            done();
            if (request.status >= 200 && request.status < 300) {
              try {
                resolve(
                  request.responseText
                    ? JSON.parse(request.responseText)
                    : null,
                );
              } catch {
                reject(
                  new Error("The server returned an unexpected response."),
                );
              }
            } else {
              const error = new Error(
                request.status === 413
                  ? "This build exceeds the supported upload size."
                  : "The upload request failed.",
              );
              error.status = request.status;
              reject(error);
            }
          };
          request.onerror = request.ontimeout = () => {
            done();
            reject(new Error("Connection interrupted"));
          };
          request.onabort = () => {
            done();
            reject(new DOMException("Paused", "AbortError"));
          };
          request.send(
            body instanceof Blob ? body : body ? JSON.stringify(body) : null,
          );
        });
      } catch (error) {
        if (
          this.controller.signal.aborted ||
          error.name === "AbortError" ||
          (error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status))
        )
          throw error;
        if (attempt === 3)
          throw new Error(
            "Connection interrupted. Click Resume upload to continue from the saved progress.",
          );
        this.onProgress({ status: "retrying", attempt: attempt + 1 });
        await this.wait(700 * 2 ** attempt);
      }
    }
  }
  remember(session) {
    try {
      sessionStorage.setItem(
        this.storageKey,
        JSON.stringify({ id: session.session_id, time: Date.now() }),
      );
    } catch {
      /* Storage can be disabled. */
    }
    this.session = session;
  }
  forget() {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {
      /* Storage is optional. */
    }
  }
  progress() {
    const loaded = [...this.loaded.values()].reduce(
      (total, value) => total + value,
      0,
    );
    const elapsed = Math.max((performance.now() - this.started) / 1000, 0.1);
    this.onProgress({
      status: "uploading",
      loaded,
      total: this.file.size,
      speed: Math.max(0, loaded - this.initialBytes) / elapsed,
    });
  }
  async run() {
    try {
      let session = this.session;
      if (!session) {
        let saved;
        try {
          saved = JSON.parse(sessionStorage.getItem(this.storageKey));
        } catch {
          /* No saved upload. */
        }
        if (saved && Date.now() - saved.time < 24 * 60 * 60 * 1000) {
          try {
            session = await this.request(
              "GET",
              `/api/transfers/${encodeURIComponent(saved.id)}`,
            );
          } catch (error) {
            if (error.status !== 404) throw error;
            this.forget();
          }
        }
      } else
        session = await this.request(
          "GET",
          `/api/transfers/${session.session_id}`,
        );
      if (!session)
        session = await this.request("POST", "/api/transfers", {
          filename: this.file.name,
          size: this.file.size,
        });
      this.remember(session);
      this.started = performance.now();
      this.initialBytes = 0;
      if (session.status === "uploading") {
        const count = Math.ceil(this.file.size / session.chunk_size);
        const received = new Set(session.received);
        const missing = [];
        this.loaded.clear();
        for (let index = 0; index < count; index++) {
          if (received.has(index))
            this.loaded.set(
              index,
              Math.min(
                session.chunk_size,
                this.file.size - index * session.chunk_size,
              ),
            );
          else missing.push(index);
        }
        this.initialBytes = [...this.loaded.values()].reduce(
          (total, value) => total + value,
          0,
        );
        this.progress();
        const worker = async () => {
          while (missing.length) {
            const index = missing.shift();
            const part = this.file.slice(
              index * session.chunk_size,
              (index + 1) * session.chunk_size,
            );
            await this.request(
              "PUT",
              `/api/transfers/${session.session_id}/parts/${index}`,
              part,
              (value) => {
                this.loaded.set(index, value);
                this.progress();
              },
            );
            this.loaded.set(index, part.size);
            this.progress();
          }
        };
        await Promise.all([worker(), worker()]);
        session = await this.request(
          "POST",
          `/api/transfers/${session.session_id}/complete`,
        );
      }
      while (
        session.status === "processing" ||
        session.status === "uploading"
      ) {
        this.onProgress({
          status: "processing",
          loaded: this.file.size,
          total: this.file.size,
        });
        await this.wait(1200);
        session = await this.request(
          "GET",
          `/api/transfers/${session.session_id}`,
        );
        if (session.status === "uploading")
          session = await this.request(
            "POST",
            `/api/transfers/${session.session_id}/complete`,
          );
      }
      this.forget();
      if (session.status === "error")
        throw new Error(
          session.error ||
            "Could not process this build. Choose a valid .ipa or .apk.",
        );
      if (session.status !== "complete" || !session.build)
        throw new Error("The server returned an unexpected upload state.");
      return session.build;
    } catch (error) {
      this.abort();
      throw error;
    }
  }
}
