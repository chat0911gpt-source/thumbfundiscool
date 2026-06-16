const APP_PASSWORD = "BLK168";
const state = {
  catalog: [],
  manifest: null,
  funds: new Map(),
  motherOptions: [],
  childOptions: [],
  lastResult: null,
  unlocked: false
};

const $ = (id) => document.getElementById(id);
const moneyFmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("zh-TW", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAY_MS = 24 * 60 * 60 * 1000;

function formatMoney(value) {
  return moneyFmt.format(Number(value || 0));
}

function formatPct(value) {
  return pctFmt.format(Number(value || 0));
}

function percentNumber(value) {
  return (Number(value || 0) * 100).toFixed(6);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

function signedClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function setStatus(text) {
  $("status").textContent = text || "";
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`資料讀取失敗：${path}`);
  return response.json();
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/基金之配息來源可能為本金/g, "")
    .replace(/[\s（）()、，,。:：/|_-]+/g, "");
}

function parseDateKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addMonthsKey(key, months) {
  const date = parseDateKey(key);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonth = year * 12 + month + months;
  const nextYear = Math.floor(targetMonth / 12);
  const nextMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  return dateKey(new Date(Date.UTC(nextYear, nextMonth, Math.min(day, lastDay))));
}

function diffMonths(startKey, endKey) {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  return Math.max(1, months);
}

function lowerBound(dates, target) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(dates, target) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastDayOfMonth(monthValue) {
  if (!monthValue) return null;
  const [year, month] = monthValue.split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatTaipei(iso) {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function productScore(query, product) {
  const q = normalize(query);
  if (!q) return 0;
  const nameNorm = normalize(product.name);
  const slugNorm = normalize(product.slug);
  let score = 0;
  if (q === nameNorm) score += 220;
  if (nameNorm.includes(q)) score += 160;
  if (nameNorm.startsWith(q)) score += 40;
  for (const token of String(query).toLowerCase().match(/[a-zA-Z0-9]+/g) || []) {
    if (slugNorm.includes(token)) score += 30;
    if (token.toUpperCase() === product.currency) score += 35;
    if (token.toUpperCase() === product.shareClass) score += 35;
  }
  if (String(product.slug).includes("a2-usd")) score += 25;
  else if (product.currency === "USD") score += 12;
  if (product.shareClass === "A2") score += 8;
  return score;
}

function searchProducts(query, limit = 30) {
  return state.catalog
    .map((product) => [productScore(query, product), product])
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, "zh-Hant") || a[1].id.localeCompare(b[1].id))
    .slice(0, limit)
    .map(([, product]) => product);
}

function fillSelect(side, results) {
  state[`${side}Options`] = results;
  const select = $(`${side}Select`);
  select.innerHTML = "";
  for (const item of results) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.display;
    select.appendChild(option);
  }
}

function searchFunds(side) {
  const query = $(`${side}Query`).value.trim();
  if (!query) return;
  const results = searchProducts(query);
  fillSelect(side, results);
}

function debounce(fn, wait = 280) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function loadFund(productId) {
  if (!productId) throw new Error("請先選擇基金");
  if (state.funds.has(productId)) return state.funds.get(productId);
  let fund;
  try {
    fund = await getJson(`data/funds/${productId}.json`);
  } catch {
    const product = state.catalog.find((item) => item.id === productId);
    throw new Error(`這檔基金尚未有淨值資料：${product ? product.display : productId}。請先等 GitHub Actions 更新完成。`);
  }
  if (!fund.points || fund.points.length < 2) throw new Error("基金資料不足，無法回測");
  state.funds.set(productId, fund);
  return fund;
}

