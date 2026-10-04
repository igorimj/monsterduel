import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY;

const CAP = { C: 25, B: 50, A: 100 };
const SK = ['atk', 'def', 'vel', 'int', 'pod'];
const STAT_MAP = { ataque: 'atk', defesa: 'def', velocidade: 'vel', inteligencia: 'int', poder: 'pod' };
const other = (p) => (p === 'p1' ? 'p2' : 'p1');

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

const games = new Map(); // code -> game (em memória)

function newGame(pid) {
  let code;
  do code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[randomBytes(1)[0] % 24]).join('');
  while (games.has(code));
  const g = {
    code, pids: { p1: pid, p2: null }, socks: { p1: null, p2: null },
    stage: 'lobby', round: 'C', wins: { p1: 0, p2: 0 }, mons: {}, revealed: new Set(),
    choice: { p1: null, p2: null }, last: null, res: null, champ: null, err: null, busy: false, touched: Date.now(),
  };
  games.set(code, g);
  return g;
}

function options(g, p) {
  const r = g.round;
  if (r === 'C') return [`${p}_C`];
  const prev = r === 'B' ? 'C' : 'B';
  if (g.last?.winner === p && g.mons[`evo_${prev}`]) return [`evo_${prev}`, `${p}_${r}`];
  return [`${p}_${r}`];
}

function view(g, me) {
  const mons = {};
  for (const [id, m] of Object.entries(g.mons)) {
    if (m.owner === me || g.revealed.has(id)) mons[id] = m;
  }
  const other_ = me ? other(me) : null;
  const theirCount = other_ ? Object.values(g.mons).filter((m) => m.owner === other_ && !m.evolved).length : 0;
  return {
    code: g.code, me, stage: g.stage, round: g.round, wins: g.wins, mons, theirCount,
    choice: g.choice, options: me ? options(g, me) : [], last: g.last, res: g.res, champ: g.champ,
    err: g.err, busy: g.busy, joined: !!g.pids.p2,
  };
}

function broadcast(g) {
  g.touched = Date.now();
  for (const p of ['p1', 'p2']) {
    const ws = g.socks[p];
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', s: view(g, p) }));
  }
}

async function toPng(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  const out = await sharp(buf, { density: 150 }).resize(384, 384, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
  return out.toString('base64');
}
const imgBlock = (b64) => ({ type: 'image', data: b64 });
const describe = (m, l) => `${l}: "${m.name}" (classe ${m.cls}, overall ${m.overall}${m.evolved ? ', EVOLUÍDO' : ''}) — pontos: ` +
  `Ataque ${m.stats.atk}, Defesa ${m.stats.def}, Velocidade ${m.stats.vel}, Inteligência ${m.stats.int}, Poder especial ${m.stats.pod}`;

// Chamada à API do Gemini (plano gratuito do Google AI Studio)
async function ask(content, maxOut = 8192, json = false) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY não configurada no servidor');
  const parts = content.map((b) => (b.type === 'image' ? { inline_data: { mime_type: 'image/png', data: b.data } } : { text: b.text }));
  const body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxOut, ...(json ? { responseMimeType: 'application/json' } : {}) } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY }, body: JSON.stringify(body),
    });
    if (r.status === 429 && attempt < 2) { await new Promise((x) => setTimeout(x, 15000)); continue; } // limite do plano grátis: espera e tenta de novo
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message || 'erro'}`.slice(0, 300));
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('A IA não retornou texto (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'vazio') + ')');
    return text;
  }
}

async function runJudge(g) {
  if (g.busy) return;
  g.busy = true; g.err = null; broadcast(g);
  try {
    const a = g.mons[g.choice.p1], b = g.mons[g.choice.p2], r = g.round;
    const [ia, ib] = await Promise.all([toPng(a.img), toPng(b.img)]);
    const text = await ask([
      imgBlock(ia), imgBlock(ib),
      { type: 'text', text: `Você é o juiz de um duelo de monstros desenhados por dois jogadores. As duas imagens anexas são, na ordem, o Monstro 1 e o Monstro 2.
