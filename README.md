# 👾 Monster Duel

Jogo multiplayer para 2 jogadores. Cada um desenha 3 monstros (classes **C ≤25**, **B ≤50**, **A ≤100** pontos) e distribui os pontos entre Ataque, Defesa, Velocidade, Inteligência e Poder especial. Em cada rodada a IA (Claude) olha os desenhos, avalia 7 critérios, declara o vencedor e **redesenha o monstro vencedor absorvendo um traço visual do perdedor** (overall 50 após a rodada C, 100 após a B). O vencedor da rodada escolhe entre o monstro evoluído e o desenho original. Quem vencer C e B é campeão; se houver empate 1×1, a rodada A decide.

Stack: Node 20 + Express + WebSocket (`ws`) + Anthropic SDK + `sharp` (SVG→PNG). Estado das partidas fica **em memória** no servidor.

## Rodar localmente
```bash
npm install
cp .env.example .env   # preencha ANTHROPIC_API_KEY
export $(grep -v '^#' .env | xargs) && npm start
# abra http://localhost:3000 em duas abas/dispositivos
```

## Git
```bash
git init && git add . && git commit -m "Monster Duel"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/monster-duel.git
git push -u origin main
```

## Deploy no Render
1. No Render: **New → Blueprint** e aponte para o repositório (usa `render.yaml`), ou **New → Web Service** com Build `npm install` e Start `npm start`.
2. Em **Environment**, defina `ANTHROPIC_API_KEY` (e opcionalmente `CLAUDE_MODEL`, padrão `claude-sonnet-5-5`).
3. Health check: `/healthz`. WebSockets funcionam no Render sem configuração extra.

Observações: no plano gratuito o serviço hiberna após inatividade (a primeira conexão demora) e reiniciar o servidor apaga as salas em andamento. Cada duelo C/B faz 2 chamadas à API (julgamento + evolução); a rodada A faz 1.