function alignedPoints(mother, child) {
  const childMap = new Map(child.points.map(([date, nav]) => [date, Number(nav)]));
  const rows = [];
  for (const [date, motherNav] of mother.points) {
    if (childMap.has(date)) {
      rows.push({ date, mother: Number(motherNav), child: Number(childMap.get(date)) });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function choosePeriod(allPoints, startDate, endDate, durationMonths) {
  if (allPoints.length < 2) throw new Error("兩檔基金沒有足夠的重疊淨值日期");
  const dates = allPoints.map((row) => row.date);
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  if (durationMonths > diffMonths(earliest, latest)) {
    throw new Error(`資料長度不夠：兩檔基金共同資料約 ${diffMonths(earliest, latest)} 個月，不足你設定的 ${durationMonths} 個月。可用區間為 ${earliest} 至 ${latest}。`);
  }
  const requestedEnd = endDate || latest;
  const endIndex = upperBound(dates, requestedEnd) - 1;
  if (endIndex < 0) throw new Error("結束日早於可用資料");
  const effectiveEnd = dates[endIndex];
  const effectiveStart = startDate || addMonthsKey(effectiveEnd, -durationMonths);
  const expectedEnd = addMonthsKey(effectiveStart, durationMonths);
  if (expectedEnd > latest) {
    throw new Error(`資料長度不夠：從 ${effectiveStart} 起算 ${durationMonths} 個月會超過目前可用資料。兩檔共同可用區間為 ${earliest} 至 ${latest}。`);
  }
  if (expectedEnd > effectiveEnd) {
    throw new Error(`資料長度不夠：你選的起訖月份不足 ${durationMonths} 個月。請延後結束月份，或縮短時間長度。`);
  }
  const startIndex = lowerBound(dates, effectiveStart);
  if (startIndex >= dates.length || dates[startIndex] > effectiveEnd) throw new Error("起始日與結束日之間沒有可用資料");
  const selected = allPoints.slice(startIndex, endIndex + 1);
  if (selected.length < 2 || selected[0].date === selected[selected.length - 1].date) throw new Error("選定區間太短，無法回測");
  return selected;
}

function firstCommonDatesByMonth(points) {
  const seen = new Set();
  const monthDates = [];
  for (const row of points) {
    const key = row.date.slice(0, 7);
    if (!seen.has(key)) {
      seen.add(key);
      monthDates.push(row.date);
    }
  }
  return monthDates;
}

function scheduleTransferDates(dates, frequency, day1, day2) {
  if (!dates.length) return [];
  const d1 = Math.min(28, Math.max(1, Number(day1 || 1)));
  const d2 = Math.min(28, Math.max(1, Number(day2 || 15)));
  const start = dates[0];
  const end = dates[dates.length - 1];
  const targets = [];
  let cursor = `${start.slice(0, 7)}-01`;
  while (cursor <= end) {
    const ym = cursor.slice(0, 7);
    if (frequency === "monthly_2") {
      targets.push(`${ym}-${String(d1).padStart(2, "0")}`);
      targets.push(`${ym}-${String(d2).padStart(2, "0")}`);
      cursor = addMonthsKey(cursor, 1);
    } else if (frequency === "quarterly") {
      targets.push(`${ym}-${String(d1).padStart(2, "0")}`);
      cursor = addMonthsKey(cursor, 3);
    } else if (frequency === "yearly") {
      targets.push(`${ym}-${String(d1).padStart(2, "0")}`);
      cursor = addMonthsKey(cursor, 12);
    } else if (frequency === "biweekly") {
      targets.push(cursor < start ? start : cursor);
      cursor = dateKey(new Date(parseDateKey(cursor).getTime() + 14 * DAY_MS));
    } else {
      targets.push(`${ym}-${String(d1).padStart(2, "0")}`);
      cursor = addMonthsKey(cursor, 1);
    }
  }
  const scheduled = [];
  const used = new Set();
  for (const target of targets.sort()) {
    if (target <= start) continue;
    const index = lowerBound(dates, target);
    if (index < dates.length) {
      const actual = dates[index];
      if (actual <= end && !used.has(actual)) {
        scheduled.push(actual);
        used.add(actual);
      }
    }
  }
  return scheduled;
}

function transferAmount(rule, value, principal, motherValue, remainingTransfers) {
  if (rule === "even_over_period") {
    if (remainingTransfers <= 1) return Math.max(0, motherValue);
    return Math.max(0, motherValue / remainingTransfers);
  }
  if (rule === "fixed_amount") return Math.max(0, value);
  if (rule === "mother_percent") return Math.max(0, motherValue * value / 100);
  return Math.max(0, principal * value / 100);
}

function runStrategy(points, settings, includeTransfers = true) {
  const principal = Number(settings.principal);
  if (principal <= 0) throw new Error("本金必須大於 0");
  const dates = points.map((row) => row.date);
  const scheduledDates = scheduleTransferDates(dates, settings.frequency, settings.transferDay1, settings.transferDay2);
  const scheduled = new Set(scheduledDates);
  const firstMotherNav = points[0].mother;
  const firstChildNav = points[0].child;
  let motherUnits = principal / firstMotherNav;
  let childUnits = 0;
  let transferIndex = 0;
  const transfers = [];
  const rows = [];
  let stopSummary = {
    enabled: Boolean(settings.takeProfitEnabled),
    targetReturn: Number(settings.takeProfitTarget || 0) / 100,
    hit: false,
    exitDate: "",
    monthsToExit: null,
    exitReturn: null
  };

  for (const point of points) {
    const date = point.date;
    const motherNav = point.mother;
    const childNav = point.child;
    if (scheduled.has(date)) {
      const motherValueBefore = motherUnits * motherNav;
      const remainingTransfers = Math.max(scheduledDates.length - transferIndex, 1);
      const amount = Math.min(
        transferAmount(settings.transferRule, Number(settings.transferValue || 0), principal, motherValueBefore, remainingTransfers),
        motherValueBefore
      );
      if (amount > 0) {
        motherUnits -= amount / motherNav;
        childUnits += amount / childNav;
        transferIndex += 1;
        const motherAfter = motherUnits * motherNav;
        const childAfter = childUnits * childNav;
        const strategyAfter = motherAfter + childAfter;
        if (includeTransfers) {
          transfers.push({
            date,
            amount,
            motherNav,
            childNav,
            motherValueAfter: motherAfter,
            childValueAfter: childAfter,
            strategyValueAfter: strategyAfter,
            strategyReturnAfter: strategyAfter / principal - 1
          });
        }
      }
    }
    const motherPart = motherUnits * motherNav;
    const childPart = childUnits * childNav;
    rows.push({
      date,
      strategy: motherPart + childPart,
      motherPart,
      childPart,
      motherOnly: principal * motherNav / firstMotherNav,
      childOnly: principal * childNav / firstChildNav,
      motherNav,
      childNav
    });
    const currentReturn = rows[rows.length - 1].strategy / principal - 1;
    if (settings.takeProfitEnabled && currentReturn >= Number(settings.takeProfitTarget || 0) / 100) {
      stopSummary = {
        enabled: true,
        targetReturn: Number(settings.takeProfitTarget || 0) / 100,
        hit: true,
        exitDate: date,
        monthsToExit: diffMonths(points[0].date, date),
        exitReturn: currentReturn
      };
      break;
    }
  }
  return { rows, transfers, stopSummary };
}

function returns(values) {
  const output = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) output.push(values[i] / values[i - 1] - 1);
  }
  return output;
}

function mean(values) {
  return values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, item) => sum + (item - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(values) {
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

function computeMetric(name, rows, column) {
  const values = rows.map((row) => Number(row[column]));
  const start = parseDateKey(rows[0].date);
  const end = parseDateKey(rows[rows.length - 1].date);
  const years = Math.max((end - start) / DAY_MS / 365.25, 1 / 365.25);
  const totalReturn = values[values.length - 1] / values[0] - 1;
  const dailyReturns = returns(values);
  const volatility = dailyReturns.length > 1 ? stdev(dailyReturns) * Math.sqrt(252) : 0;
  const meanDaily = mean(dailyReturns);
  const sharpe = volatility ? meanDaily * 252 / volatility : 0;
  return {
    name,
    startValue: values[0],
    endValue: values[values.length - 1],
    totalReturn,
    cagr: (values[values.length - 1] / values[0]) ** (1 / years) - 1,
    maxDrawdown: maxDrawdown(values),
    volatility,
    sharpeRf0: sharpe
  };
}

function sampleRows(rows, maxPoints = 900) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const sampled = rows.filter((_, index) => index % step === 0);
  if (sampled[sampled.length - 1].date !== rows[rows.length - 1].date) sampled.push(rows[rows.length - 1]);
  return sampled;
}

function prettyWindows(allPoints, settings, limit = 12) {
  const allDates = allPoints.map((row) => row.date);
  const candidates = firstCommonDatesByMonth(allPoints);
  const durationMonths = Number(settings.durationMonths);
  const results = [];
  for (const start of candidates) {
    const targetEnd = addMonthsKey(start, durationMonths);
    const startIndex = lowerBound(allDates, start);
    const endIndex = lowerBound(allDates, targetEnd);
    if (startIndex >= allPoints.length || endIndex >= allPoints.length) continue;
    const windowPoints = allPoints.slice(startIndex, endIndex + 1);
    if (windowPoints.length < 25) continue;
    const { rows, transfers, stopSummary } = runStrategy(windowPoints, settings, true);
    const strategyMetric = computeMetric("母轉子策略", rows, "strategy");
    const motherMetric = computeMetric("只持有母基金", rows, "motherOnly");
    const childMetric = computeMetric("只持有子基金", rows, "childOnly");
    const strategyReturn = strategyMetric.totalReturn;
    const motherReturn = motherMetric.totalReturn;
    const childReturn = childMetric.totalReturn;
    const bestSingle = Math.max(motherReturn, childReturn);
    results.push({
      start: rows[0].date,
      end: rows[rows.length - 1].date,
      durationMonths,
      strategyReturn,
      motherReturn,
      childReturn,
      advantageVsBestSingle: strategyReturn - bestSingle,
      maxDrawdown: strategyMetric.maxDrawdown,
      beatsBoth: strategyReturn > motherReturn && strategyReturn > childReturn,
      transferCount: transfers.length,
      takeProfitHit: Boolean(stopSummary.hit),
      monthsToExit: stopSummary.monthsToExit
    });
  }
  return results
    .sort((a, b) => b.strategyReturn - a.strategyReturn || b.advantageVsBestSingle - a.advantageVsBestSingle || b.maxDrawdown - a.maxDrawdown)
    .slice(0, limit);
}

async function buildBacktest(settings) {
  const mother = await loadFund(settings.motherId);
  const child = await loadFund(settings.childId);
  const allPoints = alignedPoints(mother, child);
  if (allPoints.length < 2) throw new Error("兩檔基金沒有重疊的淨值日期");
  const selectedPoints = choosePeriod(allPoints, settings.startDate, settings.endDate, settings.durationMonths);
  const { rows, transfers, stopSummary } = runStrategy(selectedPoints, settings, true);
  const metrics = {
    strategy: computeMetric("母轉子策略", rows, "strategy"),
    motherOnly: computeMetric("只持有母基金", rows, "motherOnly"),
    childOnly: computeMetric("只持有子基金", rows, "childOnly")
  };
  const warnings = [];
  const motherProduct = mother.product || {};
  const childProduct = child.product || {};
  if (motherProduct.currency && childProduct.currency && motherProduct.currency !== childProduct.currency) {
    warnings.push(`兩檔級別幣別不同：母基金 ${motherProduct.currency}、子基金 ${childProduct.currency}。結果未換匯。`);
  }
  if (mother.seriesKind !== "nav" || child.seriesKind !== "nav") {
    warnings.push("其中一檔基金未抓到 daily NAV，已改用官網績效序列。");
  }
  const requestedStart = settings.startDate || addMonthsKey((settings.endDate || allPoints[allPoints.length - 1].date), -settings.durationMonths);
  const requestedEnd = settings.endDate || allPoints[allPoints.length - 1].date;
  if (rows[0].date !== requestedStart || rows[rows.length - 1].date !== requestedEnd) {
    warnings.push(`你選的是月份，實際回測會採用兩檔基金都有淨值的共同日期；本次實際使用 ${rows[0].date} 至 ${rows[rows.length - 1].date}。`);
  }
  const suggestions = prettyWindows(allPoints, settings);
  const totalTransferred = transfers.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const averageTransferAmount = transfers.length ? totalTransferred / transfers.length : 0;
  return {
    funds: {
      mother: { ...motherProduct, pageName: mother.pageName, seriesKind: mother.seriesKind, latestDate: mother.latestDate },
      child: { ...childProduct, pageName: child.pageName, seriesKind: child.seriesKind, latestDate: child.latestDate }
    },
    period: {
      start: rows[0].date,
      end: rows[rows.length - 1].date,
      points: rows.length,
      durationMonths: diffMonths(selectedPoints[0].date, selectedPoints[selectedPoints.length - 1].date),
      requestedDurationMonths: settings.durationMonths,
      earliest: allPoints[0].date,
      latest: allPoints[allPoints.length - 1].date,
      requestedStart,
      requestedEnd,
      commonPointCount: allPoints.length
    },
    settings,
    metrics,
    chartRows: sampleRows(rows),
    rows,
    transfers: transfers.slice(0, 500),
    transferSummary: {
      transferCount: transfers.length,
      totalTransferred,
      averageTransferAmount,
      firstTransferAmount: transfers.length ? Number(transfers[0].amount) : 0,
      initialDate: rows[0].date,
      initialMotherValue: settings.principal,
      initialChildValue: 0,
      lastTransfers: transfers.slice(-12)
    },
    suggestions,
    takeProfit: stopSummary,
    warnings,
    assumptions: [
      "使用 GitHub Actions 每日抓取 BlackRock 台灣官網頁面內嵌的 NAV 資料。",
      "前端回測在使用者瀏覽器內完成，不會連到你的本機或 Codex token。",
      "未計入申購、贖回、轉換、信託管理、稅費與匯率。",
      "轉換日若非淨值日，使用下一個兩檔基金都有淨值的日期。"
    ],
    source: state.manifest?.source || ""
  };
}

function metricCard(label, metric, subLabel) {
  const div = document.createElement("div");
  div.className = "kpi";
  div.innerHTML = `
    <div class="label">${label}</div>
    <div class="value ${signedClass(metric.totalReturn)}">${formatPct(metric.totalReturn)}</div>
    <div class="sub">期末 ${formatMoney(metric.endValue)}｜年化 ${formatPct(metric.cagr)}</div>
    <div class="sub">${subLabel}</div>
  `;
  return div;
}

function renderKpis(result) {
  const kpis = $("kpis");
  kpis.innerHTML = "";
  const strategy = result.metrics.strategy;
  const mother = result.metrics.motherOnly;
  const child = result.metrics.childOnly;
  const bestSingle = Math.max(mother.totalReturn, child.totalReturn);
  const advantage = strategy.totalReturn - bestSingle;
  kpis.appendChild(metricCard("母轉子策略", strategy, `最大跌幅 ${formatPct(strategy.maxDrawdown)}`));
  kpis.appendChild(metricCard("只持有母基金", mother, `最大跌幅 ${formatPct(mother.maxDrawdown)}`));
  kpis.appendChild(metricCard("只持有子基金", child, `最大跌幅 ${formatPct(child.maxDrawdown)}`));
  const adv = document.createElement("div");
  adv.className = "kpi";
  adv.innerHTML = `
    <div class="label">相對最佳單一基金</div>
    <div class="value ${signedClass(advantage)}">${formatPct(advantage)}</div>
    <div class="sub">轉換 ${result.transferSummary.transferCount} 次｜共 ${formatMoney(result.transferSummary.totalTransferred)}</div>
    <div class="sub">${result.period.start} 至 ${result.period.end}</div>
  `;
  kpis.appendChild(adv);
}

function renderWarnings(result) {
  const box = $("warnings");
  box.innerHTML = "";
  for (const warning of result.warnings || []) {
    const div = document.createElement("div");
    div.className = "warning";
    div.textContent = warning;
    box.appendChild(div);
  }
}

function renderTakeProfit(result) {
  const box = $("warnings");
  const tp = result.takeProfit || {};
  if (!tp.enabled) return;
  const div = document.createElement("div");
  div.className = "warning";
  div.textContent = tp.hit
    ? `停利已觸發：整包報酬率達 ${formatPct(tp.targetReturn)}，於 ${tp.exitDate} 出場，約 ${tp.monthsToExit} 個月，出場報酬 ${formatPct(tp.exitReturn)}。`
    : `停利未觸發：本區間母子整包未達 ${formatPct(tp.targetReturn)}。`;
  box.appendChild(div);
}

function chartReturnRows(rows) {
  if (!rows || !rows.length) return [];
  const base = {
    strategy: Number(rows[0].strategy),
    motherOnly: Number(rows[0].motherOnly),
    childOnly: Number(rows[0].childOnly)
  };
  return rows.map((row) => ({
    date: row.date,
    strategyReturn: Number(row.strategy) / base.strategy - 1,
    motherOnlyReturn: Number(row.motherOnly) / base.motherOnly - 1,
    childOnlyReturn: Number(row.childOnly) / base.childOnly - 1
  }));
}

function rowReturnMap(rows) {
  const output = new Map();
  for (const row of chartReturnRows(rows)) {
    output.set(row.date, row);
  }
  return output;
}

function makePath(rows, key, x, y) {
  return rows.map((row, index) => {
    const cmd = index === 0 ? "M" : "L";
    return `${cmd}${x(index).toFixed(1)},${y(Number(row[key])).toFixed(1)}`;
  }).join(" ");
}

function renderChart(rows) {
  const svg = $("chart");
  svg.innerHTML = "";
  if (!rows || rows.length < 2) return;
  const returnRows = chartReturnRows(rows);
  const width = 960;
  const height = 360;
  const padL = 58;
  const padR = 18;
  const padT = 22;
  const padB = 42;
  const keys = ["strategyReturn", "motherOnlyReturn", "childOnlyReturn"];
  const values = returnRows.flatMap((row) => keys.map((key) => Number(row[key])));
  let min = Math.min(...values);
  let max = Math.max(...values);
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  if (min === max) max = min + 1;
  const x = (i) => padL + i / Math.max(1, returnRows.length - 1) * (width - padL - padR);
  const y = (value) => padT + (max - value) / (max - min) * (height - padT - padB);
  const ns = "http://www.w3.org/2000/svg";

  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4;
    const yy = y(value);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", padL);
    line.setAttribute("x2", width - padR);
    line.setAttribute("y1", yy);
    line.setAttribute("y2", yy);
    line.setAttribute("stroke", "#e6ebf2");
    svg.appendChild(line);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", 10);
    text.setAttribute("y", yy + 4);
    text.setAttribute("fill", "#667085");
    text.setAttribute("font-size", "12");
    text.textContent = formatPct(value);
    svg.appendChild(text);
  }

  if (min < 0 && max > 0) {
    const zeroLine = document.createElementNS(ns, "line");
    zeroLine.setAttribute("x1", padL);
    zeroLine.setAttribute("x2", width - padR);
    zeroLine.setAttribute("y1", y(0));
    zeroLine.setAttribute("y2", y(0));
    zeroLine.setAttribute("stroke", "#94a3b8");
    zeroLine.setAttribute("stroke-dasharray", "4 4");
    svg.appendChild(zeroLine);
  }

  const colors = { strategyReturn: "#1f2937", motherOnlyReturn: "#315fbd", childOnlyReturn: "#c56a20" };
  for (const key of keys) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", makePath(returnRows, key, x, y));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", colors[key]);
    path.setAttribute("stroke-width", key === "strategyReturn" ? "2.6" : "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }

  const finalLabels = keys.map((key) => ({
    key,
    value: returnRows[returnRows.length - 1][key],
    y: y(returnRows[returnRows.length - 1][key]),
    color: colors[key]
  })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < finalLabels.length; i++) {
    if (finalLabels[i].y - finalLabels[i - 1].y < 16) finalLabels[i].y = finalLabels[i - 1].y + 16;
  }
  for (const item of finalLabels) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", width - padR - 4);
    text.setAttribute("y", Math.min(height - padB, Math.max(padT + 8, item.y)));
    text.setAttribute("fill", item.color);
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "700");
    text.setAttribute("text-anchor", "end");
    text.textContent = formatPct(item.value);
    svg.appendChild(text);
  }

  const first = document.createElementNS(ns, "text");
  first.setAttribute("x", padL);
  first.setAttribute("y", height - 14);
  first.setAttribute("fill", "#667085");
  first.setAttribute("font-size", "12");
  first.textContent = returnRows[0].date;
  svg.appendChild(first);
  const last = document.createElementNS(ns, "text");
  last.setAttribute("x", width - padR);
  last.setAttribute("y", height - 14);
  last.setAttribute("fill", "#667085");
  last.setAttribute("font-size", "12");
  last.setAttribute("text-anchor", "end");
  last.textContent = returnRows[returnRows.length - 1].date;
  svg.appendChild(last);
}

