# Período Mais Intenso

Calcula o **período mais intenso de 1, 3, 5 e 10 minutos** de um jogo ou treino a partir dos dados brutos do GPS, em três métricas:

- **Distância total por minuto** (m/min)
- **Distância acima de 19,8 km/h** (m)
- **Acelerações e desacelerações acima de 3 m/s²** (n)

Alguns sistemas de GPS não exportam isso. Esta ferramenta calcula a partir do export bruto.

**Usar:** abra a página publicada, arraste os arquivos e clique em Calcular. Tudo roda no seu navegador. Nenhum arquivo é enviado para lugar nenhum.

## Arquivos aceitos

- O `.zip` que o **Polar Team Pro** exporta por jogador (a ferramenta lê o `*_samples.csv` de dentro).
- Qualquer CSV de amostras com colunas de tempo, velocidade (km/h), distância acumulada (m) e, opcionalmente, aceleração (m/s²). Separador `,` ou `;`, decimal `.` ou `,`. Sem coluna de aceleração, ela é derivada da velocidade suavizada em 0,5 s.

## Como é calculado

1. Soma por segundo: distância percorrida, distância percorrida acima do limiar de velocidade e número de eventos de acc/dec iniciados (trechos em que |a| passa do limiar por pelo menos 0,3 s).
2. Janela móvel de 60, 180, 300 e 600 s sobre cada série.
3. Guarda o máximo de cada janela e o instante em que ocorreu.

Os picos cobrem a gravação inteira do arquivo (aquecimento e intervalo incluídos). "Início" e "Fim" são tempo de gravação, não minuto de jogo.

**Trava de segurança:** um segundo com velocidade acima de 40 km/h é tratado como erro de GPS e toda janela que o contenha é descartada. Se nenhuma janela sobrar, a célula mostra "—".

Limiares, janelas e a velocidade máxima plausível podem ser alterados na própria página.

## Rodar local

Abra `index.html` no navegador. As únicas dependências são JSZip e SheetJS, carregadas de CDN.

`calc.js` tem o cálculo; `test.js` é o auto-teste (`node test.js`). A pasta `python/` tem a mesma lógica em Python, que gerou os valores de referência usados para validar o JavaScript.

## Licença

MIT. Rafael Ildefonso · Escola do Jogador · [@rafael.professor](https://www.instagram.com/rafael.professor)
