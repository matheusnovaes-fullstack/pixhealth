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

// URLs das APIs a monitorar
const APIS_MONITORADAS = [
  {
    nome: 'Okto Payments',
    url: 'https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json',
    categoria: 'pagamentos',
    agregado: false // Mostra todos os componentes
  },
  {
    nome: 'Serasa',
    url: 'https://status.allowme.com.br/api/v2/summary.json',
    categoria: 'kyc',
    agregado: true // Mostra apenas 1 card resumido
  },
  {
    nome: 'Legitimuz',
    url: 'https://legitimuz.statuspage.io/api/v2/summary.json',
    categoria: 'kyc',
    agregado: true
  },
  {
    nome: 'Unico',
    url: 'https://status.unico.io/api/v2/summary.json',
    categoria: 'kyc',
    agregado: true
  }
];

// Componentes ignorados no monitor
const IGNORADOS = ['RTM', 'JD'];

// ─────────────────────────────────────────────
// CONFIGURAÇÃO DE ALERTAS
// ─────────────────────────────────────────────

const SLACK_WEBHOOK  = 'https://hooks.slack.com/services/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';
const SLACK_MENTIONS = ['U09G386SN01', 'U09BNJL6E2X', 'U09QSBQ7SEP'];

const ALERT_EMAIL_TO  = process.env.ALERT_EMAIL_TO     || null;
const ALERT_EMAIL_FROM= process.env.ALERT_EMAIL_FROM   || null;
const SMTP_HOST       = process.env.SMTP_HOST          || null;
const SMTP_PORT       = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER       = process.env.SMTP_USER          || null;
const SMTP_PASS       = process.env.SMTP_PASS          || null;

const estadoAnterior = {};

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────

let ultimosResultados = { 
  timestamp: null, 
  componentes: [], 
  componentes_agregados: [], // Novos cards agregados para KYC
  incidentes: [], 
  resumo: {},
  por_categoria: { pagamentos: [], kyc: [] }
};
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
// ─────────────────────────────────────────────

