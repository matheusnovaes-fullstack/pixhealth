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

// ✨ NOVO: Configurações aprimoradas
const TIMEOUT_MS = 30000; // 30 segundos
const MAX_RETRIES = 3; // Tentativas automáticas
const RETRY_DELAY_MS = 2000; // 2 segundos entre tentativas

// ✨ NOVO: URLs das APIs a monitorar
const APIS_MONITORADAS = [
  {
    nome: 'Okto Payments',
    url: 'https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json',
    categoria: 'pagamentos'
  },
  {
    nome: 'Legitimuz',
    url: 'https://legitimuz.statuspage.io/api/v2/summary.json',
    categoria: 'kyc'
  },
  {
    nome: 'AllowMe',
    url: 'https://status.allowme.com.br/api/v2/summary.json',
    categoria: 'kyc'
  },
  {
    nome: 'Unico',
    url: 'https://status.unico.io/api/v2/summary.json',
    categoria: 'kyc'
  }
];

let ultimosResultados = {
  timestamp: null,
  bancos: [],
  por_categoria: { pagamentos: [], kyc: [] }
};

let clientesConectados = [];

app.use(express.static('public'));

/*
───────────────────────────────────────────────
FUNÇÃO: Mapear Status dos Componentes
───────────────────────────────────────────────
*/
function mapearStatus(statusOriginal) {
  const mapa = {
    'operational': 'UP',
    'degraded_performance': 'DEGRADED',
    'partial_outage': 'DEGRADED',
    'major_outage': 'DOWN',
    'under_maintenance': 'DEGRADED'
  };
  return mapa[statusOriginal] || 'UP';
}

