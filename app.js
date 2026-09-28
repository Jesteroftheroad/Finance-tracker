(() => {
  const cfg = window.FT_CONFIG || {};
  const { computeMonths, computeTotals, computeInvestable, parseMoney, monthIndex, MIN_EXPENSE_MONTHS } = window.FTCalc;
  const $ = (id) => document.getElementById(id);

  // ---------- formatting ----------
  const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
  const cad0 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
  const fmt = (n) => (n === null || n === undefined ? "n/a" : cad.format(n));
  const fmt0 = (n) => (n === null || n === undefined ? "n/a" : cad0.format(n));
  const pct = (r) => (r === null || r === undefined ? "n/a" : `${Math.round(r * 100)}%`);
  const compact = (v) => {
    const a = Math.abs(v);
    const s = a >= 1e6 ? `${+(a / 1e6).toFixed(1)}M` : a >= 1000 ? `${+(a / 1000).toFixed(a % 1000 ? 1 : 0)}k` : `${Math.round(a)}`;
    return `${v < 0 ? "−" : ""}$${s}`;
  };
  const monthLabel = (m, long) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-CA", { month: long ? "long" : "short", year: "numeric" });
  };
  const monthShort = (m) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-CA", { month: "short" });
  };
  const thisMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // ---------- state ----------
  const DEFAULT_SETTINGS = {
    emergency_mode: "auto", emergency_multiplier: 3, emergency_fixed: null, reserve_cards: false, card_limits: {},
  };
  let sb = null;
  let user = null;
  let rows = [];        // months rows from Supabase
  let buckets = [];     // bucket rows
  let settings = { ...DEFAULT_SETTINGS };
  let months = [];      // computed, oldest → newest
  let editingId = null;
  let editingBucketId = null;
  let activeTab = "overview";
  let loaded = false;   // true once we have data (cache or network)
  let animateNext = true; // entrance + count-up on the next render only
  const charts = {};

  // ---------- greeting ----------
  function paintGreeting() {
    const h = new Date().getHours();
    const g = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    $("greeting").textContent = g;
    $("login-greeting").textContent = g;
    $("today").textContent = new Date().toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
  }
  paintGreeting();

  // ---------- theme: dark by default, per-device choice ----------
  const isLight = () => document.documentElement.dataset.theme === "light";
  function paintThemeButton() {
    const btn = $("theme-btn");
    btn.innerHTML = icon(isLight() ? "moon" : "sun");
    btn.setAttribute("aria-label", isLight() ? "Switch to dark mode" : "Switch to light mode");
    document.querySelector('meta[name="theme-color"]').content = isLight() ? "#f6f6f7" : "#0a0a0a";
  }
  $("theme-btn").addEventListener("click", () => {
    if (isLight()) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = "light";
    store.set("ft-theme", isLight() ? "light" : "dark");
    paintThemeButton();
    renderCharts(); // Chart.js doesn't follow CSS variables; redraw with the new palette
  });
  paintThemeButton();

  // Keep the sticky summary strip just under the (variable-height) top bar.
  const topbar = document.querySelector(".topbar");
  const syncTopbarHeight = () =>
    document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  window.addEventListener("resize", syncTopbarHeight);

  // ---------- views ----------
  function show(view) {
    for (const v of ["setup-view", "login-view", "app-view"]) $(v).hidden = v !== view;
    if (view === "app-view") requestAnimationFrame(syncTopbarHeight);
  }

  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("YOUR-");

  if (!configured || !window.supabase) {
    show("setup-view");
    return;
  }

  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------- auth ----------
  function loginMsg(text, kind = "") {
    const el = $("login-msg");
    el.textContent = text;
    el.className = "msg " + kind;
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) return loginMsg("Enter your email and password.", "error");
    loginMsg("Signing in…");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) loginMsg(error.message, "error");
  });

  $("magic-link-btn").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    if (!email) return loginMsg("Enter your email first.", "error");
    loginMsg("Sending link…");
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) loginMsg(error.message, "error");
    else loginMsg("Check your email for the sign-in link.", "ok");
  });

  $("signout-btn").addEventListener("click", async () => {
    if (confirm("Sign out on this device?")) await sb.auth.signOut();
  });

  sb.auth.onAuthStateChange((_event, session) => {
    const next = session?.user || null;
    if (next?.id === user?.id) return;
    user = next;
    if (user) {
      show("app-view");
      loaded = false;
      animateNext = true;
      loadFromCache();
      render();
      setTimeout(refresh, 0); // don't call Supabase inside the auth callback itself
    } else {
      rows = []; buckets = []; settings = { ...DEFAULT_SETTINGS };
      show("login-view");
    }
  });

  // ---------- data: Supabase is the source of truth, localStorage is an offline cache ----------
  const cacheKey = () => `ft-cache-${user.id}`;

  function loadFromCache() {
    try {
      const cached = JSON.parse(store.get(cacheKey()) || "null");
      if (!cached) return;
      rows = cached.rows || [];
      buckets = cached.buckets || [];
      settings = { ...DEFAULT_SETTINGS, ...(cached.settings || {}) };
      loaded = true;
      setStatus(`Cached ${new Date(cached.at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`, "");
    } catch { /* ignore */ }
  }

  function saveCache() {
    store.set(cacheKey(), JSON.stringify({ at: Date.now(), rows, buckets, settings }));
  }

  function setStatus(text, state) {
    $("sync-status").textContent = text;
    $("sync-dot").className = `sync-dot ${state || ""}`;
  }

  let refreshing = false;
  let migrationMissing = false;
  async function refresh() {
    if (!user || refreshing) return;
    refreshing = true;
    setStatus("Syncing", "busy");
    const [m, b, s] = await Promise.all([
      sb.from("months").select("*").order("month"),
      sb.from("buckets").select("*").order("created_at"),
      sb.from("settings").select("*").maybeSingle(),
    ]);
    refreshing = false;
    if (m.error) {
      setStatus(navigator.onLine ? `Sync failed: ${m.error.message}` : "Offline · cached data", "err");
      loaded = true;
      render();
      return;
    }
    rows = m.data;
    // buckets/settings tables come from migration 002; keep working without them.
    migrationMissing = !!(b.error || s.error);
    if (!b.error) buckets = b.data;
    if (!s.error) settings = { ...DEFAULT_SETTINGS, ...(s.data || {}) };
    saveCache();
    setStatus(migrationMissing
      ? "Run migration 002 to enable buckets & settings"
      : `Synced ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`,
    migrationMissing ? "err" : "ok");
    if (!loaded) animateNext = true;
    loaded = true;
    render();
  }

  // Pick up changes made on other devices whenever you come back to the app.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { paintGreeting(); refresh(); }
  });
  window.addEventListener("online", refresh);

  function offlineOr(error, what) {
    return navigator.onLine ? `Couldn’t ${what}: ${error.message}` : `You’re offline. ${what[0].toUpperCase() + what.slice(1)} needs a connection so every device stays in sync.`;
  }

  async function saveSettings(patch) {
    const prev = settings;
    settings = { ...settings, ...patch };
    render();
    const { user_id, updated_at, ...rest } = settings;
    const { data, error } = await sb.from("settings")
      .upsert({ ...rest, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .select().single();
    if (error) {
      settings = prev;
      render();
      alert(offlineOr(error, "save settings"));
      return false;
    }
    settings = { ...DEFAULT_SETTINGS, ...data };
    saveCache();
    return true;
  }

  // ---------- tabs ----------
  const TABS = ["overview", "investable", "cards", "trends"];
  function setTab(tab, push = true) {
    if (!TABS.includes(tab)) tab = "overview";
    const changed = tab !== activeTab;
    activeTab = tab;
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    store.set("ft-tab", tab);
    if (push && location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    if (changed) animateNext = true;
    render();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.tabIndex = 0;
    el.setAttribute("role", "link");
    const go = () => setTab(el.dataset.goto);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1), false));
  activeTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get("ft-tab") || "overview";
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)));

  // ---------- motion helpers ----------
  // Count a number up from its previous value (or 0) — only on entrance, never on routine syncs.
  function setNum(id, value, format = fmt, cls) {
    const el = $(id);
    el.classList.remove("pos", "neg", "warn");
    if (cls) el.classList.add(cls);
    if (value === null || value === undefined || Number.isNaN(value)) {
      el.textContent = "n/a";
      el._v = null;
      return;
    }
    const from = el._v ?? 0;
    el._v = value;
    cancelAnimationFrame(el._raf);
    if (!animateNext || reducedMotion.matches || from === value) {
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    const dur = 700;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (value - from) * e);
      if (t < 1) el._raf = requestAnimationFrame(tick);
      else el.textContent = format(value);
    };
    el._raf = requestAnimationFrame(tick);
  }

  function setText(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.classList.remove("pos", "neg", "warn");
    if (cls) el.classList.add(cls);
  }

  // Staggered fade + slide-up for the cards of the panel that just appeared.
  function playEntrance(panel) {
    if (reducedMotion.matches) return;
    const blocks = panel.querySelectorAll(":scope > .card, :scope > .strip, :scope > .feed > .card");
    blocks.forEach((el, i) => {
      el.classList.remove("enter");
      void el.offsetWidth; // restart the animation
      el.style.setProperty("--i", i);
      el.classList.add("enter");
      el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
    });
  }

  // ---------- badges & sparklines ----------
  // Change badge: pill, tinted by whether the move is good, always with an arrow (never color alone).
  function setBadge(id, cur, prev, { upIsGood = true, mode = "pct" } = {}) {
    const el = $(id);
    el.className = "badge";
    el.removeAttribute("title");
    if (cur === null || cur === undefined || prev === null || prev === undefined) { el.textContent = ""; return; }
    let delta;
    let text;
    if (mode === "pts") {
      delta = Math.round((cur - prev) * 100);
      text = `${Math.abs(delta)} pts`;
    } else {
      if (prev === 0) { el.textContent = ""; return; }
      delta = ((cur - prev) / Math.abs(prev)) * 100;
      const a = Math.abs(delta);
      text = `${a >= 100 ? Math.round(a) : a.toFixed(1)}%`;
    }
    if (Math.abs(delta) < 0.05) {
      el.textContent = "0%";
      return;
    }
    const up = delta > 0;
    el.textContent = `${up ? "↑" : "↓"} ${text}`;
    el.classList.add(up === upIsGood ? "good" : "bad");
    el.title = `${up ? "Up" : "Down"} ${text} vs last month`;
  }

  let sparkSeq = 0;
  // Tiny inline-SVG trend line with a soft area fill and a dot on the latest point.
  function sparkline(id, values, color = "var(--text)") {
    const el = typeof id === "string" ? $(id) : id;
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v));
    if (pts.length < 2) { el.innerHTML = ""; return; }
    // Size to the space the layout gives us, so it never overlaps its neighbours.
    const W = Math.max(24, Math.round(el.clientWidth) || (el.classList.contains("lg") ? 120 : 56));
    const H = Math.max(12, Math.round(el.clientHeight) || (el.classList.contains("lg") ? 44 : 22));
    const pad = 3;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - pad * 2);
    const sy = (y) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - pad * 2);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
    const area = `${line}L${sx(x1).toFixed(1)},${H}L${sx(x0).toFixed(1)},${H}Z`;
    const [lx, ly] = pts[pts.length - 1];
    const gid = `sg${++sparkSeq}`;
    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" style="stop-color:${color};stop-opacity:.28"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/>` +
      `</linearGradient></defs>` +
      `<path d="${area}" fill="url(#${gid})"/>` +
      `<path d="${line}" fill="none" style="stroke:${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${sx(lx).toFixed(1)}" cy="${sy(ly).toFixed(1)}" r="2.5" style="fill:${color}"/></svg>`;
  }

  // ---------- render ----------
  function render() {
    months = computeMonths(rows);
    const has = months.length > 0;
    $("loading-state").hidden = loaded || has;
    $("empty-state").hidden = !loaded || has;
    let shown = null;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = !has || p.dataset.panel !== activeTab;
      if (!p.hidden) shown = p;
    });
    if (!has) return;
    if (activeTab === "overview") renderOverview();
    if (activeTab === "investable") renderInvestable();
    if (activeTab === "cards") renderCards();
    if (activeTab === "trends") renderTrends();
    renderCharts();
    if (animateNext && shown) playEntrance(shown);
    animateNext = false;
    requestAnimationFrame(syncTopbarHeight);
  }

  const series = (key) => months.map((m) => m[key]);
  const toneOf = (n) => (n === null || n === undefined ? "" : n >= 0 ? "pos" : "neg");

  function renderOverview() {
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];

    setNum("ov-networth", cur.netWorth);
    setBadge("ov-networth-badge", cur.netWorth, prev?.netWorth);
    if (prev) {
      const d = cur.netWorth - prev.netWorth;
      $("ov-networth-sub").textContent = `${monthLabel(cur.month, true)} · ${d >= 0 ? "+" : "−"}${fmt0(Math.abs(d))} vs ${monthShort(prev.month)}`;
    } else $("ov-networth-sub").textContent = monthLabel(cur.month, true);

    setNum("ov-income", cur.income, fmt0);
    setBadge("ov-income-badge", cur.income, prev?.income);
    sparkline("ov-income-spark", series("income"), "var(--income)");

    setNum("ov-expense", cur.expense, fmt0);
    setBadge("ov-expense-badge", cur.expense, prev?.expense, { upIsGood: false });
    sparkline("ov-expense-spark", series("expense"), "var(--expense)");

    setNum("ov-rate", cur.savingsRate, pct, toneOf(cur.savingsRate));
    setBadge("ov-rate-badge", cur.savingsRate, prev?.savingsRate, { mode: "pts" });
    sparkline("ov-rate-spark", series("savingsRate"), "var(--income)");

    setNum("ov-savings", cur.savings, fmt, toneOf(cur.savings));
    setBadge("ov-savings-badge", cur.savings, prev?.savings);
    sparkline("ov-savings-spark", series("savings"), cur.savings !== null && cur.savings < 0 ? "var(--expense)" : "var(--income)");
    $("ov-savings-sub").textContent = cur.savings === null
      ? "Needs a previous month to compare against"
      : `Change in bank minus cards since ${monthShort(prev.month)}${cur.gapMonths ? ` (covers ${cur.gapMonths + 1} months)` : ""}`;

    const t = computeTotals(months);
    setNum("t-income", t.totalIncome, fmt0);
    setNum("t-expense", t.expenseCount ? t.totalExpense : null, fmt0);
    setNum("t-saved", t.savingsCount ? t.totalSaved : null, fmt0, t.savingsCount ? toneOf(t.totalSaved) : "");
    setNum("t-avg", t.avgExpense, fmt0);
    $("totals-note").textContent =
      `${months.length} month${months.length === 1 ? "" : "s"} tracked · expense covers ${t.expenseCount}` +
      `${months.some((m) => m.income === null) ? " (months without income are skipped)" : ""}.`;

    renderTable();
  }

  function td(text, cls) {
    const el = document.createElement("td");
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function iconButton(name, label, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn icon ${cls || ""}`;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = icon(name);
    b.addEventListener("click", onClick);
    return b;
  }

  function renderTable() {
    const tbody = $("months-table").querySelector("tbody");
    tbody.replaceChildren();
    for (const m of [...months].reverse()) {
      const tr = document.createElement("tr");
      const first = td(monthLabel(m.month));
      if (m.gapMonths) {
        const flag = document.createElement("span");
        flag.className = "gap-flag";
        flag.textContent = `after ${m.gapMonths}-month gap`;
        first.appendChild(flag);
      }
      tr.append(
        first,
        td(fmt(m.income), m.income === null ? "na" : ""),
        td(fmt(m.cardTotal)),
        td(fmt(m.bankTotal)),
        td(fmt(m.wealthsimple)),
        td(fmt(m.expense), m.expense === null ? "na" : ""),
        td(fmt(m.savings), m.savings === null ? "na" : toneOf(m.savings)),
        td(fmt(m.netWorth)),
      );
      const cell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        iconButton("pencil", `Edit ${monthLabel(m.month)}`, "", () => openForm(m)),
        iconButton("trash", `Delete ${monthLabel(m.month)}`, "danger", () => deleteMonth(m)),
      );
      cell.appendChild(actions);
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
  }

  // ---------- investable ----------
  function renderInvestable() {
    const inv = computeInvestable(months, settings, buckets);
    const prevInv = months.length > 1 ? computeInvestable(months.slice(0, -1), settings, buckets) : null;

    setNum("inv-hero", inv.investable, fmt, inv.investable < 0 ? "neg" : "");
    setBadge("inv-hero-badge", inv.investable, prevInv?.investable);
    const parts = [];
    if (inv.cardReserve) parts.push("cards");
    parts.push(inv.emergency !== null ? "emergency fund" : "emergency fund (not set)");
    if (buckets.length) parts.push(`${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`);
    $("inv-hero-sub").textContent = inv.investable < 0
      ? `As of ${monthLabel(inv.month, true)} · short by ${fmt0(-inv.investable)} after ${parts.join(", ")}`
      : `As of ${monthLabel(inv.month, true)} · after ${parts.join(", ")}`;
    renderAllocation(inv);

    setNum("inv-cash", inv.cash, fmt0);
    setBadge("inv-cash-badge", inv.cash, prevInv?.cash);
    sparkline("inv-cash-spark", series("bankTotal"), "var(--text)");
    if (inv.runwayDays !== null) {
      setNum("inv-runway", inv.runwayDays, (v) => `${Math.round(v).toLocaleString("en-CA")} days`);
      $("inv-runway-sub").textContent = `≈ ${(inv.runwayDays / 30.44).toFixed(1)} mo at ${fmt0(inv.avgExpense)}`;
    } else {
      setNum("inv-runway", null);
      $("inv-runway-sub").textContent = "needs expense data";
    }
    if (inv.emergency) {
      const r = inv.emergencyFunded / inv.emergency;
      setNum("inv-ef-pct", r, pct, r >= 1 ? "pos" : r < 0.5 ? "warn" : "");
    } else setNum("inv-ef-pct", null);

    $("reserve-cards").checked = !!settings.reserve_cards;
    $("reserve-cards").disabled = migrationMissing;
    $("reserve-cards-amt").textContent = fmt0(inv.cards);

    // Emergency fund
    const mode = settings.emergency_mode === "fixed" ? "fixed" : "auto";
    const mult = Number(settings.emergency_multiplier) || 3;
    document.querySelectorAll("#ef-mode button").forEach((b) => {
      const on = b.dataset.mode === "fixed" ? mode === "fixed" : mode === "auto" && Number(b.dataset.mult) === mult;
      b.setAttribute("aria-checked", String(on));
      b.disabled = migrationMissing;
    });
    const showFixed = mode === "fixed" || (!inv.canAuto && inv.emergency === null);
    $("ef-fixed-form").hidden = !showFixed || migrationMissing;
    if (document.activeElement !== $("ef-fixed")) $("ef-fixed").value = settings.emergency_fixed ?? "";

    $("ef-source").textContent = { auto: `${inv.multiplier}× avg expense`, fixed: "Fixed amount", none: "Not set" }[inv.emergencySource];
    const bar = $("ef-bar");
    if (inv.emergency !== null) {
      const ratio = inv.emergency > 0 ? inv.emergencyFunded / inv.emergency : 1;
      setNum("ef-funded", inv.emergencyFunded, fmt0);
      $("ef-target").textContent = `of ${fmt0(inv.emergency)}`;
      bar.style.width = `${Math.min(100, ratio * 100)}%`;
      bar.className = `progress-fill ${ratio >= 1 ? "good" : ratio < 0.5 ? "warn" : ""}`;
    } else {
      setText("ef-funded", "No target yet");
      $("ef-target").textContent = "";
      bar.style.width = "0";
    }
    let note;
    if (migrationMissing) note = "Run migrations/002_investable_cards.sql in Supabase to save these settings.";
    else if (!inv.canAuto) {
      const need = MIN_EXPENSE_MONTHS - inv.expenseCount;
      note = `Auto-suggest needs ${MIN_EXPENSE_MONTHS} months of expense (${need > 0 ? `${need} more` : "a positive average"}). Type a target for now.`;
    } else if (mode === "fixed") note = `Auto-suggestion would be ${fmt0(inv.autoSuggestion)} (${mult}× your ${fmt0(inv.avgExpense)} average).`;
    else note = `${mult}× your ${fmt0(inv.avgExpense)} average monthly expense. Updates as you add months.`;
    $("ef-note").textContent = note;

    renderBuckets(inv);
  }

  // One horizontal bar: where every dollar of cash is assigned.
  function renderAllocation(inv) {
    const segs = [];
    if (inv.cardReserve) segs.push(["Cards", inv.cardReserve, "color-mix(in srgb, var(--text) 18%, transparent)"]);
    if (inv.emergency) segs.push(["Emergency", inv.emergency, "color-mix(in srgb, var(--text) 55%, transparent)"]);
    if (inv.bucketTotal) segs.push(["Buckets", inv.bucketTotal, "color-mix(in srgb, var(--text) 32%, transparent)"]);
    if (inv.investable > 0) segs.push(["Investable", inv.investable, "var(--income)"]);
    else if (inv.investable < 0) segs.push(["Short", -inv.investable, "var(--expense)"]);
    $("inv-alloc").innerHTML = segs.map(([, v, c]) => `<span style="flex-grow:${v};background:${c}"></span>`).join("");
    $("inv-alloc-legend").innerHTML = segs
      .map(([k, v, c]) => `<span class="key" style="--c:${c}"><i class="swatch" style="background:${c}"></i>${k}<b>${fmt0(v)}</b></span>`)
      .join("");
  }

  $("reserve-cards").addEventListener("change", (e) => saveSettings({ reserve_cards: e.target.checked }));

  document.querySelectorAll("#ef-mode button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === "fixed") {
      settings = { ...settings, emergency_mode: "fixed" };
      render();
      $("ef-fixed").focus();
      if (settings.emergency_fixed !== null && settings.emergency_fixed !== undefined) saveSettings({ emergency_mode: "fixed" });
    } else {
      saveSettings({ emergency_mode: "auto", emergency_multiplier: Number(b.dataset.mult) });
    }
  }));

  $("ef-fixed-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = parseMoney($("ef-fixed").value);
    const msg = $("ef-msg");
    if (Number.isNaN(v) || v < 0) {
      msg.className = "msg error";
      msg.textContent = "Enter a positive amount, e.g. 15000.";
      return;
    }
    msg.textContent = "";
    $("ef-fixed").blur();
    await saveSettings({ emergency_mode: "fixed", emergency_fixed: v });
  });

  function renderBuckets(inv) {
    const list = $("bucket-list");
    list.replaceChildren();
    $("bucket-total").textContent = buckets.length ? `${fmt0(inv.bucketTotal)} total` : "";
    for (const b of inv.buckets) {
      const ratio = b.target > 0 ? b.funded / b.target : 1;
      const li = document.createElement("li");
      li.className = "item";

      const top = document.createElement("div");
      top.className = "item-top";
      const name = document.createElement("span");
      name.className = "item-name";
      const nm = document.createElement("span");
      nm.textContent = b.name;
      name.appendChild(nm);
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        iconButton("pencil", `Edit ${b.name}`, "", () => editBucket(b)),
        iconButton("trash", `Delete ${b.name}`, "danger", () => deleteBucket(b)),
      );
      top.append(name, actions);

      const mid = document.createElement("div");
      mid.className = "item-mid";
      const amt = document.createElement("span");
      amt.className = "item-amt num";
      amt.innerHTML = `${fmt0(b.funded)} <span class="faint">/ ${fmt0(b.target)}</span>`;
      const meta = document.createElement("span");
      meta.className = "item-meta";
      if (b.deadline) {
        const left = monthIndex(b.deadline) - monthIndex(thisMonth());
        meta.innerHTML = `${icon("calendar")}<span></span>`;
        meta.querySelector(".i").style.cssText = "width:14px;height:14px";
        meta.lastChild.textContent = `${monthShort(b.deadline)} ${b.deadline.slice(0, 4)} · ${left >= 0 ? `${left} mo left` : "past due"}`;
        if (left < 0 && ratio < 1) meta.classList.add("warn");
      }
      mid.append(amt, meta);

      const bar = document.createElement("div");
      bar.className = "progress";
      const fill = document.createElement("div");
      fill.className = `progress-fill ${ratio >= 1 ? "good" : ""}`;
      fill.style.width = `${Math.min(100, ratio * 100)}%`;
      bar.appendChild(fill);
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${Math.round(ratio * 100)}% covered by cash`);

      li.append(top, mid, bar);
      list.appendChild(li);
    }
  }

  function editBucket(b) {
    editingBucketId = b.id;
    $("b-name").value = b.name;
    $("b-target").value = b.target;
    $("b-deadline").value = b.deadline || "";
    $("b-save").textContent = "Save bucket";
    $("b-cancel").hidden = false;
    $("b-name").focus();
  }
  function resetBucketForm() {
    editingBucketId = null;
    $("bucket-form").reset();
    $("b-save").textContent = "Add";
    $("b-cancel").hidden = true;
    $("bucket-msg").textContent = "";
  }
  $("b-cancel").addEventListener("click", resetBucketForm);

  $("bucket-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("bucket-msg");
    msg.className = "msg error";
    const name = $("b-name").value.trim();
    const target = parseMoney($("b-target").value);
    const deadline = $("b-deadline").value.trim() || null;
    if (!name) return (msg.textContent = "Give the bucket a name.");
    if (Number.isNaN(target) || target < 0) return (msg.textContent = "Target must be a positive number, e.g. 1500.");
    if (deadline && !/^\d{4}-(0[1-9]|1[0-2])$/.test(deadline)) return (msg.textContent = "Deadline must look like 2026-10.");
    $("b-save").disabled = true;
    const payload = { name, target, deadline };
    const { data, error } = editingBucketId
      ? await sb.from("buckets").update(payload).eq("id", editingBucketId).select().single()
      : await sb.from("buckets").insert(payload).select().single();
    $("b-save").disabled = false;
    if (error) return (msg.textContent = offlineOr(error, "save the bucket"));
    buckets = buckets.filter((x) => x.id !== data.id).concat(data);
    saveCache();
    resetBucketForm();
    render();
  });

  async function deleteBucket(b) {
    if (!confirm(`Delete the “${b.name}” bucket?`)) return;
    const { error } = await sb.from("buckets").delete().eq("id", b.id);
    if (error) return alert(offlineOr(error, "delete the bucket"));
    buckets = buckets.filter((x) => x.id !== b.id);
    if (editingBucketId === b.id) resetBucketForm();
    saveCache();
    render();
  }

  // ---------- cards tab ----------
  function cardNames() {
    const names = [];
    for (const m of months) for (const c of m.cards || []) if (!names.includes(c.name)) names.push(c.name);
    return names;
  }
  // Monochrome shades per card (colour is reserved for data meaning); fixed by first appearance.
  const SHADES = [92, 58, 36, 22, 14, 8];
  const cardShade = (i) => `color-mix(in srgb, var(--text) ${SHADES[i % SHADES.length]}%, transparent)`;
  const cardBalance = (m, name) => {
    const c = (m.cards || []).find((x) => x.name === name);
    return c ? Number(c.balance) : null;
  };

  function renderCards() {
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];
    const limits = settings.card_limits || {};
    const names = cardNames();

    setNum("cd-total", cur.cardTotal);
    setBadge("cd-total-badge", cur.cardTotal, prev?.cardTotal, { upIsGood: false });
    if (prev) {
      const d = cur.cardTotal - prev.cardTotal;
      $("cd-total-sub").textContent = `${monthLabel(cur.month, true)} · ${d > 0 ? "+" : d < 0 ? "−" : ""}${fmt0(Math.abs(d))} vs ${monthShort(prev.month)}`;
    } else $("cd-total-sub").textContent = monthLabel(cur.month, true);
    $("cd-legend").innerHTML = names
      .map((n, i) => `<span class="key"><i class="swatch" style="background:${cardShade(i)}"></i><span></span></span>`)
      .join("");
    $("cd-legend").querySelectorAll(".key > span").forEach((s, i) => { s.textContent = names[i]; });

    const limited = cur.cards.filter((c) => Number(limits[c.name]) > 0);
    if (limited.length) {
      const bal = limited.reduce((t, c) => t + Math.max(0, Number(c.balance)), 0);
      const lim = limited.reduce((t, c) => t + Number(limits[c.name]), 0);
      setNum("cd-util", bal / lim, pct, bal / lim > 0.3 ? "warn" : "");
      $("cd-util-sub").textContent = `of ${compact(lim)} limit`;
    } else {
      setText("cd-util", "—");
      $("cd-util-sub").textContent = "add limits below";
    }
    const top = [...cur.cards].sort((a, b) => Number(b.balance) - Number(a.balance))[0];
    if (top) {
      setNum("cd-top", Number(top.balance), fmt0);
      $("cd-top-sub").textContent = top.name;
    } else { setNum("cd-top", null); $("cd-top-sub").textContent = ""; }
    setText("cd-count", String(cur.cards.length));
    $("cd-month").textContent = monthShort(cur.month) + " " + cur.month.slice(0, 4);

    const list = $("card-list");
    list.replaceChildren();
    cur.cards.forEach((c) => {
      const i = names.indexOf(c.name);
      const balance = Number(c.balance);
      const before = prev ? cardBalance(prev, c.name) : null;
      const li = document.createElement("li");
      li.className = "item";

      const topRow = document.createElement("div");
      topRow.className = "item-top";
      const name = document.createElement("span");
      name.className = "item-name";
      name.innerHTML = `<i class="swatch" style="background:${cardShade(i)}"></i><span></span>`;
      name.lastChild.textContent = c.name;
      const amt = document.createElement("span");
      amt.className = "item-amt num";
      amt.textContent = fmt(balance);
      topRow.append(name, amt);

      const mid = document.createElement("div");
      mid.className = "item-mid";
      const badge = document.createElement("span");
      badge.id = `cd-badge-${i}`;
      mid.appendChild(badge);
      const spark = document.createElement("span");
      spark.className = "spark";
      mid.appendChild(spark);
      li.append(topRow, mid);
      list.appendChild(li);
      if (before !== null) setBadge(badge.id, balance, before, { upIsGood: false });
      else { badge.className = "caption"; badge.textContent = "New this month"; }
      sparkline(spark, months.map((m) => cardBalance(m, c.name)), "var(--text-muted)");

      const limit = Number(limits[c.name]) || 0;
      if (limit > 0) {
        const ratio = Math.max(0, balance) / limit;
        const bar = document.createElement("div");
        bar.className = "progress";
        const fill = document.createElement("div");
        fill.className = `progress-fill ${ratio > 0.7 ? "bad" : ratio > 0.3 ? "warn" : ""}`;
        fill.style.width = `${Math.min(100, ratio * 100)}%`;
        bar.appendChild(fill);
        const u = document.createElement("div");
        u.className = "item-meta";
        u.style.marginTop = "8px";
        u.textContent = `${pct(ratio)} of ${fmt0(limit)} limit${ratio > 0.3 ? " · above 30%" : ""}`;
        if (ratio > 0.3) u.classList.add("warn");
        li.append(bar, u);
      }

      const row = document.createElement("div");
      row.className = "limit-row";
      const lbl = document.createElement("label");
      const inputId = `limit-${i}`;
      lbl.htmlFor = inputId;
      lbl.textContent = "Credit limit";
      const field = document.createElement("span");
      field.className = "money-field";
      field.innerHTML = "<span>$</span>";
      const input = document.createElement("input");
      input.type = "text";
      input.id = inputId;
      input.inputMode = "decimal";
      input.className = "money";
      input.placeholder = "Optional";
      input.autocomplete = "off";
      input.value = limit > 0 ? limit : "";
      input.disabled = migrationMissing;
      input.addEventListener("change", () => saveLimit(c.name, input));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      field.appendChild(input);
      row.append(lbl, field);
      li.appendChild(row);
    });
  }

  async function saveLimit(name, input) {
    const raw = input.value.trim();
    const limits = { ...(settings.card_limits || {}) };
    if (!raw) delete limits[name];
    else {
      const v = parseMoney(raw);
      if (Number.isNaN(v) || v <= 0) {
        input.classList.add("invalid");
        return;
      }
      limits[name] = v;
    }
    input.classList.remove("invalid");
    await saveSettings({ card_limits: limits });
  }

  // ---------- trends ----------
  function renderTrends() {
    const first = months[0];
    const cur = months[months.length - 1];
    if (months.length > 1) {
      const d = cur.netWorth - first.netWorth;
      $("tr-label").textContent = "Net worth growth";
      setNum("tr-change", d, (v) => `${v >= 0 ? "+" : "−"}${cad.format(Math.abs(v))}`, toneOf(d));
      setBadge("tr-badge", cur.netWorth, first.netWorth);
      $("tr-sub").textContent = `Since ${monthLabel(first.month, true)} · now ${fmt0(cur.netWorth)}`;
    } else {
      $("tr-label").textContent = "Net worth";
      setNum("tr-change", cur.netWorth);
      setBadge("tr-badge", null, null);
      $("tr-sub").textContent = "Growth appears once you add a second month";
    }
    $("avg3-note").textContent = months.some((m) => m.expenseAvg3 !== null)
      ? "Dotted: 3-month rolling average"
      : "Dotted 3-month average appears after 3 months of expense in a row";
  }

  // ---------- charts (Chart.js, one visual language everywhere) ----------
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Resolve any CSS color (incl. color-mix / var) to something canvas understands.
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolve = (color) => { probe.style.color = color; return getComputedStyle(probe).color; };
  const alpha = (color, a) => {
    const m = resolve(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return color;
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };
  const palette = () => ({
    text: cssVar("--text"), muted: cssVar("--text-muted"), faint: cssVar("--text-faint"),
    border: cssVar("--border"), surface2: cssVar("--surface-2"),
    income: cssVar("--income"), expense: cssVar("--expense"), warning: cssVar("--warning"),
  });

  // Direct label at the end of a line (dataset.endLabel = true).
  const endLabelPlugin = {
    id: "endLabel",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      chart.data.datasets.forEach((ds, di) => {
        if (!ds.endLabel || chart.getDatasetMeta(di).hidden) return;
        const pts = chart.getDatasetMeta(di).data;
        let k = ds.data.length - 1;
        while (k >= 0 && (ds.data[k] === null || ds.data[k] === undefined)) k--;
        if (k < 0) return;
        const p = pts[k];
        ctx.save();
        ctx.font = `600 11px ${cssVar("--font-ui")}`;
        ctx.fillStyle = ds.endLabelColor || ds.borderColor;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(ds.endLabel === true ? ds.label : ds.endLabel, p.x - 8, p.y - 10);
        ctx.restore();
      });
    },
  };
  // Value labels above bars (options.plugins.barValues.enabled).
  const barValuesPlugin = {
    id: "barValues",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.enabled) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = `700 11px ${cssVar("--font-num")}`;
      ctx.fillStyle = cssVar("--text-muted");
      ctx.textAlign = "center";
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        const label = opts.labels[i];
        if (!label) return;
        const top = Math.min(bar.y, bar.base);
        ctx.textBaseline = "bottom";
        ctx.fillText(label, bar.x, top - 6);
      });
      ctx.restore();
    },
  };
  if (window.Chart) {
    Chart.register(endLabelPlugin, barValuesPlugin);
  }

  function baseOptions({ percent = false, yAxis = true, xAxis = true } = {}) {
    const c = palette();
    Chart.defaults.font.family = cssVar("--font-ui");
    Chart.defaults.color = c.faint;
    const val = (v) => (v === null || v === undefined ? "n/a" : percent ? `${Math.round(v * 100)}%` : cad0.format(v));
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: animateNext && !reducedMotion.matches ? { duration: 500, easing: "easeOutCubic" } : false,
      animations: { x: { duration: 0 } },            // grow upward only; points never slide sideways
      transitions: { resize: { animation: { duration: 0 } } },
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 18, right: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.surface2,
          borderColor: c.border,
          borderWidth: 1,
          titleColor: c.muted,
          titleFont: { family: cssVar("--font-ui"), size: 12, weight: "500" },
          bodyColor: c.text,
          bodyFont: { family: cssVar("--font-num"), size: 13, weight: "700" },
          padding: 12,
          cornerRadius: 12,
          boxWidth: 8, boxHeight: 8, boxPadding: 6, usePointStyle: true,
          filter: (item) => !item.dataset.isRef || item.raw !== null,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}  ${val(Array.isArray(ctx.raw) ? ctx.raw[1] - ctx.raw[0] : ctx.raw)}`,
          },
        },
      },
      scales: {
        x: {
          display: xAxis,
          ticks: { color: c.faint, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 16 },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          display: yAxis,
          position: "right",
          ticks: {
            color: c.faint, font: { family: cssVar("--font-num"), size: 10, weight: "500" }, maxTicksLimit: 4, padding: 8,
            callback: (v) => (percent ? `${Math.round(v * 100)}%` : compact(v)),
          },
          grid: { color: c.border, drawTicks: false },
          border: { display: false, dash: [2, 4] },
        },
      },
    };
  }

  // Smooth line + gradient area; the latest point gets a filled dot with a halo ring.
  function areaLine(label, data, color, extra = {}) {
    let last = data.length - 1;
    while (last >= 0 && (data[last] === null || data[last] === undefined)) last--;
    const solid = resolve(color);
    return {
      label, data,
      borderColor: solid,
      borderWidth: 2,
      tension: 0.35,
      cubicInterpolationMode: "monotone",
      spanGaps: true,
      fill: "start",
      backgroundColor: (ctx) => {
        const area = ctx.chart.chartArea;
        if (!area) return "transparent";
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, alpha(solid, 0.22));
        g.addColorStop(1, alpha(solid, 0));
        return g;
      },
      pointRadius: (ctx) => (ctx.dataIndex === last ? 4 : 0),
      pointBackgroundColor: solid,
      pointBorderColor: alpha(solid, 0.25),
      pointBorderWidth: (ctx) => (ctx.dataIndex === last ? 8 : 0),
      pointHoverRadius: 5,
      pointHoverBorderWidth: 6,
      pointHoverBorderColor: alpha(solid, 0.25),
      pointStyle: "circle",
      order: 1,
      ...extra,
    };
  }
  // Dotted muted reference line, drawn behind the actual line.
  function refLine(label, data) {
    const c = palette();
    return {
      label, data, isRef: true,
      borderColor: c.muted,
      borderWidth: 1.5,
      borderDash: [2, 4],
      tension: 0.35,
      cubicInterpolationMode: "monotone",
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      spanGaps: true,
      order: 2,
    };
  }

  function drawChart(id, config) {
    if (!window.Chart) return;
    charts[id]?.destroy();
    charts[id] = new Chart($(id), config);
  }

  function renderCharts() {
    if (!months.length || !user || !window.Chart) return;
    const c = palette();
    const labels = months.map((m) => monthShort(m.month) + (months.length > 12 || m.month.endsWith("-01") ? ` ${m.month.slice(2, 4)}` : ""));
    const t = computeTotals(months);

    if (activeTab === "overview") {
      const heroOpts = baseOptions({ yAxis: false });
      heroOpts.layout.padding = { top: 12, left: 8, right: 8 };
      drawChart("chart-hero-worth", {
        type: "line",
        data: { labels, datasets: [areaLine("Net worth", series("netWorth"), c.text)] },
        options: heroOpts,
      });

      const flowOpts = baseOptions();
      drawChart("chart-flow", {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              type: "line", ...refLine("Avg expense", months.map(() => t.avgExpense)),
              order: 0,
            },
            {
              label: "Income", data: series("income"), backgroundColor: c.income,
              borderRadius: 6, borderSkipped: "start", categoryPercentage: 0.62, barPercentage: 0.82, maxBarThickness: 18, order: 1,
            },
            {
              label: "Expense", data: series("expense"), backgroundColor: c.expense,
              borderRadius: 6, borderSkipped: "start", categoryPercentage: 0.62, barPercentage: 0.82, maxBarThickness: 18, order: 1,
            },
          ],
        },
        options: flowOpts,
      });
    }

    if (activeTab === "investable") {
      const inv = computeInvestable(months, settings, buckets);
      const steps = [["Cash", inv.cash, "total"]];
      if (inv.cardReserve) steps.push(["Cards", -inv.cardReserve, "minus"]);
      steps.push(["Emergency", -(inv.emergency || 0), "minus"]);
      if (buckets.length) steps.push(["Buckets", -inv.bucketTotal, "minus"]);
      steps.push(["Investable", inv.investable, "total"]);
      let level = 0;
      const data = steps.map(([, v, kind]) => {
        if (kind === "total") { level = v; return [0, v]; }
        const from = level;
        level += v;
        return [level, from];
      });
      const colors = steps.map(([, v, kind], i) =>
        i === steps.length - 1 ? (v < 0 ? c.expense : c.income) : kind === "minus" ? alpha(c.text, 0.18) : alpha(c.text, 0.85));
      const opts = baseOptions();
      opts.interaction = { mode: "nearest", intersect: true };
      opts.scales.x.ticks.autoSkip = false;
      opts.scales.x.ticks.font = { size: 10 };
      opts.plugins.tooltip.callbacks.label = (ctx) => {
        const [, v, kind] = steps[ctx.dataIndex];
        return ` ${kind === "minus" ? "− " + cad0.format(-v) : cad0.format(v)}`;
      };
      opts.plugins.barValues = { enabled: true, labels: steps.map(([, v, kind]) => (kind === "minus" ? `−${compact(-v)}` : compact(v))) };
      drawChart("chart-waterfall", {
        type: "bar",
        data: {
          labels: steps.map((s) => s[0]),
          datasets: [{ label: "Amount", data, backgroundColor: colors, borderRadius: 6, borderSkipped: false, maxBarThickness: 48 }],
        },
        options: opts,
      });
    }

    if (activeTab === "cards") {
      const names = cardNames();
      const opts = baseOptions();
      opts.scales.x.stacked = true;
      opts.scales.y.stacked = true;
      opts.plugins.tooltip.callbacks.footer = (items) => `Total  ${cad0.format(items.reduce((s, it) => s + (it.raw || 0), 0))}`;
      opts.plugins.tooltip.footerFont = { family: cssVar("--font-num"), size: 12, weight: "700" };
      opts.plugins.tooltip.footerColor = c.muted;
      drawChart("chart-cards", {
        type: "bar",
        data: {
          labels,
          datasets: names.map((name, i) => ({
            label: name,
            data: months.map((m) => cardBalance(m, name)),
            backgroundColor: resolve(cardShade(i)),
            borderColor: resolve(cssVar("--surface")),
            borderWidth: { top: 2 },
            borderSkipped: "start",
            borderRadius: i === names.length - 1 ? { topLeft: 6, topRight: 6 } : 0,
            maxBarThickness: 28,
          })),
        },
        options: opts,
      });
    }

    if (activeTab === "trends") {
      drawChart("chart-worth", {
        type: "line",
        data: { labels, datasets: [areaLine("Net worth", series("netWorth"), c.text)] },
        options: baseOptions(),
      });

      const rates = series("savingsRate");
      const known = rates.filter((r) => r !== null);
      const avgRate = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
      drawChart("chart-rate", {
        type: "line",
        data: {
          labels,
          datasets: [
            areaLine("Savings rate", rates, c.income),
            refLine("Average", months.map(() => avgRate)),
          ],
        },
        options: baseOptions({ percent: true }),
      });

      drawChart("chart-spend", {
        type: "line",
        data: {
          labels,
          datasets: [
            areaLine("Expense", series("expense"), c.expense),
            refLine("3-mo average", series("expenseAvg3")),
          ],
        },
        options: baseOptions(),
      });

      drawChart("chart-ws", {
        type: "line",
        data: { labels, datasets: [areaLine("Wealthsimple", series("wealthsimple"), c.muted)] },
        options: baseOptions(),
      });
    }
  }

  // ---------- entry form ----------
  const dialog = $("entry-dialog");

  function addAcctRow(kind, name = "", balance = "") {
    const row = $("acct-row-tpl").content.firstElementChild.cloneNode(true);
    row.querySelector(".acct-name").value = name;
    row.querySelector(".acct-bal").value = balance === "" ? "" : String(balance);
    row.querySelector(".acct-remove").addEventListener("click", () => { row.remove(); updatePreview(); });
    $(kind === "cards" ? "f-cards" : "f-banks").appendChild(row);
    return row;
  }

  document.querySelectorAll("[data-add]").forEach((btn) =>
    btn.addEventListener("click", () => addAcctRow(btn.dataset.add).querySelector(".acct-name").focus()),
  );

  const latest = () => months[months.length - 1] || null;

  function openForm(entry = null) {
    editingId = entry?.id || null;
    $("entry-title").textContent = entry ? `Edit ${monthLabel(entry.month, true)}` : "Add month";
    $("entry-kicker").textContent = entry ? "Update balances" : "Monthly check-in";
    $("entry-msg").textContent = "";
    $("f-cards").replaceChildren();
    $("f-banks").replaceChildren();
    document.querySelectorAll("#entry-form .invalid").forEach((el) => el.classList.remove("invalid"));

    if (entry) {
      $("f-month").value = entry.month;
      $("f-income").value = entry.income ?? "";
      $("f-ws").value = entry.wealthsimple;
      entry.cards.forEach((c) => addAcctRow("cards", c.name, c.balance));
      entry.banks.forEach((b) => addAcctRow("banks", b.name, b.balance));
    } else {
      // New month: same account names as the latest month (or the defaults), empty amounts.
      const last = latest();
      $("f-month").value = suggestNextMonth();
      $("f-income").value = "";
      $("f-ws").value = "";
      (last ? last.cards.map((c) => c.name) : cfg.DEFAULT_CARDS || []).forEach((n) => addAcctRow("cards", n));
      (last ? last.banks.map((b) => b.name) : cfg.DEFAULT_BANKS || []).forEach((n) => addAcctRow("banks", n));
    }
    $("copy-last-btn").hidden = !!entry || !latest();
    updatePreview();
    dialog.showModal();
  }

  function suggestNextMonth() {
    const last = latest();
    if (!last) return thisMonth();
    const [y, m] = last.month.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    return next > thisMonth() ? thisMonth() : next;
  }

  $("add-btn").addEventListener("click", () => openForm());
  $("entry-close").addEventListener("click", () => dialog.close());

  $("copy-last-btn").addEventListener("click", () => {
    const last = latest();
    if (!last) return;
    $("f-cards").replaceChildren();
    $("f-banks").replaceChildren();
    last.cards.forEach((c) => addAcctRow("cards", c.name, c.balance));
    last.banks.forEach((b) => addAcctRow("banks", b.name, b.balance));
    $("f-ws").value = last.wealthsimple;
    updatePreview();
  });

  // Reads and validates the form. Returns { entry } or { error, el }.
  function readForm() {
    document.querySelectorAll("#entry-form .invalid").forEach((el) => el.classList.remove("invalid"));
    const fail = (error, el) => { el?.classList.add("invalid"); return { error, el }; };

    const month = $("f-month").value.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail("Month must look like 2026-09.", $("f-month"));

    let income = null;
    if ($("f-income").value.trim() !== "") {
      income = parseMoney($("f-income").value);
      if (Number.isNaN(income)) return fail("Income must be a number (e.g. 5200 or 5,200.50).", $("f-income"));
      if (income < 0) return fail("Income can’t be negative.", $("f-income"));
    }

    const readList = (containerId, label) => {
      const list = [];
      const seen = new Set();
      for (const row of $(containerId).querySelectorAll(".acct-row")) {
        const nameEl = row.querySelector(".acct-name");
        const balEl = row.querySelector(".acct-bal");
        const name = nameEl.value.trim();
        if (!name) return fail(`Every ${label} needs a name.`, nameEl);
        if (seen.has(name.toLowerCase())) return fail(`“${name}” is listed twice.`, nameEl);
        seen.add(name.toLowerCase());
        const balance = parseMoney(balEl.value);
        if (Number.isNaN(balance)) return fail(`Enter a balance for ${name} (0 if it’s empty).`, balEl);
        list.push({ name, balance });
      }
      return list;
    };

    const cards = readList("f-cards", "card");
    if (cards.error) return cards;
    const banks = readList("f-banks", "account");
    if (banks.error) return banks;

    const ws = parseMoney($("f-ws").value);
    if (Number.isNaN(ws)) return fail("Wealthsimple must be a number (0 if none).", $("f-ws"));
    if (ws < 0) return fail("Wealthsimple balance can’t be negative.", $("f-ws"));

    return { entry: { month, income, cards, banks, wealthsimple: ws } };
  }

  // Live preview of what this month will compute to.
  function updatePreview() {
    const r = readForm();
    document.querySelectorAll("#entry-form .invalid").forEach((el) => el.classList.remove("invalid"));
    const el = $("entry-preview");
    el.replaceChildren();
    if (r.error) return;
    const others = rows.filter((x) => x.id !== editingId && x.month !== r.entry.month);
    const me = computeMonths([...others, r.entry]).find((x) => x.month === r.entry.month);
    const cells = [
      ["Cards", fmt0(me.cardTotal), ""],
      ["Bank", fmt0(me.bankTotal), ""],
      ["Saved", fmt0(me.savings), toneOf(me.savings)],
      ["Expense", fmt0(me.expense), ""],
      ["Net worth", fmt0(me.netWorth), ""],
    ];
    for (const [k, v, cls] of cells) {
      const d = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      if (cls) dd.className = cls;
      d.append(dt, dd);
      el.appendChild(d);
    }
  }
  $("entry-form").addEventListener("input", updatePreview);

  $("entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("entry-msg");
    msg.className = "msg error";
    const r = readForm();
    if (r.error) {
      msg.textContent = r.error;
      r.el?.focus();
      return;
    }
    const entry = { ...r.entry, updated_at: new Date().toISOString() };
    if (entry.income === null && !confirm("Save without income? Saved and net worth still work, but expense and savings rate will show n/a for this month.")) return;

    // Adding a month that already exists → confirm, then overwrite that row.
    let targetId = editingId;
    const clash = rows.find((x) => x.month === entry.month && x.id !== editingId);
    if (clash) {
      if (editingId) {
        msg.textContent = `${monthLabel(entry.month)} already has an entry. Edit or delete that one instead.`;
        return;
      }
      if (!confirm(`${monthLabel(entry.month)} already exists. Replace it with these numbers?`)) return;
      targetId = clash.id;
    }

    $("entry-save").disabled = true;
    msg.className = "msg";
    msg.textContent = "Saving…";
    const q = targetId
      ? sb.from("months").update(entry).eq("id", targetId).select().single()
      : sb.from("months").insert(entry).select().single();
    const { data, error } = await q;
    $("entry-save").disabled = false;

    if (error) {
      msg.className = "msg error";
      msg.textContent = /null value in column "income"/.test(error.message)
        ? "Your database still requires income. Run migrations/002_investable_cards.sql in Supabase, or enter income."
        : offlineOr(error, "save");
      return;
    }
    rows = rows.filter((x) => x.id !== data.id).concat(data);
    saveCache();
    animateNext = true;
    render();
    dialog.close();
    refresh();
  });

  async function deleteMonth(m) {
    if (!confirm(`Delete ${monthLabel(m.month)}? This can’t be undone, and the next month’s numbers will be recalculated.`)) return;
    const { error } = await sb.from("months").delete().eq("id", m.id);
    if (error) return alert(offlineOr(error, "delete"));
    rows = rows.filter((x) => x.id !== m.id);
    saveCache();
    render();
  }

  // ---------- CSV export (a backup you own) ----------
  $("export-btn").addEventListener("click", () => {
    const cNames = [...new Set(months.flatMap((m) => m.cards.map((c) => c.name)))];
    const bNames = [...new Set(months.flatMap((m) => m.banks.map((b) => b.name)))];
    const header = [
      "month", "income",
      ...cNames.map((n) => `card: ${n}`), "total_cards",
      ...bNames.map((n) => `bank: ${n}`), "total_bank",
      "wealthsimple", "expense", "saved", "savings_rate", "net_worth",
    ];
    const val = (list, n) => list.find((x) => x.name === n)?.balance ?? "";
    const lines = months.map((m) => [
      m.month, m.income ?? "",
      ...cNames.map((n) => val(m.cards, n)), m.cardTotal,
      ...bNames.map((n) => val(m.banks, n)), m.bankTotal,
      m.wealthsimple, m.expense ?? "", m.savings ?? "",
      m.savingsRate === null ? "" : m.savingsRate.toFixed(4), m.netWorth,
    ]);
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [header, ...lines].map((l) => l.map(esc).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `finances-${thisMonth()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Initial session check (onAuthStateChange also fires; this covers older clients).
  sb.auth.getSession().then(({ data }) => {
    if (!data.session) show("login-view");
  });
})();