${describe(a, 'Monstro 1')}
${describe(b, 'Monstro 2')}
Avalie cada monstro de 0 a 10 nos critérios: ataque, defesa, velocidade, inteligencia, poder, aparencia (aparência/intimidação), criatividade. Use os pontos distribuídos como referência, mas interprete visualmente o desenho (garras, asas, armadura, cauda, olhos etc.). Escolha um vencedor. Depois identifique o MAIOR PONTO FORTE VISUAL do perdedor (uma característica física concreta que o vencedor possa absorver, ex.: "asas membranosas", "tentáculos", "placas de armadura").
Responda SOMENTE JSON: {"scores":{"m1":{"ataque":0,"defesa":0,"velocidade":0,"inteligencia":0,"poder":0,"aparencia":0,"criatividade":0},"m2":{...}},"winner":"m1" ou "m2","verdict":"2-3 frases narrando o duelo em português","trait":"característica física absorvida do perdedor","traitStat":"ataque|defesa|velocidade|inteligencia|poder"}` },
    ], 4096, true);
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    const w = j.winner === 'm2' ? 'p2' : 'p1', l = other(w);
    const wm = g.mons[g.choice[w]], lm = g.mons[g.choice[l]];
    const res = { winner: w, scores: { p1: j.scores.m1, p2: j.scores.m2 }, verdict: String(j.verdict || ''), trait: String(j.trait || ''), evoId: null };

    if (r !== 'A') {
      const target = r === 'C' ? 50 : 100;
      const [wb, lb] = await Promise.all([toPng(wm.img), toPng(lm.img)]);
      const out = await ask([
        imgBlock(wb), imgBlock(lb),
        { type: 'text', text: `Redesenhe o monstro vencedor "${wm.name}" (primeira imagem) como uma EVOLUÇÃO sua, absorvendo fisicamente este traço do monstro perdedor "${lm.name}" (segunda imagem): ${res.trait}. Mantenha a identidade, cores e pose do vencedor e incorpore visivelmente o traço, deixando o monstro mais poderoso e imponente. Se o vencedor já tiver traços absorvidos antes, preserve-os.
Responda SOMENTE com um SVG válido: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360">, fundo branco (um rect), formas simples (path, ellipse, circle, polygon, gradientes), sem scripts, sem imagens externas, sem texto, no máximo 9000 caracteres.` },
      ], 8192);
      const mt = out.match(/<svg[\s\S]*<\/svg>/i);
      let img = wm.img;
      if (mt) {
        const clean = mt[0].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/<(image|foreignObject)[\s\S]*?(\/>|<\/\1>)/gi, '');
        await sharp(Buffer.from(clean)).png().toBuffer(); // valida o SVG
        img = 'data:image/svg+xml;base64,' + Buffer.from(clean).toString('base64');
      }
      const sk = STAT_MAP[j.traitStat] || SK.reduce((x, k) => (lm.stats[k] > lm.stats[x] ? k : x), 'atk');
      const raw = {}; SK.forEach((k) => (raw[k] = wm.stats[k] + (k === sk ? lm.stats[k] * 0.5 : 0)));
      const tot = SK.reduce((s, k) => s + raw[k], 0) || 1, st = {};
      SK.forEach((k) => (st[k] = Math.round((raw[k] / tot) * target)));
      st[sk] += target - SK.reduce((s, k) => s + st[k], 0);
      g.mons[`evo_${r}`] = { owner: w, cls: r, name: wm.name.replace(/ \+.*$/, '') + ' +' + res.trait.slice(0, 24), stats: st, overall: target, img, evolved: true, trait: res.trait };
      g.revealed.add(`evo_${r}`);
      res.evoId = `evo_${r}`;
    }
    g.wins[w]++; g.res = res; g.stage = 'result';
  } catch (e) {
    console.error('judge error', e);
    g.err = e.message || 'falha na IA';
  }
  g.busy = false; broadcast(g);
}

