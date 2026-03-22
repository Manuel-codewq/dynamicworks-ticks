/* ═══════════════════════════════════════════════════════════════
   DynamicWorks Angola — Tick Server
   Liga à Deriv via WebSocket e guarda os últimos 300 ticks
   de cada ativo no Firebase Realtime Database.
   A app lê esses ticks ao abrir → gráfico cheio imediatamente.
   ─────────────────────────────────────────────────────────────
   Deploy: Render.com (free tier — sempre ligado)
   Variáveis de ambiente necessárias:
     FIREBASE_DB_URL  = https://dynamicworks-angola-default-rtdb.firebaseio.com
     FIREBASE_SECRET  = <teu Database Secret do Firebase Console>
═══════════════════════════════════════════════════════════════ */

'use strict';

const WebSocket = require('ws');
const https     = require('https');

/* ── Configuração ── */
const DERIV_APP_ID  = 127916;
const DERIV_WS_URL  = `wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}&l=PT`;
const TICKS_MAX     = 300;   /* ticks guardados por ativo */
const SAVE_INTERVAL = 2000;  /* gravar no Firebase de 2 em 2 segundos */
const PING_INTERVAL = 25000; /* ping para manter ligação viva */

const ASSETS = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
];

/* ── Firebase config (via variáveis de ambiente) ── */
const DB_URL    = process.env.FIREBASE_DB_URL
                  || 'https://dynamicworks-angola-default-rtdb.firebaseio.com';
const DB_SECRET = process.env.FIREBASE_SECRET || '';

if (!DB_SECRET) {
  console.warn('[AVISO] FIREBASE_SECRET não definido — os ticks não serão guardados!');
}

/* ── Buffer em memória ── */
/* ticks[sym] = [{v: preço, t: epoch_segundos}, ...] */
const ticks   = {};
const dirty   = {};   /* quais símbolos tiveram novos ticks desde o último save */

ASSETS.forEach(function(sym) {
  ticks[sym]  = [];
  dirty[sym]  = false;
});

/* ════════════════════════════════════════════════
   FIREBASE — gravar via REST API (sem SDK)
   Não precisamos do SDK completo — o REST é suficiente
   e mantém o servidor leve.
════════════════════════════════════════════════ */
function fbWrite(sym, data) {
  if (!DB_SECRET) return;

  const body    = JSON.stringify(data);
  const path    = `/ticks/${sym}.json?auth=${DB_SECRET}`;
  const urlObj  = new URL(DB_URL);
  const options = {
    hostname: urlObj.hostname,
    path:     path,
    method:   'PUT',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = https.request(options, function(res) {
    /* Ler resposta para libertar a socket */
    res.resume();
    if (res.statusCode !== 200) {
      console.error(`[Firebase] Erro ${res.statusCode} ao gravar ${sym}`);
    }
  });

  req.on('error', function(err) {
    console.error('[Firebase] Erro de rede:', err.message);
  });

  req.write(body);
  req.end();
}

/* Gravar apenas os símbolos que tiveram novos ticks */
function saveAllDirty() {
  ASSETS.forEach(function(sym) {
    if (!dirty[sym]) return;
    dirty[sym] = false;
    fbWrite(sym, ticks[sym]);
  });
}

/* Arrancar o timer de gravação */
setInterval(saveAllDirty, SAVE_INTERVAL);

/* ════════════════════════════════════════════════
   DERIV WEBSOCKET
════════════════════════════════════════════════ */
let ws          = null;
let pingTimer   = null;
let reconnTimer = null;
let reconnN     = 0;

function connect() {
  console.log(`[Deriv] A ligar... (tentativa ${reconnN + 1})`);

  ws = new WebSocket(DERIV_WS_URL);

  ws.on('open', function() {
    reconnN = 0;
    clearTimeout(reconnTimer);
    console.log('[Deriv] Ligado! A subscrever ticks...');

    /* Subscrever todos os ativos */
    ASSETS.forEach(function(sym) {
      ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    });

    /* Ping a cada 25s para manter ligação */
    clearInterval(pingTimer);
    pingTimer = setInterval(function() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, PING_INTERVAL);
  });

  ws.on('message', function(raw) {
    let d;
    try { d = JSON.parse(raw); } catch(e) { return; }
    if (!d) return;

    if (d.msg_type === 'tick' && d.tick) {
      const sym   = d.tick.symbol;
      const price = parseFloat(d.tick.quote);
      const epoch = d.tick.epoch || Math.floor(Date.now() / 1000);

      if (!ticks[sym]) return;

      /* Adicionar tick ao buffer */
      ticks[sym].push({ v: price, t: epoch });

      /* Manter apenas os últimos TICKS_MAX */
      if (ticks[sym].length > TICKS_MAX) {
        ticks[sym] = ticks[sym].slice(-TICKS_MAX);
      }

      dirty[sym] = true;
    }
  });

  ws.on('close', function() {
    console.log('[Deriv] Ligação fechada. A reconectar...');
    clearInterval(pingTimer);
    reconnect();
  });

  ws.on('error', function(err) {
    console.error('[Deriv] Erro WebSocket:', err.message);
    /* O evento 'close' vai disparar a seguir */
  });
}

function reconnect() {
  reconnN++;
  const delay = Math.min(3000 * reconnN, 30000);
  console.log(`[Deriv] Reconectar em ${delay / 1000}s...`);
  clearTimeout(reconnTimer);
  reconnTimer = setTimeout(connect, delay);
}

/* Arrancar */
connect();

/* ════════════════════════════════════════════════
   HTTP SERVER — necessário para o Render saber
   que o serviço está vivo (health check)
════════════════════════════════════════════════ */
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer(function(req, res) {
  /* Endpoint de status — útil para debug */
  if (req.url === '/status') {
    const status = {};
    ASSETS.forEach(function(sym) {
      status[sym] = ticks[sym].length + ' ticks';
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok:     true,
      uptime: Math.floor(process.uptime()) + 's',
      ticks:  status,
    }));
    return;
  }

  /* Health check para o Render */
  res.writeHead(200);
  res.end('DynamicWorks Tick Server OK');
});

server.listen(PORT, function() {
  console.log(`[Server] A correr na porta ${PORT}`);
  console.log('[Server] Status em: /status');
});
