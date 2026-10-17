(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const storageKey = "appdistro.access-token";
  let token = "";
  try {
    token = sessionStorage.getItem(storageKey) || "";
  } catch {
    /* Storage can be disabled. */
  }
  let builds = [];
  let platform = "all";
  let nextAction = null;
  let selectedFile = null;
  let uploadRequest = null;
  let deleteTarget = null;
  let successUrl = "";
  let toastTimer;
  let loadSequence = 0;

  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/static/dashboard-icons.svg#${name}`);
    svg.append(use);
    return svg;
  };
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const bytes = (value) => {
    if (!value) return "0 B";
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
    return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${["B", "KB", "MB", "GB"][unit]}`;
  };
  const installUrl = (build) =>
    new URL(`/get/${encodeURIComponent(build.upload_id)}`, location.origin)
      .href;
  const appKey = (build) => `${build.platform}:${build.bundle_id}`;
  const dateValue = (build) => Date.parse(build.created_at) || 0;
  const setError = (id, message = "") => {
    $(id).textContent = message;
    $(id).hidden = !message;
  };
  const notify = (message) => {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 4500);
  };
  const copyLink = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      notify("Installation link copied. Ready to share.");
    } catch {
      notify(
        "Copy isn’t available in this browser. Open the installation page and copy its address.",
      );
    }
  };
  const saveToken = (value) => {
    token = value;
    try {
      if (value) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* In-memory sign in still works. */
    }
    $("session-label").textContent = value
      ? "Lock workspace"
      : "Unlock workspace";
  };
  const lock = () => {
    loadSequence += 1;
    if (uploadRequest) {
      uploadRequest.abort();
      uploadRequest = null;
    }
    saveToken("");
    builds = [];
    for (const id of ["upload-dialog", "delete-dialog"]) $(id).close();
    setError("library-error");
    render();
  };
  const readError = async (response, fallback) => {
    if (response.status === 413)
      return "This build exceeds the server’s upload limit. Try a smaller build or increase the proxy limit.";
    if (response.status >= 500)
      return "The server couldn’t complete this request. Please try again.";
    const body = await response.text();
    if (body && !body.includes("<") && body.length < 300) {
      try {
        const detail = JSON.parse(body).detail;
        if (typeof detail === "string") return detail;
      } catch {
        return body;
      }
    }
    return fallback;
  };
  async function loadBuilds() {
    if (!token) {
      render();
      return;
    }
    const sequence = ++loadSequence;
    const requestToken = token;
    $("refresh-builds").disabled = true;
    $("build-list").setAttribute("aria-busy", "true");
    setError("library-error");
    try {
      const response = await fetch("/api/builds", {
        headers: { "X-Auth-Token": requestToken },
        cache: "no-store",
      });
      if (sequence !== loadSequence) return;
      if (response.status === 403 || response.status === 401) {
        lock();
        showAuth();
        setError(
          "auth-error",
          "Your access token is no longer valid. Please unlock the workspace again.",
        );
        return;
      }
      if (!response.ok)
        throw new Error(
          await readError(response, "Couldn’t load builds. Please try again."),
        );
      const data = await response.json();
      if (sequence !== loadSequence) return;
      builds = data;
      render();
    } catch (error) {
      if (sequence === loadSequence) {
        setError(
          "library-error",
          error instanceof TypeError
            ? "Can’t reach the server. Check your connection and refresh."
            : error.message,
        );
        if (!builds.length)
          emptyState(
            "Couldn’t load your library.",
            "Use Refresh to try again. Your builds are still stored on the server.",
            "Try again",
            loadBuilds,
            "refresh",
          );
      }
    } finally {
      $("refresh-builds").disabled = !token;
      $("build-list").setAttribute("aria-busy", "false");
    }
  }
  function emptyState(title, description, action, callback, symbol) {
    $("empty-state").hidden = false;
    $("empty-title").textContent = title;
    $("empty-description").textContent = description;
    $("empty-action").textContent = action;
    $("empty-action").append(icon("arrow"));
    $("empty-action").onclick = callback;
    document
      .querySelector(".empty-art > svg use")
      .setAttribute("href", `/static/dashboard-icons.svg#${symbol}`);
  }
  function render() {
    $("session-label").textContent = token
      ? "Lock workspace"
      : "Unlock workspace";
    $("refresh-builds").disabled = !token;
    const apps = new Set(builds.map(appKey)).size;
    $("stat-apps").textContent = token ? apps.toLocaleString() : "—";
    $("stat-builds").textContent = token ? builds.length.toLocaleString() : "—";
    $("stat-size").textContent = token
      ? bytes(builds.reduce((sum, build) => sum + build.file_size, 0))
      : "—";
    $("nav-count").textContent = token ? apps.toLocaleString() : "—";
    $("build-count").textContent = token ? builds.length.toLocaleString() : "0";
    $("build-list").replaceChildren();
    const query = $("search-builds").value.toLowerCase().trim();
    let visible = builds.filter(
      (build) =>
        (platform === "all" || build.platform === platform) &&
        `${build.app_title} ${build.bundle_id} ${build.bundle_version}`
          .toLowerCase()
          .includes(query),
    );
    const sort = $("sort-builds").value;
    visible.sort((a, b) =>
      sort === "name"
        ? a.app_title.localeCompare(b.app_title) || dateValue(b) - dateValue(a)
        : (dateValue(b) - dateValue(a)) * (sort === "oldest" ? -1 : 1),
    );
    $("results-summary").textContent = token
      ? `Showing ${visible.length} of ${builds.length} ${builds.length === 1 ? "build" : "builds"}`
      : "Your app library is private.";
    if (!token) {
      emptyState(
        "Your builds, all in one place.",
        "Unlock your workspace to view your app library and share a new build.",
        "Unlock workspace",
        () => showAuth(),
        "lock",
      );
      return;
    }
    if (!builds.length) {
      emptyState(
        "Every release starts with a build.",
        "Upload your first iOS or Android build. Your team’s next download is one link away.",
        "Upload your first build",
        openUpload,
        "layers",
      );
      return;
    }
    if (!visible.length) {
      emptyState(
        "No builds found.",
        "Try another app name or bundle ID, or clear your filters.",
        "Clear filters",
        resetFilters,
        "search",
      );
      return;
    }
    $("empty-state").hidden = true;
    const latest = new Map();
    [...builds]
      .sort((a, b) => dateValue(b) - dateValue(a))
      .forEach((build) => {
        if (!latest.has(appKey(build)))
          latest.set(appKey(build), build.upload_id);
      });
    const fragment = document.createDocumentFragment();
    visible.forEach((build) => {
      const row = node("article", "build-row build-grid");
      row.setAttribute("role", "listitem");
      const cell = node("div", "app-cell");
      const color =
        [...build.bundle_id].reduce(
          (sum, char) => sum + char.charCodeAt(0),
          0,
        ) % 5;
      const initials =
        build.app_title
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((word) => Array.from(word)[0] || "")
          .join("")
          .toUpperCase() || "A";
      cell.append(node("span", `app-avatar avatar-${color}`, initials));
      const info = node("div", "app-info");
      const name = node("a", "app-title", build.app_title);
      name.href = installUrl(build);
      name.target = "_blank";
      name.rel = "noopener";
      name.title = `${build.app_title} · Open installation page`;
      const bundle = node("span", "bundle-id", build.bundle_id);
      bundle.title = build.bundle_id;
      info.append(name, bundle);
      cell.append(info);
      const platformCell = node("div", "platform-cell");
      const badge = node("span", "platform-badge");
      badge.append(
        icon(build.platform === "ios" ? "apple" : "android"),
        document.createTextNode(build.platform === "ios" ? "iOS" : "Android"),
      );
      platformCell.append(badge);
      const version = node("div", "version-cell");
      const versionLabel = node(
        "span",
        "version-label",
        `v${build.bundle_version}`,
      );
      versionLabel.title = build.bundle_version;
      version.append(versionLabel);
      if (latest.get(appKey(build)) === build.upload_id)
        version.append(node("span", "latest-badge", "LATEST"));
      const date = node("div", "date-cell");
      if (build.created_at) {
        const time = new Date(build.created_at);
        date.title = time.toLocaleString();
        date.append(
          document.createTextNode(
            time.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            }),
          ),
          node(
            "span",
            "",
            time.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          ),
        );
      } else date.textContent = "Legacy build";
      const size = node("span", "size-cell", bytes(build.file_size));
      const actions = node("div", "row-actions");
      const copy = node("button", "icon-button");
      copy.type = "button";
      copy.title = "Copy installation link";
      copy.setAttribute(
        "aria-label",
        `Copy installation link for ${build.app_title} ${build.bundle_version}`,
      );
      copy.append(icon("copy"));
      copy.onclick = () => copyLink(installUrl(build));
      const download = node("a", "icon-button");
      download.title = "Download build";
      download.setAttribute(
        "aria-label",
        `Download ${build.app_title} ${build.bundle_version}`,
      );
      download.href = `${installUrl(build)}/app.${build.platform === "ios" ? "ipa" : "apk"}`;
      download.append(icon("download"));
      const remove = node("button", "icon-button delete-button");
      remove.type = "button";
      remove.title = "Delete build";
      remove.setAttribute(
        "aria-label",
        `Delete ${build.app_title} ${build.bundle_version}`,
      );
      remove.append(icon("trash"));
      remove.onclick = () => showDelete(build);
      actions.append(copy, download, remove);
      row.append(cell, platformCell, version, date, size, actions);
      fragment.append(row);
    });
    $("build-list").append(fragment);
  }
  function resetFilters() {
    platform = "all";
    $("search-builds").value = "";
    document.querySelectorAll(".platform-tab").forEach((button) => {
      const active = button.dataset.platform === "all";
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    render();
  }
  function showAuth(action = null) {
    nextAction = action;
    setError("auth-error");
    $("access-token").value = "";
    $("access-token").type = "password";
    $("toggle-token").textContent = "Show";
    $("toggle-token").setAttribute("aria-label", "Show access token");
    $("auth-dialog").showModal();
    $("access-token").focus();
  }
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const candidate = $("access-token").value.trim();
    if (!candidate) return;
    $("auth-submit").disabled = true;
    setError("auth-error");
    try {
      const response = await fetch("/api/builds", {
        headers: { "X-Auth-Token": candidate },
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "That access token isn’t valid. Check it and try again."
            : "Can’t unlock the workspace right now. Please try again.",
        );
      const data = await response.json();
      if (!$("auth-dialog").open) return;
      saveToken(candidate);
      builds = data;
      render();
      $("auth-dialog").close();
      $("access-token").value = "";
      const action = nextAction;
      nextAction = null;
      if (action) action();
      else notify("Workspace unlocked. Welcome back.");
    } catch (error) {
      setError(
        "auth-error",
        error instanceof TypeError
          ? "Can’t reach the server. Check your connection and try again."
          : error.message,
      );
    } finally {
      $("auth-submit").disabled = false;
    }
  });
  $("toggle-token").onclick = () => {
    const hidden = $("access-token").type === "password";
    $("access-token").type = hidden ? "text" : "password";
    $("toggle-token").textContent = hidden ? "Hide" : "Show";
    $("toggle-token").setAttribute(
      "aria-label",
      `${hidden ? "Hide" : "Show"} access token`,
    );
  };
  $("session-button").onclick = () => {
    if (token) {
      lock();
      notify("Workspace locked. Access token cleared.");
    } else showAuth();
  };

  function openUpload() {
    if (!token) {
      showAuth(openUpload);
      return;
    }
    selectedFile = null;
    successUrl = "";
    $("upload-form").reset();
    $("file-label").textContent = "Drop your build here";
    $("file-detail").textContent = "or click to browse · .ipa and .apk";
    $("upload-submit").disabled = true;
    $("upload-submit").hidden = false;
    $("build-file").disabled = false;
    $("drop-zone").hidden = false;
    $("drop-zone").classList.remove("is-uploading");
    for (const id of ["upload-progress-wrap", "upload-success", "upload-done"])
      $(id).hidden = true;
    setError("upload-error");
    $("upload-dialog").showModal();
  }
  function selectFile(file) {
    if (uploadRequest || !file) return;
    selectedFile = null;
    $("upload-submit").disabled = true;
    setError("upload-error");
    $("file-label").textContent = file.name;
    $("file-detail").textContent = bytes(file.size);
    if (!/\.(ipa|apk)$/i.test(file.name)) {
      setError("upload-error", "Choose an iOS .ipa or Android .apk file.");
      return;
    }
    if (!file.size) {
      setError(
        "upload-error",
        "This file is empty. Please choose a valid app build.",
      );
      return;
    }
    selectedFile = file;
    $("upload-submit").disabled = false;
    $("file-detail").textContent =
      `${bytes(file.size)} · ${/\.ipa$/i.test(file.name) ? "iOS" : "Android"} · Click to change`;
  }
  $("build-file").addEventListener("change", (event) =>
    selectFile(event.target.files[0]),
  );
  for (const eventName of ["dragenter", "dragover"])
    $("drop-zone").addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!uploadRequest) $("drop-zone").classList.add("dragging");
    });
  for (const eventName of ["dragleave", "drop"])
    $("drop-zone").addEventListener(eventName, (event) => {
      event.preventDefault();
      $("drop-zone").classList.remove("dragging");
    });
  $("drop-zone").addEventListener("drop", (event) => {
    if (event.dataTransfer.files.length > 1) {
      setError("upload-error", "Upload one build at a time.");
      return;
    }
    selectFile(event.dataTransfer.files[0]);
  });
  $("upload-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selectedFile || uploadRequest) return;
    const form = new FormData();
    form.append("app_file", selectedFile);
    const request = new XMLHttpRequest();
    uploadRequest = request;
    request.open("POST", "/api/upload");
    request.setRequestHeader("X-Auth-Token", token);
    request.timeout = 600000;
    $("upload-submit").disabled = true;
    $("build-file").disabled = true;
    $("drop-zone").classList.add("is-uploading");
    $("upload-progress-wrap").hidden = false;
    $("upload-progress").value = 0;
    $("upload-percent").textContent = "0%";
    $("upload-status").textContent = "Uploading…";
    setError("upload-error");
    const finished = () => {
      uploadRequest = null;
      $("drop-zone").classList.remove("is-uploading");
      $("build-file").disabled = false;
      $("upload-submit").disabled = false;
    };
    const fail = (message) => {
      finished();
      $("upload-progress-wrap").hidden = true;
      setError("upload-error", message);
    };
    request.upload.onprogress = (progress) => {
      if (!progress.lengthComputable) return;
      const percent = Math.round((progress.loaded / progress.total) * 100);
      $("upload-progress").value = percent;
      $("upload-percent").textContent = `${percent}%`;
      $("upload-status").textContent =
        percent === 100 ? "Processing build…" : "Uploading…";
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const build = JSON.parse(request.responseText);
          successUrl = installUrl(build);
          finished();
          $("upload-progress-wrap").hidden = true;
          $("drop-zone").hidden = true;
          $("upload-submit").hidden = true;
          $("success-link").href = successUrl;
          $("upload-success").hidden = false;
          $("upload-done").hidden = false;
          resetFilters();
          loadBuilds();
        } catch {
          fail(
            "The server returned an unexpected response. Refresh the library before trying again.",
          );
        }
      } else if (request.status === 403 || request.status === 401) {
        finished();
        lock();
        showAuth(openUpload);
        setError(
          "auth-error",
          "Your token is no longer valid. Unlock the workspace to upload again.",
        );
      } else if (request.status === 413)
        fail(
          "This build exceeds the server’s upload limit. Try a smaller build or increase the proxy limit.",
        );
      else if (request.status === 400 || request.status === 422)
        fail(
          "We couldn’t read this build. Choose a valid exported .ipa or .apk file.",
        );
      else
        fail(
          "The server couldn’t process this build. Please try again or check the app’s server logs.",
        );
    };
    request.onerror = () =>
      fail(
        "The upload connection was interrupted. Refresh the library before trying again.",
      );
    request.ontimeout = () =>
      fail(
        "The upload took too long. Refresh the library to check whether it completed.",
      );
    request.onabort = () => {
      finished();
    };
    request.send(form);
  });
  $("success-copy").onclick = () => copyLink(successUrl);
  $("new-build").onclick = openUpload;
  $("banner-upload").onclick = openUpload;
  function showDelete(build) {
    deleteTarget = build;
    $("delete-description").textContent =
      `${build.app_title} · v${build.bundle_version} · ${build.platform === "ios" ? "iOS" : "Android"}`;
    setError("delete-error");
    $("delete-submit").disabled = false;
    $("delete-dialog").showModal();
  }
  $("delete-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!deleteTarget) return;
    $("delete-submit").disabled = true;
    setError("delete-error");
    try {
      const response = await fetch(
        `/api/delete/${encodeURIComponent(deleteTarget.upload_id)}`,
        { method: "DELETE", headers: { "X-Auth-Token": token } },
      );
      if (response.status === 403 || response.status === 401) {
        lock();
        showAuth();
        setError(
          "auth-error",
          "Your token is no longer valid. Unlock the workspace again.",
        );
        return;
      }
      if (!response.ok && response.status !== 404)
        throw new Error(
          await readError(
            response,
            "Couldn’t delete this build. Please try again.",
          ),
        );
      $("delete-dialog").close();
      deleteTarget = null;
      notify("Build deleted. Its installation link is no longer available.");
      await loadBuilds();
    } catch (error) {
      setError(
        "delete-error",
        error instanceof TypeError
          ? "Can’t reach the server. Check your connection before trying again."
          : error.message,
      );
    } finally {
      $("delete-submit").disabled = false;
    }
  });
  document.querySelectorAll("[data-close]").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.close === "upload-dialog" && uploadRequest) {
        notify(
          "Your build is uploading. Keep this window open until it finishes.",
        );
        return;
      }
      $(button.dataset.close).close();
    }),
  );
  $("upload-dialog").addEventListener("cancel", (event) => {
    if (uploadRequest) {
      event.preventDefault();
      notify(
        "Your build is uploading. Keep this window open until it finishes.",
      );
    }
  });
  $("auth-dialog").addEventListener("close", () => {
    $("access-token").value = "";
  });
  document.querySelectorAll(".platform-tab").forEach((button) =>
    button.addEventListener("click", () => {
      platform = button.dataset.platform;
      document.querySelectorAll(".platform-tab").forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle("selected", active);
        tab.setAttribute("aria-pressed", String(active));
      });
      render();
    }),
  );
  $("search-builds").addEventListener("input", render);
  $("sort-builds").addEventListener("change", render);
  $("refresh-builds").onclick = loadBuilds;
  window.addEventListener("beforeunload", (event) => {
    if (uploadRequest) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  render();
  if (token) loadBuilds();
})();
