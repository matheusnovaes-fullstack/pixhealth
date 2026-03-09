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

// ✨ MELHORIAS: Configurações aprimoradas
const STATUSPAGE_URL = "https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json";
const TIMEOUT_MS = 30000; // 30 segundos (antes era 10s)
const MAX_RETRIES = 3; // Tentativas automáticas
const RETRY_DELAY_MS = 2000; // 2 segundos entre tentativas

let ultimosResultados = {
  timestamp: null,
  bancos: []
};

let clientesConectados = [];

app.use(express.static('public'));

/*
───────────────────────────────────────────────
FUNÇÃO: Consultar StatusPage COM RETRY
───────────────────────────────────────────────
*/
async function consultarStatusPage(tentativa = 1) {
  try {

    const inicio = Date.now();
    
    // ✨ Log informativo de tentativa
    console.log(`[StatusPage] Tentativa ${tentativa}/${MAX_RETRIES} - Consultando API...`);

    const response = await axios.get(STATUSPAGE_URL, {
      timeout: TIMEOUT_MS, // ✨ Timeout aumentado para 30s
      headers: {
        'User-Agent': 'PixHealthMonitor/1.0'
      }
    });

    const latencia = Date.now() - inicio;
    
    // ✨ Log de sucesso
    console.log(`[StatusPage] ✓ Resposta recebida em ${latencia}ms`);

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

    // ✨ Identificar tipo de erro
    const tipoErro = erro.code === 'ECONNABORTED' ? 'Timeout' : 
                     erro.code === 'ENOTFOUND' ? 'DNS Error' :
                     erro.response ? `HTTP ${erro.response.status}` : 'Network Error';
    
    console.error(`[StatusPage] ✗ Falha na tentativa ${tentativa}/${MAX_RETRIES}: ${tipoErro} - ${erro.message}`);

    // ✨ RETRY: Se ainda tem tentativas, tenta novamente
    if (tentativa < MAX_RETRIES) {
      console.log(`[StatusPage] ⏳ Aguardando ${RETRY_DELAY_MS / 1000}s antes da próxima tentativa...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return consultarStatusPage(tentativa + 1);
    }

    // ✨ Esgotou as tentativas - mensagem melhorada
    console.error(`[StatusPage] ✗ FALHA TOTAL após ${MAX_RETRIES} tentativas`);

    return [{
      id: "statuspage-erro-comunicacao",
      nome: "⚠️ Erro de Comunicação com API",
      status: "DEGRADED", // ✨ DEGRADED em vez de DOWN para diferenciar
      status_original: "erro_comunicacao",
      motivo: `Não foi possível conectar à API após ${MAX_RETRIES} tentativas (${tipoErro}). Isso NÃO significa que os serviços estão fora do ar, apenas que não conseguimos verificar o status no momento.`,
      latencia_statuspage_ms: null,
      atualizado_em: new Date().toISOString(),
      erro_tipo: tipoErro // ✨ Info adicional para debug
    }];

  }
}

/*
───────────────────────────────────────────────
MONITORAMENTO
───────────────────────────────────────────────
*/
async function monitorarBancos() {

  console.log("\n" + "=".repeat(60));
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} - Consultando StatusPage...`);
  console.log("=".repeat(60));

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

  // ✨ Log melhorado com status
  const bancosOK = bancos.filter(b => b.status === 'UP').length;
  const bancosDown = bancos.filter(b => b.status === 'DOWN').length;
  const bancosDegraded = bancos.filter(b => b.status === 'DEGRADED').length;
  
  console.log(`[Monitor] Total: ${bancos.length} | UP: ${bancosOK} | DOWN: ${bancosDown} | DEGRADED: ${bancosDegraded}`);
  console.log("=".repeat(60) + "\n");

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
    clientes_ws: clientesConectados.length,
    // ✨ Info adicional sobre configuração
    config: {
      timeout_ms: TIMEOUT_MS,
      max_retries: MAX_RETRIES,
      intervalo_segundos: INTERVALO_SEGUNDOS
    }
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
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s | Retries: ${MAX_RETRIES}`); // ✨ Info das melhorias
  console.log("==============================================");
  console.log("");

  monitorarBancos();

  setInterval(
    monitorarBancos,
    INTERVALO_SEGUNDOS * 1000
  );

});
