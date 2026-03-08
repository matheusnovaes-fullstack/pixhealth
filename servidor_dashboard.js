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

// Componentes ignorados no monitor
const IGNORADOS = ['RTM', 'JD'];

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────

let ultimosResultados = { timestamp: null, componentes: [], incidentes: [], resumo: {} };
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
// MAPEAMENTO DE STATUS
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
    case 'UP':       return 'OPERACIONAL';
    case 'DEGRADED': return 'DEGRADAÇÃO';
    case 'DOWN':     return 'DOWN';
    default:         return status;
  }
}

// ─────────────────────────────────────────────
// SEPARAR COMPONENTES
// group: true  → grupo pai (ex: "Brazilian Banks") — ignorar
// group: false → componente real — exibir (exceto IGNORADOS)
// ─────────────────────────────────────────────

function separarComponentes(rawComponents) {
  const grupos = {};
  rawComponents
    .filter(c => c.group === true)
    .forEach(g => { grupos[g.id] = g.name; });

  return rawComponents
    .filter(c => c.group === false && !IGNORADOS.includes(c.name))
    .map(c => {
      const status = mapearStatus(c.status);
      return {
        id:              c.id,
        nome:            c.name,
        grupo:           c.group_id ? (grupos[c.group_id] || null) : null,
        status,
        status_original: c.status,
        label:           labelStatus(status),
        descricao:       c.description || null,
        atualizado_em:   c.updated_at  || new Date().toISOString(),
      };
    })
    .sort((a, b) => {
      const ordem = { DOWN: 0, DEGRADED: 1, UP: 2 };
      return (ordem[a.status] ?? 99) - (ordem[b.status] ?? 99);
    });
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

    const componentes = separarComponentes(data.components || []);
    const geral       = data.status || {};

    // Incidentes ativos — inclui histórico de atualizações para o modal
    const incidentes = (data.incidents || []).map(i => ({
      id:         i.id,
      nome:       i.name,
      status:     i.status,
      impacto:    i.impact,
      atualizado: i.updated_at,
      url:        i.shortlink || null,
      updates:    (i.incident_updates || []).map(u => ({
        status:     u.status,
        body:       u.body,
        updated_at: u.updated_at
      }))
    }));

    const manutencoes = (data.scheduled_maintenances || []).map(m => ({
      id:         m.id,
      nome:       m.name,
      status:     m.status,
      inicio:     m.scheduled_for,
      fim:        m.scheduled_until,
      atualizado: m.updated_at
    }));

    return { componentes, geral, latencia, incidentes, manutencoes };

  } catch (erro) {
    console.error('[StatusPage] Erro ao consultar:', erro.message);
    return {
      componentes: [{
        id:              'statuspage-erro',
        nome:            'StatusPage API',
        grupo:           null,
        status:          'DOWN',
        status_original: 'erro',
        label:           'DOWN',
        descricao:       erro.message,
        atualizado_em:   new Date().toISOString(),
      }],
      geral:       { indicator: 'critical', description: erro.message },
      latencia:    null,
      incidentes:  [],
      manutencoes: []
    };
  }
}

// ─────────────────────────────────────────────
// MONITORAMENTO
// ─────────────────────────────────────────────

