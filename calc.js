// Pure math for the dashboard. No DOM, no network — easy to reason about and test.
(function (root) {
  const sum = (list) => (list || []).reduce((t, a) => t + (Number(a.balance) || 0), 0);
  const round2 = (n) => Math.round(n * 100) / 100;

  // "2026-09" -> 2026*12 + 8, so consecutive months differ by exactly 1.
  const monthIndex = (m) => {
    const [y, mo] = m.split("-").map(Number);
    return y * 12 + (mo - 1);
  };

  /**
   * rows: [{ month, income, cards:[{name,balance}], banks:[...], wealthsimple }]
   * Returns rows sorted oldest → newest with derived fields added.
   *
   *   cardTotal = Σ cards
   *   bankTotal = Σ banks
   *   netCash   = bankTotal − cardTotal          (Wealthsimple deliberately excluded)
   *   expense   = income − (netCash − prev.netCash)
   *   savings   = income − expense              (= change in netCash)
   *   netWorth  = bankTotal + wealthsimple − cardTotal
   *
   * The first month has no previous month, so expense/savings are null ("n/a").
   * If months were skipped, the change spans the gap; `gapMonths` records how many.
   */
  function computeMonths(rows) {
    const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));
    let prev = null;
    return sorted.map((r) => {
      const cardTotal = round2(sum(r.cards));
      const bankTotal = round2(sum(r.banks));
      const income = Number(r.income) || 0;
      const ws = Number(r.wealthsimple) || 0;
      const netCash = round2(bankTotal - cardTotal);
      const out = {
        ...r,
        income,
        wealthsimple: ws,
        cardTotal,
        bankTotal,
        netCash,
        netWorth: round2(bankTotal + ws - cardTotal),
        expense: null,
        savings: null,
        gapMonths: 0,
      };
      if (prev) {
        const change = netCash - prev.netCash;
        out.expense = round2(income - change);
        out.savings = round2(income - out.expense);
        out.gapMonths = monthIndex(r.month) - monthIndex(prev.month) - 1;
      }
      prev = out;
      return out;
    });
  }

  function computeTotals(months) {
    const derived = months.filter((m) => m.expense !== null);
    const totalIncome = round2(months.reduce((t, m) => t + m.income, 0));
    const totalExpense = round2(derived.reduce((t, m) => t + m.expense, 0));
    const totalSaved = round2(derived.reduce((t, m) => t + m.savings, 0));
    return {
      totalIncome,
      totalExpense,
      totalSaved,
      avgExpense: derived.length ? round2(totalExpense / derived.length) : null,
      derivedCount: derived.length,
    };
  }

  // Accepts "1,234.56", "$1234", " 12 ", "-50". Returns a number, or NaN if invalid.
  function parseMoney(str) {
    const s = String(str ?? "").replace(/[\s,$]/g, "");
    if (!/^-?\d+(\.\d{1,2})?$|^-?\.\d{1,2}$/.test(s)) return NaN;
    return Number(s);
  }

  const api = { computeMonths, computeTotals, parseMoney, monthIndex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FTCalc = api;
})(this);
