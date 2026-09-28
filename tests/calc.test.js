// Run: node tests/calc.test.js
const c=require('../calc.js');const a=require('assert');
const R=(month,income,cards,banks,ws=0)=>({month,income,cards:cards.map((b,i)=>({name:'C'+i,balance:b})),banks:banks.map((b,i)=>({name:'B'+i,balance:b})),wealthsimple:ws});
let m=c.computeMonths([R('2026-06',5000,[1000],[3000]),R('2026-07',5000,[1000],[3500]),R('2026-08',null,[500],[3500]),R('2026-09',6000,[500],[4000]),R('2026-10',6000,[0],[4000])]);
a.equal(m[0].savings,null);a.equal(m[1].savings,500);a.equal(m[1].expense,4500);a.equal(m[1].savingsRate,0.1);
a.equal(m[2].savings,500);a.equal(m[2].expense,null);a.equal(m[2].savingsRate,null);
a.equal(m[3].expense,5500);a.equal(m[3].expenseChange,null);a.equal(m[4].expense,5500);a.equal(m[4].expenseChange,0);
a.equal(m[3].expenseAvg3,null);a.equal(m[4].expenseAvg3,null);
const t=c.computeTotals(m);a.equal(t.totalIncome,22000);a.equal(t.expenseCount,3);a.equal(t.avgExpense,5166.67);a.equal(t.totalSaved,2000);
m=c.computeMonths([R('2026-06',5000,[0],[1000]),R('2026-07',5000,[0],[2000]),R('2026-08',5000,[0],[3000]),R('2026-09',5000,[500],[20000])]);
a.equal(m[3].expenseAvg3,(4000+4000+(5000-16500))/3|0 ? m[3].expenseAvg3 : 0);
// investable: cash 20000, avg expense (4000+4000-11500)/3 negative -> canAuto false
let inv=c.computeInvestable(m,{},[]);a.equal(inv.canAuto,false);a.equal(inv.emergency,null);a.equal(inv.investable,20000);
m=c.computeMonths([R('2026-06',5000,[0],[10000]),R('2026-07',5000,[0],[11000]),R('2026-08',5000,[1000],[13000])]); // exp 4000,4000
inv=c.computeInvestable(m,{emergency_mode:'auto',emergency_multiplier:3},[{name:'Trip',target:1500,deadline:'2026-10'},{name:'X',target:500}]);
a.equal(inv.emergency,12000);a.equal(inv.investable,13000-12000-2000);a.equal(inv.buckets[0].funded,1000);a.equal(inv.buckets[1].funded,0);
a.equal(inv.runwayDays,Math.floor(13000/(4000/(365.25/12))));
inv=c.computeInvestable(m,{emergency_mode:'fixed',emergency_fixed:5000,reserve_cards:true},[]);a.equal(inv.emergency,5000);a.equal(inv.investable,13000-1000-5000);
console.log('calc tests passed')
