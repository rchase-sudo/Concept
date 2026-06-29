// app.js
//
// Frontend logic for the "Drafted" concept generator. Renders everything
// into the <div id="root"> left empty by concept.html, using `sb`
// (the Supabase client) and `pdfjsLib` / `window.jspdf` already set up
// by the inline <script> block in that file.
//
// Flow:
//   1. Auth screen (sign in / sign up) until there's a session.
//   2. Workspace: optional reference upload (image or PDF) + prompt.
//   3. On "Generate": upload file -> insert `generations` row -> invoke
//      the `generate-concept` edge function -> poll `check-status` every
//      3s until status is "complete" or "failed".
//   4. History grid of past generations, with a detail modal.

(() => {
  const root = document.getElementById("root");

  const state = {
    session: null,
    authMode: "signin", // "signin" | "signup"
    authError: "",
    authSuccess: "",
    authBusy: false,

    sourceFile: null, // File
    sourcePreviewUrl: null, // data URL for the file-pin thumb
    sourceKind: null, // "image" | "pdf"

    generating: false,
    errorMessage: "",
    currentGeneration: null, // row from `generations`
    resultImageUrl: null, // signed URL for the current result

    history: [],
    historyLoading: true,
    modalGeneration: null,

    pollTimer: null,
  };

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function statusLabel(status) {
    return {
      pending: "Queued",
      analyzing: "Analyzing reference",
      rendering: "Rendering concept",
      complete: "Complete",
      failed: "Failed",
    }[status] || status;
  }

  function slugify(str) {
    return (str || "concept")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "concept";
  }

  function clearPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImageDims(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function downloadFromUrl(url, filename) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  async function downloadAsPdf(url, title) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const dataUrl = await blobToDataURL(blob);
    const img = await loadImageDims(dataUrl);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: img.width >= img.height ? "landscape" : "portrait",
      unit: "pt",
      format: [img.width, img.height],
    });
    pdf.addImage(dataUrl, "PNG", 0, 0, img.width, img.height);
    pdf.save(`${slugify(title)}.pdf`);
  }

  async function pdfFirstPageThumb(file) {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas.toDataURL("image/png");
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function render() {
    root.innerHTML = renderTopbar() + (state.session ? renderWorkspace() : renderAuth()) + renderModal();
    attachListeners();
  }

  function renderTopbar() {
    const right = state.session
      ? `<div class="topbar-right">
           <span class="user-email">${escapeHtml(state.session.user.email)}</span>
           <button class="btn btn-ghost" data-action="sign-out">Sign out</button>
         </div>`
      : "";
    return `
      <header class="topbar">
        <div class="brand"><span class="mark"></span> Drafted</div>
        ${right}
      </header>`;
  }

  function renderAuth() {
    const isSignUp = state.authMode === "signup";
    return `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-eyebrow">Concept Plan Generator</div>
          <h1 class="auth-title">${isSignUp ? "Create your account" : "Welcome back"}</h1>
          <p class="auth-sub">${isSignUp
            ? "Sign up to start turning floor plans and sketches into rendered concepts."
            : "Sign in to pick up where you left off."}</p>

          ${state.authError ? `<div class="auth-error">${escapeHtml(state.authError)}</div>` : ""}
          ${state.authSuccess ? `<div class="auth-success">${escapeHtml(state.authSuccess)}</div>` : ""}

          <form id="auth-form">
            <div class="field">
              <label for="auth-email">Email</label>
              <input id="auth-email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="auth-password">Password</label>
              <input id="auth-password" type="password" autocomplete="${isSignUp ? "new-password" : "current-password"}" minlength="6" required />
            </div>
            <button type="submit" class="btn btn-primary auth-submit" ${state.authBusy ? "disabled" : ""}>
              ${state.authBusy ? `<span class="spin"></span> Please wait` : (isSignUp ? "Sign up" : "Sign in")}
            </button>
          </form>

          <div class="auth-toggle">
            ${isSignUp ? "Already have an account?" : "Don't have an account?"}
            <button type="button" data-action="toggle-auth-mode">${isSignUp ? "Sign in" : "Sign up"}</button>
          </div>
        </div>
      </div>`;
  }

  function renderDropzone() {
    if (state.sourceFile) {
      return `
        <div class="dropzone" data-role="dropzone">
          <input type="file" id="file-input" accept="image/*,application/pdf" />
        </div>
        <div class="file-pin">
          <img class="thumb" src="${state.sourcePreviewUrl || ""}" alt="" />
          <div class="meta">
            <div class="name">${escapeHtml(state.sourceFile.name)}</div>
            <div class="kind">${state.sourceKind === "pdf" ? "PDF" : "IMAGE"}</div>
          </div>
          <button class="remove" data-action="remove-file" title="Remove file">&times;</button>
        </div>`;
    }
    return `
      <div class="dropzone" data-role="dropzone">
        <svg class="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="dropzone-text">Drop a floor plan, sketch, or photo</div>
        <div class="dropzone-hint">PNG, JPG or PDF — optional</div>
        <input type="file" id="file-input" accept="image/*,application/pdf" />
      </div>`;
  }

  function renderStatusStrip() {
    const gen = state.currentGeneration;
    if (!gen) return "";
    const failed = gen.status === "failed";
    return `
      <div class="status-strip ${failed ? "failed" : ""}">
        <span class="status-dot"></span>
        <span class="status-tag">${gen.status.toUpperCase()}</span>
        <span class="status-text">${failed ? escapeHtml(gen.error_message || "Generation failed") : statusLabel(gen.status)}</span>
      </div>`;
  }

  function renderResultPanel() {
    const gen = state.currentGeneration;
    if (!gen || gen.status !== "complete" || !state.resultImageUrl) return "";
    return `
      <div class="result-panel">
        <div class="result-head">
          <div class="result-title">${escapeHtml(gen.title || "Untitled Concept")}</div>
          <button class="btn btn-ghost" data-action="dismiss-result">Start a new concept</button>
        </div>
        <div class="result-frame">
          <img src="${state.resultImageUrl}" alt="${escapeHtml(gen.title || "Concept render")}" />
          <div class="result-actions">
            <button class="btn btn-primary" data-action="download-png">Download PNG</button>
            <button class="btn" data-action="download-pdf">Download PDF</button>
            <a class="btn btn-ghost" href="${state.resultImageUrl}" target="_blank" rel="noopener">Open full size</a>
          </div>
        </div>
      </div>`;
  }

  function renderHistoryCard(item) {
    const pillClass = ["complete", "failed"].includes(item.status) ? item.status : "pending";
    const thumb = item.signedUrl
      ? `<img src="${item.signedUrl}" alt="" />`
      : `<span class="spin"></span>`;
    return `
      <div class="history-card" data-action="open-history" data-id="${item.id}">
        <div class="thumb-wrap">${thumb}</div>
        <div class="body">
          <div class="title">${escapeHtml(item.title || item.prompt)}</div>
          <div class="date">${formatDate(item.created_at)}</div>
          <span class="pill ${pillClass}">${escapeHtml(statusLabel(item.status))}</span>
        </div>
      </div>`;
  }

  function renderHistorySection() {
    let body;
    if (state.historyLoading) {
      body = `<div class="empty-state"><span class="spin"></span></div>`;
    } else if (state.history.length === 0) {
      body = `<div class="empty-state">No concepts yet — generate your first one above.</div>`;
    } else {
      body = `<div class="history-grid">${state.history.map(renderHistoryCard).join("")}</div>`;
    }
    return `
      <div class="history-section">
        <div class="history-head">
          <div class="panel-label">Recent concepts</div>
          <button class="btn btn-ghost" data-action="refresh-history">Refresh</button>
        </div>
        ${body}
      </div>`;
  }

  function renderWorkspace() {
    return `
      <main class="workspace">
        <div class="workspace-head">
          <div class="workspace-eyebrow">Concept Plan Generator</div>
          <h1 class="workspace-title">Turn a plan into a picture.</h1>
          <p class="workspace-sub">Upload a floor plan, sketch, or site photo, describe what you're imagining, and get back a rendered concept image.</p>
        </div>

        ${state.errorMessage ? `<div class="auth-error" style="margin-bottom:20px;">${escapeHtml(state.errorMessage)}</div>` : ""}

        <div class="generator-grid">
          <div class="panel">
            <div class="panel-label">Reference (optional)</div>
            ${renderDropzone()}
          </div>
          <div class="panel">
            <div class="panel-label">Describe the concept</div>
            <textarea class="prompt-box" placeholder="e.g. A warm, modern kitchen renovation with white oak cabinetry, a large island, and soft pendant lighting over the counter."></textarea>
            <div class="generate-row">
              <span class="char-hint" data-role="char-hint">0 characters</span>
              <button class="btn btn-primary" data-action="generate" ${state.generating ? "disabled" : ""}>
                ${state.generating ? `<span class="spin"></span> Generating` : "Generate concept"}
              </button>
            </div>
          </div>
        </div>

        ${renderStatusStrip()}
        ${renderResultPanel()}
        ${renderHistorySection()}
      </main>`;
  }

  function renderModal() {
    const gen = state.modalGeneration;
    if (!gen) return "";
    return `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-card" data-role="modal-card">
          <div style="position:relative;">
            <button class="btn btn-ghost modal-close" data-action="close-modal">&times;</button>
            <div class="result-frame" style="border:none; border-radius:0;">
              ${gen.signedUrl
                ? `<img src="${gen.signedUrl}" alt="" />`
                : `<div class="empty-state">${gen.status === "failed" ? escapeHtml(gen.error_message || "Generation failed") : "Still rendering…"}</div>`}
            </div>
            <div style="padding:20px;">
              <div class="result-title" style="margin-bottom:8px;">${escapeHtml(gen.title || "Untitled Concept")}</div>
              <div class="date" style="margin-bottom:14px;">${formatDate(gen.created_at)}</div>
              <div class="char-hint" style="white-space:normal; line-height:1.5;">${escapeHtml(gen.prompt)}</div>
              ${gen.signedUrl ? `
                <div class="result-actions" style="padding:18px 0 0; border-top:none;">
                  <button class="btn btn-primary" data-action="modal-download-png">Download PNG</button>
                  <button class="btn" data-action="modal-download-pdf">Download PDF</button>
                </div>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------

  function attachListeners() {
    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", onAction);
    });

    const authForm = root.querySelector("#auth-form");
    if (authForm) authForm.addEventListener("submit", onAuthSubmit);

    const fileInput = root.querySelector("#file-input");
    if (fileInput) fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFileSelected(file);
    });

    const dropzone = root.querySelector('[data-role="dropzone"]');
    if (dropzone) {
      dropzone.addEventListener("click", (e) => {
        if (e.target === dropzone) fileInput && fileInput.click();
      });
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("drag-over");
      });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag-over");
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleFileSelected(file);
      });
    }

    const promptBox = root.querySelector(".prompt-box");
    const charHint = root.querySelector('[data-role="char-hint"]');
    if (promptBox && charHint) {
      promptBox.addEventListener("input", () => {
        charHint.textContent = `${promptBox.value.length} characters`;
      });
    }

    const modalCard = root.querySelector('[data-role="modal-card"]');
    if (modalCard) modalCard.addEventListener("click", (e) => e.stopPropagation());
  }

  function onAction(e) {
    const action = e.currentTarget.dataset.action;
    const handlers = {
      "toggle-auth-mode": () => {
        state.authMode = state.authMode === "signin" ? "signup" : "signin";
        state.authError = "";
        state.authSuccess = "";
        render();
      },
      "sign-out": async () => { await sb.auth.signOut(); },
      "remove-file": () => {
        state.sourceFile = null;
        state.sourcePreviewUrl = null;
        state.sourceKind = null;
        render();
      },
      "generate": handleGenerate,
      "dismiss-result": () => {
        state.currentGeneration = null;
        state.resultImageUrl = null;
        render();
      },
      "download-png": () => {
        if (state.resultImageUrl) {
          downloadFromUrl(state.resultImageUrl, `${slugify(state.currentGeneration?.title)}.png`);
        }
      },
      "download-pdf": () => {
        if (state.resultImageUrl) {
          downloadAsPdf(state.resultImageUrl, state.currentGeneration?.title);
        }
      },
      "refresh-history": refreshHistory,
      "open-history": () => {
        const id = e.currentTarget.dataset.id;
        const item = state.history.find((h) => h.id === id);
        if (item) { state.modalGeneration = item; render(); }
      },
      "close-modal": () => { state.modalGeneration = null; render(); },
      "modal-download-png": () => {
        const gen = state.modalGeneration;
        if (gen?.signedUrl) downloadFromUrl(gen.signedUrl, `${slugify(gen.title)}.png`);
      },
      "modal-download-pdf": () => {
        const gen = state.modalGeneration;
        if (gen?.signedUrl) downloadAsPdf(gen.signedUrl, gen.title);
      },
    };
    if (handlers[action]) handlers[action]();
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const email = root.querySelector("#auth-email").value.trim();
    const password = root.querySelector("#auth-password").value;
    state.authBusy = true;
    state.authError = "";
    state.authSuccess = "";
    render();

    try {
      if (state.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          state.authSuccess = "Check your email to confirm your account, then sign in.";
          state.authMode = "signin";
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      state.authError = err.message || "Something went wrong.";
    } finally {
      state.authBusy = false;
      render();
    }
  }

  async function handleFileSelected(file) {
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";
    if (!isImage && !isPdf) {
      state.errorMessage = "Please choose an image or a PDF file.";
      render();
      return;
    }
    state.errorMessage = "";
    state.sourceFile = file;
    state.sourceKind = isPdf ? "pdf" : "image";
    try {
      state.sourcePreviewUrl = isPdf ? await pdfFirstPageThumb(file) : await blobToDataURL(file);
    } catch (err) {
      console.error("Preview generation failed:", err);
      state.sourcePreviewUrl = null;
    }
    render();
  }

  async function handleGenerate() {
    const promptBox = root.querySelector(".prompt-box");
    const promptText = promptBox ? promptBox.value.trim() : "";
    if (!promptText) {
      state.errorMessage = "Please describe the concept you want to generate.";
      render();
      return;
    }

    state.generating = true;
    state.errorMessage = "";
    state.resultImageUrl = null;
    render();

    try {
      const user = state.session.user;
      let sourcePath = null;
      const sourceKind = state.sourceKind;

      if (state.sourceFile) {
        const ext = (state.sourceFile.name.split(".").pop() || (sourceKind === "pdf" ? "pdf" : "png")).toLowerCase();
        sourcePath = `${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await sb.storage
          .from("uploads")
          .upload(sourcePath, state.sourceFile, { contentType: state.sourceFile.type || undefined });
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
      }

      const { data: gen, error: insErr } = await sb
        .from("generations")
        .insert({ user_id: user.id, prompt: promptText, source_path: sourcePath, source_kind: sourceKind, status: "pending" })
        .select()
        .single();
      if (insErr) throw new Error(`Could not create generation: ${insErr.message}`);

      state.currentGeneration = gen;
      state.sourceFile = null;
      state.sourcePreviewUrl = null;
      state.sourceKind = null;
      render();

      const { error: fnErr } = await sb.functions.invoke("generate-concept", { body: { generation_id: gen.id } });
      if (fnErr) throw new Error(fnErr.message || "Failed to start generation");

      startPolling(gen.id);
      refreshHistory();
    } catch (err) {
      console.error(err);
      state.errorMessage = err.message || "Something went wrong.";
      state.generating = false;
      render();
    }
  }

  function startPolling(generationId) {
    clearPolling();
    state.pollTimer = setInterval(async () => {
      try {
        const { data, error } = await sb.functions.invoke("check-status", { body: { generation_id: generationId } });
        if (error) throw error;
        const gen = data.generation;
        state.currentGeneration = gen;

        if (gen.status === "complete" || gen.status === "failed") {
          clearPolling();
          state.generating = false;
          if (gen.status === "complete" && gen.output_path) {
            const { data: signed } = await sb.storage.from("outputs").createSignedUrl(gen.output_path, 3600);
            state.resultImageUrl = signed?.signedUrl || null;
          }
          refreshHistory();
        }
        render();
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 3000);
  }

  async function refreshHistory() {
    const user = state.session?.user;
    if (!user) return;
    const { data, error } = await sb
      .from("generations")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(24);

    if (error) {
      console.error("Failed to load history:", error);
      state.historyLoading = false;
      render();
      return;
    }

    const items = data || [];
    await Promise.all(items.map(async (item) => {
      if (item.status === "complete" && item.output_path) {
        const { data: signed } = await sb.storage.from("outputs").createSignedUrl(item.output_path, 3600);
        item.signedUrl = signed?.signedUrl || null;
      }
    }));

    state.history = items;
    state.historyLoading = false;

    // Resume polling if something was left mid-flight (e.g. after a refresh).
    const active = items.find((i) => ["pending", "analyzing", "rendering"].includes(i.status));
    if (active && !state.pollTimer) {
      state.currentGeneration = active;
      state.generating = true;
      startPolling(active.id);
    }

    render();
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  async function init() {
    const { data } = await sb.auth.getSession();
    state.session = data.session || null;
    render();
    if (state.session) refreshHistory();

    sb.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      if (!session) {
        clearPolling();
        state.history = [];
        state.historyLoading = true;
        state.currentGeneration = null;
        state.resultImageUrl = null;
      }
      render();
      if (session) refreshHistory();
    });
  }

  init();
})();