function renderSuggestions(result) {
  const body = $("suggestionsBody");
  const months = result.period.requestedDurationMonths || result.period.durationMonths;
  $("suggestionNote").textContent = `依目前設定的 ${months} 個月與同一套母轉子方法，掃描歷史上每個可用起點，並依母轉子策略報酬由高到低排序。`;
  body.innerHTML = "";
  for (const row of result.suggestions || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.start} 至 ${row.end}</td>
      <td class="${signedClass(row.strategyReturn)}">${formatPct(row.strategyReturn)}</td>
      <td>${formatPct(row.motherReturn)}</td>
      <td>${formatPct(row.childReturn)}</td>
      <td class="${signedClass(row.advantageVsBestSingle)}">${formatPct(row.advantageVsBestSingle)}</td>
      <td>${formatPct(row.maxDrawdown)}</td>
      <td>${row.takeProfitHit ? `${row.monthsToExit} 月` : "-"}</td>
    `;
    body.appendChild(tr);
  }
  if (!body.children.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7">尚無可排序區間</td>`;
    body.appendChild(tr);
  }
}

function renderTransfers(result) {
  const body = $("transfersBody");
  body.innerHTML = "";
  const transfers = result.transfers || [];
  const summary = result.transferSummary || {};
  const total = Number(summary.transferCount || 0);
  const shownText = total > transfers.length ? `目前顯示前 ${transfers.length} 筆。` : "已顯示全部轉換。";
  $("transferNote").textContent = `一開始本金全數放在母基金，再依設定轉出到子基金。共 ${total} 次，表格依時間由早到晚揭露。${shownText}`;
  const initial = document.createElement("tr");
  initial.innerHTML = `
    <td>${summary.initialDate || result.period.start}</td>
    <td>初始投入母基金</td>
    <td>-</td>
    <td>${formatMoney(summary.initialMotherValue || result.settings.principal)}</td>
    <td>${formatMoney(summary.initialChildValue || 0)}</td>
    <td>${formatPct(0)}</td>
  `;
  body.appendChild(initial);
  for (const row of transfers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>母轉子</td>
      <td>${formatMoney(row.amount)}</td>
      <td>${formatMoney(row.motherValueAfter)}</td>
      <td>${formatMoney(row.childValueAfter)}</td>
      <td>${formatPct(row.strategyReturnAfter)}</td>
    `;
    body.appendChild(tr);
  }
  if (body.children.length === 1 && !transfers.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6">尚無轉換紀錄</td>`;
    body.appendChild(tr);
  }
}

