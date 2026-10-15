// Período mais intenso — núcleo do cálculo (mesma lógica de GPS/periodo_mais_intenso.py).
// Roda no navegador (index.html) e no Node (test.js). Sem dependências.

const PADRAO = { janelasMin: [1, 3, 5, 10], limiarHsr: 19.8, limiarAcc: 3.0, durMinEventoS: 0.3, suavizaS: 0.5 };

function achaCol(cols, padroes, evitar = []) {
  for (let i = 0; i < cols.length; i++) {
    const lc = cols[i].toLowerCase();
    if (padroes.some(p => p.test(lc)) && !evitar.some(e => lc.includes(e))) return i;
  }
  return -1;
}

function num(s) {
  if (s == null) return NaN;
  const x = parseFloat(String(s).trim().replace(",", "."));
  return x;
}

function tempoS(s) {
  const x = Number(String(s).trim().replace(",", "."));
  if (!Number.isNaN(x) && s !== "") return x;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(String(s).trim());   // [HH:]MM:SS.f
  if (m) return (+m[1] || 0) * 3600 + +m[2] * 60 + parseFloat(m[3].replace(",", "."));
  const d = Date.parse(s);
  return Number.isNaN(d) ? NaN : d / 1000;
}

// CSV de amostras -> {t, v, passo, a} em arrays numéricos. v em km/h, passo em m por amostra, a em m/s².
function parseSamples(text) {
  const linhas = text.split(/\r?\n/).filter(l => l.trim() !== "");
  const cab = linhas[0].slice(0, 2000);
  const sep = (cab.match(/;/g) || []).length > (cab.match(/,/g) || []).length ? ";" : ",";
  const cols = linhas[0].replace(/^﻿/, "").split(sep).map(c => c.trim());
  const iT = achaCol(cols, [/timestamp/, /^time$/, /^tempo$/, /\btime\b/, /hora/, /tempo/], ["lap", "volta", "zona", "zone", "dura"]);
  const iV = achaCol(cols, [/speed/, /veloc/], ["max", "máx", "med", "méd", "zone", "zona"]);
  const iD = achaCol(cols, [/distance/, /dist[âa]ncia/], ["zone", "zona", "/", "min"]);
  const iA = achaCol(cols, [/accel/, /aceler/]);
  if (iT < 0) throw new Error("coluna de tempo não encontrada: " + cols.join(", "));
  if (iV < 0 && iD < 0) throw new Error("sem coluna de velocidade nem de distância");

  const t = [], v = [], d = [], a = [];
  let t0 = null;
  for (let i = 1; i < linhas.length; i++) {
    const c = linhas[i].split(sep);
    const ts = tempoS(c[iT]);
    if (Number.isNaN(ts)) continue;
    if (t0 === null) t0 = ts;
    t.push(ts - t0);
    v.push(iV >= 0 ? num(c[iV]) : NaN);
    d.push(iD >= 0 ? num(c[iD]) : NaN);
    a.push(iA >= 0 ? num(c[iA]) : NaN);
  }
  if (t.length && t[t.length - 1] > 1e5) for (let i = 0; i < t.length; i++) t[i] /= 1000;   // ms -> s

  const n = t.length;
  // ffill
  for (let i = 1; i < n; i++) { if (Number.isNaN(v[i])) v[i] = v[i - 1]; if (Number.isNaN(d[i])) d[i] = d[i - 1]; }
  for (let i = 0; i < n; i++) { if (Number.isNaN(v[i])) v[i] = 0; if (Number.isNaN(d[i])) d[i] = 0; if (Number.isNaN(a[i])) a[i] = 0; }

  const dt = new Float64Array(n);
  const dts = [];
  for (let i = 1; i < n; i++) { dt[i] = Math.min(Math.max(t[i] - t[i - 1], 0), 5); if (dt[i] > 0) dts.push(dt[i]); }
  dts.sort((x, y) => x - y);
  const dtMed = dts.length ? dts[Math.floor(dts.length / 2)] : 1;
  dt[0] = dtMed;

  let passo = new Float64Array(n);
  if (iD >= 0) {
    let neg = 0, max = -Infinity;
    for (let i = 1; i < n; i++) { passo[i] = d[i] - d[i - 1]; if (passo[i] < 0) neg++; if (d[i] > max) max = d[i]; }
    if (neg / n > 0.01 || max < 50) for (let i = 0; i < n; i++) passo[i] = d[i];   // já é por amostra
    for (let i = 0; i < n; i++) if (passo[i] < 0) passo[i] = 0;
  } else {
    for (let i = 0; i < n; i++) passo[i] = v[i] / 3.6 * dt[i];
  }
  if (iV < 0) for (let i = 0; i < n; i++) v[i] = dt[i] > 0 ? passo[i] / dt[i] * 3.6 : 0;

  let acc;
  if (iA >= 0) acc = Float64Array.from(a);
  else {   // deriva da velocidade suavizada
    const hz = 1 / Math.max(dtMed, 1e-3), k = Math.max(Math.round(PADRAO.suavizaS * hz), 1);
    const vs = new Float64Array(n), h = Math.floor(k / 2);
    for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i - h + k - 1); j++) { s += v[j] / 3.6; c++; } vs[i] = s / c; }
    acc = new Float64Array(n);
    for (let i = 0; i < n; i++) { const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1); acc[i] = t[i1] > t[i0] ? (vs[i1] - vs[i0]) / (t[i1] - t[i0]) : 0; }
  }
  return { t, v: Float64Array.from(v), passo, a: acc, hz: 1 / dtMed };
}