async function monitorar() {
  console.log('[Monitor] Consultando StatusPage Okto...');

  const { componentes, geral, latencia, incidentes, manutencoes } = await consultarStatusPage();

  const nUp       = componentes.filter(c => c.status === 'UP').length;
  const nDegraded = componentes.filter(c => c.status === 'DEGRADED').length;
  const nDown     = componentes.filter(c => c.status === 'DOWN').length;

  ultimosResultados = {
    timestamp:       new Date().toISOString(),
    componentes,
    geral,
    incidentes,
    manutencoes,
    latencia_api_ms: latencia,
    resumo: {
      total:    componentes.length,
      up:       nUp,
      degraded: nDegraded,
      down:     nDown
    }
  };

  historicoDia.push({
    timestamp:   new Date().toISOString(),
    hora:        new Date().toLocaleTimeString('pt-BR'),
    componentes: componentes.map(c => ({
      id:              c.id,
      nome:            c.nome,
      grupo:           c.grupo,
      status:          c.status,
      status_original: c.status_original
    }))
  });

  if (historicoDia.length > 1440) historicoDia.shift();

  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[Sistema] Resetando histórico (meia-noite)');
    historicoDia = [];
  }

  const msg = JSON.stringify({ tipo: 'atualizacao', dados: ultimosResultados });
  clientesConectados.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  try {
    fs.appendFileSync('monitoramento_okto.log', JSON.stringify({
      timestamp: ultimosResultados.timestamp,
      resumo:    ultimosResultados.resumo,
      geral:     ultimosResultados.geral
    }) + '\n');
  } catch (e) {}

  console.log(`[Monitor] Total: ${componentes.length} | UP: ${nUp} | DEGRADED: ${nDegraded} | DOWN: ${nDown} | API: ${latencia}ms`);
  if (incidentes.length > 0) {
    console.log(`[Monitor] Incidentes ativos: ${incidentes.map(i => i.nome).join(', ')}`);
  }
}

// ─────────────────────────────────────────────
// ROTAS API
// ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

app.get('/api/health', (req, res) => {
  res.json({
    status:             'alive',
    timestamp:          new Date().toISOString(),
    uptime_segundos:    Math.floor(process.uptime()),
    clientes_ws:        clientesConectados.length,
    historico_size:     historicoDia.length,
    ultima_verificacao: ultimosResultados.timestamp || null
  });
});

app.get('/api/historico', (req, res) => {
  const { inicio, fim, componente } = req.query;
  let dados = [...historicoDia];

  if (inicio && fim) {
    dados = dados.filter(item => {
      const hora       = new Date(item.timestamp).getHours();
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
    total:   dados.length,
    periodo: {
      inicio: dados[0]?.timestamp || null,
      fim:    dados[dados.length - 1]?.timestamp || null
    },
    dados
  });
});

app.get('/api/historico/exportar', (req, res) => {
  if (!historicoDia.length) {
    return res.status(404).send('Nenhum dado disponível para exportar.');
  }

  const dataHoje  = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
  const cabecalho = ['data', 'hora', 'componente_id', 'componente_nome', 'grupo', 'status', 'status_original'].join(';');
  const linhas    = [];

  historicoDia.forEach(item => {
    const data = new Date(item.timestamp).toLocaleDateString('pt-BR');
    const hora = item.hora || new Date(item.timestamp).toLocaleTimeString('pt-BR');
    item.componentes.forEach(c => {
      linhas.push([data, hora, c.id, c.nome, c.grupo || '', c.status, c.status_original].join(';'));
    });
  });

  const csv         = '\uFEFF' + cabecalho + '\n' + linhas.join('\n');
  const nomeArquivo = `relatorio_okto_${dataHoje}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.send(csv);
});

app.get('/api/oscilacoes', (req, res) => {
  if (historicoDia.length < 5) {
    return res.json({ mensagem: 'Dados insuficientes (mínimo 5 verificações)', porHora: [] });
  }

  const porHora = {};
  historicoDia.forEach(item => {
    const hora = new Date(item.timestamp).getHours();
    if (!porHora[hora]) {
      porHora[hora] = { hora: `${String(hora).padStart(2, '0')}:00`, verificacoes: 0, incidentes: 0, componentesAfetados: new Set() };
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

  const horarioCritico = resultado.reduce(
    (max, h) => h.incidentes > (max?.incidentes || 0) ? h : max, null
  );

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
      console.log(`[Keep-Alive] OK - Uptime: ${response.data.uptime_segundos}s | Histórico: ${response.data.historico_size} registros`);
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
  console.log('Pix Health Monitor');
  console.log('='.repeat(60));
  console.log(`Servidor:   http://0.0.0.0:${PORTA}`);
  console.log(`StatusPage: ${STATUSPAGE_URL}`);
  console.log(`Intervalo:  ${INTERVALO_SEGUNDOS}s`);
  console.log(`Ignorados:  ${IGNORADOS.join(' | ')}`);
  console.log('='.repeat(60) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
