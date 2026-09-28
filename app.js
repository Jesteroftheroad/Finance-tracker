(() => {
  const cfg = window.FT_CONFIG || {};
  const { computeMonths, computeTotals, computeInvestable, parseMoney, MIN_EXPENSE_MONTHS } = window.FTCalc;
  const $ = (id) => document.getElementById(id);

  const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
  const cad0 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
  const fmt = (n) => (n === null || n === undefined ? "n/a" : cad.format(n));
  const fmt0 = (n) => (n === null || n === undefined ? "n/a" : cad0.format(n));
  const pct = (r) => (r === null || r === undefined ? "n/a" : `${Math.round(r * 100)}%`);
  const monthLabel = (m, long) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-CA", { month: long ? "long" : "short", year: "numeric" });
  };
  const thisMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };

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
  const charts = {};

  // ---------- theme (per device) ----------
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : darkQuery.matches;
  };
  function paintThemeButton() {
    $("theme-btn").innerHTML = isDark()
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM3.5 4.9l1.4-1.4 2.1 2.1-1.4 1.4zm13 13 1.4-1.4 2.1 2.1-1.4 1.4zM1 11h3v2H1zm19 0h3v2h-3zM3.5 19.1l2.1-2.1 1.4 1.4-2.1 2.1zm13-13 2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.5 5.5 0 0 1 13.4 3.1 9 9 0 0 0 12 3z"/></svg>';
  }
  $("theme-btn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("ft-theme", next);
    paintThemeButton();
    renderCharts();
  });
  darkQuery.addEventListener("change", () => { paintThemeButton(); renderCharts(); });
  paintThemeButton();

  // ---------- views ----------
  function show(view) {
    for (const v of ["setup-view", "login-view", "app-view"]) $(v).hidden = v !== view;
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
      loadFromCache();
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
      setStatus(`Cached ${new Date(cached.at).toLocaleString("en-CA")}`);
      render();
    } catch { /* ignore */ }
  }

  function saveCache() {
    store.set(cacheKey(), JSON.stringify({ at: Date.now(), rows, buckets, settings }));
  }

  function setStatus(text) { $("sync-status").textContent = text; }

  let refreshing = false;
  let migrationMissing = false;
  async function refresh() {
    if (!user || refreshing) return;
    refreshing = true;
    setStatus("Syncing…");
    const [m, b, s] = await Promise.all([
      sb.from("months").select("*").order("month"),
      sb.from("buckets").select("*").order("created_at"),
      sb.from("settings").select("*").maybeSingle(),
    ]);
    refreshing = false;
    if (m.error) {
      setStatus(navigator.onLine ? `Sync failed: ${m.error.message}` : "Offline — showing cached data");
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
      ? "Run migration 002 in Supabase to enable buckets & settings"
      : `Synced ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`);
    render();
  }

  // Pick up changes made on other devices whenever you come back to the app.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
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
    activeTab = tab;
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    store.set("ft-tab", tab);
    if (push && location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    render();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1), false));
  activeTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get("ft-tab") || "overview";
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)));

  // ---------- render ----------
  function render() {
    months = computeMonths(rows);
    const has = months.length > 0;
    $("empty-state").hidden = has;
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = !has || p.dataset.panel !== activeTab; });
    if (!has) return;
    if (activeTab === "overview") renderOverview();
    if (activeTab === "investable") renderInvestable();
    if (activeTab === "cards") renderCards();
    renderCharts();
  }

  function setText(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.classList.remove("good", "bad");
    if (cls) el.classList.add(cls);
  }
  const signCls = (n) => (n === null || n === undefined ? "" : n >= 0 ? "good" : "bad");
  const arrow = (n) => (n > 0 ? "▲" : n < 0 ? "▼" : "•");

  function renderOverview() {
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];
    $("ov-month").textContent = monthLabel(cur.month, true);

    setText("ov-networth", fmt(cur.netWorth));
    if (prev) {
      const d = cur.netWorth - prev.netWorth;
      setText("ov-networth-sub", `${arrow(d)} ${fmt(Math.abs(d))} vs ${monthLabel(prev.month)}`, signCls(d));
    } else setText("ov-networth-sub", "");

    setText("ov-income", fmt(cur.income));
    setText("ov-income-sub", cur.income === null ? "Not entered" : "");

    setText("ov-expense", fmt(cur.expense));
    if (cur.expense === null) {
      setText("ov-expense-sub", !prev ? "Needs a previous month" : "Needs this month’s income");
    } else if (cur.expenseChange !== null) {
      // Spending more is the bad direction, so ▲ is red here.
      const d = cur.expenseChange;
      setText("ov-expense-sub", `${arrow(d)} ${fmt0(Math.abs(d))} vs ${monthLabel(prev.month)}`, d > 0 ? "bad" : "good");
    } else {
      setText("ov-expense-sub", cur.gapMonths ? `Covers ${cur.gapMonths + 1} months` : "");
    }

    setText("ov-savings", fmt(cur.savings), signCls(cur.savings));
    setText("ov-savings-sub", cur.savings === null ? "Needs a previous month" : "Change in bank − cards");

    setText("ov-rate", pct(cur.savingsRate), signCls(cur.savingsRate));
    const prevRate = prev?.savingsRate;
    if (cur.savingsRate !== null && prevRate !== null && prevRate !== undefined) {
      const d = Math.round((cur.savingsRate - prevRate) * 100);
      setText("ov-rate-sub", `${arrow(d)} ${Math.abs(d)} pts vs ${monthLabel(prev.month)}`, d >= 0 ? "good" : "bad");
    } else setText("ov-rate-sub", "Saved ÷ income");

    const t = computeTotals(months);
    setText("t-income", fmt(t.totalIncome));
    setText("t-expense", t.expenseCount ? fmt(t.totalExpense) : "n/a");
    setText("t-saved", t.savingsCount ? fmt(t.totalSaved) : "n/a", t.savingsCount ? signCls(t.totalSaved) : "");
    setText("t-avg", fmt(t.avgExpense));
    $("totals-note").textContent =
      `${months.length} month${months.length === 1 ? "" : "s"} tracked. Expense covers ${t.expenseCount}; ` +
      `the first month has nothing to compare against${months.some((m) => m.income === null) ? ", and months without income are skipped" : ""}.`;

    renderTable();
  }

  function td(text, cls) {
    const el = document.createElement("td");
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function button(label, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn sm ${cls}`;
    b.textContent = label;
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
        td(fmt(m.income), m.income === null ? "muted" : ""),
        td(fmt(m.cardTotal)),
        td(fmt(m.bankTotal)),
        td(fmt(m.wealthsimple)),
        td(fmt(m.expense), m.expense === null ? "muted" : ""),
        td(fmt(m.savings), m.savings === null ? "muted" : signCls(m.savings)),
        td(fmt(m.netWorth)),
      );
      const cell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(button("Edit", "ghost", () => openForm(m)), button("Delete", "ghost danger", () => deleteMonth(m)));
      cell.appendChild(actions);
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
  }

  // ---------- investable ----------
  function renderInvestable() {
    const inv = computeInvestable(months, settings, buckets);
    $("inv-month").textContent = `As of ${monthLabel(inv.month, true)}`;
    setText("inv-hero", fmt(inv.investable), inv.investable < 0 ? "bad" : "");
    const parts = [];
    if (inv.cardReserve) parts.push("cards");
    parts.push(inv.emergency !== null ? "emergency fund" : "emergency fund (not set)");
    if (buckets.length) parts.push(`${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`);
    setText("inv-hero-sub", inv.investable < 0
      ? `Short by ${fmt(-inv.investable)} after ${parts.join(", ")}`
      : `After ${parts.join(", ")}`);

    setText("inv-cash", fmt(inv.cash));
    if (inv.runwayDays !== null) {
      setText("inv-runway", `${inv.runwayDays.toLocaleString("en-CA")} days`);
      setText("inv-runway-sub", `≈ ${(inv.runwayDays / 30.44).toFixed(1)} months at ${fmt0(inv.avgExpense)}/mo`);
    } else {
      setText("inv-runway", "n/a");
      setText("inv-runway-sub", "Needs a month of expense");
    }

    $("reserve-cards").checked = !!settings.reserve_cards;
    $("reserve-cards").disabled = migrationMissing;
    $("reserve-cards-amt").textContent = `(${fmt(inv.cards)})`;

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
    if (document.activeElement !== $("ef-fixed")) {
      $("ef-fixed").value = settings.emergency_fixed ?? "";
    }

    const src = { auto: `${inv.multiplier}× avg expense`, fixed: "Fixed amount", none: "Not set" }[inv.emergencySource];
    $("ef-source").textContent = src;
    if (inv.emergency !== null) {
      const ratio = inv.emergency > 0 ? inv.emergencyFunded / inv.emergency : 1;
      $("ef-funded").textContent = `${fmt0(inv.emergencyFunded)} covered`;
      $("ef-target").textContent = `of ${fmt0(inv.emergency)} · ${Math.round(ratio * 100)}%`;
      $("ef-bar").style.width = `${Math.min(100, ratio * 100)}%`;
      $("ef-bar").className = "progress-fill" + (ratio >= 1 ? " full" : "");
    } else {
      $("ef-funded").textContent = "No target yet";
      $("ef-target").textContent = "";
      $("ef-bar").style.width = "0";
    }
    let note = "";
    if (!inv.canAuto) {
      const need = MIN_EXPENSE_MONTHS - inv.expenseCount;
      note = `Auto-suggest needs ${MIN_EXPENSE_MONTHS} months of derived expense (${need > 0 ? `${need} more` : "positive average"}). Type a target for now.`;
    } else if (mode === "fixed") {
      note = `Auto-suggestion would be ${fmt0(inv.autoSuggestion)} (${mult}× your ${fmt0(inv.avgExpense)} average).`;
    } else {
      note = `${mult}× your average monthly expense of ${fmt0(inv.avgExpense)}. Updates as you add months.`;
    }
    if (migrationMissing) note = "Run migrations/002_investable_cards.sql in Supabase to save these settings.";
    $("ef-note").textContent = note;

    renderBuckets(inv);
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
      const li = document.createElement("li");
      li.className = "bucket-item";
      const ratio = b.target > 0 ? b.funded / b.target : 1;
      const top = document.createElement("div");
      top.className = "item-top";
      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = b.name;
      const amt = document.createElement("span");
      amt.textContent = `${fmt0(b.funded)} / ${fmt0(b.target)}`;
      top.append(name, amt);

      const bar = document.createElement("div");
      bar.className = "progress";
      const fill = document.createElement("div");
      fill.className = "progress-fill" + (ratio >= 1 ? " full" : "");
      fill.style.width = `${Math.min(100, ratio * 100)}%`;
      bar.appendChild(fill);

      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.style.marginTop = "8px";
      const bits = [];
      if (b.deadline) {
        const monthsLeft = window.FTCalc.monthIndex(b.deadline) - window.FTCalc.monthIndex(thisMonth());
        bits.push(`By ${monthLabel(b.deadline)}${monthsLeft >= 0 ? ` · ${monthsLeft} mo left` : " · past due"}`);
      }
      bits.push(ratio >= 1 ? "Fully covered by cash" : `${Math.round(ratio * 100)}% covered by cash`);
      meta.textContent = bits.join(" · ");

      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(button("Edit", "ghost", () => editBucket(b)), button("Delete", "ghost danger", () => deleteBucket(b)));
      li.append(top, bar, meta, actions);
      list.appendChild(li);
    }
  }

  function editBucket(b) {
    editingBucketId = b.id;
    $("b-name").value = b.name;
    $("b-target").value = b.target;
    $("b-deadline").value = b.deadline || "";
    $("b-save").textContent = "Save";
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
  const seriesColor = (i) => css(`--s${(i % 8) + 1}`);

  function renderCards() {
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];
    const limits = settings.card_limits || {};
    const names = cardNames();
    $("cd-month").textContent = monthLabel(cur.month, true);

    setText("cd-total", fmt(cur.cardTotal));
    if (prev) {
      const d = cur.cardTotal - prev.cardTotal;
      setText("cd-total-sub", `${arrow(d)} ${fmt0(Math.abs(d))} vs ${monthLabel(prev.month)}`, d > 0 ? "bad" : "good");
    } else setText("cd-total-sub", "");

    const limited = cur.cards.filter((c) => Number(limits[c.name]) > 0);
    if (limited.length) {
      const bal = limited.reduce((t, c) => t + Number(c.balance), 0);
      const lim = limited.reduce((t, c) => t + Number(limits[c.name]), 0);
      setText("cd-util", pct(bal / lim), bal / lim > 0.3 ? "bad" : "");
      setText("cd-util-sub", `${fmt0(bal)} of ${fmt0(lim)} limit${limited.length < cur.cards.length ? ` · ${limited.length} of ${cur.cards.length} cards` : ""}`);
    } else {
      setText("cd-util", "—");
      setText("cd-util-sub", "Add limits below");
    }

    const list = $("card-list");
    list.replaceChildren();
    for (const c of cur.cards) {
      const i = names.indexOf(c.name);
      const before = prev?.cards.find((x) => x.name === c.name);
      const li = document.createElement("li");
      li.className = "card-item";

      const top = document.createElement("div");
      top.className = "item-top";
      const name = document.createElement("span");
      name.className = "item-name";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = seriesColor(i);
      name.append(sw, c.name);
      const amt = document.createElement("span");
      amt.style.fontWeight = "650";
      amt.textContent = fmt(Number(c.balance));
      top.append(name, amt);
      li.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "item-meta";
      if (before) {
        const d = Number(c.balance) - Number(before.balance);
        meta.textContent = `${arrow(d)} ${fmt0(Math.abs(d))} vs ${monthLabel(prev.month)}`;
        if (d > 0) meta.classList.add("bad");
        else if (d < 0) meta.classList.add("good");
      } else meta.textContent = "New this month";
      li.appendChild(meta);

      const limit = Number(limits[c.name]) || 0;
      if (limit > 0) {
        const ratio = Math.max(0, Number(c.balance)) / limit;
        const bar = document.createElement("div");
        bar.className = "progress";
        bar.style.marginTop = "10px";
        const fill = document.createElement("div");
        fill.className = "progress-fill" + (ratio > 0.3 ? " over" : "");
        fill.style.width = `${Math.min(100, ratio * 100)}%`;
        bar.appendChild(fill);
        const u = document.createElement("div");
        u.className = "item-meta";
        u.style.marginTop = "6px";
        u.textContent = `${pct(ratio)} utilization${ratio > 0.3 ? " · above 30%" : ""}`;
        li.append(bar, u);
      }

      const row = document.createElement("div");
      row.className = "limit-row";
      const lbl = document.createElement("label");
      const inputId = `limit-${i}`;
      lbl.htmlFor = inputId;
      lbl.textContent = "Credit limit";
      const input = document.createElement("input");
      input.type = "text";
      input.id = inputId;
      input.inputMode = "decimal";
      input.className = "money";
      input.placeholder = "Optional";
      input.value = limit > 0 ? limit : "";
      input.disabled = migrationMissing;
      input.addEventListener("change", () => saveLimit(c.name, input));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      row.append(lbl, input);
      li.appendChild(row);
      list.appendChild(li);
    }
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

  // ---------- charts (Chart.js) ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function baseOptions({ percent = false, legend = true } = {}) {
    const text = css("--muted");
    const val = (v) => (v === null || v === undefined ? "n/a" : percent ? `${Math.round(v * 100)}%` : cad.format(v));
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // charts redraw on every sync; animating each time looks jumpy
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: legend,
          position: "bottom",
          labels: { color: css("--text-2"), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3, padding: 14 },
        },
        tooltip: {
          backgroundColor: css("--surface"),
          titleColor: css("--text"),
          bodyColor: css("--text-2"),
          borderColor: css("--grid"),
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          callbacks: { label: (c) => ` ${c.dataset.label}: ${val(Array.isArray(c.raw) ? c.raw[1] - c.raw[0] : c.raw)}` },
        },
      },
      scales: {
        x: { ticks: { color: text, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false }, border: { color: css("--grid") } },
        y: {
          ticks: { color: text, maxTicksLimit: 6, callback: (v) => (percent ? `${Math.round(v * 100)}%` : cad0.format(v)) },
          grid: { color: css("--grid") },
          border: { display: false },
        },
      },
    };
  }
  const line = (label, data, color, extra = {}) => ({
    label, data, borderColor: color, backgroundColor: color,
    borderWidth: 2, tension: 0.3, pointRadius: 3, pointHoverRadius: 5, spanGaps: false, ...extra,
  });
  const bar = (label, data, color, extra = {}) => ({
    label, data, backgroundColor: color, borderRadius: 4, borderSkipped: "start", maxBarThickness: 36, ...extra,
  });

  function drawChart(id, config) {
    if (!window.Chart) return;
    charts[id]?.destroy();
    charts[id] = new Chart($(id), config);
  }

  function renderCharts() {
    if (!months.length || !user) return;
    const labels = months.map((m) => monthLabel(m.month));

    if (activeTab === "overview") {
      drawChart("chart-flow", {
        type: "bar",
        data: {
          labels,
          datasets: [
            bar("Income", months.map((m) => m.income), css("--s1")),
            bar("Expense", months.map((m) => m.expense), css("--s2")),
          ],
        },
        options: baseOptions(),
      });
    }

    if (activeTab === "investable") {
      const inv = computeInvestable(months, settings, buckets);
      const steps = [["Total cash", inv.cash, "total"]];
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
        kind === "minus" ? css("--neutral") : i === steps.length - 1 ? (v < 0 ? css("--bad") : css("--s3")) : css("--s1"));
      const opts = baseOptions({ legend: false });
      opts.plugins.tooltip.callbacks.label = (c) => {
        const [, v, kind] = steps[c.dataIndex];
        return ` ${kind === "minus" ? "− " + cad.format(-v) : cad.format(v)}`;
      };
      opts.interaction = { mode: "nearest", intersect: true };
      opts.scales.x.ticks.autoSkip = false;
      drawChart("chart-waterfall", {
        type: "bar",
        data: { labels: steps.map((s) => s[0]), datasets: [bar("Amount", data, colors, { borderSkipped: false, maxBarThickness: 56 })] },
        options: opts,
      });
    }

    if (activeTab === "cards") {
      const names = cardNames();
      drawChart("chart-cards", {
        type: "line",
        data: {
          labels,
          datasets: names.map((name, i) => line(name, months.map((m) => {
            const c = (m.cards || []).find((x) => x.name === name);
            return c ? Number(c.balance) : null;
          }), seriesColor(i))),
        },
        options: baseOptions(),
      });
    }

    if (activeTab === "trends") {
      drawChart("chart-worth", {
        type: "line",
        data: {
          labels,
          datasets: [
            line("Net worth", months.map((m) => m.netWorth), css("--s1"), { fill: false }),
            line("Wealthsimple", months.map((m) => m.wealthsimple), css("--s2")),
          ],
        },
        options: baseOptions(),
      });

      const rateOpts = baseOptions({ percent: true, legend: false });
      drawChart("chart-rate", {
        type: "bar",
        data: {
          labels,
          datasets: [bar("Savings rate", months.map((m) => m.savingsRate),
            months.map((m) => (m.savingsRate !== null && m.savingsRate < 0 ? css("--bad") : css("--s3"))))],
        },
        options: rateOpts,
      });

      const hasAvg = months.some((m) => m.expenseAvg3 !== null);
      $("avg3-note").textContent = hasAvg
        ? "The line smooths out one-off months: each point averages that month and the two before it."
        : "The 3-month average appears once you have 3 months of expense in a row.";
      drawChart("chart-avg", {
        type: "bar",
        data: {
          labels,
          datasets: [
            { ...line("3-month average", months.map((m) => m.expenseAvg3), css("--s1")), type: "line", order: 0 },
            bar("Expense", months.map((m) => m.expense), css("--s2"), { order: 1 }),
          ],
        },
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
    $("entry-title").textContent = entry ? `Edit ${monthLabel(entry.month)}` : "Add month";
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

  // Live "what this month will look like" line under the form.
  function updatePreview() {
    const r = readForm();
    document.querySelectorAll("#entry-form .invalid").forEach((el) => el.classList.remove("invalid"));
    const el = $("entry-preview");
    if (r.error) { el.textContent = ""; return; }
    const others = rows.filter((x) => x.id !== editingId && x.month !== r.entry.month);
    const me = computeMonths([...others, r.entry]).find((x) => x.month === r.entry.month);
    el.textContent =
      `Cards ${fmt(me.cardTotal)} · Bank ${fmt(me.bankTotal)} · Saved ${fmt(me.savings)} · ` +
      `Expense ${fmt(me.expense)} · Net worth ${fmt(me.netWorth)}`;
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
