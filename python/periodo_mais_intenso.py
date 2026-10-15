"""
Período mais intenso (janelas móveis de 1, 3, 5 e 10 min) a partir do export BRUTO
do Polar Team Pro (CSV por jogador, 1 ou 10 Hz).

Uso:
    python GPS/periodo_mais_intenso.py                    # todos os .zip/.csv de GPS/brutos
    python GPS/periodo_mais_intenso.py jogador1.zip ...   # zips da Polar (ou o *_samples.csv de dentro)
    python GPS/periodo_mais_intenso.py --test             # auto-teste sintético

Saída: GPS/periodos_intensos.xlsx (+ tabela no terminal).

Métricas por janela:
    dist      distância total / minuto (m/min)              -> pico da média móvel
    hsr       distância acima de LIMIAR_HSR km/h (m)         -> pico da soma móvel
    acc_dec   nº de acelerações + desacelerações > LIMIAR_ACC m/s² -> pico da contagem móvel
"""
import sys, re, glob, os, io, zipfile, tempfile
import numpy as np
import pandas as pd

JANELAS_MIN = [1, 3, 5, 10]
LIMIAR_HSR = 19.8       # km/h
LIMIAR_ACC = 3.0        # m/s²  (|a| > 3)
SUAVIZA_S = 0.5         # s de média móvel na velocidade antes de derivar a aceleração (só se o CSV não trouxer aceleração)
DUR_MIN_EVENTO_S = 0.3  # ponytail: um evento de acc/dec precisa durar >= 0.3 s; ajuste se a Polar contar diferente