function renderAssumptions(result) {
  $("assumptions").textContent = (result.assumptions || []).join("　");
}

function frequencyText(value) {
  return {
    monthly_1: "每月一次",
    monthly_2: "每月兩次",
    quarterly: "每季一次",
    yearly: "每年一次",
    biweekly: "每兩週一次"
  }[value] || "每月一次";
}

const transferRuleDescriptions = {
  even_over_period: "依期間平均轉完：系統會看你的回測月數與轉換頻率，自動算出每次固定轉出多少，目標是在整段期間內把母基金逐步轉到子基金。",
  initial_percent: "本金比例：每次都用「原始本金 × 這個百分比」轉出。例如本金 100 萬、數值 5，就是每次轉 5 萬。",
  mother_percent: "母基金餘額比例：每次用「轉換當天母基金剩餘市值 × 這個百分比」轉出，所以越後面通常轉出金額會越小。",
  fixed_amount: "固定金額：每次都轉出同一個金額。例如數值填 30000，就是每次從母基金轉 3 萬到子基金。"
};

function updateTransferValueState() {
  const valueInput = $("transferValue");
  const rule = $("transferRule").value;
  const isEven = rule === "even_over_period";
  valueInput.disabled = isEven;
  valueInput.placeholder = isEven ? "依期間自動計算" : "";
  $("transferRuleHelp").textContent = transferRuleDescriptions[rule] || "";
  if (isEven) {
    $("transferValueLabel").textContent = "自動計算，不用填";
    valueInput.dataset.autoValue = "1";
    valueInput.value = "";
    const months = Number($("durationMonths").value || 0);
    const frequency = frequencyText($("frequency").value);
    $("transferValueHint").textContent = `目前設定：${months || "-"} 個月、${frequency}。按「開始回測」後會顯示實際每次轉出金額。`;
  } else if (rule === "fixed_amount") {
    valueInput.disabled = false;
    if (!valueInput.value || valueInput.dataset.autoValue === "1") valueInput.value = "30000";
    valueInput.dataset.autoValue = "0";
    $("transferValueLabel").textContent = "每次轉出金額";
    $("transferValueHint").textContent = "直接填金額。例如填 30000，就是每次轉出 3 萬。";
  } else {
    valueInput.disabled = false;
    if (!valueInput.value || valueInput.dataset.autoValue === "1") valueInput.value = "5";
    valueInput.dataset.autoValue = "0";
    $("transferValueLabel").textContent = "每次轉出比例（%）";
    $("transferValueHint").textContent = "直接填百分比數字。例如填 5，就是每次轉出 5%。";
  }
}

