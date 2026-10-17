// Bear Dashboard — Single-page app
// Router, state store, API client, 4 views
// Note: innerHTML usage is safe here — all rendered data comes from our own
// backend API (Stellar addresses, contract state). No untrusted user input.

(() => {
  // ── Theme (dark/light) ── #461, #578
  (function initTheme() {
    var saved = localStorage.getItem("bear-theme");
    var theme = saved;
    if (!theme) {
      // Respect OS system preference (#578)
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
        theme = "light";
      } else {
        theme = "dark";
      }
    }
    document.documentElement.setAttribute("data-theme", theme);
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var current = document.documentElement.getAttribute("data-theme") || "dark";
        var next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("bear-theme", next);
      });
    }
  })();
  // ── State Store ──
  const state = {
    stats: null,
    wallets: null,
    agents: null,
    jobs: null,
    history: null,
    loading: { stats: false, wallets: false, agents: false, jobs: false },
    jobFilter: "Active",
    jobSearch: "",
    agentSearch: "",   // #583 — agent name/description/tag filter
    agentPage: 1,
    agentPageSize: 24,
    agentTotal: 0,
    txPending: false,
  };

  // ── Debounce helper ──
  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  // ── Stellar Wallets Kit integration ──
  const wallet = {
    connected: false,
    publicKey: null,
    network: null, // 'testnet' | 'mainnet' | null
  };
  window.__walletState = wallet;

  // Initialize Stellar Wallets Kit (loaded via UMD script tag)
  var swkReady = false;
  var StellarWalletsKit, KitEventType, SwkAppDarkTheme, defaultModules;
  if (window.MyWalletKit) {
    StellarWalletsKit = window.MyWalletKit.StellarWalletsKit;
    KitEventType = window.MyWalletKit.KitEventType;
    SwkAppDarkTheme = window.MyWalletKit.SwkAppDarkTheme;
    defaultModules = window.MyWalletKit.defaultModules;
    StellarWalletsKit.init({
      theme: SwkAppDarkTheme,
      modules: defaultModules(),
    });
    // Mount the connect button in sidebar
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (btnWrapper) StellarWalletsKit.createButton(btnWrapper);
    // Listen for wallet state changes
    StellarWalletsKit.on(KitEventType.STATE_UPDATED, function (event) {
      var addr =
        event.payload &&
        (event.payload.address ||
          (event.payload.accounts &&
            event.payload.accounts[0] &&
            event.payload.accounts[0].address));
      if (!addr || addr.length <= 10) {
        // Fallback: fetch current address from SWK
        StellarWalletsKit.getAddress()
          .then(function (res) {
            wallet.connected = true;
            wallet.publicKey = res.address;
            updateWalletUI();
          })
          .catch(function () {});
        return;
      }
      wallet.connected = true;
      wallet.publicKey = addr;
      updateWalletUI();
    });
    swkReady = true;
  }

  // Freighter detection: prefer Freighter if present
  async function detectFreighter() {
    try {
      const api = window.freighterApi || window.freighter;
      if (!api || typeof api.getPublicKey !== "function") return;
      const pk = await api.getPublicKey();
      if (!pk || pk.length <= 10) return;
      let net = null;
      if (typeof api.getNetwork === "function") {
        try {
          const n = await api.getNetwork();
          if (String(n).toLowerCase().includes("test")) net = "testnet";
          else if (
            String(n).toLowerCase().includes("pub") ||
            String(n).toLowerCase().includes("main")
          )
            net = "mainnet";
        } catch (e) {}
      }
      wallet.connected = true;
      wallet.publicKey = pk;
      wallet.network = net;
      previousPublicKey = pk; // Track for change detection (#575)
      updateWalletUI();
      if (typeof api.onNetworkChanged === "function") {
        api.onNetworkChanged(function (n) {
          let updatedNet = null;
          if (String(n).toLowerCase().includes("test")) updatedNet = "testnet";
          else if (
            String(n).toLowerCase().includes("pub") ||
            String(n).toLowerCase().includes("main")
          )
            updatedNet = "mainnet";
          wallet.network = updatedNet;
          updateWalletUI();
        });
      }
    } catch (e) {
      // ignore
    }
  }

  // Retry Freighter detection a few times on load
  async function retryDetectFreighter(attempts) {
    if (attempts <= 0) return;
    await detectFreighter();
    if (!wallet.connected) {
      setTimeout(function () {
        retryDetectFreighter(attempts - 1);
      }, 1000);
    }
  }
  retryDetectFreighter(3);

  // Track previous public key for account change detection (#575)
  var previousPublicKey = null;

  // Periodic poll for account changes (#575)
  async function checkAccountChange() {
    if (!wallet.connected) return;
    try {
      const api = window.freighterApi || window.freighter;
      if (!api || typeof api.getPublicKey !== "function") return;
      const currentPk = await api.getPublicKey();
      if (!currentPk || currentPk.length <= 10) return;

      // Account changed detected
      if (previousPublicKey && previousPublicKey !== currentPk) {
        toast("Account changed to " + truncAddr(currentPk), "info");
        // Clear session token
        var token = window.__sessionToken;
        if (token) {
          fetch("/api/auth/logout", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
          }).catch(function () {});
          window.__sessionToken = null;
        }
        // Update wallet state
        wallet.publicKey = currentPk;
        updateWalletUI();
      }
      previousPublicKey = currentPk;
    } catch (e) {
      // ignore
    }
  }

  // Poll for account changes every 3 seconds
  setInterval(checkAccountChange, 3000);

  function disconnectWallet() {
    wallet.connected = false;
    wallet.publicKey = null;
    wallet.network = null;
    previousPublicKey = null; // Clear account change tracking (#575)
    // Clear all cached state so the next session starts fresh
    state.stats = null;
    state.wallets = null;
    state.agents = null;
    state.jobs = null;
    state.history = null;
    // Invalidate server-side session token if present
    var token = window.__sessionToken;
    if (token) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      }).catch(function () {});
      window.__sessionToken = null;
    }
    // Tell SWK to disconnect if the API supports it
    if (swkReady && StellarWalletsKit && typeof StellarWalletsKit.disconnect === "function") {
      try {
        StellarWalletsKit.disconnect();
      } catch (e) {}
    }
    updateWalletUI();
    // Re-show the SWK connect button
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (btnWrapper) btnWrapper.style.display = "";
    toast("Wallet disconnected");
    // Navigate to the root so the user lands on the connect prompt
    window.location.hash = "#/";
    navigate();
  }

  function updateWalletUI() {
    var connectedEl = document.getElementById("wallet-connected");
    var modeLabel = document.getElementById("wallet-mode-label");
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (wallet.connected && wallet.publicKey) {
      if (connectedEl) connectedEl.style.display = "flex";
      var addrDisplay = document.getElementById("wallet-addr-display");
      if (addrDisplay) {
        addrDisplay.title = wallet.publicKey;
        addrDisplay.innerHTML =
          '<span id="wallet-addr-text">' +
          escapeHtml(truncAddr(wallet.publicKey)) +
          "</span>" +
          copyBtn(wallet.publicKey, "wallet public key");
      }
      if (modeLabel) {
        const netLabel =
          wallet.network === "mainnet"
            ? "Mainnet"
            : wallet.network === "testnet"
              ? "Testnet"
              : "Connected";
        modeLabel.textContent = "Connected — " + netLabel;
      }
      // Update sidebar network badge
      try {
        var nb = document.getElementById("network-badge");
        if (nb)
          nb.innerHTML =
            '<span class="badge-dot"></span>' +
            (wallet.network === "mainnet"
              ? "Stellar Mainnet"
              : wallet.network === "testnet"
                ? "Stellar Testnet"
                : "Unknown Network");
      } catch (e) {}
      // Hide the SWK connect button once connected
      if (btnWrapper) btnWrapper.style.display = "none";
    } else {
      if (connectedEl) connectedEl.style.display = "none";
      if (modeLabel) modeLabel.textContent = "Demo Mode";
      if (btnWrapper) btnWrapper.style.display = "";
    }
  }

  /** Build unsigned tx on server, sign with Stellar Wallets Kit, submit via server */
  async function signAndSubmit(buildEndpoint, params) {
    await ensureSession();
    // 1. Build unsigned tx on server
    var buildRes = await api(buildEndpoint, {
      method: "POST",
      body: { publicKey: wallet.publicKey, ...params },
    });
    // 2. Sign with Stellar Wallets Kit
    // Prefer Freighter if available
    try {
      const api = window.freighterApi || window.freighter;
      if (api && typeof api.signTransaction === "function") {
        if (wallet.network === "mainnet")
          throw new Error(
            "Freighter is on Mainnet — dashboard blocks mainnet signing to avoid real transactions",
          );
        const sigRes = await api.signTransaction(buildRes.xdr);
        // Accept multiple possible response shapes
        const signedXdr =
          sigRes.signedTransaction ||
          sigRes.signedTx ||
          sigRes.signedTxXdr ||
          sigRes.signedXdr ||
          sigRes;
        return await apiClientSubmit(signedXdr);
      }
    } catch (e) {
      // Fall through to SWK path if Freighter signing fails
      console.warn("Freighter signing failed, falling back to SWK:", e);
    }

    if (!swkReady) throw new Error("Stellar Wallets Kit not loaded");
    var { address } = await StellarWalletsKit.getAddress();
    var { signedTxXdr } = await StellarWalletsKit.signTransaction(buildRes.xdr, {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: address,
    });
    return await apiClientSubmit(signedTxXdr);
  }

  async function apiClientSubmit(signedXdr) {
    return await api("/submit", {
      method: "POST",
      body: { signedXdr: signedXdr },
    });
  }

  // Expose wallet functions globally
  window.__disconnectWallet = disconnectWallet;

  /**
   * Returns a display label for the currently connected wallet.
   * Prefers the wallet name exposed by Stellar Wallets Kit; falls back to
   * "Freighter" when only the legacy freighterApi is present, and "Wallet"
   * as a generic catch-all.  Closes #584 (hardcoded "(Freighter)" label).
   */
  function connectedWalletLabel() {
    if (swkReady && StellarWalletsKit && typeof StellarWalletsKit.getWalletName === "function") {
      try {
        var name = StellarWalletsKit.getWalletName();
        if (name && name.length > 0) return name;
      } catch (e) {}
    }
    var freighter = window.freighterApi || window.freighter;
    if (freighter && typeof freighter.getPublicKey === "function") return "Freighter";
    return "Wallet";
  }

  // ── API Client ──
  async function api(path, opts = {}) {
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    if (window.__sessionToken) headers.Authorization = "Bearer " + window.__sessionToken;
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (networkErr) {
      var networkMsg = "Network error — could not reach the server";
      var networkError = new Error(networkMsg);
      if (!opts._silent) notifyError(networkError);
      throw networkError;
    }
    var responseText = "";
    try {
      responseText = await res.text();
    } catch (readError) {
      var readErrorMessage = "The server response could not be read.";
      var readResponseError = new Error(readErrorMessage);
      readResponseError.technicalDetails = res.status + " " + res.statusText;
      if (!opts._silent) notifyError(readResponseError);
      throw readResponseError;
    }
    var data;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        var responseMsg = "The server returned an invalid response.";
        var responseError = new Error(responseMsg);
        responseError.technicalDetails = res.status + " " + res.statusText + (responseText ? "\n" + responseText : "");
        if (!opts._silent) notifyError(responseError);
        throw responseError;
      }
    }
    if (!res.ok) {
      var rawError = data && data.error ? data.error : responseText || "Request failed (" + res.status + ")";
      var apiError = new Error(formatSorobanError(rawError));
      apiError.technicalDetails = responseText || getTechnicalDetails(rawError);
      if (!opts._silent) notifyError(apiError);
      throw apiError;
    }
    return data == null ? {} : data;
  }

  var authPromise = null;
  async function ensureSession() {
    if (!wallet.connected || !wallet.publicKey || window.__sessionToken) return;
    if (wallet.network === "mainnet") {
      throw new Error("Dashboard authentication is disabled for Mainnet wallets");
    }
    if (authPromise) return authPromise;
    authPromise = (async function () {
      const challenge = await api(
        "/auth/challenge?publicKey=" + encodeURIComponent(wallet.publicKey),
      );
      const signed = await signWalletTransaction(challenge.xdr);
      const verified = await api("/auth/verify", {
        method: "POST",
        body: { publicKey: wallet.publicKey, nonce: challenge.nonce, signedXdr: signed },
      });
      window.__sessionToken = verified.token;
    })();
    try {
      await authPromise;
    } finally {
      authPromise = null;
    }
  }

  async function signWalletTransaction(txXdr) {
    const freighter = window.freighterApi || window.freighter;
    if (freighter && typeof freighter.signTransaction === "function") {
      const result = await freighter.signTransaction(txXdr);
      return (
        result.signedTransaction ||
        result.signedTx ||
        result.signedTxXdr ||
        result.signedXdr ||
        result
      );
    }
    if (!swkReady) throw new Error("Stellar Wallet Kit not loaded");
    const addressResult = await StellarWalletsKit.getAddress();
    const result = await StellarWalletsKit.signTransaction(txXdr, {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: addressResult.address,
    });
    return result.signedTxXdr;
  }

  // ── Helpers ──
  function truncAddr(addr) {
    if (!addr) return "\u2014";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return escapeHtml(String(str == null ? "" : str))
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatMusd(raw) {
    if (!raw) return "0.00";
    if (String(raw).includes(".")) return parseFloat(raw).toFixed(2);
    const val = BigInt(raw);
    const whole = val / 10000000n;
    const frac = Number(val % 10000000n) / 10000000;
    return (Number(whole) + frac).toFixed(2);
  }

  // ── Status tooltip descriptions (#466) ──
  const STATUS_TOOLTIPS = {
    Open:      "Job created but not yet funded — awaiting escrow deposit.",
    Funded:    "Escrow deposit received; waiting for the provider to submit a deliverable.",
    Submitted: "Provider has submitted a deliverable URI; waiting for evaluator approval.",
    Completed: "Evaluator approved the deliverable and funds have been released to the provider.",
    Rejected:  "Evaluator rejected the deliverable (reserved for future dispute resolution).",
    Cancelled: "Job was cancelled by the client or timed out; budget has been refunded.",
    Disputed:  "Client opened a dispute on the submitted deliverable; evaluator must resolve.",
  };

  function statusBadge(status) {
    const safe = escapeHtml(status);
    const tip = escapeHtml(STATUS_TOOLTIPS[status] || status);
    return (
      '<span class="status-badge status-' + safe + '" title="' + tip + '"><span class="dot"></span>' + safe + "</span>"
    );
  }

  // ── Identicon generator (#468) ──
  // Generates a deterministic 5×5 symmetric SVG identicon from a Stellar public key.
  function agentIdenticon(pubkey) {
    if (!pubkey || pubkey.length < 10) {
      return '<div class="agent-avatar">?</div>';
    }
    // Derive a numeric seed from the key characters
    var seed = 0;
    for (var i = 0; i < pubkey.length; i++) {
      seed = (seed * 31 + pubkey.charCodeAt(i)) >>> 0;
    }
    // Simple seeded PRNG (xorshift32)
    function rand() {
      seed ^= seed << 13;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed = seed >>> 0;
      return seed;
    }
    // Pick a hue from the key
    var hue = rand() % 360;
    var color = "hsl(" + hue + ",60%,65%)";
    var bg = "hsl(" + hue + ",30%,15%)";
    // Build 5×5 symmetric grid (only fill left 3 columns, mirror to right)
    var cells = [];
    for (var r = 0; r < 5; r++) {
      for (var c = 0; c < 3; c++) {
        cells.push(rand() % 2 === 1);
      }
    }
    var size = 40;
    var cell = size / 5;
    var rects = "";
    for (var row = 0; row < 5; row++) {
      for (var col = 0; col < 5; col++) {
        var srcCol = col < 3 ? col : 4 - col;
        if (cells[row * 3 + srcCol]) {
          rects += '<rect x="' + (col * cell) + '" y="' + (row * cell) + '" width="' + cell + '" height="' + cell + '" fill="' + color + '"/>';
        }
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="border-radius:8px;display:block">'
      + '<rect width="' + size + '" height="' + size + '" fill="' + bg + '"/>'
      + rects
      + '</svg>';
    return '<div class="agent-avatar agent-avatar-svg" title="' + escapeHtml(pubkey) + '">' + svg + '</div>';
  }
  // ── Toast container — resolved from DOM once on first call ──
  var container = document.getElementById("toasts");

  function toast(msg, type = "success", duration = null, details = "") {
    if (!container) container = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    var msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    el.appendChild(msgSpan);

    if (details) {
      var detailsEl = document.createElement("details");
      detailsEl.className = "toast-details";
      var detailsSummary = document.createElement("summary");
      detailsSummary.textContent = "View Technical Details";
      var detailsText = document.createElement("pre");
      detailsText.textContent = details;
      detailsEl.appendChild(detailsSummary);
      detailsEl.appendChild(detailsText);
      el.appendChild(detailsEl);
    }

    var closeBtn = document.createElement("span");
    closeBtn.className = "toast-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Dismiss");
    el.appendChild(closeBtn);

    function dismiss() {
      el.style.animation = "toast-out 0.25s ease-in forwards";
      setTimeout(function () { el.remove(); }, 260);
    }
    closeBtn.addEventListener("click", dismiss);

    container.appendChild(el);
    var autoDismiss = duration == null ? 4000 : duration;
    setTimeout(dismiss, autoDismiss);
  }

  function errorText(error) {
    if (error == null) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (typeof error === "object") {
      if (typeof error.error === "string") return error.error;
      if (typeof error.message === "string") return error.message;
      try {
        return JSON.stringify(error);
      } catch (e) {
        return String(error);
      }
    }
    return String(error);
  }

  function extractSorobanCode(text) {
    var match = text.match(/(?:HostError|Error)\s*\(?\s*Contract\s*,\s*#?\s*(\d+)/i);
    if (match) return Number(match[1]);
    match = text.match(/contract(?:[_ ]error)?\s*(?:code)?\s*[:#]\s*(\d+)/i);
    if (match) return Number(match[1]);
    return null;
  }

  function formatSorobanError(error) {
    var text = errorText(error);
    if (!text) return "Transaction failed. Try again or view technical details.";
    var code = extractSorobanCode(text);
    var messages = {
      1: "The client and provider must be different accounts.",
      2: "The provider and evaluator must be different accounts.",
      3: "The contract is paused. Please try again later.",
      4: "This job is not in a valid status for this action.",
      5: "The requested job could not be found.",
    };
    if (code != null && messages[code]) return messages[code];
    if (/self[\s_-]*escrow/i.test(text)) return messages[1];
    if (/invalid[\s_-]*(parties|addresses?|participants?)/i.test(text)) return messages[2];
    if (/\bcontract[\s_-]*paused\b|\bpaused\b/i.test(text)) return messages[3];
    if (/invalid[\s_-]*status/i.test(text)) return messages[4];
    if (/job[\s_-]*not[\s_-]*found|unknown[\s_-]*job/i.test(text)) return messages[5];
    if (/(tx failed|submit failed|simulation error|hosterror|host error|contract error|xdr)/i.test(text)) {
      return "Transaction failed. Try again or view technical details.";
    }
    return text;
  }

  function getTechnicalDetails(error) {
    if (error && typeof error.technicalDetails === "string") return error.technicalDetails;
    if (error && typeof error.raw === "string") return error.raw;
    if (error && error.details != null) {
      try {
        return JSON.stringify(error.details, null, 2);
      } catch (e) {}
    }
    if (error && error.data != null) {
      try {
        return JSON.stringify(error.data, null, 2);
      } catch (e) {}
    }
    return errorText(error);
  }

  function notifyError(error) {
    if (error && error.__dashboardNotified) return;
    toast(formatSorobanError(error), "error", null, getTechnicalDetails(error));
    if (error && typeof error === "object") error.__dashboardNotified = true;
  }

  // Public alias required by the issue spec
  window.showToast = toast;
  window.__formatSorobanError = formatSorobanError;

  // ── Transaction Overlay ──
  function showTxOverlay(text) {
    const overlay = document.getElementById("tx-overlay");
    const modal = overlay.querySelector(".tx-modal");
    modal.innerHTML =
      '<div class="tx-spinner"></div><div class="tx-text">' +
      escapeHtml(text || "Submitting to Stellar...") +
      "</div>";
    overlay.classList.add("active");
  }
  function hideTxOverlay() {
    document.getElementById("tx-overlay").classList.remove("active");
  }

  // ── Copy to clipboard ──
  async function copyToClipboard(text, source) {
    var value = String(text == null ? "" : text);
    if (!value) return false;
    var copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (e) {}
    if (!copied) {
      var ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand("copy");
      } catch (e) {}
      ta.remove();
    }
    if (!copied) {
      toast("Could not copy to clipboard", "error");
      return false;
    }
    if (source) {
      if (!source.__copyIcon) {
        source.__copyIcon = source.innerHTML;
        source.__copyLabel = source.getAttribute("aria-label") || "Copy to clipboard";
        source.__copyTitle = source.title;
      }
      source.classList.add("copied");
      source.setAttribute("aria-label", "Copied!");
      source.title = "Copied!";
      source.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l4 4L19 6"/></svg>';
      clearTimeout(source.__copyResetTimer);
      source.__copyResetTimer = setTimeout(function () {
        source.classList.remove("copied");
        source.setAttribute("aria-label", source.__copyLabel);
        source.title = source.__copyTitle;
        source.innerHTML = source.__copyIcon;
      }, 2000);
    }
    toast("Copied!", "success", 2000);
    return true;
  }

  function copyBtn(value, label) {
    if (value == null || String(value) === "") return "";
    var safe = escapeAttr(String(value));
    var safeLabel = escapeAttr(label || "value");
    return (
      '<button type="button" class="copy-btn" data-copy-value="' +
      safe +
      '" aria-label="Copy ' +
      safeLabel +
      '" title="Copy ' +
      safeLabel +
      '" onclick="event.stopPropagation()">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
      "</svg></button>"
    );
  }

  function copyable(value, label, display) {
    if (value == null || String(value) === "") return "";
    var text = String(value);
    var visible = display == null ? truncAddr(text) : String(display);
    return (
      '<span class="copyable-value" title="' +
      escapeAttr(text) +
      '">' +
      escapeHtml(visible) +
      "</span>" +
      copyBtn(text, label)
    );
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("[data-copy-value]") : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    copyToClipboard(target.getAttribute("data-copy-value"), target);
  }, true);


  /**
   * Returns a human-readable relative time string (e.g. "2 hours ago") for a
   * Unix timestamp (seconds).  Falls back to an absolute ISO date string when
   * the Intl.RelativeTimeFormat API is unavailable.
   * Closes #584 (missing helper that caused ReferenceError on render).
   */
  function formatRelativeTime(unixSeconds) {
    if (!unixSeconds) return "—";
    var ts = Number(unixSeconds) * 1000;
    if (!Number.isFinite(ts)) return "—";
    var diffMs = Date.now() - ts;
    var diffSec = Math.round(diffMs / 1000);
    var diffMin = Math.round(diffSec / 60);
    var diffHr  = Math.round(diffMin / 60);
    var diffDay = Math.round(diffHr  / 24);

    if (typeof Intl !== "undefined" && Intl.RelativeTimeFormat) {
      var rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      if (Math.abs(diffSec) < 60)  return rtf.format(-diffSec, "second");
      if (Math.abs(diffMin) < 60)  return rtf.format(-diffMin, "minute");
      if (Math.abs(diffHr)  < 24)  return rtf.format(-diffHr,  "hour");
      if (Math.abs(diffDay) < 30)  return rtf.format(-diffDay, "day");
    }
    return new Date(ts).toLocaleDateString();
  }

  // ── Modal ──
  function showModal(contentHtml) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = contentHtml; // Safe: only called with our own static template strings
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  // ── Skeleton Loaders (#582) ──
  function skeletonCards(n) {
    let html = '<div class="stat-grid">';
    for (let i = 0; i < (n || 4); i++) {
      html +=
        '<div class="skeleton-card"><div class="skeleton skeleton-lg"></div><div class="skeleton skeleton-line w60"></div></div>';
    }
    return html + "</div>";
  }
  function skeletonList(n) {
    let html = "";
    for (let i = 0; i < (n || 3); i++) {
      html +=
        '<div class="skeleton-card skeleton-job-row">' +
        '<div class="skeleton skeleton-line w40" style="margin-bottom:8px"></div>' +
        '<div class="skeleton skeleton-line w80"></div>' +
        '</div>';
    }
    return html;
  }
  // Skeleton grid for agent cards (#582)
  function skeletonAgentCards(n) {
    let html = '<div class="agent-grid">';
    for (let i = 0; i < (n || 4); i++) {
      html +=
        '<div class="skeleton-card skeleton-agent-card">' +
        '<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">' +
        '<div class="skeleton" style="width:40px;height:40px;border-radius:10px;flex-shrink:0"></div>' +
        '<div class="skeleton skeleton-line w60" style="margin:0"></div>' +
        '</div>' +
        '<div class="skeleton skeleton-line w80"></div>' +
        '<div class="skeleton skeleton-line w60"></div>' +
        '</div>';
    }
    return html + "</div>";
  }

  // ── Safe DOM render helper ──
  function setPage(html) {
    // All HTML is constructed from trusted sources (our API responses contain
    // only Stellar addresses and contract state, not user-generated content)
    document.getElementById("page").innerHTML = html;
  }

  // ── Deliverable Validation (#730) ──
  // The backend DeliverableValidator inspects each deliverable URI and returns
  // a validation object alongside the job.  We surface warnings as badges and
  // rejected deliverables as error toasts so evaluators are never exposed to
  // malicious payloads without a visible warning.
  //
  // Expected shape (all fields optional / defensive):
  //   job.deliverableValidation = {
  //     status: "valid" | "warning" | "rejected",
  //     warnings: [{ code, message }],
  //     reason: "string"
  //   }
  function getDeliverableValidation(job) {
    if (!job) return null;
    var v = job.deliverableValidation || job.deliverable_validation || null;
    if (!v || typeof v !== "object") return null;
    return v;
  }

  function normalizeWarnings(validation) {
    if (!validation) return [];
    var raw = validation.warnings;
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (w == null) continue;
      if (typeof w === "string") {
        out.push({ code: "", message: w });
      } else if (typeof w === "object") {
        out.push({
          code: w.code == null ? "" : String(w.code),
          message: w.message == null ? String(w.code || "Suspicious deliverable