// Séries por segundo inteiro: dist (m), hsr (m), accDec (eventos iniciados naquele segundo).
function seriesPorSegundo(s, cfg) {
  const { t, v, passo, a } = s, n = t.length;
  const nSeg = Math.floor(t[n - 1]) + 1;
  const dist = new Float64Array(nSeg), hsr = new Float64Array(nSeg), accDec = new Float64Array(nSeg);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(t[i]);
    dist[k] += passo[i];
    if (v[i] > cfg.limiarHsr) hsr[k] += passo[i];
  }
  for (const sinal of [1, -1]) {
    let dentro = false, ini = 0;
    for (let i = 0; i <= n; i++) {
      const acima = i < n && a[i] * sinal > cfg.limiarAcc;
      if (acima && !dentro) { dentro = true; ini = i; }
      else if (!acima && dentro) {
        dentro = false;
        const f = Math.min(i, n - 1);
        if (t[f] - t[ini] >= cfg.durMinEventoS) accDec[Math.floor(t[ini])] += 1;
      }
    }
  }
  return { dist, hsr, accDec };
}

function picoJanela(x, w) {
  if (x.length < w) { let s = 0; for (const y of x) s += y; return { max: s, ini: 0 }; }
  let soma = 0;
  for (let i = 0; i < w; i++) soma += x[i];
  let max = soma, ini = 0;
  for (let i = w; i < x.length; i++) { soma += x[i] - x[i - w]; if (soma > max) { max = soma; ini = i - w + 1; } }
  return { max, ini };
}

function hms(s) { s = Math.floor(s); const p = n => String(n).padStart(2, "0"); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`; }

function analisar(text, jogador, cfg = {}) {
  cfg = { ...PADRAO, ...cfg };
  const g = seriesPorSegundo(parseSamples(text), cfg);
  const metricas = [["dist", `Distância total/min`, "m"], ["hsr", `Distância > ${cfg.limiarHsr} km/h`, "m"], ["accDec", `Acc+Dec > ${Number(cfg.limiarAcc).toFixed(1)} m/s²`, "n"]];
  const out = [];
  for (const m of cfg.janelasMin) {
    const w = m * 60;
    for (const [k, rot, unid] of metricas) {
      const { max, ini } = picoJanela(g[k], w);
      out.push({ Jogador: jogador, "Janela (min)": m, "Métrica": rot, "Valor no pico": k === "accDec" ? Math.round(max) : Math.round(max * 10) / 10,
                 Unidade: unid, "Por minuto": Math.round(max / m * 100) / 100, "Início": hms(ini), Fim: hms(ini + w) });
    }
  }
  return out;
}

// Polar: data_hora_numero_Nome_Nome_samples.csv -> "numero Nome"
function nomeJogador(nomeArquivo) {
  const base = nomeArquivo.split("/").pop().replace(/\.csv$/i, "");
  const m = /^\d{8}_\d{6}_(\d+)_([^_]+)_/.exec(base);
  return m ? `${m[1]} ${m[2]}` : base.replace("_samples", "");
}

if (typeof module !== "undefined") module.exports = { analisar, nomeJogador, parseSamples, seriesPorSegundo, picoJanela, PADRAO };