function renderTransferValueResult(result) {
  if (result.settings.transferRule !== "even_over_period") return;
  const valueInput = $("transferValue");
  const count = Number(result.transferSummary.transferCount || 0);
  const amount = Number(result.transferSummary.firstTransferAmount || result.transferSummary.averageTransferAmount || 0);
  valueInput.value = amount ? String(Math.round(amount)) : "";
  valueInput.dataset.autoValue = "1";
  $("transferValueLabel").textContent = "每次自動轉出金額";
  $("transferValueHint").textContent = count
    ? `本次回測實際轉換 ${count} 次，每次約 ${formatMoney(amount)}，總共轉出 ${formatMoney(result.transferSummary.totalTransferred)}。`
    : "本次區間沒有產生轉換日期。";
}

function updateTakeProfitState() {
  const enabled = $("takeProfitEnabled").checked;
  $("takeProfitTarget").disabled = !enabled;
  $("takeProfitHelp").textContent = enabled
    ? `母子整包報酬率達到 ${$("takeProfitTarget").value || 0}% 時，系統會停止回測並顯示出場月份。`
    : "未啟用時，回測會跑完整個設定區間。";
}

let lastEditedMonthField = "";

function addMonthsToMonthValue(monthValue, offset) {
  if (!monthValue) return "";
  const key = addMonthsKey(`${monthValue}-01`, offset);
  return key.slice(0, 7);
}