/*
───────────────────────────────────────────────
FUNÇÃO: Consultar StatusPage COM RETRY
───────────────────────────────────────────────
*/
async function consultarStatusPage(apiConfig, tentativa = 1) {
  try {

    const inicio = Date.now();
    
    console.log(`[${apiConfig.nome}] Tentativa ${tentativa}/${MAX_RETRIES} - Consultando API...`);

    const response = await axios.get(apiConfig.url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'PixHealthMonitor/1.0'
      }
    });

    const latencia = Date.now() - inicio;
    
    console.log(`[${apiConfig.nome}] ✓ Resposta recebida em ${latencia}ms`);

    const data = response.data;
    const componentes = data.components || [];

    const bancos = componentes.map(c => {

      const status = mapearStatus(c.status);
      let motivo = null;

      if (status !== 'UP') {
        motivo = c.description || "Instabilidade reportada na StatusPage";
      }

      return {
        id: `${apiConfig.nome}-${c.id}`,
        nome: c.name,
        provedor: apiConfig.nome,
        categoria: apiConfig.categoria,
        status: status,
        status_original: c.status,
        motivo: motivo,
        latencia_statuspage_ms: latencia,
        atualizado_em: new Date().toISOString()
      };
    });

    return { bancos, sucesso: true };

  } catch (erro) {

    const tipoErro = erro.code === 'ECONNABORTED' ? 'Timeout' : 
                     erro.code === 'ENOTFOUND' ? 'DNS Error' :
                     erro.response ? `HTTP ${erro.response.status}` : 'Network Error';
    
    console.error(`[${apiConfig.nome}] ✗ Falha na tentativa ${tentativa}/${MAX_RETRIES}: ${tipoErro} - ${erro.message}`);

    // Se ainda tem tentativas, tenta novamente
    if (tentativa < MAX_RETRIES) {
      console.log(`[${apiConfig.nome}] ⏳ Aguardando ${RETRY_DELAY_MS / 1000}s antes da próxima tentativa...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return consultarStatusPage(apiConfig, tentativa + 1);
    }

    // Esgotou as tentativas
    console.error(`[${apiConfig.nome}] ✗ FALHA TOTAL após ${MAX_RETRIES} tentativas`);

    return {
      bancos: [{
        id: `${apiConfig.nome}-erro-comunicacao`,
        nome: `⚠️ Erro de Comunicação - ${apiConfig.nome}`,
        provedor: apiConfig.nome,
        categoria: apiConfig.categoria,
        status: "DEGRADED",
        status_original: "erro_comunicacao",
        motivo: `Não foi possível conectar à API após ${MAX_RETRIES} tentativas (${tipoErro}). Isso NÃO significa que os serviços estão fora do ar, apenas que não conseguimos verificar o status no momento.`,
        latencia_statuspage_ms: null,
        atualizado_em: new Date().toISOString(),
        erro_tipo: tipoErro
      }],
      sucesso: false
    };

  }
}

/*
───────────────────────────────────────────────
MONITORAMENTO
───────────────────────────────────────────────
*/
async function monitorarBancos() {

  console.log("\n" + "=".repeat(80));
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} - Consultando todas as APIs...`);
  console.log("=".repeat(80));

  // Consulta todas as APIs em paralelo
  const resultados = await Promise.all(
    APIS_MONITORADAS.map(api => consultarStatusPage(api))
  );

  // Combina todos os bancos/componentes
  const todosBancos = resultados.flatMap(r => r.bancos);

  // Separa por categoria
  const porCategoria = {
    pagamentos: todosBancos.filter(b => b.categoria === 'pagamentos'),
    kyc: todosBancos.filter(b => b.categoria === 'kyc')
  };

  ultimosResultados = {
    timestamp: new Date().toISOString(),
    bancos: todosBancos,
    por_categoria: porCategoria,
    resumo: {
      total: todosBancos.length,
      up: todosBancos.filter(b => b.status === 'UP').length,
      degraded: todosBancos.filter(b => b.status === 'DEGRADED').length,
      down: todosBancos.filter(b => b.status === 'DOWN').length,
      por_provedor: APIS_MONITORADAS.map(api => ({
        nome: api.nome,
        componentes: todosBancos.filter(b => b.provedor === api.nome).length
      }))
    }
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

  // Log melhorado com status por categoria
  const { up, degraded, down } = ultimosResultados.resumo;
  
  console.log(`\n[Monitor] RESUMO GERAL:`);
  console.log(`  Total: ${todosBancos.length} | UP: ${up} | DEGRADED: ${degraded} | DOWN: ${down}`);
  console.log(`  Pagamentos (Okto): ${porCategoria.pagamentos.length} componentes`);
  console.log(`  KYC (Legitimuz + AllowMe): ${porCategoria.kyc.length} componentes`);
  console.log("=".repeat(80) + "\n");

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
    config: {
      timeout_ms: TIMEOUT_MS,
      max_retries: MAX_RETRIES,
      intervalo_segundos: INTERVALO_SEGUNDOS
    },
    apis_monitoradas: APIS_MONITORADAS.map(a => ({ nome: a.nome, categoria: a.categoria }))
  });
});

/*
───────────────────────────────────────────────
INICIALIZAÇÃO
───────────────────────────────────────────────
*/

server.listen(PORTA, '0.0.0.0', () => {

  console.log("");
  console.log("=".repeat(70));
  console.log("PIX HEALTH MONITOR - MULTI-PROVIDER");
  console.log("=".repeat(70));
  console.log(`Servidor: http://0.0.0.0:${PORTA}`);
  console.log(`Intervalo: ${INTERVALO_SEGUNDOS}s | Timeout: ${TIMEOUT_MS / 1000}s | Retries: ${MAX_RETRIES}`);
  console.log("");
  console.log("APIs Monitoradas:");
  APIS_MONITORADAS.forEach(api => {
    console.log(`  • ${api.nome.padEnd(20)} [${api.categoria.toUpperCase()}]`);
  });
  console.log("=".repeat(70));
  console.log("");

  monitorarBancos();

  setInterval(
    monitorarBancos,
    INTERVALO_SEGUNDOS * 1000
  );

});