function separarComponentes(rawComponents, provedor, categoria) {
  const grupos = {};
  rawComponents
    .filter(c => c.group === true)
    .forEach(g => { grupos[g.id] = g.name; });

  return rawComponents
    .filter(c => c.group === false && !IGNORADOS.includes(c.name))
    .map(c => {
      const status = mapearStatus(c.status);
      return {
        id:              `${provedor}-${c.id}`,
        nome:            c.name,
        provedor:        provedor,
        categoria:       categoria,
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
// CRIAR CARD AGREGADO (para KYC)
// ─────────────────────────────────────────────

function criarCardAgregado(provedor, componentes) {
  const total = componentes.length;
  const up = componentes.filter(c => c.status === 'UP').length;
  const degraded = componentes.filter(c => c.status === 'DEGRADED').length;
  const down = componentes.filter(c => c.status === 'DOWN').length;

  // Define status geral do provedor
  let statusGeral = 'UP';
  let mensagem = 'Todos os serviços operacionais';
  let componentesComProblema = [];

  if (down > 0) {
    statusGeral = 'DOWN';
    componentesComProblema = componentes.filter(c => c.status === 'DOWN');
    mensagem = `${down} serviço${down > 1 ? 's' : ''} fora do ar`;
  } else if (degraded > 0) {
    statusGeral = 'DEGRADED';
    componentesComProblema = componentes.filter(c => c.status === 'DEGRADED');
    mensagem = `${degraded} serviço${degraded > 1 ? 's' : ''} com degradação`;
  }

  // Monta detalhes dos problemas
  const detalhes = componentesComProblema.map(c => ({
    nome: c.nome,
    status: c.label,
    motivo: c.descricao || 'Sem detalhes disponíveis'
  }));

  return {
    id: `agregado-${provedor}`,
    nome: provedor,
    provedor: provedor,
    categoria: 'kyc',
    status: statusGeral,
    label: labelStatus(statusGeral),
    mensagem: mensagem,
    detalhes: detalhes, // Só aparece se tiver problema
    resumo: {
      total: total,
      up: up,
      degraded: degraded,
      down: down
    },
    atualizado_em: new Date().toISOString(),
    agregado: true
  };
}

// ─────────────────────────────────────────────
// ALERTAS
// ─────────────────────────────────────────────

async function enviarSlack(componente, statusNovo, statusAnterior) {
  const emoji = { DOWN: '🔴', DEGRADED: '🟡', UP: '🟢' };
  const label = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };
  const cor = { DOWN: '#ff4d4d', DEGRADED: '#f5c842', UP: '#1fd97a' };

  const isRecovery = statusNovo === 'UP';
  const horaAgora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dataAgora = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  
  let grupoDisplay = componente.grupo || 'APIs & Infraestrutura';
  if (componente.categoria === 'kyc') {
    grupoDisplay = 'Processadoras KYC';
  }
  
  const mencoes = SLACK_MENTIONS.map(id => `<@${id}>`).join(' ');

  const titulo = isRecovery
    ? `${emoji.UP} Serviço Recuperado — ${componente.provedor}: ${componente.nome}`
    : statusNovo === 'DOWN'
      ? `${emoji.DOWN} ALERTA CRÍTICO — ${componente.provedor}: ${componente.nome} está FORA DO AR`
      : `${emoji.DEGRADED} ALERTA — ${componente.provedor}: ${componente.nome} com DEGRADAÇÃO`;

  const payload = {
    text: mencoes,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: titulo, emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: isRecovery
            ? `${mencoes} — O serviço voltou ao normal. ✅`
            : `${mencoes} — Atenção! Problema detectado no monitoramento Pix Health.`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*🏢 Provedor:*\n\`${componente.provedor}\``
          },
          {
            type: 'mrkdwn',
            text: `*🔧 Componente:*\n\`${componente.nome}\``
          },
          {
            type: 'mrkdwn',
            text: `*📂 Categoria:*\n${grupoDisplay}`
          },
          {
            type: 'mrkdwn',
            text: `*⚠️ Problema:*\n${label[statusAnterior] || statusAnterior} → *${label[statusNovo] || statusNovo}*`
          },
          {
            type: 'mrkdwn',
            text: `*📡 Status técnico:*\n\`${componente.status_original || statusNovo.toLowerCase()}\``
          },
          {
            type: 'mrkdwn',
            text: `*🕐 Detectado:*\n${horaAgora} de ${dataAgora}`
          }
        ]
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Pix Health Monitor · Multi-Provider StatusPage · ${componente.provedor}`
          }
        ]
      }
    ]
  };

  try {
    await axios.post(SLACK_WEBHOOK, payload, { timeout: 8000 });
    console.log(`[Slack] Alerta enviado: ${componente.provedor}/${componente.nome} | ${label[statusAnterior]} → ${label[statusNovo]}`);
  } catch (e) {
    console.error('[Slack] Erro ao enviar alerta:', e.message);
  }
}

async function enviarEmail(componente, statusNovo, statusAnterior) {
  if (!ALERT_EMAIL_TO || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) {
    console.warn('[Email] nodemailer não instalado. Rode: npm install nodemailer');
    return;
  }

  const label = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };
  const labelAnt = label[statusAnterior] || statusAnterior;
  const labelNovo = label[statusNovo] || statusNovo;
  const hora = new Date().toLocaleString('pt-BR');
  const isRecovery = statusNovo === 'UP';
  const cor = statusNovo === 'DOWN' ? '#ff4d4d' : statusNovo === 'DEGRADED' ? '#f5c842' : '#1fd97a';

  let grupoDisplay = componente.grupo || 'APIs & Infraestrutura';
  if (componente.categoria === 'kyc') {
    grupoDisplay = 'Processadoras KYC';
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;background:#0f0f13;padding:32px;border-radius:12px;max-width:520px;margin:0 auto">
      <div style="border-left:4px solid ${cor};padding-left:16px;margin-bottom:24px">
        <p style="color:#a0a0b0;font-size:11px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px">
          Pix Health Monitor
        </p>
        <h2 style="color:#f0f0f5;margin:0;font-size:20px">
          ${isRecovery ? '✅ Serviço recuperado' : statusNovo === 'DOWN' ? '🔴 Serviço fora do ar' : '🟡 Degradação detectada'}
        </h2>
      </div>

      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20;width:40%">Provedor</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;font-weight:600;border-bottom:1px solid #1a1a20">${componente.provedor}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20">Componente</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;font-weight:600;border-bottom:1px solid #1a1a20">${componente.nome}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20">Categoria</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;border-bottom:1px solid #1a1a20">${grupoDisplay}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20">Mudança</td>
          <td style="padding:10px 0;font-size:14px;border-bottom:1px solid #1a1a20">
            <span style="color:#a0a0b0">${labelAnt}</span>
            <span style="color:#4a4a5a"> → </span>
            <span style="color:${cor};font-weight:700">${labelNovo}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Horário</td>
          <td style="padding:10px 0;color:#a0a0b0;font-size:13px;font-family:monospace">${hora}</td>
        </tr>
      </table>

      <p style="color:#4a4a5a;font-size:11px;margin-top:24px;text-align:center">
        Pix Health Monitor · Multi-Provider StatusPage
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Pix Health Monitor" <${ALERT_EMAIL_FROM || SMTP_USER}>`,
      to: ALERT_EMAIL_TO,
      subject: `${isRecovery ? '✅ Recuperado' : statusNovo === 'DOWN' ? '🔴 DOWN' : '🟡 Degradação'} — ${componente.provedor}: ${componente.nome}`,
      html
    });
    console.log(`[Email] Alerta enviado para ${ALERT_EMAIL_TO}: ${componente.provedor}/${componente.nome} → ${labelNovo}`);
  } catch (e) {
    console.error('[Email] Erro ao enviar:', e.message);
  }
}

