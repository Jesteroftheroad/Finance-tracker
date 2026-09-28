(() => {
  const cfg = window.FT_CONFIG || {};
  const { computeMonths, computeTotals, parseMoney } = window.FTCalc;
  const $ = (id) => document.getElementById(id);

  const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
  const fmt = (n) => (n === null || n === undefined ? "n/a" : cad.format(n));
  const fmtShort = (n) => cad.format(Math.round(n)).replace(/\.00$/, "");
  const monthLabel = (m) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-CA", { month: "short", year: "numeric" });
  };
  const thisMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  // ---------- state ----------
  let sb = null;
  let user = null;
  let rows = [];        // raw rows from Supabase
  let months = [];      // computed, oldest → newest
  let editingId = null;
  const charts = {};

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
      options: {
        shouldCreateUser: false, // only the account you created can sign in
        emailRedirectTo: location.origin + location.pathname,
      },
    });
    if (error) loginMsg(error.message, "error");
    else loginMsg("Check your email for the sign-in link.", "ok");
  });

  $("signout-btn").addEventListener("click", async () => {
    await sb.auth.signOut();
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
      rows = [];
      show("login-view");
    }
  });

  // ---------- data: Supabase is the source of truth, localStorage is an offline cache ----------
  const cacheKey = () => `ft-cache-${user.id}`;

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(cacheKey());
      if (!raw) return;
      const cached = JSON.parse(raw);
      rows = cached.rows || [];
      setStatus(`Cached ${new Date(cached.at).toLocaleString("en-CA")}`);
      render();
    } catch { /* ignore */ }
  }

  function saveCache() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), rows }));
    } catch { /* ignore */ }
  }

  function setStatus(text) { $("sync-status").textContent = text; }

  let refreshing = false;
  async function refresh() {
    if (!user || refreshing) return;
    refreshing = true;
    setStatus("Syncing…");
    const { data, error } = await sb.from("months").select("*").order("month");
    refreshing = false;
    if (error) {
      setStatus(navigator.onLine ? `Sync failed: ${error.message}` : "Offline — showing cached data");
      render();
      return;
    }
    rows = data;
    saveCache();
    setStatus(`Synced ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`);
    render();
  }

  // Pick up changes made on other devices whenever you come back to the app.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.addEventListener("online", refresh);

  // ---------- render ----------
  function render() {
    months = computeMonths(rows);
    const has = months.length > 0;
    $("empty-state").hidden = has;
    $("dashboard").hidden = !has;
    if (!has) return;
    renderSummary();
    renderTotals();
    renderTable();
    renderCharts();
  }

  function setMoney(id, n, colorize = false) {
    const el = $(id);
    el.textContent = fmt(n);
    el.classList.remove("good", "bad");
    if (colorize && n !== null) el.classList.add(n >= 0 ? "good" : "bad");
  }

  function renderSummary() {
    const cur = months[months.length - 1];
    const prev = months[months.length - 2];
    $("summary-month").textContent = monthLabel(cur.month);

    setMoney("s-income", cur.income);
    setMoney("s-expense", cur.expense);
    setMoney("s-savings", cur.savings, true);
    setMoney("s-networth", cur.netWorth);

    $("s-income-sub").textContent = "";
    $("s-expense-sub").textContent =
      cur.expense === null ? "Needs a previous month"
      : cur.gapMonths ? `Covers ${cur.gapMonths + 1} months` : "";
    $("s-savings-sub").textContent =
      cur.savings !== null && cur.income > 0
        ? `${Math.round((cur.savings / cur.income) * 100)}% of income`
        : "";
    if (prev) {
      const d = cur.netWorth - prev.netWorth;
      $("s-networth-sub").textContent = `${d >= 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs ${monthLabel(prev.month)}`;
    } else {
      $("s-networth-sub").textContent = "";
    }
  }

  function renderTotals() {
    const t = computeTotals(months);
    setMoney("t-income", t.totalIncome);
    setMoney("t-expense", t.derivedCount ? t.totalExpense : null);
    setMoney("t-saved", t.derivedCount ? t.totalSaved : null, true);
    setMoney("t-avg", t.avgExpense);
    $("totals-note").textContent =
      `Income covers all ${months.length} month${months.length === 1 ? "" : "s"}. ` +
      `Expense and savings cover ${t.derivedCount} (the first month has nothing to compare against).`;
  }

  function td(text, cls) {
    const el = document.createElement("td");
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
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
        td(fmt(m.income)),
        td(fmt(m.cardTotal)),
        td(fmt(m.bankTotal)),
        td(fmt(m.wealthsimple)),
        td(fmt(m.expense), m.expense === null ? "muted" : ""),
        td(fmt(m.savings), m.savings === null ? "muted" : m.savings >= 0 ? "good" : "bad"),
        td(fmt(m.netWorth)),
      );
      const cell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions";
      cell.appendChild(actions);
      const edit = document.createElement("button");
      edit.className = "ghost small-btn";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openForm(m));
      const del = document.createElement("button");
      del.className = "ghost small-btn bad";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteMonth(m));
      actions.append(edit, del);
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
  }

  // ---------- charts ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const CARD_COLORS = ["#2563eb", "#ea580c", "#16a34a", "#9333ea", "#db2777", "#0891b2", "#ca8a04", "#64748b"];

  function baseOptions() {
    const grid = css("--border");
    const text = css("--muted");
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // charts redraw on every sync; animating each time looks jumpy
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: text, boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw === null ? "n/a" : cad.format(c.raw)}` } },
      },
      scales: {
        x: { ticks: { color: text }, grid: { display: false } },
        y: { ticks: { color: text, callback: (v) => fmtShort(v) }, grid: { color: grid } },
      },
    };
  }

  function drawChart(key, config) {
    if (!window.Chart) return;
    charts[key]?.destroy();
    charts[key] = new Chart($(key), config);
  }

  function renderCharts() {
    const labels = months.map((m) => monthLabel(m.month));

    drawChart("chart-flow", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Income", data: months.map((m) => m.income), backgroundColor: css("--income"), borderRadius: 4 },
          { label: "Expense", data: months.map((m) => m.expense), backgroundColor: css("--expense"), borderRadius: 4 },
        ],
      },
      options: baseOptions(),
    });

    // One line per card name ever used; a card missing in a month shows as a gap.
    const names = [];
    for (const m of months) for (const c of m.cards || []) if (!names.includes(c.name)) names.push(c.name);
    drawChart("chart-cards", {
      type: "line",
      data: {
        labels,
        datasets: names.map((name, i) => ({
          label: name,
          data: months.map((m) => {
            const c = (m.cards || []).find((x) => x.name === name);
            return c ? Number(c.balance) : null;
          }),
          borderColor: CARD_COLORS[i % CARD_COLORS.length],
          backgroundColor: CARD_COLORS[i % CARD_COLORS.length],
          tension: 0.25,
          pointRadius: 3,
          spanGaps: false,
        })),
      },
      options: baseOptions(),
    });

    drawChart("chart-worth", {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Net worth", data: months.map((m) => m.netWorth), borderColor: css("--worth"), backgroundColor: css("--worth"), tension: 0.25, pointRadius: 3 },
          { label: "Wealthsimple", data: months.map((m) => m.wealthsimple), borderColor: css("--ws"), backgroundColor: css("--ws"), tension: 0.25, pointRadius: 3 },
        ],
      },
      options: baseOptions(),
    });
  }

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (months.length) renderCharts();
  });

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

  function latest() { return months[months.length - 1] || null; }

  function openForm(entry = null) {
    editingId = entry?.id || null;
    $("entry-title").textContent = entry ? `Edit ${monthLabel(entry.month)}` : "Add month";
    $("entry-msg").textContent = "";
    $("f-cards").replaceChildren();
    $("f-banks").replaceChildren();
    document.querySelectorAll("#entry-form .invalid").forEach((el) => el.classList.remove("invalid"));

    if (entry) {
      $("f-month").value = entry.month;
      $("f-income").value = entry.income;
      $("f-ws").value = entry.wealthsimple;
      entry.cards.forEach((c) => addAcctRow("cards", c.name, c.balance));
      entry.banks.forEach((b) => addAcctRow("banks", b.name, b.balance));
    } else {
      // New month: same account names as the latest month (or the defaults), empty amounts.
      const last = latest();
      $("f-month").value = suggestNextMonth();
      $("f-income").value = "";
      $("f-ws").value = "";
      const cardNames = last ? last.cards.map((c) => c.name) : cfg.DEFAULT_CARDS || [];
      const bankNames = last ? last.banks.map((b) => b.name) : cfg.DEFAULT_BANKS || [];
      cardNames.forEach((n) => addAcctRow("cards", n));
      bankNames.forEach((n) => addAcctRow("banks", n));
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

    const income = parseMoney($("f-income").value);
    if (Number.isNaN(income)) return fail("Income must be a number (e.g. 5200 or 5,200.50).", $("f-income"));
    if (income < 0) return fail("Income can’t be negative.", $("f-income"));

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
    const computed = computeMonths([...others, r.entry]);
    const me = computed.find((x) => x.month === r.entry.month);
    el.textContent =
      `Cards ${fmt(me.cardTotal)} · Bank ${fmt(me.bankTotal)} · ` +
      `Expense ${fmt(me.expense)} · Savings ${fmt(me.savings)} · Net worth ${fmt(me.netWorth)}`;
  }
  $("entry-form").addEventListener("input", updatePreview);

  $("entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("entry-msg");
    const r = readForm();
    if (r.error) {
      msg.textContent = r.error;
      r.el?.focus();
      return;
    }
    const entry = { ...r.entry, updated_at: new Date().toISOString() };

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
    msg.textContent = "Saving…";
    const q = targetId
      ? sb.from("months").update(entry).eq("id", targetId).select().single()
      : sb.from("months").insert(entry).select().single();
    const { data, error } = await q;
    $("entry-save").disabled = false;

    if (error) {
      msg.textContent = navigator.onLine
        ? `Couldn’t save: ${error.message}`
        : "You’re offline. Saving needs a connection so every device stays in sync.";
      return;
    }
    rows = rows.filter((x) => x.id !== data.id).concat(data);
    saveCache();
    render();
    dialog.close();
    refresh();
  });

  async function deleteMonth(m) {
    if (!confirm(`Delete ${monthLabel(m.month)}? This can’t be undone, and the next month’s expense will be recalculated.`)) return;
    const { error } = await sb.from("months").delete().eq("id", m.id);
    if (error) {
      alert(navigator.onLine ? `Couldn’t delete: ${error.message}` : "You’re offline. Deleting needs a connection.");
      return;
    }
    rows = rows.filter((x) => x.id !== m.id);
    saveCache();
    render();
  }

  // ---------- CSV export (a backup you own) ----------
  $("export-btn").addEventListener("click", () => {
    const cardNames = [...new Set(months.flatMap((m) => m.cards.map((c) => c.name)))];
    const bankNames = [...new Set(months.flatMap((m) => m.banks.map((b) => b.name)))];
    const header = [
      "month", "income",
      ...cardNames.map((n) => `card: ${n}`), "total_cards",
      ...bankNames.map((n) => `bank: ${n}`), "total_bank",
      "wealthsimple", "expense", "savings", "net_worth",
    ];
    const val = (list, n) => list.find((x) => x.name === n)?.balance ?? "";
    const lines = months.map((m) => [
      m.month, m.income,
      ...cardNames.map((n) => val(m.cards, n)), m.cardTotal,
      ...bankNames.map((n) => val(m.banks, n)), m.bankTotal,
      m.wealthsimple, m.expense ?? "", m.savings ?? "", m.netWorth,
    ]);
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [header, ...lines].map((l) => l.map(esc).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `finances-${thisMonth()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Initial session check (onAuthStateChange also fires, this covers older clients).
  sb.auth.getSession().then(({ data }) => {
    if (!data.session) show("login-view");
  });
})();
