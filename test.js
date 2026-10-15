// node test.js                -> auto-teste sintético
// node test.js <pasta> <ref.csv> -> roda nos *_samples.csv da pasta e compara com o CSV de referência do Python
const fs = require("fs"), path = require("path");
const { analisar, nomeJogador } = require("./calc.js");

function sintetico() {
  // 1 Hz, 20 min a 6 km/h; de 600 a 660 s: 25 km/h, com 1 acc e 1 dec de 2 s a |4| m/s²
  const L = ["Time,Speed [km/h],Distance [m],Acceleration [m/s²]"];
  let d = 0;
  for (let s = 0; s < 1200; s++) {
    const v = s >= 600 && s < 660 ? 25 : 6; d += v / 3.6;
    const a = (s === 610 || s === 611) ? 4 : (s === 640 || s === 641) ? -4 : 0;
    L.push(`${s},${v},${d.toFixed(3)},${a}`);
  }
  const r = analisar(L.join("\n"), "Teste");
  const g = (m, met) => r.find(x => x["Janela (min)"] === m && x["Métrica"].startsWith(met));
  const ok = (c, msg) => { if (!c) throw new Error("FALHOU: " + msg); };
  ok(Math.abs(g(1, "Distância total")["Valor no pico"] - 416.7) < 1, "dist 1 min");
  ok(g(1, "Distância total")["Início"] === "00:10:00", "início");
  ok(Math.abs(g(1, "Distância >")["Valor no pico"] - 416.7) < 1, "hsr 1 min");
  ok(g(1, "Acc+Dec")["Valor no pico"] === 2, "acc 1 min");
  ok(g(10, "Acc+Dec")["Valor no pico"] === 2, "acc 10 min");
  ok(Math.abs(g(10, "Distância total")["Por minuto"] - 131.7) < 1, "dist 10 min");
  // erro de GPS: 50 km/h em 620 s -> janelas que contêm 620 s são descartadas
  const L2 = L.map((l, i) => i === 621 ? l.replace(/^620,25,/, "620,50,") : l);
  const r2 = analisar(L2.join("\n"), "T2");
  const g2 = (m, met) => r2.find(x => x["Janela (min)"] === m && x["Métrica"].startsWith(met));
  ok(g2(1, "Distância total")["Início"] === "00:10:21", "trava: início " + g2(1, "Distância total")["Início"]);
  ok(Math.abs(g2(1, "Distância total")["Valor no pico"] - 305.8) < 1, "trava: valor");
  ok(g2(10, "Acc+Dec")["Valor no pico"] === 1, "trava: acc 10 min");
  ok(r2.segundosExcluidos === 1, "trava: segundos excluídos");
  console.log("auto-teste OK");
}

if (process.argv.length < 4) { sintetico(); process.exit(); }

const [pasta, ref] = process.argv.slice(2);
const linhas = [];
for (const f of fs.readdirSync(pasta).filter(f => /_samples\.csv$/i.test(f))) {
  linhas.push(...analisar(fs.readFileSync(path.join(pasta, f), "utf8"), nomeJogador(f)));
}
// referência: CSV exportado do pandas com as mesmas colunas
const refL = fs.readFileSync(ref, "utf8").trim().split(/\r?\n/).map(l => l.split(";"));
const cab = refL[0];
const chave = r => `${r["Jogador"]}|${r["Janela (min)"]}|${r["Métrica"]}`;
const mapa = new Map(linhas.map(r => [chave(r), r]));
let difs = 0;
for (const l of refL.slice(1)) {
  const o = Object.fromEntries(cab.map((c, i) => [c, l[i]]));
  const js = mapa.get(`${o["Jogador"]}|${+o["Janela (min)"]}|${o["Métrica"]}`);
  if (!js) { console.log("faltou", chave(o)); difs++; continue; }
  for (const c of ["Valor no pico", "Por minuto", "Início"]) {
    const a = js[c], b = isNaN(+o[c]) ? o[c] : +o[c];
    if (typeof b === "number" ? Math.abs(a - b) > 0.15 : a !== b) { console.log("dif", chave(o), c, a, b); difs++; }
  }
}
console.log(`${refL.length - 1} linhas comparadas, ${difs} diferenças`);
process.exit(difs ? 1 : 0);