function syncMonthRange(changedId = "") {
  if (changedId === "startMonth" || changedId === "endMonth") lastEditedMonthField = changedId;
  const months = Math.max(1, Number($("durationMonths").value || 1));
  const start = $("startMonth").value;
  const end = $("endMonth").value;
  if (start && (!end || changedId === "startMonth" || (changedId === "durationMonths" && lastEditedMonthField !== "endMonth"))) {
    $("endMonth").value = addMonthsToMonthValue(start, months);
    lastEditedMonthField = "startMonth";
    return;
  }
  if (end && (!start || changedId === "endMonth" || changedId === "durationMonths")) {
    $("startMonth").value = addMonthsToMonthValue(end, -months);
    lastEditedMonthField = "endMonth";
  }
}

function payload() {
  return {
    motherId: $("motherSelect").value,
    childId: $("childSelect").value,
    principal: Number($("principal").value || 1000000),
    durationMonths: Math.max(1, Number($("durationMonths").value || 120)),
    startDate: $("startMonth").value ? `${$("startMonth").value}-01` : null,
    endDate: $("endMonth").value ? lastDayOfMonth($("endMonth").value) : null,
    frequency: $("frequency").value,
    transferRule: $("transferRule").value,
    transferValue: Number($("transferValue").value || 0),
    transferDay1: Number($("transferDay1").value || 1),
    transferDay2: Number($("transferDay2").value || 15),
    takeProfitEnabled: $("takeProfitEnabled").checked,
    takeProfitTarget: Number($("takeProfitTarget").value || 0)
  };
}

