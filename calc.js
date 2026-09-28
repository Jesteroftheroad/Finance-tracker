// Pure math for the dashboard. No DOM, no network — easy to reason about and test.
(function (root) {
  const sum = (list) => (list || []).reduce((t, a) => t + (Number(a.balance) || 0), 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  // "2026-09" -> 2026*12 + 8, so consecutive months differ by exactly 1.
  const monthIndex = (m) => {
    const [y, mo] = m.split("-").map(Number);
    return y * 12 + (mo - 1);
  };

  /**
   * rows: [{ month, income|null, cards:[{name,balance}], banks:[...], wealthsimple }]
   * Returns rows sorted oldest → newest with derived fields added.
   *
   *   cardTotal   = Σ cards
   *   bankTotal   = Σ banks
   *   netCash     = bankTotal − cardTotal          (Wealthsimple deliberately excluded)
   *   savings     = netCash − prev.netCash         (= income − expense)
   *   expense     = income − savings               (needs income)
   *   savingsRate = savings ÷ income               (needs income > 0)
   *   netWorth    = bankTotal + wealthsimple − cardTotal
   *   expenseChange = expense − previous month's expense (both must exist)
   *   expenseAvg3 = average of this and the 2 previous months' expense (all 3 must exist)
   *
   * The first month has no previous month, so savings/expense are null ("n/a").
   * If months were skipped, the change spans the gap; `gapMonths` records how many.
   */
  function computeMonths(rows) {
    const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));
    const out = [];
    for (const r of sorted) {
      const prev = out[out.length - 1];
      const cardTotal = round2(sum(r.cards));
      const bankTotal = round2(sum(r.banks));
      const income = num(r.income);
      const ws = Number(r.wealthsimple) || 0;
      const netCash = round2(bankTotal - cardTotal);
      const m = {
        ...r,
        income,
        wealthsimple: ws,
        cardTotal,
        bankTotal,
        netCash,
        netWorth: round2(bankTotal + ws - cardTotal),
        savings: null,
        expense: null,
        savingsRate: null,
        expenseChange: null,
        expenseAvg3: null,
        gapMonths: 0,
      };
      if (prev) {
        m.savings = round2(netCash - prev.netCash);
        m.gapMonths = monthIndex(r.month) - monthIndex(prev.month) - 1;
        if (income !== null) m.expense = round2(income - m.savings);
        if (income) m.savingsRate = m.savings / income;
        if (m.expense !== null && prev.expense !== null) m.expenseChange = round2(m.expense - prev.expense);
      }
      const last3 = [...out.slice(-2), m].map((x) => x.expense);
      if (last3.length === 3 && last3.every((e) => e !== null)) {
        m.expenseAvg3 = round2((last3[0] + last3[1] + last3[2]) / 3);
      }
      out.push(m);
    }
    return out;
  }

  function computeTotals(months) {
    const withExpense = months.filter((m) => m.expense !== null);
    const withSavings = months.filter((m) => m.savings !== null);
    const totalExpense = round2(withExpense.reduce((t, m) => t + m.expense, 0));
    return {
      totalIncome: round2(months.reduce((t, m) => t + (m.income || 0), 0)),
      totalExpense,
      totalSaved: round2(withSavings.reduce((t, m) => t + m.savings, 0)),
      avgExpense: withExpense.length ? round2(totalExpense / withExpense.length) : null,
      expenseCount: withExpense.length,
      savingsCount: withSavings.length,
    };
  }

  // Months of derived expense needed before the emergency fund can be auto-suggested.
  const MIN_EXPENSE_MONTHS = 2;

  /**
   * The "what can I actually deploy" view, from the latest month's cash.
   * settings: { emergency_mode, emergency_multiplier, emergency_fixed, reserve_cards }
   * buckets:  [{ name, target, deadline }]
   */
  function computeInvestable(months, settings, buckets) {
    const latest = months[months.length - 1] || null;
    const totals = computeTotals(months);
    const cash = latest ? latest.bankTotal : 0;
    const cards = latest ? latest.cardTotal : 0;
    const s = settings || {};
    const multiplier = Number(s.emergency_multiplier) || 3;
    const canAuto = totals.expenseCount >= MIN_EXPENSE_MONTHS && totals.avgExpense > 0;

    let emergency = null;       // null = no target yet
    let emergencySource = "none";
    if (s.emergency_mode === "fixed" && num(s.emergency_fixed) !== null) {
      emergency = round2(Number(s.emergency_fixed));
      emergencySource = "fixed";
    } else if (canAuto) {
      emergency = round2(totals.avgExpense * multiplier);
      emergencySource = "auto";
    }

    const cardReserve = s.reserve_cards ? cards : 0;
    const bucketTotal = round2((buckets || []).reduce((t, b) => t + (Number(b.target) || 0), 0));
    const investable = round2(cash - cardReserve - (emergency || 0) - bucketTotal);

    // How much of each earmark the cash actually covers, in order:
    // cards (if reserved) → emergency fund → buckets by soonest deadline.
    let left = cash - cardReserve;
    const efFunded = emergency ? Math.max(0, Math.min(emergency, left)) : 0;
    left -= emergency || 0;
    const sortedBuckets = [...(buckets || [])].sort((a, b) =>
      (a.deadline || "9999-99").localeCompare(b.deadline || "9999-99"));
    const bucketFunding = sortedBuckets.map((b) => {
      const target = Number(b.target) || 0;
      const funded = Math.max(0, Math.min(target, left));
      left -= target;
      return { ...b, target, funded: round2(funded) };
    });

    const dailyExpense = totals.avgExpense > 0 ? totals.avgExpense / (365.25 / 12) : null;
    return {
      month: latest ? latest.month : null,
      cash,
      cards,
      cardReserve,
      multiplier,
      canAuto,
      autoSuggestion: canAuto ? round2(totals.avgExpense * multiplier) : null,
      emergency,
      emergencySource,
      emergencyFunded: round2(efFunded),
      bucketTotal,
      buckets: bucketFunding,
      investable,
      avgExpense: totals.avgExpense,
      expenseCount: totals.expenseCount,
      runwayDays: dailyExpense ? Math.floor(cash / dailyExpense) : null,
    };
  }

  // Accepts "1,234.56", "$1234", " 12 ", "-50". Returns a number, or NaN if invalid.
  function parseMoney(str) {
    const s = String(str ?? "").replace(/[\s,$]/g, "");
    if (!/^-?\d+(\.\d{1,2})?$|^-?\.\d{1,2}$/.test(s)) return NaN;
    return Number(s);
  }

  const api = { computeMonths, computeTotals, computeInvestable, parseMoney, monthIndex, MIN_EXPENSE_MONTHS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FTCalc = api;
})(this);
