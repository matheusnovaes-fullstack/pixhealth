require('./keepalive');
process.env.TZ = 'America/Sao_Paulo';

const express   = require('express');
const axios     = require('axios');
const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORTA              = process.env.PORT || 3000;
const INTERVALO_SEGUNDOS = process.env.INTERVALO_MONITORAMENTO || 60;
const SELF_PING_INTERVAL = 14 * 60 * 1000;

const STATUSPAGE_URL = 'https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json';

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────

let ultimosResultados = { timestamp: null, componentes: [], resumo: {} };
let clientesConectados = [];
let historicoDia = [];

// ─────────────────────────────────────────────
// STATIC + WEBSOCKET
// ─────────────────────────────────────────────

app.use(express.static('public'));

wss.on('connection', (ws) => {
  console.log('[WebSocket] Cliente conectado');
  clientesConectados.push(ws);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  if (ultimosResultados.timestamp) {
    ws.send(JSON.stringify({ tipo: 'atualizacao', dados: ultimosResultados }));
  }

  ws.on('pong', () => {});
  ws.on('close', () => {
    clearInterval(pingInterval);
    clientesConectados = clientesConectados.filter(c => c !== ws);
    console.log('[WebSocket] Cliente desconectado');
  });
  ws.on('error', (err) => console.error('[WebSocket] Erro:', err.message));
});

// ─────────────────────────────────────────────
// MAPEAMENTO DE STATUS OKTO → UP / DEGRADED / DOWN
// ─────────────────────────────────────────────

function mapearStatus(statusOriginal) {
  switch (statusOriginal) {
    case 'operational':
      return 'UP';
    case 'degraded_performance':
    case 'under_maintenance':
      return 'DEGRADED';
    case 'partial_outage':
    case 'major_outage':
      return 'DOWN';
    default:
      return 'UP';
  }
}

function labelStatus(status) {
  switch (status) {
    case 'UP':       return 'Operacional';
    case 'DEGRADED': return 'Degradado';
    case 'DOWN':     return 'Fora';
    default:         return status;
  }
}

// ─────────────────────────────────────────────
// CONSULTAR STATUSPAGE
// ─────────────────────────────────────────────

async function consultarStatusPage() {
  try {
    const inicio   = Date.now();
    const response = await axios.get(STATUSPAGE_URL, { timeout: 10000 });
    const latencia = Date.now() - inicio;
    const data     = response.data;

    // Filtra apenas componentes raiz (sem parent_id) para evitar duplicatas
    const componentes = (data.components || [])
      .filter(c => !c.group || c.showcase)
      .map(c => {
        const status = mapearStatus(c.status);
        return {
          id:              c.id,
          nome:            c.name,
          status,
          status_original: c.status,
          label:           labelStatus(status),
          descricao:       c.description || null,
          atualizado_em:   c.updated_at  || new Date().toISOString(),
          latencia_api_ms: latencia
        };
      });

    // Status geral da página
    const geral = data.status || {};

    return { componentes, geral, latencia };

  } catch (erro) {
    console.error('[StatusPage] Erro ao consultar:', erro.message);
    return {
      componentes: [{
        id:   'statuspage',
        nome: 'StatusPage API',
        status: 'DOWN',
        status_original: 'erro',
        label: 'Fora',
        descricao: erro.message,
        atualizado_em: new Date().toISOString(),
        latencia_api_ms: null
      }],
      geral: { indicator: 'critical', description: erro.message },
      latencia: null
    };
  }
}

// ─────────────────────────────────────────────
// MONITORAMENTO
// ─────────────────────────────────────────────

async function monitorar() {
  console.log(`[Monitor] Consultando StatusPage Okto...`);

  const { componentes, geral, latencia } = await consultarStatusPage();

  const nUp       = componentes.filter(c => c.status === 'UP').length;
  const nDegraded = componentes.filter(c => c.status === 'DEGRADED').length;
  const nDown     = componentes.filter(c => c.status === 'DOWN').length;

  ultimosResultados = {
    timestamp:  new Date().toISOString(),
    componentes,
    geral,
    latencia_api_ms: latencia,
    resumo: {
      total:    componentes.length,
      up:       nUp,
      degraded: nDegraded,
      down:     nDown
    }
  };

  // Histórico do dia
  historicoDia.push({
    timestamp:  new Date().toISOString(),
    hora:       new Date().toLocaleTimeString('pt-BR'),
    componentes: componentes.map(c => ({
      id:     c.id,
      nome:   c.nome,
      status: c.status,
      status_original: c.status_original
    }))
  });

  if (historicoDia.length > 1440) historicoDia.shift();

  // Reset meia-noite
  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[Sistema] Resetando histórico (meia-noite)');
    historicoDia = [];
  }

  // Broadcast WebSocket
  const msg = JSON.stringify({ tipo: 'atualizacao', dados: ultimosResultados });
  clientesConectados.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  // Log
  try {
    fs.appendFileSync('monitoramento_okto.log', JSON.stringify(ultimosResultados) + '\n');
  } catch (e) {}

  console.log(`[Monitor] UP: ${nUp} | DEGRADED: ${nDegraded} | DOWN: ${nDown} | ${latencia}ms`);
}