function renderResult(result) {
  state.lastResult = result;
  $("csvButton").disabled = false;
  renderKpis(result);
  renderWarnings(result);
  renderTakeProfit(result);
  renderChart(result.chartRows);
  renderSuggestions(result);
  renderTransfers(result);
  renderAssumptions(result);
  renderTransferValueResult(result);
}

function markSettingsChanged() {
  if (!state.lastResult) return;
  setStatus("設定已變更，請按「開始回測」更新結果與轉換路徑。");
  $("csvButton").disabled = true;
  $("transferNote").textContent = "";
  $("transfersBody").innerHTML = `<tr><td colspan="6">設定已變更，請重新回測更新轉換路徑</td></tr>`;
  $("suggestionsBody").innerHTML = `<tr><td colspan="7">設定已變更，請重新回測更新漂亮區間</td></tr>`;
  if ($("transferRule").value === "even_over_period") updateTransferValueState();
}

async function runBacktest() {
  const button = $("runButton");
  button.disabled = true;
  setStatus("回測中...");
  try {
    const result = await buildBacktest(payload());
    renderResult(result);
    const latestMother = result.funds.mother.latestDate || "-";
    const latestChild = result.funds.child.latestDate || "-";
    setStatus(`完成：${result.period.start} 至 ${result.period.end}，約 ${result.period.durationMonths} 個月。共同資料 ${result.period.commonPointCount} 筆，範圍 ${result.period.earliest} 至 ${result.period.latest}。最新淨值：母 ${latestMother}，子 ${latestChild}。`);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    button.disabled = false;
  }
}

