// app.js
(() => {
  const root = document.getElementById("root");

  const state = {
    session: null,
    authMode: "signin",
    authError: "",
    authSuccess: "",
    authBusy: false,

    sourceFile: null,
    sourcePreviewUrl: null,
    sourceKind: null,

    // The prompt textarea is state-backed instead of DOM-only. Previously
    // its typed content lived nowhere except the live <textarea> node, so
    // ANY re-render (a poll tick, a background auth token refresh, etc.)
    // would silently wipe it. Storing it here means a re-render always
    // redraws whatever was last typed, no matter what triggered the render.
    promptText: "",

    // Optional required-parking-stalls input. Blank string = no requirement
    // (generate-concept behaves exactly as before). A positive integer here
    // gets passed straight through to the `generations` row as
    // required_parking_stalls.
    parkingSpaces: "",

    generating: false,
    errorMessage: "",
    currentGeneration: null,
    resultImageUrl: null,

    history: [],
    historyLoading: true,
    modalGeneration: null,

    // ---- Folders ----
    folders: [],
    foldersLoading: true,
    currentFolderId: null,     // null = "All concepts"
    renamingFolderId: null,    // folder currently being renamed inline
    renameFolderDraft: "",
    newFolderDraft: "",        // state-backed "new folder" input, same reasoning as promptText

    // ---- Per-card 3-dot menu ----
    openMenuGenId: null,       // which history card's menu is open
    moveSubmenuOpen: false,    // whether the "move to folder" submenu is expanded

   

    _pollInterval: null,
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
      pending:   "Queued",
      analyzing: "Analyzing reference",
      rendering: "Rendering concept",
      completed: "Complete",
      failed:    "Failed",
    }[status] || status;
  }

  function isTerminal(status) {
    return status === "completed" || status === "failed";
  }

  function slugify(str) {
    return (str || "concept")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "concept";
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
      img.onload  = () => resolve(img);
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
    const resp    = await fetch(url);
    const blob    = await resp.blob();
    const dataUrl = await blobToDataURL(blob);
    const img     = await loadImageDims(dataUrl);
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
    const buf      = await file.arrayBuffer();
    const doc      = await pdfjsLib.getDocument({ data: buf }).promise;
    const page     = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas.toDataURL("image/png");
  }

  async function pdfFirstPageToImageBlob(file, scale = 2.5) {
    const buf      = await file.arrayBuffer();
    const doc      = await pdfjsLib.getDocument({ data: buf }).promise;
    const page     = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to render PDF page to image"));
      }, "image/png");
    });
  }

  // ---------------------------------------------------------------
  // Polling — always the source of truth for completion
  // ---------------------------------------------------------------

  function stopPolling() {
    if (state._pollInterval) {
      clearInterval(state._pollInterval);
      state._pollInterval = null;
    }
  }

  function startPolling(generationId) {
    stopPolling();
    state._pollInterval = setInterval(async () => {
      try {
        const { data, error } = await sb
          .from("generations")
          .select("*")
          .eq("id", generationId)
          .single();

        if (error || !data) return;

        state.currentGeneration = data;

        if (data.status === "completed") {
          stopPolling();
          state.generating = false;

          if (data.output_path) {
            const { data: signed, error: signErr } = await sb.storage
              .from("outputs")
              .createSignedUrl(data.output_path, 3600);
            if (signErr) {
              console.error("Failed to create signed URL:", signErr.message, "bucket: outputs, path:", data.output_path);
            }
            state.resultImageUrl = signed?.signedUrl || null;
          } else {
            state.resultImageUrl = null;
          }

          refreshHistory();
          render();
        } else if (data.status === "failed") {
          stopPolling();
          state.generating   = false;
          state.errorMessage = data.error_message || "Generation failed.";
          render();
        } else {
          // still in progress, update status strip
          render();
        }
      } catch (e) {
        console.error("Poll error:", e);
      }
    }, 3000);
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

          ${state.authError   ? `<div class="auth-error">${escapeHtml(state.authError)}</div>`     : ""}
          ${state.authSuccess ? `<div class="auth-success">${escapeHtml(state.authSuccess)}</div>` : ""}

          <form id="auth-form">
            <div class="field">
              <label for="auth-email">Email</label>
              <input id="auth-email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="auth-password">Password</label>
              <input id="auth-password" type="password"
                autocomplete="${isSignUp ? "new-password" : "current-password"}"
                minlength="6" required />
            </div>
            <button type="submit" class="btn btn-primary auth-submit" ${state.authBusy ? "disabled" : ""}>
              ${state.authBusy
                ? `<span class="spin"></span> Please wait`
                : (isSignUp ? "Sign up" : "Sign in")}
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

  // ---- Plan legend ----
  // Static reference describing the line colors/styles a user's uploaded
  // reference plan may use, and what each one is treated as by the pipeline
  // (mirrors ORIGINAL_PLAN_RULES in the generate-concept edge function).
  const LEGEND_ITEMS = [
    {
      swatchClass: "magenta thick solid",
      label: "Property line",
      desc: "No development is allowed outside this line, other than access to an existing road.",
    },
    {
      swatchClass: "yellow thin dashed",
      label: "Building setback line",
      desc: "No development beyond this line, other than road access and proposed vegetation.",
    },
    {
      swatchClass: "green thick dashed shaded",
      label: "Wetland setback area",
      desc: "No development or alteration inside this area, other than grading.",
    },
    {
      swatchClass: "orange thin dashed",
      label: "Pavement setback",
      desc: "Nothing beyond this setback, other than vegetation.",
    },
    {
      swatchClass: "red thick solid",
      label: "Desired access road",
      desc: "This location must be used for site access.",
    },
    {
      swatchClass: "blue thick solid",
      label: "Desired building location",
      desc: "This location must be used for the proposed building — no other buildings may be added.",
    },
  ];

  function renderLegendSwatch(swatchClass) {
    return `<span class="legend-swatch ${swatchClass}"></span>`;
  }

  function renderLegend() {
    const rows = LEGEND_ITEMS.map((item) => `
      <div class="legend-row">
        ${renderLegendSwatch(item.swatchClass)}
        <div class="legend-text">
          <div class="legend-label">${escapeHtml(item.label)}</div>
          <div class="legend-desc">${escapeHtml(item.desc)}</div>
        </div>
      </div>`).join("");
  
    return `
      <div class="legend always-open">
        <div class="legend-header">
          <span class="legend-title">Plan legend</span>
        </div>
        <div class="legend-body">
          <div class="legend-hint">If your uploaded reference uses these lines, this is how each one is read.</div>
          <div class="legend-grid">${rows}</div>
        </div>
      </div>`;
  }

  function renderStatusStrip() {
    const gen = state.currentGeneration;
    if (!gen || isTerminal(gen.status)) return "";
    return `
      <div class="status-strip">
        <span class="status-dot"></span>
        <span class="status-tag">${gen.status.toUpperCase()}</span>
        <span class="status-text">${statusLabel(gen.status)}</span>
      </div>`;
  }

  function renderResultPanel() {
    const gen = state.currentGeneration;
    if (!gen || gen.status !== "completed" || !state.resultImageUrl) return "";
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

  // ---- Folders ----

  function renderFolderSidebar() {
    const folderItems = state.folders.map(renderFolderItem).join("");
    return `
      <aside class="folder-sidebar">
        <div class="panel-label">Folders</div>
        <div class="folder-list">
          <div class="folder-item ${state.currentFolderId === null ? "active" : ""}"
               data-action="select-folder" data-folder-id=""
               data-role="folder-drop" data-drop-target="root">
            <span class="folder-name">All concepts</span>
          </div>
          ${folderItems}
        </div>
        <form id="new-folder-form" class="new-folder-form">
          <input id="new-folder-input" placeholder="New folder name" autocomplete="off"
            value="${escapeHtml(state.newFolderDraft)}" />
          <button type="submit" class="btn btn-ghost new-folder-btn" title="Add folder">+</button>
        </form>
      </aside>`;
  }

  function renderFolderItem(folder) {
    const isActive = state.currentFolderId === folder.id;

    if (state.renamingFolderId === folder.id) {
      return `
        <div class="folder-item renaming" data-role="folder-drop" data-drop-target="${folder.id}">
          <input class="folder-rename-input" data-folder-id="${folder.id}"
            value="${escapeHtml(state.renameFolderDraft)}" />
        </div>`;
    }

    return `
      <div class="folder-item ${isActive ? "active" : ""}"
           data-action="select-folder" data-folder-id="${folder.id}"
           data-role="folder-drop" data-drop-target="${folder.id}">
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-actions">
          <button class="icon-btn" data-action="rename-folder" data-folder-id="${folder.id}" title="Rename">✎</button>
          <button class="icon-btn" data-action="delete-folder" data-folder-id="${folder.id}" title="Delete">🗑</button>
        </span>
      </div>`;
  }

  // ---- History cards + 3-dot menu ----

  function renderHistoryCard(item) {
    const pillClass = item.status === "completed" ? "complete"
                    : item.status === "failed"    ? "failed"
                    : "pending";
    const thumb = item.result_url || item.signedUrl
      ? `<img src="${item.result_url || item.signedUrl}" alt="" />`
      : `<span class="spin"></span>`;
    const menuOpen = state.openMenuGenId === item.id;

    return `
      <div class="history-card" draggable="true" data-action-drag="gen" data-gen-id="${item.id}">
        <div class="thumb-wrap" data-action="open-history" data-id="${item.id}">${thumb}</div>
        <div class="body" data-action="open-history" data-id="${item.id}">
          <div class="title">${escapeHtml(item.title || item.prompt)}</div>
          <div class="date">${formatDate(item.created_at)}</div>
          <span class="pill ${pillClass}">${escapeHtml(statusLabel(item.status))}</span>
        </div>
        <button class="kebab-btn" data-action="toggle-card-menu" data-id="${item.id}" title="More options">⋯</button>
        ${menuOpen ? renderCardMenu(item) : ""}
      </div>`;
  }

  function renderCardMenu(item) {
    const canDownload = item.status === "completed" && (item.result_url || item.signedUrl);
    return `
      <div class="card-menu" data-role="card-menu">
        ${canDownload
          ? `<button class="card-menu-item" data-action="menu-download" data-id="${item.id}">Download</button>`
          : ""}
        <button class="card-menu-item" data-action="menu-move-toggle" data-id="${item.id}">Move to folder ▸</button>
        ${state.moveSubmenuOpen ? renderMoveSubmenu(item) : ""}
        <div class="card-menu-divider"></div>
        <button class="card-menu-item danger" data-action="menu-delete" data-id="${item.id}">Delete</button>
      </div>`;
  }

  function renderMoveSubmenu(item) {
    const noFolderRow = `
      <button class="card-menu-item ${!item.folder_id ? "current" : ""}"
        data-action="move-to-folder" data-id="${item.id}" data-folder-id="">No folder</button>`;
    const folderRows = state.folders.map((f) => `
      <button class="card-menu-item ${item.folder_id === f.id ? "current" : ""}"
        data-action="move-to-folder" data-id="${item.id}" data-folder-id="${f.id}">${escapeHtml(f.name)}</button>`
    ).join("");
    return `<div class="card-submenu">${noFolderRow}${folderRows}</div>`;
  }

  function renderHistorySection() {
    const filtered = state.currentFolderId === null
      ? state.history
      : state.history.filter((h) => h.folder_id === state.currentFolderId);

    const folderName = state.currentFolderId === null
      ? "All concepts"
      : (state.folders.find((f) => f.id === state.currentFolderId)?.name || "Folder");

    let body;
    if (state.historyLoading) {
      body = `<div class="empty-state"><span class="spin"></span></div>`;
    } else if (filtered.length === 0) {
      body = `<div class="empty-state">${
        state.currentFolderId === null
          ? "No concepts yet — generate your first one above."
          : "No concepts in this folder yet — drag one here, or use a card's ⋯ menu."
      }</div>`;
    } else {
      body = `<div class="history-grid">${filtered.map(renderHistoryCard).join("")}</div>`;
    }

    return `
      <div class="history-section">
        <div class="history-head">
          <div class="panel-label">${escapeHtml(folderName)}</div>
          <button class="btn btn-ghost" data-action="refresh-history">Refresh</button>
        </div>
        ${body}
      </div>`;
  }

  function renderLibrarySection() {
    return `
      <div class="library-layout">
        ${renderFolderSidebar()}
        ${renderHistorySection()}
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

        ${state.errorMessage
          ? `<div class="auth-error" style="margin-bottom:20px;">${escapeHtml(state.errorMessage)}</div>`
          : ""}

        <div class="generator-grid">
          <div class="panel">
            <div class="panel-label">Reference (optional)</div>
            ${renderDropzone()}
            ${renderLegend()}
          </div>
          <div class="panel">
            <div class="panel-label">Describe the concept</div>
            <textarea class="prompt-box" placeholder="e.g. A warm, modern kitchen renovation with white oak cabinetry, a large island, and soft pendant lighting over the counter.">${escapeHtml(state.promptText)}</textarea>
            <div class="parking-row">
              <label for="parking-input" class="parking-label">
                Required parking spaces <span class="optional-tag">optional</span>
              </label>
              <input id="parking-input" type="number" min="1" step="1"
                class="parking-input" placeholder="e.g. 40"
                value="${escapeHtml(state.parkingSpaces)}" />
            </div>
            <div class="generate-row">
              <span class="char-hint" data-role="char-hint">${state.promptText.length} characters</span>
              <button class="btn btn-primary" data-action="generate" ${state.generating ? "disabled" : ""}>
                ${state.generating ? `<span class="spin"></span> Generating` : "Generate concept"}
              </button>
            </div>
          </div>
        </div>

        ${renderStatusStrip()}
        ${renderResultPanel()}
        ${renderLibrarySection()}
      </main>`;
  }

  function renderModal() {
    const gen = state.modalGeneration;
    if (!gen) return "";
    const imgUrl = gen.result_url || gen.signedUrl || null;
    return `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal-card" data-role="modal-card">
          <div style="position:relative;">
            <button class="btn btn-ghost modal-close" data-action="close-modal">&times;</button>
            <div class="result-frame" style="border:none; border-radius:0;">
              ${imgUrl
                ? `<img src="${imgUrl}" alt="" />`
                : `<div class="empty-state">${
                    gen.status === "failed"
                      ? escapeHtml(gen.error_message || "Generation failed")
                      : "Still rendering…"
                  }</div>`}
            </div>
            <div style="padding:20px;">
              <div class="result-title" style="margin-bottom:8px;">${escapeHtml(gen.title || "Untitled Concept")}</div>
              <div class="date" style="margin-bottom:14px;">${formatDate(gen.created_at)}</div>
              <div class="char-hint" style="white-space:normal; line-height:1.5;">${escapeHtml(gen.prompt)}</div>
              ${imgUrl ? `
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

    // The prompt textarea is state-backed so a later render() (poll tick,
    // auth event, etc.) redraws whatever was actually typed instead of blank.
    const promptBox = root.querySelector(".prompt-box");
    const charHint  = root.querySelector('[data-role="char-hint"]');
    if (promptBox && charHint) {
      promptBox.addEventListener("input", () => {
        state.promptText = promptBox.value;
        charHint.textContent = `${promptBox.value.length} characters`;
      });
    }

    const parkingInput = root.querySelector("#parking-input");
    if (parkingInput) {
      parkingInput.addEventListener("input", () => {
        state.parkingSpaces = parkingInput.value;
      });
    }

    const modalCard = root.querySelector('[data-role="modal-card"]');
    if (modalCard) modalCard.addEventListener("click", (e) => e.stopPropagation());

    // ---- New-folder form ----
    const newFolderForm = root.querySelector("#new-folder-form");
    if (newFolderForm) newFolderForm.addEventListener("submit", onNewFolderSubmit);

    const newFolderInput = root.querySelector("#new-folder-input");
    if (newFolderInput) {
      newFolderInput.addEventListener("input", () => {
        state.newFolderDraft = newFolderInput.value;
      });
    }

    // ---- Inline folder rename ----
    const renameInput = root.querySelector(".folder-rename-input");
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
      renameInput.addEventListener("input", () => {
        state.renameFolderDraft = renameInput.value;
      });
      renameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitFolderRename();
        } else if (e.key === "Escape") {
          state.renamingFolderId = null;
          render();
        }
      });
      renameInput.addEventListener("blur", () => {
        commitFolderRename();
      });
    }

    // ---- Drag-and-drop: cards -> folders ----
    // IMPORTANT: dragover/dragleave toggle a class directly on the real DOM
    // node instead of going through state + render(). Calling render() mid-drag
    // would replace the DOM (including the element being dragged) and silently
    // cancel the native HTML5 drag operation. render() is only called from the
    // `drop` handler below, which fires after the drag session has ended.
    root.querySelectorAll('[data-action-drag="gen"]').forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", el.dataset.genId);
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
      });
    });

    root.querySelectorAll('[data-role="folder-drop"]').forEach((el) => {
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => {
        el.classList.remove("drag-over");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drag-over");
        const genId = e.dataTransfer.getData("text/plain");
        if (!genId) return;
        const dropTarget = el.dataset.dropTarget;
        const folderId = dropTarget === "root" ? null : dropTarget;
        moveGenerationToFolder(genId, folderId);
      });
    });
  }

  // Closes any open card menu when clicking outside it. Bound once, at
  // module load (not inside attachListeners), so it never gets re-bound or
  // duplicated across renders.
  document.addEventListener("click", (e) => {
    if (state.openMenuGenId === null) return;
    const withinMenu = e.target.closest(".card-menu, .kebab-btn");
    if (!withinMenu) {
      state.openMenuGenId = null;
      state.moveSubmenuOpen = false;
      render();
    }
  });

  function onAction(e) {
    const action = e.currentTarget.dataset.action;
    const handlers = {
      "toggle-auth-mode": () => {
        state.authMode = state.authMode === "signin" ? "signup" : "signin";
        state.authError   = "";
        state.authSuccess = "";
        render();
      },
      "sign-out": async () => {
        stopPolling();
        await sb.auth.signOut();
      },
      "remove-file": () => {
        state.sourceFile       = null;
        state.sourcePreviewUrl = null;
        state.sourceKind       = null;
        render();
      },
      "generate": handleGenerate,
      "dismiss-result": () => {
        state.currentGeneration = null;
        state.resultImageUrl    = null;
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
        const id   = e.currentTarget.dataset.id;
        const item = state.history.find((h) => h.id === id);
        if (item) { state.modalGeneration = item; render(); }
      },
      "close-modal": () => { state.modalGeneration = null; render(); },
      "modal-download-png": () => {
        const gen    = state.modalGeneration;
        const imgUrl = gen?.result_url || gen?.signedUrl;
        if (imgUrl) downloadFromUrl(imgUrl, `${slugify(gen.title)}.png`);
      },
      "modal-download-pdf": () => {
        const gen    = state.modalGeneration;
        const imgUrl = gen?.result_url || gen?.signedUrl;
        if (imgUrl) downloadAsPdf(imgUrl, gen.title);
      },

      // ---- Plan legend ----
      

      // ---- Folders ----
      "select-folder": () => {
        const id = e.currentTarget.dataset.folderId;
        state.currentFolderId = id ? id : null;
        state.openMenuGenId = null;
        render();
      },
      "rename-folder": () => {
        const id = e.currentTarget.dataset.folderId;
        const folder = state.folders.find((f) => f.id === id);
        if (!folder) return;
        state.renamingFolderId = id;
        state.renameFolderDraft = folder.name;
        render();
      },
      "delete-folder": () => {
        const id = e.currentTarget.dataset.folderId;
        const folder = state.folders.find((f) => f.id === id);
        if (!folder) return;
        if (!confirm(`Delete folder "${folder.name}"? Concepts inside it will move to "All concepts" — they will NOT be deleted.`)) return;
        deleteFolder(id);
      },

      // ---- Per-card 3-dot menu ----
      "toggle-card-menu": () => {
        const id = e.currentTarget.dataset.id;
        state.openMenuGenId = state.openMenuGenId === id ? null : id;
        state.moveSubmenuOpen = false;
        render();
      },
      "menu-download": () => {
        const id = e.currentTarget.dataset.id;
        const item = state.history.find((h) => h.id === id);
        const url = item?.result_url || item?.signedUrl;
        if (url) downloadFromUrl(url, `${slugify(item.title)}.png`);
        state.openMenuGenId = null;
        state.moveSubmenuOpen = false;
        render();
      },
      "menu-move-toggle": () => {
        state.moveSubmenuOpen = !state.moveSubmenuOpen;
        render();
      },
      "move-to-folder": () => {
        const id = e.currentTarget.dataset.id;
        const folderId = e.currentTarget.dataset.folderId || null;
        state.openMenuGenId = null;
        state.moveSubmenuOpen = false;
        moveGenerationToFolder(id, folderId);
      },
      "menu-delete": () => {
        const id = e.currentTarget.dataset.id;
        state.openMenuGenId = null;
        state.moveSubmenuOpen = false;
        render();
        if (!confirm("Delete this concept? This can't be undone.")) return;
        deleteGeneration(id);
      },
    };
    if (handlers[action]) handlers[action]();
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const email    = root.querySelector("#auth-email").value.trim();
    const password = root.querySelector("#auth-password").value;
    state.authBusy    = true;
    state.authError   = "";
    state.authSuccess = "";
    render();

    try {
      if (state.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          state.authSuccess = "Check your email to confirm your account, then sign in.";
          state.authMode    = "signin";
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
    const isPdf   = file.type === "application/pdf";
    if (!isImage && !isPdf) {
      state.errorMessage = "Please choose an image or a PDF file.";
      render();
      return;
    }
    state.errorMessage = "";
    state.sourceFile   = file;
    state.sourceKind   = isPdf ? "pdf" : "image";
    try {
      state.sourcePreviewUrl = isPdf ? await pdfFirstPageThumb(file) : await blobToDataURL(file);
    } catch (err) {
      console.error("Preview generation failed:", err);
      state.sourcePreviewUrl = null;
    }
    render();
  }

  async function invokeWithAuthRetry(functionName, body) {
    const { data: freshSession } = await sb.auth.getSession();
    const accessToken = freshSession?.session?.access_token;

    const attempt = (token) =>
      sb.functions.invoke(functionName, {
        body,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

    let result = await attempt(accessToken);
    const errMsg = result?.error?.message || "";
    if (errMsg.includes("UNAUTHORIZED_NO_AUTH_HEADER") || errMsg.includes("Missing authorization")) {
      console.warn(`Auth header missing for ${functionName} — refreshing session and retrying once`);
      const { data: refreshed } = await sb.auth.refreshSession();
      const retryToken = refreshed?.session?.access_token;
      result = await attempt(retryToken);
    }
    return result;
  }

  async function handleGenerate() {
    const promptText = state.promptText.trim();
    if (!promptText) {
      state.errorMessage = "Please describe the concept you want to generate.";
      render();
      return;
    }

    // Optional required-parking-stalls field. Blank -> null -> generate-concept
    // no-ops on parking entirely. A filled-in value must be a positive whole number.
    let requiredParkingStalls = null;
    const rawParking = state.parkingSpaces.trim();
    if (rawParking) {
      const n = parseInt(rawParking, 10);
      if (!Number.isFinite(n) || n <= 0) {
        state.errorMessage = "Parking spaces must be a positive whole number.";
        render();
        return;
      }
      requiredParkingStalls = n;
    }

    state.generating     = true;
    state.errorMessage   = "";
    state.resultImageUrl = null;
    render();

    try {
      const user = state.session.user;
      await runGenerateConceptFlow(user, promptText, requiredParkingStalls);
    } catch (err) {
      console.error(err);
      stopPolling();
      state.errorMessage = err.message || "Something went wrong.";
      state.generating   = false;
      render();
    }
  }

  // Creates the `generations` row and kicks off generate-concept. A new
  // concept always lands in "All concepts" (folder_id null) at creation
  // time -- moving it into a folder afterward is a separate action.
  async function runGenerateConceptFlow(user, promptText, requiredParkingStalls = null) {
    let sourcePath   = null;
    const sourceKind = state.sourceFile ? state.sourceKind : null;

    if (state.sourceFile) {
      let uploadBlob = state.sourceFile;
      let uploadExt  = (state.sourceFile.name.split(".").pop() || "png").toLowerCase();
      let uploadType = state.sourceFile.type || undefined;

      if (sourceKind === "pdf") {
        try {
          uploadBlob = await pdfFirstPageToImageBlob(state.sourceFile);
          uploadExt  = "png";
          uploadType = "image/png";
        } catch (pdfErr) {
          throw new Error(`Could not convert PDF to image: ${pdfErr.message}`);
        }
      }

      sourcePath = `${user.id}/${Date.now()}-${crypto.randomUUID()}.${uploadExt}`;
      const { error: upErr } = await sb.storage
        .from("uploads")
        .upload(sourcePath, uploadBlob, { contentType: uploadType });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
    }

    const { data: gen, error: insErr } = await sb
      .from("generations")
      .insert({
        user_id:     user.id,
        prompt:      promptText,
        source_path: sourcePath,
        source_kind: sourceKind,
        status:      "pending",
        required_parking_stalls: requiredParkingStalls,
      })
      .select()
      .single();
    if (insErr) throw new Error(`Could not create generation: ${insErr.message}`);

    finishKickoff(gen);

    invokeWithAuthRetry("generate-concept", { generation_id: gen.id }).catch((err) => {
      console.warn("Invoke finished with error (polling continues):", err?.message);
    });
  }

  function finishKickoff(gen) {
    state.currentGeneration = gen;
    state.sourceFile        = null;
    state.sourcePreviewUrl  = null;
    state.sourceKind        = null;
    state.promptText        = "";
    state.parkingSpaces     = "";

    startPolling(gen.id);
    render();
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
      if (item.status === "completed" && item.output_path) {
        const { data: signed, error: signErr } = await sb.storage
          .from("outputs")
          .createSignedUrl(item.output_path, 3600);
        if (signErr) {
          console.error("History signed URL failed for", item.id, ":", signErr.message, "path:", item.output_path);
        }
        item.signedUrl = signed?.signedUrl || null;
      }
    }));

    state.history        = items;
    state.historyLoading = false;
    render();
  }

  // ---------------------------------------------------------------
  // Folders — backend calls
  // ---------------------------------------------------------------

  async function loadFolders() {
    const user = state.session?.user;
    if (!user) return;

    const { data, error } = await sb
      .from("folders")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Failed to load folders:", error);
      state.foldersLoading = false;
      render();
      return;
    }

    state.folders = data || [];
    state.foldersLoading = false;
    render();
  }

  async function onNewFolderSubmit(e) {
    e.preventDefault();
    const name = state.newFolderDraft.trim();
    if (!name) return;
    await createFolder(name);
  }

  async function createFolder(name) {
    const user = state.session?.user;
    if (!user) return;

    const { data, error } = await sb
      .from("folders")
      .insert({ user_id: user.id, name })
      .select()
      .single();

    if (error) {
      state.errorMessage = `Could not create folder: ${error.message}`;
      render();
      return;
    }

    state.folders = [...state.folders, data];
    state.newFolderDraft = "";
    render();
  }

  async function commitFolderRename() {
    const id = state.renamingFolderId;
    if (!id) return; // already committed (e.g. Enter then blur firing twice) -- no-op
    const name = state.renameFolderDraft.trim();
    state.renamingFolderId = null;
    if (!name) { render(); return; }
    await renameFolder(id, name);
  }

  async function renameFolder(id, name) {
    const { data, error } = await sb
      .from("folders")
      .update({ name })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      state.errorMessage = `Could not rename folder: ${error.message}`;
      render();
      return;
    }

    state.folders = state.folders.map((f) => (f.id === id ? data : f));
    render();
  }

  async function deleteFolder(id) {
    const { error } = await sb.from("folders").delete().eq("id", id);

    if (error) {
      state.errorMessage = `Could not delete folder: ${error.message}`;
      render();
      return;
    }

    state.folders = state.folders.filter((f) => f.id !== id);
    // The DB's ON DELETE SET NULL already cleared folder_id server-side;
    // mirror that locally so the UI matches without waiting for a refetch.
    state.history = state.history.map((h) => (h.folder_id === id ? { ...h, folder_id: null } : h));
    if (state.currentFolderId === id) state.currentFolderId = null;
    render();
  }

  async function moveGenerationToFolder(generationId, folderId) {
    const { error } = await sb
      .from("generations")
      .update({ folder_id: folderId })
      .eq("id", generationId);

    if (error) {
      state.errorMessage = `Could not move concept: ${error.message}`;
      render();
      return;
    }

    state.history = state.history.map((h) =>
      h.id === generationId ? { ...h, folder_id: folderId } : h
    );
    render();
  }

  async function deleteGeneration(id) {
    const item = state.history.find((h) => h.id === id)
      || (state.modalGeneration?.id === id ? state.modalGeneration : null);

    // Best-effort cleanup of storage objects -- don't block the DB delete on these.
    if (item?.output_path) {
      try {
        await sb.storage.from("outputs").remove([item.output_path]);
      } catch (e) {
        console.warn("Failed to remove output file (non-fatal):", e);
      }
    }
    if (item?.source_path) {
      try {
        await sb.storage.from("uploads").remove([item.source_path]);
      } catch (e) {
        console.warn("Failed to remove source file (non-fatal):", e);
      }
    }

    const { error } = await sb.from("generations").delete().eq("id", id);
    if (error) {
      state.errorMessage = `Could not delete concept: ${error.message}`;
      render();
      return;
    }

    state.history = state.history.filter((h) => h.id !== id);
    if (state.currentGeneration?.id === id) {
      state.currentGeneration = null;
      state.resultImageUrl = null;
    }
    if (state.modalGeneration?.id === id) {
      state.modalGeneration = null;
    }
    render();
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  const PAID_REDIRECT_URL   = "https://rchase-sudo.github.io/Concept/";
  const UNPAID_REDIRECT_URL = "https://rchase-sudo.github.io/Upgrade/";

  async function checkPaidStatusAndRoute(session) {
    if (!session) return;

    const { data: profile, error } = await sb
      .from("profiles")
      .select("is_paid")
      .eq("id", session.user.id)
      .single();

    if (error) {
      console.error("Could not load profile/paid status:", error.message);
      window.location.href = UNPAID_REDIRECT_URL;
      return;
    }

    if (profile?.is_paid) {
      return;
    }

    window.location.href = UNPAID_REDIRECT_URL;
  }

  async function init() {
    const { data } = await sb.auth.getSession();
    let sessionCandidate = data.session || null;

    if (sessionCandidate) {
      const { data: userData, error: userErr } = await sb.auth.getUser();
      if (userErr || !userData?.user) {
        console.warn("Stale session detected on load — clearing it so login shows.");
        await sb.auth.signOut();
        sessionCandidate = null;
      }
    }

    state.session = sessionCandidate;

    if (state.session) {
      await checkPaidStatusAndRoute(state.session);
    }

    render();
    if (state.session) {
      refreshHistory();
      loadFolders();
    }

    // Supabase silently refreshes the access token on a timer AND on
    // tab/window focus. Only SIGNED_IN / SIGNED_OUT / USER_UPDATED actually
    // need a rebuild + redirect check. TOKEN_REFRESHED still needs
    // state.session updated (so subsequent Supabase calls use the fresh
    // token) but must NOT touch the DOM or re-run redirect logic, or it
    // silently wipes in-progress state (e.g. the prompt textarea) on every
    // routine token refresh.
    sb.auth.onAuthStateChange((event, session) => {
      state.session = session;

      if (event === "TOKEN_REFRESHED") {
        return; // session object updated silently, UI stays untouched
      }

      if (!session) {
        stopPolling();
        state.history           = [];
        state.historyLoading    = true;
        state.folders           = [];
        state.foldersLoading    = true;
        state.currentFolderId   = null;
        state.currentGeneration = null;
        state.resultImageUrl    = null;
      }
      render();
      if (session) {
        refreshHistory();
        loadFolders();
        checkPaidStatusAndRoute(session);
      }
    });
  }

  init();
})();
