// Бэктест пачки стратегий на дневных ценах (Yahoo, бесплатно, без ключа).
//   node C:\Games\rabota\trading\backtest.js [тикеры через запятую]
// Учится (выбирает лучшую) на TRAIN, проверяется на TEST, которого «не видел». Только long, комиссия+проскальзывание на каждую сторону.
// Пишет trading/report.md и data/<тикер>.json. Настоящих сделок не делает.
const fs = require('fs');
const path = require('path');

const TICKERS = (process.argv[2] || 'SPY,QQQ,AAPL,MSFT,NVDA,TSLA').split(',');
const TRAIN_END = '2023-12-31';          // 2016–2023: рост, обвал 2020, медвежий 2022
const COST = 0.0005;                      // 0.05% на сторону
const DIR = __dirname, DATA = path.join(DIR, 'data');
fs.mkdirSync(DATA, { recursive: true });

async function load(t) {
  const f = path.join(DATA, `${t}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=10y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = (await r.json()).chart.result[0], q = j.indicators.quote[0], adj = j.indicators.adjclose?.[0]?.adjclose;
  const rows = [];
  j.timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    const k = adj ? adj[i] / q.close[i] : 1; // поправка на сплиты/дивиденды
    rows.push({ d: new Date(ts * 1000).toISOString().slice(0, 10), o: q.open[i] * k, h: q.high[i] * k, l: q.low[i] * k, c: q.close[i] * k });
  });
  fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}

// ---------- индикаторы ----------
const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n);
function rsi(c, n) {
  const out = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = 100 - 100 / (1 + g / (l || 1e-9)); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9));
  }
  return out;
}

// ---------- стратегии ----------
// swing: pos[i] = держим ли бумагу в течение дня i (решение по закрытию i-1) → доход close-to-close.
// intraday: вход на открытии (9:30), выход на закрытии того же дня.
function strategies(R) {
  const c = R.map(r => r.c), S = [];
  const swing = (name, fn) => S.push({ name, type: 'swing', fn });
  swing('Купил и держал', () => c.map(() => 1));
  const smas = {}; const m = n => (smas[n] ||= sma(c, n));
  for (const f of [5, 10, 20, 50]) for (const s of [50, 100, 200]) if (f < s)
    swing(`SMA ${f}/${s} пересечение`, () => c.map((_, i) => m(f)[i] != null && m(s)[i] != null && m(f)[i] > m(s)[i] ? 1 : 0));
  for (const n of [20, 50, 100, 200]) swing(`Цена выше SMA${n}`, () => c.map((x, i) => m(n)[i] != null && x > m(n)[i] ? 1 : 0));
  for (const n of [2, 14]) for (const lo of [5, 10, 20, 30]) for (const hi of [50, 70]) swing(`RSI${n} < ${lo}, выход > ${hi}`, () => {
    const r = rsi(c, n); let p = 0; return c.map((_, i) => { if (r[i] == null) return 0; if (!p && r[i] < lo) p = 1; else if (p && r[i] > hi) p = 0; return p; });
  });
  for (const n of [20, 60, 120, 250]) swing(`Моментум ${n} дн > 0`, () => c.map((x, i) => i >= n && x > c[i - n] ? 1 : 0));
  for (const n of [20, 55]) for (const k of [10, 20]) swing(`Пробой max${n}, выход min${k}`, () => {
    let p = 0; return c.map((x, i) => { if (i < n) return 0; const hi = Math.max(...c.slice(i - n, i)), lo = Math.min(...c.slice(i - k, i)); if (!p && x > hi) p = 1; else if (p && x < lo) p = 0; return p; });
  });
  const intra = (name, fn) => S.push({ name, type: 'intraday', fn });
  intra('Каждый день: купил в 9:30, продал на закрытии', () => R.map(() => 1));
  for (const g of [0.5, 1, 1.5, 2]) intra(`Гэп вниз > ${g}% → купить в 9:30, продать на закрытии`, () => R.map((r, i) => i && r.o < R[i - 1].c * (1 - g / 100) ? 1 : 0));
  for (const g of [0.5, 1, 1.5, 2]) intra(`Гэп вверх > ${g}% → купить в 9:30, продать на закрытии`, () => R.map((r, i) => i && r.o > R[i - 1].c * (1 + g / 100) ? 1 : 0));
  return S;
}

// дневные доходы стратегии с учётом издержек
function returns(R, st, pos) {
  const out = [0];
  for (let i = 1; i < R.length; i++) {
    if (st.type === 'intraday') { out.push(pos[i] ? R[i].c / R[i].o - 1 - 2 * COST : 0); continue; }
    const p = pos[i - 1], prev = i >= 2 ? pos[i - 2] : 0;
    out.push(p * (R[i].c / R[i - 1].c - 1) - (p !== prev ? COST : 0));
  }
  return out;
}
function stats(rets, R, from, to) {
  let eq = 1, peak = 1, dd = 0, n = 0, sum = 0, sq = 0, active = 0;
  for (let i = 0; i < R.length; i++) {
    if (R[i].d < from || R[i].d > to) continue;
    const r = rets[i]; eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    n++; sum += r; sq += r * r; if (r !== 0) active++;
  }
  const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean) || 1e-9;
  return { ret: eq - 1, dd, sharpe: mean / sd * Math.sqrt(252), active: active / n };
}
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

(async () => {
  const lines = [`# Бэктест ${new Date().toISOString().slice(0, 10)}`, '', `Учёба (выбор лучшей): по ${TRAIN_END}. Проверка: с 2024-01-01 по сегодня. Комиссия+проскальзывание ${COST * 100}% на сторону. Только покупка, без плеча.`, ''];
  let beatTrain = 0, beatBoth = 0, total = 0, winnersHold = 0;
  for (const t of TICKERS) {
    const R = await load(t), S = strategies(R), start = R[0].d;
    const res = S.map(st => { const rets = returns(R, st, st.fn()); return { st, tr: stats(rets, R, start, TRAIN_END), te: stats(rets, R, '2024-01-01', '9999') }; });
    const bh = res[0];
    for (const x of res.slice(1)) {
      total++;
      if (x.tr.sharpe > bh.tr.sharpe) { beatTrain++; if (x.te.ret > bh.te.ret) beatBoth++; }
    }
    const best = res.slice(1).sort((a, b) => b.tr.sharpe - a.tr.sharpe)[0];
    if (best.te.ret > bh.te.ret) winnersHold++;
    const topTest = res.slice(1).sort((a, b) => b.te.ret - a.te.ret)[0];
    lines.push(`## ${t} (${start} … ${R[R.length - 1].d})`, '',
      `Купил и держал: учёба ${pct(bh.tr.ret)} (Sharpe ${bh.tr.sharpe.toFixed(2)}), проверка ${pct(bh.te.ret)}, макс. просадка на проверке ${pct(bh.te.dd)}.`, '',
      `Лучшая на учёбе: «${best.st.name}» — учёба ${pct(best.tr.ret)} (Sharpe ${best.tr.sharpe.toFixed(2)}), **на проверке ${pct(best.te.ret)}** (просадка ${pct(best.te.dd)}, в рынке ${(best.te.active * 100).toFixed(0)}% дней). ${best.te.ret > bh.te.ret ? 'Обогнала «купил и держал».' : 'Проиграла «купил и держал».'}`, '',
      `Задним числом лучшая на проверке была бы «${topTest.st.name}» ${pct(topTest.te.ret)} — но заранее её было не угадать (это и есть подгонка).`, '');
  }
  lines.push('## Итог', '',
    `Проверено ${total} пар «стратегия × акция». На учёбе «купил и держал» по Sharpe обогнали ${beatTrain}; из них и на проверке по доходу обогнали ${beatBoth}.`,
    `Лучшая-на-учёбе стратегия обогнала «купил и держал» на проверке в ${winnersHold} из ${TICKERS.length} акций.`, '');
  fs.writeFileSync(path.join(DIR, 'report.md'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
