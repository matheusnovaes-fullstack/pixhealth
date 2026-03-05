# Create the modified servidor_dashboard.js file with Statuspage summary support

code = r"""
require('./keepalive');
process.env.TZ = 'America/Sao_Paulo';

const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORTA = process.env.PORT || 3000;
const INTERVALO_SEGUNDOS = process.env.INTERVALO_MONITORAMENTO || 60;

const STATUSPAGE_URL = "https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json";

let ultimosResultados = {
  timestamp: null,
  bancos: []
};

let clientesConectados = [];

app.use(express.static('public'));

/*
───────────────────────────────────────────────
FUNÇÃO: Consultar StatusPage
───────────────────────────────────────────────
*/
async function consultarStatusPage() {
  try {

    const inicio = Date.now();

    const response = await axios.get(STATUSPAGE_URL, {
      timeout: 10000
    });

    const latencia = Date.now() - inicio;

    const data = response.data;

    const componentes = data.components || [];

    const bancos = componentes.map(c => {

      let status = "UP";
      let motivo = null;

      if (
        c.status === "major_outage" ||
        c.status === "partial_outage" ||
        c.status === "degraded_performance"
      ) {
        status = "DOWN";
        motivo = c.description || "Instabilidade reportada na StatusPage";
      }

      return {
        id: c.id,
        nome: c.name,
        status: status,
        status_original: c.status,
        motivo: motivo,
        latencia_statuspage_ms: latencia,
        atualizado_em: new Date().toISOString()
      };
    });

    return bancos;

  } catch (erro) {

    console.error("[StatusPage] Erro ao consultar:", erro.message);

    return [{
      id: "statuspage",
      nome: "StatusPage API",
      status: "DOWN",
      motivo: erro.message,
      atualizado_em: new Date().toISOString()
    }];

  }
}

/*
───────────────────────────────────────────────
MONITORAMENTO
───────────────────────────────────────────────
*/
async function monitorarBancos() {

  console.log("[Monitor] Consultando StatusPage...");

  const bancos = await consultarStatusPage();

  ultimosResultados = {
    timestamp: new Date().toISOString(),
    bancos
  };

  const mensagem = JSON.stringify({
    tipo: "atualizacao",
    dados: ultimosResultados
  });

  clientesConectados.forEach(cliente => {
    if (cliente.readyState === WebSocket.OPEN) {
      cliente.send(mensagem);
    }
  });

  console.log(`[Monitor] ${bancos.length} instituições atualizadas.`);

}

/*
───────────────────────────────────────────────
WEBSOCKET
───────────────────────────────────────────────
*/
wss.on('connection', (ws) => {

  console.log("[WebSocket] Cliente conectado");

  clientesConectados.push(ws);

  ws.on('close', () => {
    clientesConectados = clientesConectados.filter(c => c !== ws);
    console.log("[WebSocket] Cliente desconectado");
  });

  if (ultimosResultados.bancos.length > 0) {
    ws.send(JSON.stringify({
      tipo: "atualizacao",
      dados: ultimosResultados
    }));
  }

});

/*
───────────────────────────────────────────────
ROTAS API
───────────────────────────────────────────────
*/

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime_segundos: Math.floor(process.uptime()),
    clientes_ws: clientesConectados.length
  });
});

/*
───────────────────────────────────────────────
INICIALIZAÇÃO
───────────────────────────────────────────────
*/

server.listen(PORTA, '0.0.0.0', () => {

  console.log("");
  console.log("==============================================");
  console.log("PIX / BANK STATUS MONITOR");
  console.log("==============================================");
  console.log(`Servidor: http://0.0.0.0:${PORTA}`);
  console.log(`StatusPage: ${STATUSPAGE_URL}`);
  console.log(`Intervalo: ${INTERVALO_SEGUNDOS}s`);
  console.log("==============================================");
  console.log("");

  monitorarBancos();

  setInterval(
    monitorarBancos,
    INTERVALO_SEGUNDOS * 1000
  );

});
"""

path = "/mnt/data/servidor_dashboard_statuspage.js"
with open(path, "w") as f:
    f.write(code)

path