function tick(g) { // avança automaticamente quando possível
  if (g.stage === 'draw') {
    const done = (p) => ORD.every((c) => g.mons[`${p}_${c}`]);
    if (done('p1') && done('p2')) { g.stage = 'pick'; g.round = 'C'; }
  }
  if (g.stage === 'pick') {
    for (const p of ['p1', 'p2']) { const o = options(g, p); if (!g.choice[p] && o.length === 1) g.choice[p] = o[0]; }
    if (g.choice.p1 && g.choice.p2) { g.stage = 'judging'; g.choice.p1 && g.revealed.add(g.choice.p1); g.revealed.add(g.choice.p2); }
  }
  broadcast(g);
  if (g.stage === 'judging' && !g.busy) runJudge(g);
}
const ORD = ['C', 'B', 'A'];

wss.on('connection', (ws) => {
  let g = null, me = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === 'create') {
        g = newGame(String(m.pid).slice(0, 64)); me = 'p1'; g.socks.p1 = ws;
        return broadcast(g);
      }
      if (m.t === 'join') {
        g = games.get(String(m.code || '').toUpperCase());
        if (!g) return ws.send(JSON.stringify({ t: 'error', msg: 'Sala não encontrada' }));
        const pid = String(m.pid).slice(0, 64);
        if (g.pids.p1 === pid) me = 'p1';
        else if (g.pids.p2 === pid) me = 'p2';
        else if (!g.pids.p2) { g.pids.p2 = pid; me = 'p2'; g.stage = 'draw'; }
        else { me = null; return ws.send(JSON.stringify({ t: 'state', s: view(g, null) })); }
        g.socks[me] = ws;
        return tick(g);
      }
      if (!g || !me) return;
      if (m.t === 'save' && g.stage === 'draw') {
        const cls = m.cls, cap = CAP[cls];
        if (!cap || g.mons[`${me}_${cls}`]) return;
        const stats = {}; let sum = 0;
        for (const k of SK) { const v = Math.max(0, Math.floor(+m.stats?.[k] || 0)); stats[k] = v; sum += v; }
        if (sum < 1 || sum > cap) return ws.send(JSON.stringify({ t: 'error', msg: `Distribua entre 1 e ${cap} pontos` }));
        if (typeof m.img !== 'string' || !m.img.startsWith('data:image/png;base64,') || m.img.length > 900000) return;
        g.mons[`${me}_${cls}`] = { owner: me, cls, name: String(m.name || 'Monstro').slice(0, 30), stats, overall: cap, img: m.img };
        return tick(g);
      }
      if (m.t === 'pick' && g.stage === 'pick') {
        if (options(g, me).includes(m.id) && !g.choice[me]) { g.choice[me] = m.id; return tick(g); }
      }
      if (m.t === 'retry' && g.stage === 'judging' && !g.busy) return runJudge(g);
      if (m.t === 'next' && g.stage === 'result') {
        const w = g.res.winner;
        if (g.round === 'A' || g.wins[w] >= 2) {
          g.stage = 'end'; g.champ = g.wins.p1 > g.wins.p2 ? 'p1' : g.wins.p2 > g.wins.p1 ? 'p2' : w;
          for (const id of Object.keys(g.mons)) g.revealed.add(id);
          return broadcast(g);
        }
        g.last = { winner: w }; g.round = g.round === 'C' ? 'B' : 'A';
        g.stage = 'pick'; g.choice = { p1: null, p2: null }; g.res = null;
        return tick(g);
      }
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => { if (g && me && g.socks[me] === ws) g.socks[me] = null; });
});

setInterval(() => { // limpa salas inativas (6h)
  for (const [c, g] of games) if (Date.now() - g.touched > 6 * 3600e3) games.delete(c);
}, 600e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Monster Duel em http://localhost:${PORT} (modelo: ${MODEL}, IA: ${API_KEY ? 'ok' : 'SEM CHAVE'})`));