async function verificarAlertas(componentes) {
  for (const c of componentes) {
    // Ignora cards agregados nos alertas (eles só servem pra visualização)
    if (c.agregado) continue;

    const anterior = estadoAnterior[c.id];

    if (anterior === undefined) {
      estadoAnterior[c.id] = c.status;
      continue;
    }

    if (anterior !== c.status) {
      const deveAlertar = c.status !== 'UP' || anterior !== 'UP';
      console.log(`[Alerta] ${c.provedor}/${c.nome}: ${anterior} → ${c.status}`);

      if (deveAlertar) {
        await Promise.allSettled([
          enviarSlack(c, c.status, anterior),
          enviarEmail(c, c.status, anterior)
        ]);
      }

      estadoAnterior[c.id] = c.status;
    }
  }
}

// ─────────────────────────────────────────────
// CONSULTAR STATUSPAGE (COM RETRY)
// ─────────────────────────────────────────────

async function consultarStatusPage(apiConfig, tentativa = 1) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;
  
  try {
    const inicio = Date.now();
    console.log(`[${apiConfig.nome}] Tentativa ${tentativa}/${MAX_RETRIES}...`);
    
    const response = await axios.get(apiConfig.url, { timeout: 30000 });
    const latencia = Date.now() - inicio;
    
    console.log(`[${apiConfig.nome}] ✓ Resposta em ${latencia}ms`);

    const data = response.data;
    const componentes = separarComponentes(data.components || [], apiConfig.nome, apiConfig.categoria);
    const geral = data.status || {};

    const incidentes = (data.incidents || []).map(i => ({
      id: `${apiConfig.nome}-${i.id}`,
      provedor: apiConfig.nome,
      nome: i.name,
      status: i.status,
      impacto: i.impact,
      atualizado: i.updated_at,
      url: i.shortlink || null
    }));

    const manutencoes = (data.scheduled_maintenances || []).map(m => ({
      id: `${apiConfig.nome}-${m.id}`,
      provedor: apiConfig.nome,
      nome: m.name,
      status: m.status,
      inicio: m.scheduled_for,
      fim: m.scheduled_until,
      atualizado: m.updated_at
    }));

    return { componentes, geral, latencia, incidentes, manutencoes, sucesso: true };

  } catch (erro) {
    const tipoErro = erro.code === 'ECONNABORTED' ? 'Timeout' : 
                     erro.code === 'ENOTFOUND' ? 'DNS Error' :
                     erro.response ? `HTTP ${erro.response.status}` : 'Network Error';
    
    console.error(`[${apiConfig.nome}] ✗ Falha na tentativa ${tentativa}/${MAX_RETRIES}: ${tipoErro}`);

    if (tentativa < MAX_RETRIES) {
      console.log(`[${apiConfig.nome}] ⏳ Aguardando ${RETRY_DELAY / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return consultarStatusPage(apiConfig, tentativa + 1);
    }

    console.error(`[${apiConfig.nome}] ✗ FALHA TOTAL após ${MAX_RETRIES} tentativas`);

    return {
      componentes: [{
        id: `${apiConfig.nome}-erro`,
        nome: `⚠️ Erro de Comunicação - ${apiConfig.nome}`,
        provedor: apiConfig.nome,
        categoria: apiConfig.categoria,
        grupo: null,
        status: 'DEGRADED',
        status_original: 'erro_comunicacao',
        label: 'Erro de Comunicação',
        descricao: `Não foi possível conectar após ${MAX_RETRIES} tentativas (${tipoErro})`,
        atualizado_em: new Date().toISOString(),
      }],
      geral: { indicator: 'minor', description: `Erro: ${tipoErro}` },
      latencia: null,
      incidentes: [],
      manutencoes: [],
      sucesso: false
    };
  }
}

// ─────────────────────────────────────────────
// MONITORAMENTO
// ─────────────────────────────────────────────

async function monitorar() {
  console.log('\n' + '='.repeat(80));
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} - Consultando todas as APIs...`);
  console.log('='.repeat(80));

  const resultados = await Promise.all(
    APIS_MONITORADAS.map(api => consultarStatusPage(api))
  );

  // Componentes completos (todos)
  const todosComponentes = resultados.flatMap(r => r.componentes);
  const todosIncidentes = resultados.flatMap(r => r.incidentes);
  const todasManutencoes = resultados.flatMap(r => r.manutencoes);

  // Cria cards agregados para KYC
  const componentesAgregados = [];
  
  APIS_MONITORADAS.forEach((api, index) => {
    const componentes = resultados[index].componentes;
    
    if (api.agregado) {
      // Cria card resumido
      const cardAgregado = criarCardAgregado(api.nome, componentes);
      componentesAgregados.push(cardAgregado);
    } else {
      // Mantém componentes individuais (Okto)
      componentesAgregados.push(...componentes);
    }
  });

  // Separa por categoria
  const porCategoria = {
    pagamentos: todosComponentes.filter(c => c.categoria === 'pagamentos'),
    kyc: todosComponentes.filter(c => c.categoria === 'kyc')
  };

  const nUp = todosComponentes.filter(c => c.status === 'UP').length;
  const nDegraded = todosComponentes.filter(c => c.status === 'DEGRADED').length;
  const nDown = todosComponentes.filter(c => c.status === 'DOWN').length;

  ultimosResultados = {
    timestamp: new Date().toISOString(),
    componentes: todosComponentes, // Todos os componentes (para alertas e histórico)
    componentes_agregados: componentesAgregados, // Para exibição no frontend
    por_categoria: porCategoria,
    geral: { indicator: nDown > 0 ? 'critical' : nDegraded > 0 ? 'minor' : 'none' },
    incidentes: todosIncidentes,
    manutencoes: todasManutencoes,
    resumo: {
      total: todosComponentes.length,
      up: nUp,
      degraded: nDegraded,
      down: nDown,
      por_provedor: APIS_MONITORADAS.map(api => ({
        nome: api.nome,
        componentes: todosComponentes.filter(c => c.provedor === api.nome).length
      }))
    }
  };

  historicoDia.push({
    timestamp: new Date().toISOString(),
    hora: new Date().toLocaleTimeString('pt-BR'),
    componentes: todosComponentes.map(c => ({
      id: c.id,
      nome: c.nome,
      provedor: c.provedor,
      categoria: c.categoria,
      grupo: c.grupo,
      status: c.status,
      status_original: c.status_original
    }))
  });

  if (historicoDia.length > 1440) historicoDia.shift();

  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[Sistema] Resetando histórico (meia-noite)');
    historicoDia = [];
  }

  await verificarAlertas(todosComponentes);

  const msg = JSON.stringify({ tipo: 'atualizacao', dados: ultimosResultados });
  clientesConectados.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  try {
    fs.appendFileSync('monitoramento_multiprovider.log', JSON.stringify({
      timestamp: ultimosResultados.timestamp,
      resumo: ultimosResultados.resumo
    }) + '\n');
  } catch (e) {}

  console.log(`\n[Monitor] RESUMO GERAL:`);
  console.log(`  Total: ${todosComponentes.length} | UP: ${nUp} | DEGRADED: ${nDegraded} | DOWN: ${nDown}`);
  console.log(`  Pagamentos (Okto): ${porCategoria.pagamentos.length} componentes`);
  console.log(`  KYC (Serasa+Legitimuz+Unico): ${porCategoria.kyc.length} componentes`);
  console.log(`  Cards na dashboard: ${componentesAgregados.length}`);
  if (todosIncidentes.length > 0) {
    console.log(`  Incidentes ativos: ${todosIncidentes.length}`);
  }
  console.log('='.repeat(80) + '\n');
}