function downloadCsv() {
  const result = state.lastResult;
  if (!result) return;
  const header = [
    "date",
    "strategy_value",
    "mother_only_value",
    "child_only_value",
    "strategy_return_pct",
    "mother_only_return_pct",
    "child_only_return_pct",
    "mother_part_value",
    "child_part_value",
    "mother_nav",
    "child_nav",
    "transfer_amount",
    "is_transfer"
  ];
  const returnMap = rowReturnMap(result.rows);
  const transferMap = new Map((result.transfers || []).map((row) => [row.date, Number(row.amount || 0)]));
  const lines = [
    csvLine([`母基金：${result.funds.mother.display || result.funds.mother.name || ""}`]),
    csvLine([`子基金：${result.funds.child.display || result.funds.child.name || ""}`]),
    csvLine([`實際回測區間：${result.period.start} 至 ${result.period.end}`]),
    csvLine([`共同資料範圍：${result.period.earliest} 至 ${result.period.latest}，${result.period.commonPointCount} 筆共同日期`]),
    header.join(",")
  ];
  for (const row of result.rows) {
    const returnsForDate = returnMap.get(row.date) || {};
    const transferAmountForDate = transferMap.get(row.date) || 0;
    lines.push(csvLine([
      row.date,
      row.strategy,
      row.motherOnly,
      row.childOnly,
      percentNumber(returnsForDate.strategyReturn),
      percentNumber(returnsForDate.motherOnlyReturn),
      percentNumber(returnsForDate.childOnlyReturn),
      row.motherPart,
      row.childPart,
      row.motherNav,
      row.childNav,
      transferAmountForDate,
      transferAmountForDate > 0 ? 1 : 0
    ]));
  }
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mother-child-backtest-${result.period.start}-${result.period.end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadCatalog() {
  setStatus("載入基金資料...");
  const [manifest, catalog] = await Promise.all([
    getJson("data/manifest.json"),
    getJson("data/catalog.json")
  ]);
  state.manifest = manifest;
  state.catalog = catalog.products || [];
  $("dataStamp").textContent = `資料更新時間：${formatTaipei(manifest.updatedAt)}｜基金清單 ${manifest.productCount || state.catalog.length} 檔｜可回測 ${manifest.fundCount || 0} 檔`;
  if (!state.catalog.length) throw new Error("尚未建立基金清單，請先執行 GitHub Actions 的資料更新。");
}

function setupEvents() {
  const debouncedMother = debounce(() => {
    searchFunds("mother");
    markSettingsChanged();
  });
  const debouncedChild = debounce(() => {
    searchFunds("child");
    markSettingsChanged();
  });
  $("motherQuery").addEventListener("input", debouncedMother);
  $("childQuery").addEventListener("input", debouncedChild);
  $("runButton").addEventListener("click", runBacktest);
  $("csvButton").addEventListener("click", downloadCsv);
  $("transferRule").addEventListener("change", () => {
    updateTransferValueState();
    markSettingsChanged();
  });
  $("takeProfitEnabled").addEventListener("change", () => {
    updateTakeProfitState();
    markSettingsChanged();
  });
  $("takeProfitTarget").addEventListener("input", () => {
    updateTakeProfitState();
    markSettingsChanged();
  });
  $("startMonth").addEventListener("change", () => {
    syncMonthRange("startMonth");
    markSettingsChanged();
  });
  $("endMonth").addEventListener("change", () => {
    syncMonthRange("endMonth");
    markSettingsChanged();
  });
  $("durationMonths").addEventListener("input", () => {
    syncMonthRange("durationMonths");
    updateTransferValueState();
    markSettingsChanged();
  });
  for (const id of ["principal", "frequency", "transferDay1", "transferDay2", "transferValue", "motherSelect", "childSelect", "takeProfitTarget"]) {
    const element = $(id);
    element.addEventListener("change", markSettingsChanged);
    if (["principal", "transferDay1", "transferDay2", "transferValue"].includes(id)) element.addEventListener("input", markSettingsChanged);
  }
  $("frequency").addEventListener("change", updateTransferValueState);
}

async function bootDashboard() {
  updateTransferValueState();
  updateTakeProfitState();
  try {
    await loadCatalog();
    searchFunds("mother");
    searchFunds("child");
    await runBacktest();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function unlock() {
  if (state.unlocked) return;
  state.unlocked = true;
  $("loginMask").classList.add("hidden");
  document.body.classList.remove("locked");
  bootDashboard();
}

function setupAuth() {
  $("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("password").value === APP_PASSWORD) {
      unlock();
    } else {
      $("loginError").textContent = "密碼不正確";
    }
  });
}

function init() {
  setupEvents();
  setupAuth();
}

init();