// ─────────────────────────────────────────────
// ROTAS API
// ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

app.get('/api/health', (req, res) => {
  res.json({
    status:            'alive',
    timestamp:         new Date().toISOString(),
    uptime_segundos:   Math.floor(process.uptime()),
    clientes_ws:       clientesConectados.length,
    historico_size:    historicoDia.length,
    ultima_verificacao: ultimosResultados.timestamp || null
  });
});

app.get('/api/historico', (req, res) => {
  const { inicio, fim, componente } = req.query;
  let dados = [...historicoDia];

  if (inicio && fim) {
    dados = dados.filter(item => {
      const hora      = new Date(item.timestamp).getHours();
      const horaInicio = parseInt(inicio);
      const horaFim    = parseInt(fim);
      return hora >= horaInicio && hora <= horaFim;
    });
  }

  if (componente) {
    dados = dados.map(item => ({
      ...item,
      componentes: item.componentes.filter(c => c.id === componente || c.nome === componente)
    }));
  }

  res.json({
    total:  dados.length,
    periodo: {
      inicio: dados[0]?.timestamp || null,
      fim:    dados[dados.length - 1]?.timestamp || null
    },
    dados
  });
});

// Exportar CSV
app.get('/api/historico/exportar', (req, res) => {
  if (!historicoDia.length) {
    return res.status(404).send('Nenhum dado disponível para exportar.');
  }

  const dataHoje  = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
  const cabecalho = ['data', 'hora', 'componente_id', 'componente_nome', 'status', 'status_original'].join(';');
  const linhas    = [];

  historicoDia.forEach(item => {
    const data = new Date(item.timestamp).toLocaleDateString('pt-BR');
    const hora = item.hora || new Date(item.timestamp).toLocaleTimeString('pt-BR');
    item.componentes.forEach(c => {
      linhas.push([data, hora, c.id, c.nome, c.status, c.status_original].join(';'));
    });
  });

  const csv          = '\uFEFF' + cabecalho + '\n' + linhas.join('\n');
  const nomeArquivo  = `relatorio_okto_${dataHoje}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.send(csv);
});

// Análise por hora (quantos componentes ficaram DOWN/DEGRADED por hora)
app.get('/api/oscilacoes', (req, res) => {
  if (historicoDia.length < 5) {
    return res.json({ mensagem: 'Dados insuficientes (mínimo 5 verificações)', porHora: [] });
  }

  const porHora = {};

  historicoDia.forEach(item => {
    const hora = new Date(item.timestamp).getHours();
    if (!porHora[hora]) {
      porHora[hora] = { hora: `${String(hora).padStart(2,'0')}:00`, verificacoes: 0, incidentes: 0, componentesAfetados: new Set() };
    }
    porHora[hora].verificacoes++;
    item.componentes.forEach(c => {
      if (c.status !== 'UP') {
        porHora[hora].incidentes++;
        porHora[hora].componentesAfetados.add(c.nome);
      }
    });
  });

  const resultado = Object.values(porHora).map(h => ({
    hora:                 h.hora,
    verificacoes:         h.verificacoes,
    incidentes:           h.incidentes,
    componentes_afetados: h.componentesAfetados.size,
    nomes_afetados:       Array.from(h.componentesAfetados)
  })).sort((a, b) => a.hora.localeCompare(b.hora));

  const horarioCritico = resultado.reduce((max, h) => h.incidentes > (max?.incidentes || 0) ? h : max, null);

  res.json({ horarioCritico, porHora: resultado });
});

// ─────────────────────────────────────────────
// KEEP-ALIVE
// ─────────────────────────────────────────────

function iniciarKeepAlive() {
  setInterval(async () => {
    try {
      const selfUrl  = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`;
      const response = await axios.get(`${selfUrl}/api/health`, {
        timeout: 5000,
        headers: { 'User-Agent': 'Internal-KeepAlive/1.0' }
      });
      console.log(`[Keep-Alive] OK - Uptime: ${response.data.uptime_segundos}s`);
    } catch (erro) {
      console.log(`[Keep-Alive] Erro: ${erro.message}`);
    }
  }, SELF_PING_INTERVAL);
  console.log(`[Keep-Alive] Configurado para ${SELF_PING_INTERVAL / 60000} minutos`);
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

server.listen(PORTA, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('Okto Payments Status Monitor');
  console.log('='.repeat(60));
  console.log(`Servidor:   http://0.0.0.0:${PORTA}`);
  console.log(`StatusPage: ${STATUSPAGE_URL}`);
  console.log(`Intervalo:  ${INTERVALO_SEGUNDOS}s`);
  console.log('='.repeat(60) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
