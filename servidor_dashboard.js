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
// CONFIGURAÇÃO DE ALERTAS
// ─────────────────────────────────────────────

// Slack — webhook fixo + usuários a mencionar
const SLACK_WEBHOOK  = 'https://hooks.slack.com/services/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';
const SLACK_MENTIONS = ['U09G386SN01', 'U09BNJL6E2X', 'U09QSBQ7SEP'];

// Email (opcional — configure as variáveis no Render se quiser ativar futuramente)
const ALERT_EMAIL_TO  = process.env.ALERT_EMAIL_TO     || null;
const ALERT_EMAIL_FROM= process.env.ALERT_EMAIL_FROM   || null;
const SMTP_HOST       = process.env.SMTP_HOST          || null;
const SMTP_PORT       = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER       = process.env.SMTP_USER          || null;
const SMTP_PASS       = process.env.SMTP_PASS          || null;

// Mapa de estado anterior por componente { [id]: 'UP' | 'DEGRADED' | 'DOWN' }
// Evita alertas repetidos — só notifica quando o status MUDA
const estadoAnterior = {};

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
// group: true  → grupo pai — ignorar
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
// ALERTAS
// ─────────────────────────────────────────────

const EMOJI = { DOWN: '🔴', DEGRADED: '🟡', UP: '🟢' };
const LABEL = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };

async function enviarSlack(componente, statusNovo, statusAnterior) {
  const emoji     = { DOWN: '🔴', DEGRADED: '🟡', UP: '🟢' };
  const label     = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };
  const cor       = { DOWN: '#ff4d4d', DEGRADED: '#f5c842', UP: '#1fd97a' };

  const isRecovery  = statusNovo === 'UP';
  const horaAgora   = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dataAgora   = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const grupo       = componente.grupo || 'APIs & Infraestrutura';
  const mencoes     = SLACK_MENTIONS.map(id => `<@${id}>`).join(' ');

  const titulo = isRecovery
    ? `${emoji.UP} Serviço Recuperado — ${componente.nome}`
    : statusNovo === 'DOWN'
      ? `${emoji.DOWN} ALERTA CRÍTICO — ${componente.nome} está FORA DO AR`
      : `${emoji.DEGRADED} ALERTA — ${componente.nome} com DEGRADAÇÃO`;

  const payload = {
    text: mencoes, // garante que a menção aparece como notificação push
    blocks: [
      // Cabeçalho
      {
        type: 'header',
        text: { type: 'plain_text', text: titulo, emoji: true }
      },
      // Menções + chamada de atenção
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
      // Detalhes do incidente
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*🏦 Componente:*
\`${componente.nome}\``
          },
          {
            type: 'mrkdwn',
            text: `*📂 Grupo:*
${grupo}`
          },
          {
            type: 'mrkdwn',
            text: `*⚠️ Problema:*
${label[statusAnterior] || statusAnterior} → *${label[statusNovo] || statusNovo}*`
          },
          {
            type: 'mrkdwn',
            text: `*📡 Status técnico:*
\`${componente.status_original || statusNovo.toLowerCase()}\``
          },
          {
            type: 'mrkdwn',
            text: `*📅 Data:*
${dataAgora}`
          },
          {
            type: 'mrkdwn',
            text: `*🕐 Hora:*
${horaAgora}`
          }
        ]
      },
      { type: 'divider' },
      // Rodapé
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Pix Health Monitor · Okto Payments StatusPage · Detectado às ${horaAgora} de ${dataAgora}`
          }
        ]
      }
    ]
  };

  try {
    await axios.post(SLACK_WEBHOOK, payload, { timeout: 8000 });
    console.log(`[Slack] Alerta enviado: ${componente.nome} | ${label[statusAnterior]} → ${label[statusNovo]}`);
  } catch (e) {
    console.error('[Slack] Erro ao enviar alerta:', e.message);
  }
}


async function enviarEmail(componente, statusNovo, statusAnterior) {
  if (!ALERT_EMAIL_TO || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;

  // Nodemailer é carregado dinamicamente para não quebrar se não estiver instalado
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) {
    console.warn('[Email] nodemailer não instalado. Rode: npm install nodemailer');
    return;
  }

  const label     = LABEL[statusNovo]     || statusNovo;
  const labelAnt  = LABEL[statusAnterior] || statusAnterior;
  const hora      = new Date().toLocaleString('pt-BR');
  const isRecovery = statusNovo === 'UP';
  const cor       = statusNovo === 'DOWN' ? '#ff4d4d' : statusNovo === 'DEGRADED' ? '#f5c842' : '#1fd97a';

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
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20;width:40%">Componente</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;font-weight:600;border-bottom:1px solid #1a1a20">${componente.nome}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20">Grupo</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;border-bottom:1px solid #1a1a20">${componente.grupo || 'APIs & Infra'}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1a20">Mudança</td>
          <td style="padding:10px 0;font-size:14px;border-bottom:1px solid #1a1a20">
            <span style="color:#a0a0b0">${labelAnt}</span>
            <span style="color:#4a4a5a"> → </span>
            <span style="color:${cor};font-weight:700">${label}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Horário</td>
          <td style="padding:10px 0;color:#a0a0b0;font-size:13px;font-family:monospace">${hora}</td>
        </tr>
      </table>

      <p style="color:#4a4a5a;font-size:11px;margin-top:24px;text-align:center">
        Pix Health Monitor · Okto Payments StatusPage
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from:    `"Pix Health Monitor" <${ALERT_EMAIL_FROM || SMTP_USER}>`,
      to:      ALERT_EMAIL_TO,
      subject: `${isRecovery ? '✅ Recuperado' : statusNovo === 'DOWN' ? '🔴 DOWN' : '🟡 Degradação'} — ${componente.nome}`,
      html
    });
    console.log(`[Email] Alerta enviado para ${ALERT_EMAIL_TO}: ${componente.nome} → ${label}`);
  } catch (e) {
    console.error('[Email] Erro ao enviar:', e.message);
  }
}

// Verifica mudanças de estado e dispara alertas
async function verificarAlertas(componentes) {
  for (const c of componentes) {
    const anterior = estadoAnterior[c.id];

    // Primeira execução: apenas registra o estado, não alerta
    if (anterior === undefined) {
      estadoAnterior[c.id] = c.status;
      continue;
    }

    // Mudança de estado detectada
    if (anterior !== c.status) {
      const deveAlertar = c.status !== 'UP' || anterior !== 'UP'; // alerta na ida E na volta
      console.log(`[Alerta] ${c.nome}: ${anterior} → ${c.status}`);

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

  // Verifica mudanças e dispara alertas
  await verificarAlertas(componentes);

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
  console.log(`Slack:      ✓ webhook ativo | Menções: ${SLACK_MENTIONS.length} usuários`);
  console.log(`Email:      ${ALERT_EMAIL_TO ? '✓ configurado' : '✗ não configurado'}`);
  console.log('='.repeat(60) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