// ─────────────────────────────────────────────
// ROTAS API
// ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime_segundos: Math.floor(process.uptime()),
    clientes_ws: clientesConectados.length,
    historico_size: historicoDia.length,
    ultima_verificacao: ultimosResultados.timestamp || null,
    apis_monitoradas: APIS_MONITORADAS.map(a => ({ nome: a.nome, categoria: a.categoria, agregado: a.agregado }))
  });
});

app.get('/api/historico', (req, res) => {
  const { inicio, fim, componente, provedor, categoria } = req.query;
  let dados = [...historicoDia];

  if (inicio && fim) {
    dados = dados.filter(item => {
      const hora = new Date(item.timestamp).getHours();
      const horaInicio = parseInt(inicio);
      const horaFim = parseInt(fim);
      return hora >= horaInicio && hora <= horaFim;
    });
  }

  if (provedor) {
    dados = dados.map(item => ({
      ...item,
      componentes: item.componentes.filter(c => c.provedor === provedor)
    }));
  }

  if (categoria) {
    dados = dados.map(item => ({
      ...item,
      componentes: item.componentes.filter(c => c.categoria === categoria)
    }));
  }

  if (componente) {
    dados = dados.map(item => ({
      ...item,
      componentes: item.componentes.filter(c => c.id === componente || c.nome === componente)
    }));
  }

  res.json({
    total: dados.length,
    periodo: {
      inicio: dados[0]?.timestamp || null,
      fim: dados[dados.length - 1]?.timestamp || null
    },
    dados
  });
});