# ---------- leitura tolerante ----------
def ler_csv(path):
    raw = open(path, "rb").read()
    txt = None
    for enc in ("utf-8-sig", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            pass
    sep = ";" if txt[:2000].count(";") > txt[:2000].count(",") else ","
    df = pd.read_csv(io.StringIO(txt), sep=sep, decimal="," if sep == ";" else ".", low_memory=False)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def acha_col(df, *padroes, evitar=()):
    for c in df.columns:
        lc = c.lower()
        if any(re.search(p, lc) for p in padroes) and not any(e in lc for e in evitar):
            return c
    return None


def to_num(s):
    return pd.to_numeric(s.astype(str).str.replace(",", ".", regex=False), errors="coerce")


def tempo_s(df):
    c = acha_col(df, r"timestamp", r"^time$", r"^tempo$", r"\btime\b", r"hora", r"tempo",
                 evitar=("lap", "volta", "zona", "zone", "dura"))
    if c is None:
        raise ValueError("coluna de tempo não encontrada: " + ", ".join(df.columns))
    s = df[c]
    t = to_num(s)
    if t.notna().mean() > 0.9:                        # já é segundos (ou ms)
        t = t.astype(float)
        if t.max() > 1e5:
            t = t / 1000.0
        return (t - t.iloc[0]).to_numpy(), c
    try:                                              # texto HH:MM:SS.fff
        td = pd.to_timedelta(s.astype(str), errors="coerce")
        if td.notna().mean() > 0.9:
            return (td - td.iloc[0]).dt.total_seconds().to_numpy(), c
    except Exception:
        pass
    dt = pd.to_datetime(s, errors="coerce")           # datetime
    return (dt - dt.iloc[0]).dt.total_seconds().to_numpy(), c


# ---------- núcleo ----------
def series_por_segundo(df):
    """DataFrame indexado por segundo inteiro: dist (m), hsr (m), acc_dec (eventos iniciados)."""
    t, _ = tempo_s(df)
    ok = ~np.isnan(t)
    df, t = df[ok].reset_index(drop=True), t[ok]
    dt = np.diff(t, prepend=t[0])
    dt[0] = np.median(dt[1:]) if len(dt) > 1 else 1.0
    dt = np.clip(dt, 0, 5)                            # buraco de GPS não vira distância gigante

    cv = acha_col(df, r"speed", r"veloc", evitar=("max", "máx", "med", "méd", "zone", "zona"))
    v = to_num(df[cv]).ffill().fillna(0).to_numpy() if cv else None   # km/h

    cd = acha_col(df, r"distance", r"dist[âa]ncia", evitar=("zone", "zona", "/", "min"))
    if cd:
        d = to_num(df[cd]).ffill().fillna(0).to_numpy()
        passo = np.diff(d, prepend=d[0])
        passo[0] = 0
        if (passo < 0).mean() > 0.01 or np.nanmax(d) < 50:   # não é cumulativa -> já é por amostra
            passo = d
        passo = np.clip(passo, 0, None)
    elif v is not None:
        passo = v / 3.6 * dt
    else:
        raise ValueError("sem coluna de velocidade nem de distância")
    if v is None:
        v = np.where(dt > 0, passo / np.where(dt > 0, dt, 1) * 3.6, 0)

    hsr = np.where(v > LIMIAR_HSR, passo, 0.0)

    ca = acha_col(df, r"accel", r"aceler")
    if ca:
        a = to_num(df[ca]).fillna(0).to_numpy()
    else:
        hz = 1.0 / max(np.median(dt[dt > 0]), 1e-3)
        k = max(int(round(SUAVIZA_S * hz)), 1)
        vs = pd.Series(v / 3.6).rolling(k, center=True, min_periods=1).mean().to_numpy()
        a = np.gradient(vs, t)

    ev = np.zeros(len(a))
    for sinal in (1, -1):
        acima = (a * sinal) > LIMIAR_ACC
        borda = np.diff(acima.astype(int), prepend=0)
        inicios = np.flatnonzero(borda == 1)
        fins = np.flatnonzero(borda == -1)
        for i in inicios:
            f = fins[fins > i]
            f = f[0] if len(f) else len(a) - 1
            if t[f] - t[i] >= DUR_MIN_EVENTO_S:
                ev[i] += 1

    seg = np.floor(t).astype(int)
    g = pd.DataFrame({"dist": passo, "hsr": hsr, "acc_dec": ev}).groupby(seg).sum()
    return g.reindex(range(0, seg.max() + 1), fill_value=0.0)


def pico_janela(serie, w):
    """soma móvel de w segundos -> (max, segundo inicial)"""
    x = serie.to_numpy(dtype=float)
    if len(x) < w:
        return float(x.sum()), 0
    c = np.concatenate([[0.0], np.cumsum(x)])
    somas = c[w:] - c[:-w]
    i = int(np.argmax(somas))
    return float(somas[i]), i


def hms(s):
    s = int(s)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


METRICAS = (("dist", "Distância total/min", "m"),
            ("hsr", f"Distância > {LIMIAR_HSR} km/h", "m"),
            ("acc_dec", f"Acc+Dec > {LIMIAR_ACC} m/s²", "n"))


def analisar(df, nome):
    g = series_por_segundo(df)
    linhas = []
    for m in JANELAS_MIN:
        w = m * 60
        for met, rot, unid in METRICAS:
            val, i = pico_janela(g[met], w)
            linhas.append({"Jogador": nome, "Janela (min)": m, "Métrica": rot,
                           "Valor no pico": int(val) if met == "acc_dec" else round(val, 1),
                           "Unidade": unid, "Por minuto": round(val / m, 2),
                           "Início": hms(i), "Fim": hms(i + w)})
    return pd.DataFrame(linhas)


def nome_jogador(df, path):
    c = acha_col(df, r"player name", r"nome do jogador", r"^name$", r"^nome$", r"jogador")
    if c and df[c].notna().any():
        return str(df[c].dropna().iloc[0])
    base = os.path.splitext(os.path.basename(path))[0]
    m = re.match(r"\d{8}_\d{6}_(\d+)_([^_]+)_", base)   # Polar: data_hora_numero_Nome_Nome_samples
    return f"{m.group(1)} {m.group(2)}" if m else base.replace("_samples", "")


# ---------- auto-teste ----------
def _test():
    # 1 Hz, 20 min a 6 km/h (100 m/min); de 600 s a 660 s: 25 km/h (416,7 m/min, > 19,8),
    # com 1 acc e 1 dec de 2 s em |a| = 4 m/s²
    t = np.arange(0, 1200, 1.0)
    v = np.full_like(t, 6.0)
    v[600:660] = 25.0
    a = np.zeros_like(t)
    a[610:612] = 4.0
    a[640:642] = -4.0
    df = pd.DataFrame({"Player name": "Teste", "Time": t, "Speed [km/h]": v,
                       "Distance [m]": np.cumsum(v / 3.6), "Acceleration [m/s2]": a})
    r = analisar(df, "Teste").set_index(["Janela (min)", "Métrica"])
    D, H, A = (m[1] for m in METRICAS)
    assert 400 <= r.loc[(1, D), "Valor no pico"] <= 420, r.loc[(1, D), "Valor no pico"]
    assert r.loc[(1, D), "Início"] == "00:10:00"
    assert 400 <= r.loc[(1, H), "Valor no pico"] <= 420
    assert r.loc[(1, A), "Valor no pico"] == 2
    assert r.loc[(10, A), "Valor no pico"] == 2
    assert abs(r.loc[(10, D), "Por minuto"] - 131.7) < 1   # (416,7*1 + 100*9)/10
    print("auto-teste OK")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--test"]:
        _test()
        sys.exit()
    aqui = os.path.dirname(os.path.abspath(__file__))
    paths = []
    tmp = tempfile.mkdtemp()
    for a in args or [os.path.join(aqui, "brutos")]:
        itens = sorted(glob.glob(os.path.join(a, "*.zip")) + glob.glob(os.path.join(a, "*_samples.csv"))) if os.path.isdir(a) else [a]
        for it in itens:
            if it.lower().endswith(".zip"):          # export Polar: 1 zip por jogador, CSV em *_samples.csv
                with zipfile.ZipFile(it) as z:
                    for n in z.namelist():
                        if n.lower().endswith("_samples.csv"):
                            paths.append(z.extract(n, tmp))
            else:
                paths.append(it)
    if not paths:
        sys.exit("nenhum CSV encontrado")
    res = []
    for p in paths:
        df = ler_csv(p)
        res.append(analisar(df, nome_jogador(df, p)).assign(Arquivo=os.path.basename(p)))
        print(f"ok {p} ({len(df)} amostras)")
    out = pd.concat(res, ignore_index=True)
    dest = os.path.join(aqui, "periodos_intensos.xlsx")
    out.to_excel(dest, index=False)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_rows", 500)
    print(out.drop(columns="Arquivo").to_string(index=False))
    print("\n->", dest)