app.get('/api/historico/exportar', (req, res) => {
  if (!historicoDia.length) {
    return res.status(404).send('Nenhum dado disponível para exportar.');
  }

  const dataHoje = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
  const cabecalho = ['data', 'hora', 'provedor', 'categoria', 'componente_id', 'componente_nome', 'grupo', 'status', 'status_original'].join(';');
  const linhas = [];

  historicoDia.forEach(item => {
    const data = new Date(item.timestamp).toLocaleDateString('pt-BR');
    const hora = item.hora || new Date(item.timestamp).toLocaleTimeString('pt-BR');
    item.componentes.forEach(c => {
      linhas.push([data, hora, c.provedor, c.categoria, c.id, c.nome, c.grupo || '', c.status, c.status_original].join(';'));
    });
  });

  const csv = '\uFEFF' + cabecalho + '\n' + linhas.join('\n');
  const nomeArquivo = `relatorio_multiprovider_${dataHoje}.csv`;

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
        porHora[hora].componentesAfetados.add(`${c.provedor}/${c.nome}`);
      }
    });
  });

  const resultado = Object.values(porHora).map(h => ({
    hora: h.hora,
    verificacoes: h.verificacoes,
    incidentes: h.incidentes,
    componentes_afetados: h.componentesAfetados.size,
    nomes_afetados: Array.from(h.componentesAfetados)
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
      const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`;
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
  console.log('Pix Health Monitor - Multi-Provider com Cards Agregados');
  console.log('='.repeat(60));
  console.log(`Servidor:   http://0.0.0.0:${PORTA}`);
  console.log(`Intervalo:  ${INTERVALO_SEGUNDOS}s`);
  console.log(`\nAPIs Monitoradas:`);
  APIS_MONITORADAS.forEach(api => {
    const tipo = api.agregado ? '[AGREGADO]' : '[DETALHADO]';
    console.log(`  • ${api.nome.padEnd(20)} ${tipo.padEnd(12)} ${api.categoria}`);
  });
  console.log(`\nIgnorados:  ${IGNORADOS.join(' | ')}`);
  console.log(`Slack:      ✓ webhook ativo | Menções: ${SLACK_MENTIONS.length} usuários`);
  console.log(`Email:      ${ALERT_EMAIL_TO ? '✓ configurado' : '✗ não configurado'}`);
  console.log('='.repeat(60) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
