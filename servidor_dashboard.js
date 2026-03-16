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
const TIMEOUT_MS         = 30000;
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 2000;

// ─────────────────────────────────────────────
// APIs MONITORADAS
//
// OKTO       → summary.json  → cards individuais (bancos + Central Bank + Withdraw/Deposit)
// KYC        → status.json   → 1 card por processadora
//              summary.json  → consultado só quando status != operational (detalha serviço afetado)
// CLOUDFLARE → status.json   → 1 card agregado
//              summary.json  → consultado só quando status != operational
//              incidents[]   → log completo igual ao da Okto (mesmo com componentes operacionais)
// ─────────────────────────────────────────────

const OKTO_CONFIG = {
  nome:       'Okto Payments',
  urlSummary: 'https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json',
  categoria:  'pagamentos'
};

const KYC_CONFIGS = [
  {
    nome:       'Serasa',
    urlStatus:  'https://status.allowme.com.br/api/v2/status.json',
    urlSummary: 'https://status.allowme.com.br/api/v2/summary.json',
    categoria:  'kyc'
  },
  {
    nome:       'Legitimuz',
    urlStatus:  'https://legitimuz.statuspage.io/api/v2/status.json',
    urlSummary: 'https://legitimuz.statuspage.io/api/v2/summary.json',
    categoria:  'kyc'
  },
  {
    nome:       'Unico',
    urlStatus:  'https://status.unico.io/api/v2/status.json',
    urlSummary: 'https://status.unico.io/api/v2/summary.json',
    categoria:  'kyc'
  }
];

// Cloudflare — infraestrutura crítica
// Mesma lógica de 2 etapas das KYC + detecção de incidentes ativos como a Okto
const CLOUDFLARE_CONFIG = {
  nome:       'Cloudflare',
  urlStatus:  'https://www.cloudflarestatus.com/api/v2/status.json',
  urlSummary: 'https://www.cloudflarestatus.com/api/v2/summary.json',
  categoria:  'infraestrutura'
};

// Componentes da Okto a ignorar
const IGNORADOS_OKTO = ['RTM', 'JD'];

// ─────────────────────────────────────────────
// CONFIGURAÇÃO DE ALERTAS
// ─────────────────────────────────────────────

const SLACK_WEBHOOK   = process.env.SLACK_WEBHOOK
const SLACK_WEBHOOK_2 = process.env.SLACK_WEBHOOK_2 || null
const SLACK_MENTIONS  = process.env.SLACK_MENTION ? process.env.SLACK_MENTION.split(',') : []


const ALERT_EMAIL_TO   = process.env.ALERT_EMAIL_TO   || null;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || null;
const SMTP_HOST        = process.env.SMTP_HOST        || null;
const SMTP_PORT        = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER        = process.env.SMTP_USER        || null;
const SMTP_PASS        = process.env.SMTP_PASS        || null;

const estadoAnterior = {};

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────

let ultimosResultados = {
  timestamp:             null,
  componentes:           [],   // Internos: todos individuais (alertas + histórico)
  componentes_dashboard: [],   // O que o frontend renderiza
  incidentes:            [],
  manutencoes:           [],
  resumo:                {},
  por_categoria:         { pagamentos: [], kyc: [] }
};

let clientesConectados = [];
let historicoDia       = [];

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

// Mapeia status do statuspage.io (components[].status) para UP / DEGRADED / DOWN
function mapearStatus(statusOriginal) {
  switch (statusOriginal) {
    case 'operational':           return 'UP';
    case 'degraded_performance':
    case 'under_maintenance':     return 'DEGRADED';
    case 'partial_outage':
    case 'major_outage':          return 'DOWN';
    default:                      return 'UP';
  }
}

// Mapeia o campo "indicator" do status.json para UP / DEGRADED / DOWN
function mapearIndicator(indicator) {
  switch (indicator) {
    case 'none':                  return 'UP';
    case 'minor':
    case 'maintenance':           return 'DEGRADED';
    case 'major':
    case 'critical':              return 'DOWN';
    default:                      return 'UP';
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
// HTTP COM RETRY
// ─────────────────────────────────────────────

async function httpGet(url, tentativa = 1) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'PixHealthMonitor/1.0' }
    });
    return { data: res.data, sucesso: true };
  } catch (erro) {
    const tipoErro = erro.code === 'ECONNABORTED' ? 'Timeout'
                   : erro.code === 'ENOTFOUND'    ? 'DNS Error'
                   : erro.response                ? `HTTP ${erro.response.status}`
                                                  : 'Network Error';
    if (tentativa < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return httpGet(url, tentativa + 1);
    }
    return { data: null, sucesso: false, tipoErro };
  }
}

// ─────────────────────────────────────────────
// OKTO — CONSULTA COMPLETA (summary.json)
// Retorna cards individuais: bancos + Central Bank + Withdraw/Deposit
// ─────────────────────────────────────────────

async function consultarOkto() {
  console.log(`[Okto] Consultando summary.json...`);
  const inicio = Date.now();
  const { data, sucesso, tipoErro } = await httpGet(OKTO_CONFIG.urlSummary);

  if (!sucesso || !data) {
    console.error(`[Okto] ✗ Falha total: ${tipoErro}`);
    return {
      componentes: [{
        id:              'Okto Payments-erro',
        nome:            '⚠️ Erro de Comunicação - Okto Payments',
        provedor:        'Okto Payments',
        categoria:       'pagamentos',
        grupo:           null,
        status:          'DEGRADED',
        status_original: 'erro_comunicacao',
        label:           'Erro de Comunicação',
        descricao:       `Não foi possível conectar (${tipoErro})`,
        atualizado_em:   new Date().toISOString()
      }],
      incidentes:  [],
      manutencoes: []
    };
  }

  const latencia = Date.now() - inicio;
  console.log(`[Okto] ✓ Resposta em ${latencia}ms`);

  const rawComponents = data.components || [];

  // Monta mapa de grupos
  const grupos = {};
  rawComponents.filter(c => c.group === true).forEach(g => { grupos[g.id] = g.name; });

  // Filtra apenas folhas (não são grupos) e remove os ignorados
  const componentes = rawComponents
    .filter(c => c.group === false && !IGNORADOS_OKTO.includes(c.name))
    .map(c => {
      const status = mapearStatus(c.status);
      return {
        id:              `Okto Payments-${c.id}`,
        nome:            c.name,
        provedor:        'Okto Payments',
        categoria:       'pagamentos',
        grupo:           c.group_id ? (grupos[c.group_id] || null) : null,
        status,
        status_original: c.status,
        label:           labelStatus(status),
        descricao:       c.description || null,
        atualizado_em:   c.updated_at  || new Date().toISOString()
      };
    })
    .sort((a, b) => {
      const ord = { DOWN: 0, DEGRADED: 1, UP: 2 };
      return (ord[a.status] ?? 2) - (ord[b.status] ?? 2);
    });

  // Incidentes ativos (qualquer status exceto resolved)
  // Inclui updates[] completo e lista de componentes afetados
  const incidentes = (data.incidents || [])
    .filter(i => i.status !== 'resolved')
    .map(i => {
      // Nomes dos componentes afetados por este incidente
      const afetados = (i.components || []).map(c => c.name);
      return {
        id:         `Okto Payments-${i.id}`,
        provedor:   'Okto Payments',
        nome:       i.name,
        status:     i.status,
        impacto:    i.impact,
        atualizado: i.updated_at,
        url:        i.shortlink || null,
        afetados,   // nomes dos bancos/componentes afetados
        updates:    (i.incident_updates || []).map(u => ({
          status:     u.status,
          body:       u.body,
          updated_at: u.updated_at
        }))
      };
    });

  // Incidentes resolvidos recentes (últimas 24h) — para histórico/modal
  const incidentesResolvidos = (data.incidents || [])
    .filter(i => i.status === 'resolved')
    .slice(0, 5)
    .map(i => ({
      id:         `Okto Payments-${i.id}`,
      provedor:   'Okto Payments',
      nome:       i.name,
      status:     i.status,
      impacto:    i.impact,
      atualizado: i.updated_at,
      url:        i.shortlink || null,
      afetados:   (i.components || []).map(c => c.name),
      updates:    (i.incident_updates || []).map(u => ({
        status:     u.status,
        body:       u.body,
        updated_at: u.updated_at
      }))
    }));

  // Marca componentes que têm incidente ativo (mesmo estando operational)
  const nomesComIncidente = new Set(
    incidentes.flatMap(i => i.afetados)
  );

  const componentesMarcados = componentes.map(c => ({
    ...c,
    incidente_ativo: nomesComIncidente.has(c.nome),
    // Se tem incidente ativo mas componente está UP, mostra como WARNING
    status_display: nomesComIncidente.has(c.nome) && c.status === 'UP' ? 'WARNING' : c.status
  }));

  const manutencoes = (data.scheduled_maintenances || []).map(m => ({
    id: `Okto Payments-${m.id}`, provedor: 'Okto Payments',
    nome: m.name, status: m.status,
    inicio: m.scheduled_for, fim: m.scheduled_until, atualizado: m.updated_at
  }));

  if (incidentes.length > 0) {
    console.log(`[Okto] ⚠️  ${incidentes.length} incidente(s) ativo(s):`);
    incidentes.forEach(i => console.log(`  ↳ "${i.nome}" (${i.status}) — afeta: ${i.afetados.join(', ') || 'não especificado'}`));
  }

  console.log(`[Okto] ${componentesMarcados.length} cards individuais`);
  return {
    componentes:          componentesMarcados,
    incidentes:           [...incidentes, ...incidentesResolvidos],
    incidentesAtivos:     incidentes,
    manutencoes
  };
}

// ─────────────────────────────────────────────
// KYC — CONSULTA EM 2 ETAPAS
//
// Etapa 1: status.json  → indicator geral → UP / DEGRADED / DOWN
// Etapa 2: summary.json → SOMENTE se não for UP → lista serviços afetados
//
// Resultado: SEMPRE 1 único card por processadora na dashboard
// ─────────────────────────────────────────────

async function consultarKYC(config) {
  console.log(`[${config.nome}] Consultando status.json...`);

  // ── Etapa 1: status geral ──
  const { data: statusData, sucesso: statusOk, tipoErro: statusErro } =
    await httpGet(config.urlStatus);

  if (!statusOk || !statusData) {
    console.error(`[${config.nome}] ✗ status.json falhou: ${statusErro}`);
    return {
      card: {
        id:            `agregado-${config.nome}`,
        nome:          config.nome,
        provedor:      config.nome,
        categoria:     'kyc',
        status:        'DEGRADED',
        label:         'DEGRADAÇÃO',
        mensagem:      `Não foi possível verificar o status (${statusErro})`,
        detalhes:      [],
        atualizado_em: new Date().toISOString(),
        agregado:      true
      },
      componentesInternos: [],
      incidentes:          [],
      manutencoes:         []
    };
  }

  const indicator   = statusData.status?.indicator  || 'none';
  const description = statusData.status?.description || '';
  const statusGeral = mapearIndicator(indicator);

  console.log(`[${config.nome}] ✓ indicator="${indicator}" → ${statusGeral}`);

  // ── Tudo operacional: card verde, sem buscar detalhes ──
  if (statusGeral === 'UP') {
    return {
      card: {
        id:            `agregado-${config.nome}`,
        nome:          config.nome,
        provedor:      config.nome,
        categoria:     'kyc',
        status:        'UP',
        label:         'OPERACIONAL',
        mensagem:      'Todos os serviços operacionais',
        detalhes:      [],
        atualizado_em: new Date().toISOString(),
        agregado:      true
      },
      componentesInternos: [{
        id:              `${config.nome}-geral`,
        nome:            config.nome,
        provedor:        config.nome,
        categoria:       'kyc',
        status:          'UP',
        status_original: indicator,
        label:           'OPERACIONAL',
        descricao:       description,
        atualizado_em:   new Date().toISOString()
      }],
      incidentes:  [],
      manutencoes: []
    };
  }

  // ── Há problema: busca summary.json para identificar serviços afetados ──
  console.log(`[${config.nome}] ⚠️  ${statusGeral} — buscando detalhes via summary.json...`);

  const { data: summaryData, sucesso: summaryOk } = await httpGet(config.urlSummary);

  let detalhes            = [];
  let componentesInternos = [];
  let incidentes          = [];
  let manutencoes         = [];
  let mensagem            = description || labelStatus(statusGeral);

  if (summaryOk && summaryData) {
    const rawComponents = summaryData.components || [];
    const grupos = {};
    rawComponents.filter(c => c.group === true).forEach(g => { grupos[g.id] = g.name; });

    // Componentes individuais (para detalhes do card)
    const todosIndividuais = rawComponents
      .filter(c => c.group === false)
      .map(c => {
        const st = mapearStatus(c.status);
        return {
          id:              `${config.nome}-${c.id}`,
          nome:            c.name,
          provedor:        config.nome,
          categoria:       'kyc',
          grupo:           c.group_id ? (grupos[c.group_id] || null) : null,
          status:          st,
          status_original: c.status,
          label:           labelStatus(st),
          descricao:       c.description || null,
          atualizado_em:   c.updated_at  || new Date().toISOString()
        };
      });

    // Serviços com problema → aparecem nos detalhes do card
    const afetados = todosIndividuais.filter(c => c.status !== 'UP');
    const nDown    = afetados.filter(c => c.status === 'DOWN').length;
    const nDeg     = afetados.filter(c => c.status === 'DEGRADED').length;

    if (nDown > 0 && nDeg > 0) {
      mensagem = `${nDown} serviço${nDown > 1 ? 's' : ''} fora do ar e ${nDeg} com degradação`;
    } else if (nDown > 0) {
      mensagem = `${nDown} serviço${nDown > 1 ? 's' : ''} fora do ar`;
    } else if (nDeg > 0) {
      mensagem = `${nDeg} serviço${nDeg > 1 ? 's' : ''} com degradação`;
    }

    detalhes = afetados.map(c => ({
      nome:   c.nome,
      status: c.label,
      motivo: c.descricao && c.descricao.trim()
                ? c.descricao
                : `Instabilidade reportada na StatusPage (${c.status_original})`
    }));

    incidentes  = (summaryData.incidents || []).map(i => ({
      id: `${config.nome}-${i.id}`, provedor: config.nome,
      nome: i.name, status: i.status, impacto: i.impact,
      atualizado: i.updated_at, url: i.shortlink || null
    }));

    manutencoes = (summaryData.scheduled_maintenances || []).map(m => ({
      id: `${config.nome}-${m.id}`, provedor: config.nome,
      nome: m.name, status: m.status,
      inicio: m.scheduled_for, fim: m.scheduled_until, atualizado: m.updated_at
    }));

    console.log(`[${config.nome}] ✓ ${afetados.length} serviço(s) afetado(s):`);
    afetados.forEach(c => console.log(`  ↳ ${c.nome}: ${c.label}`));

    // IMPORTANTE: componente interno sempre usa ID fixo 'X-geral'
    // Isso garante que o verificarAlertas rastreie corretamente a mudança
    // de status entre ciclos (UP → DEGRADED → UP) usando sempre o mesmo ID.
    // Os detalhes individuais ficam no card para exibição, não nos alertas.
    componentesInternos = [{
      id:              `${config.nome}-geral`,
      nome:            config.nome,
      provedor:        config.nome,
      categoria:       'kyc',
      status:          statusGeral,
      status_original: indicator,
      label:           labelStatus(statusGeral),
      descricao:       mensagem,   // ex: "2 serviços com degradação"
      atualizado_em:   new Date().toISOString()
    }];

  } else {
    // summary.json indisponível — card com status geral sem detalhar serviços
    console.warn(`[${config.nome}] ⚠️  summary.json indisponível — card sem detalhes de serviço`);
    mensagem = description || `Instabilidade detectada (${labelStatus(statusGeral)})`;
    componentesInternos = [{
      id:              `${config.nome}-geral`,
      nome:            config.nome,
      provedor:        config.nome,
      categoria:       'kyc',
      status:          statusGeral,
      status_original: indicator,
      label:           labelStatus(statusGeral),
      descricao:       description,
      atualizado_em:   new Date().toISOString()
    }];
  }

  return {
    card: {
      id:            `agregado-${config.nome}`,
      nome:          config.nome,
      provedor:      config.nome,
      categoria:     'kyc',
      status:        statusGeral,
      label:         labelStatus(statusGeral),
      mensagem,
      detalhes,
      atualizado_em: new Date().toISOString(),
      agregado:      true
    },
    componentesInternos,
    incidentes,
    manutencoes
  };
}

// ─────────────────────────────────────────────
// CLOUDFLARE — BASEADO 100% EM INCIDENTS[]
//
// Ignora componentes individuais (são centenas de países/regiões).
// Status do card é determinado exclusivamente pelos incidents[]:
//   • Sem incidente ativo  → card verde
//   • Incidente ativo      → card amarelo/vermelho com log completo
// ─────────────────────────────────────────────

async function consultarCloudflare() {
  console.log(`[Cloudflare] Consultando summary.json...`);

  const { data, sucesso, tipoErro } = await httpGet(CLOUDFLARE_CONFIG.urlSummary);

  if (!sucesso || !data) {
    console.error(`[Cloudflare] ✗ Falha: ${tipoErro}`);
    return {
      card: {
        id:              'agregado-Cloudflare',
        nome:            'Cloudflare',
        provedor:        'Cloudflare',
        categoria:       'infraestrutura',
        status:          'DEGRADED',
        label:           'DEGRADAÇÃO',
        mensagem:        `Não foi possível verificar o status (${tipoErro})`,
        detalhes:        [],
        incidente_ativo:  false,
        incidentes_ativos: [],
        atualizado_em:   new Date().toISOString(),
        agregado:        true
      },
      componentesInternos: [],
      incidentes:          [],
      incidentesAtivos:    [],
      manutencoes:         []
    };
  }

  // ── Incidentes ativos (não resolved) ──
  const incidentesAtivos = (data.incidents || [])
    .filter(i => i.status !== 'resolved')
    .map(i => ({
      id:         `Cloudflare-${i.id}`,
      provedor:   'Cloudflare',
      nome:       i.name,
      status:     i.status,
      impacto:    i.impact,
      atualizado: i.updated_at,
      url:        i.shortlink || null,
      afetados:   (i.components || []).map(c => c.name),
      updates:    (i.incident_updates || []).map(u => ({
        status:     u.status,
        body:       u.body,
        updated_at: u.updated_at
      }))
    }));

  // ── Incidentes resolvidos recentes (para histórico/modal) ──
  const incidentesResolvidos = (data.incidents || [])
    .filter(i => i.status === 'resolved')
    .slice(0, 5)
    .map(i => ({
      id:         `Cloudflare-${i.id}`,
      provedor:   'Cloudflare',
      nome:       i.name,
      status:     i.status,
      impacto:    i.impact,
      atualizado: i.updated_at,
      url:        i.shortlink || null,
      afetados:   (i.components || []).map(c => c.name),
      updates:    (i.incident_updates || []).map(u => ({
        status:     u.status,
        body:       u.body,
        updated_at: u.updated_at
      }))
    }));

  const manutencoes = (data.scheduled_maintenances || []).map(m => ({
    id: `Cloudflare-${m.id}`, provedor: 'Cloudflare',
    nome: m.name, status: m.status,
    inicio: m.scheduled_for, fim: m.scheduled_until, atualizado: m.updated_at
  }));

  // ── Status do card determinado SOMENTE pelos incidentes ──
  let statusGeral = 'UP';
  let labelGeral  = 'OPERACIONAL';
  let mensagem    = 'Nenhum incidente ativo';

  if (incidentesAtivos.length > 0) {
    const inc = incidentesAtivos[0];
    // Determina severidade pelo campo impact do incidente
    const isCritical = incidentesAtivos.some(i => i.impacto === 'critical' || i.impacto === 'major');
    statusGeral = isCritical ? 'DOWN' : 'DEGRADED';
    labelGeral  = isCritical ? 'DOWN' : 'DEGRADAÇÃO';
    mensagem    = inc.nome;

    console.log(`[Cloudflare] ⚠️  ${incidentesAtivos.length} incidente(s) ativo(s):`);
    incidentesAtivos.forEach(i => console.log(`  ↳ "${i.nome}" [${i.status}] impact=${i.impacto}`));
  } else {
    console.log(`[Cloudflare] ✓ Nenhum incidente ativo`);
  }

  // Componente interno único (para alertas e histórico)
  const componentesInternos = [{
    id:              'Cloudflare-geral',
    nome:            'Cloudflare',
    provedor:        'Cloudflare',
    categoria:       'infraestrutura',
    grupo:           null,
    status:          statusGeral,
    status_original: statusGeral.toLowerCase(),
    label:           labelGeral,
    descricao:       mensagem,
    atualizado_em:   new Date().toISOString()
  }];

  return {
    card: {
      id:               'agregado-Cloudflare',
      nome:             'Cloudflare',
      provedor:         'Cloudflare',
      categoria:        'infraestrutura',
      status:           statusGeral,
      label:            labelGeral,
      mensagem,
      detalhes:         [],          // Não usamos detalhes de componentes — o log está nos incidents
      incidente_ativo:  incidentesAtivos.length > 0,
      incidentes_ativos: incidentesAtivos,
      atualizado_em:    new Date().toISOString(),
      agregado:         true
    },
    componentesInternos,
    incidentes:       [...incidentesAtivos, ...incidentesResolvidos],
    incidentesAtivos,
    manutencoes
  };
}


// ─────────────────────────────────────────────
// ALERTAS — SLACK
// ─────────────────────────────────────────────

async function enviarSlack(componente, statusNovo, statusAnterior) {
  const emoji = { DOWN: '🔴', DEGRADED: '🟡', UP: '🟢' };
  const label = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };

  const isRecovery   = statusNovo === 'UP';
  const horaAgora    = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dataAgora    = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const grupoDisplay =
    componente.categoria === 'kyc'            ? 'Processadoras KYC'  :
    componente.categoria === 'infraestrutura' ? 'Infraestrutura'     :
    componente.grupo || 'APIs & Infraestrutura';

  const mencoes = SLACK_MENTIONS.map(id => `<@${id}>`).join(' ');

  const titulo = isRecovery
    ? `${emoji.UP} Serviço Recuperado — ${componente.provedor}: ${componente.nome}`
    : statusNovo === 'DOWN'
      ? `${emoji.DOWN} ALERTA CRÍTICO — ${componente.provedor}: ${componente.nome} está FORA DO AR`
      : `${emoji.DEGRADED} ALERTA — ${componente.provedor}: ${componente.nome} com DEGRADAÇÃO`;

  // Detalhes adicionais para KYC/Cloudflare (vem da descricao do componente interno)
  const detalheExtra = !isRecovery && componente.descricao
    ? `\n> ${componente.descricao}`
    : '';

  const payload = {
    text: mencoes,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: titulo, emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: isRecovery
            ? `${mencoes} — O serviço voltou ao normal. ✅`
            : `${mencoes} — Atenção! Problema detectado no monitoramento Pix Health.${detalheExtra}`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*🏢 Provedor:*\n\`${componente.provedor}\`` },
          { type: 'mrkdwn', text: `*🔧 Serviço:*\n\`${componente.nome}\`` },
          { type: 'mrkdwn', text: `*📂 Categoria:*\n${grupoDisplay}` },
          { type: 'mrkdwn', text: `*⚠️ Mudança:*\n${label[statusAnterior] || statusAnterior} → *${label[statusNovo] || statusNovo}*` },
          { type: 'mrkdwn', text: `*📡 Status técnico:*\n\`${componente.status_original || statusNovo.toLowerCase()}\`` },
          { type: 'mrkdwn', text: `*🕐 Detectado:*\n${horaAgora} de ${dataAgora}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Pix Health Monitor · Multi-Provider · ${componente.provedor}` }]
      }
    ]
  };

  try {
    await axios.post(SLACK_WEBHOOK, payload, { timeout: 8000 });
    console.log(`[Slack] Alerta: ${componente.provedor}/${componente.nome} | ${label[statusAnterior]} → ${label[statusNovo]}`);
  } catch (e) {
    console.error('[Slack] Erro:', e.message);
  }
}

// ─────────────────────────────────────────────
// ALERTAS — EMAIL
// ─────────────────────────────────────────────

async function enviarEmail(componente, statusNovo, statusAnterior) {
  if (!ALERT_EMAIL_TO || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { console.warn('[Email] nodemailer não instalado. Rode: npm install nodemailer'); return; }

  const label      = { DOWN: 'FORA DO AR', DEGRADED: 'DEGRADAÇÃO', UP: 'OPERACIONAL' };
  const isRecovery = statusNovo === 'UP';
  const cor        = statusNovo === 'DOWN' ? '#ff4d4d' : statusNovo === 'DEGRADED' ? '#f5c842' : '#1fd97a';
  const hora       = new Date().toLocaleString('pt-BR');
  const grupoDisplay = componente.categoria === 'kyc' ? 'Processadoras KYC' : (componente.grupo || 'APIs & Infraestrutura');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;background:#0f0f13;padding:32px;border-radius:12px;max-width:520px;margin:0 auto">
      <div style="border-left:4px solid ${cor};padding-left:16px;margin-bottom:24px">
        <p style="color:#a0a0b0;font-size:11px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px">Pix Health Monitor</p>
        <h2 style="color:#f0f0f5;margin:0;font-size:20px">
          ${isRecovery ? '✅ Serviço recuperado' : statusNovo === 'DOWN' ? '🔴 Serviço fora do ar' : '🟡 Degradação detectada'}
        </h2>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;border-bottom:1px solid #1a1a20;width:40%">Provedor</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;font-weight:600;border-bottom:1px solid #1a1a20">${componente.provedor}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;border-bottom:1px solid #1a1a20">Serviço</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;font-weight:600;border-bottom:1px solid #1a1a20">${componente.nome}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;border-bottom:1px solid #1a1a20">Categoria</td>
          <td style="padding:10px 0;color:#f0f0f5;font-size:14px;border-bottom:1px solid #1a1a20">${grupoDisplay}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase;border-bottom:1px solid #1a1a20">Mudança</td>
          <td style="padding:10px 0;font-size:14px;border-bottom:1px solid #1a1a20">
            <span style="color:#a0a0b0">${label[statusAnterior] || statusAnterior}</span>
            <span style="color:#4a4a5a"> → </span>
            <span style="color:${cor};font-weight:700">${label[statusNovo] || statusNovo}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#4a4a5a;font-size:12px;text-transform:uppercase">Horário</td>
          <td style="padding:10px 0;color:#a0a0b0;font-size:13px;font-family:monospace">${hora}</td>
        </tr>
      </table>
      <p style="color:#4a4a5a;font-size:11px;margin-top:24px;text-align:center">Pix Health Monitor · Multi-Provider StatusPage</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from:    `"Pix Health Monitor" <${ALERT_EMAIL_FROM || SMTP_USER}>`,
      to:      ALERT_EMAIL_TO,
      subject: `${isRecovery ? '✅ Recuperado' : statusNovo === 'DOWN' ? '🔴 DOWN' : '🟡 Degradação'} — ${componente.provedor}: ${componente.nome}`,
      html
    });
    console.log(`[Email] Alerta enviado: ${componente.provedor}/${componente.nome}`);
  } catch (e) {
    console.error('[Email] Erro:', e.message);
  }
}

// ─────────────────────────────────────────────
// VERIFICAR E DISPARAR ALERTAS
// Sempre sobre componentes individuais internos
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// VERIFICAR E DISPARAR ALERTAS
// Cobre TODOS os componentes internos:
//   • Okto    → cada banco/API individual
//   • KYC     → componente 'X-geral' (status vem do indicator do status.json)
//   • Cloudflare → componente 'Cloudflare-geral' (status vem dos incidents[])
// ─────────────────────────────────────────────

async function verificarAlertas(componentes) {
  for (const c of componentes) {
    const anterior = estadoAnterior[c.id];

    if (anterior === undefined) {
      estadoAnterior[c.id] = c.status;
      console.log(`[Alerta] Registrado estado inicial: ${c.provedor}/${c.nome} → ${c.status}`);
      continue;
    }

    if (anterior !== c.status) {
      console.log(`[Alerta] MUDANÇA DETECTADA: ${c.provedor}/${c.nome}: ${anterior} → ${c.status}`);

      // Enriquece a descrição para KYC e Cloudflare no alerta
      const componenteEnriquecido = {
        ...c,
        // Para KYC/Cloudflare o grupo fica como a categoria legível
        grupo: c.grupo || (
          c.categoria === 'kyc'            ? 'Processadoras KYC' :
          c.categoria === 'infraestrutura' ? 'Infraestrutura'    :
          'APIs & Infraestrutura'
        )
      };

      await Promise.allSettled([
        enviarSlack(componenteEnriquecido, c.status, anterior),
        enviarEmail(componenteEnriquecido, c.status, anterior)
      ]);
      estadoAnterior[c.id] = c.status;
    }
  }
}

// ─────────────────────────────────────────────
// MONITORAMENTO PRINCIPAL
// ─────────────────────────────────────────────

async function monitorar() {
  console.log('\n' + '='.repeat(80));
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} — Consultando APIs...`);
  console.log('='.repeat(80));

  const [oktoResult, cloudflareResult, ...kycResults] = await Promise.all([
    consultarOkto(),
    consultarCloudflare(),
    ...KYC_CONFIGS.map(c => consultarKYC(c))
  ]);

  const componentesOkto        = oktoResult.componentes;
  const componentesKYC         = kycResults.flatMap(r => r.componentesInternos);
  const componentesCloudflare  = cloudflareResult.componentesInternos;
  const todosComponentes       = [...componentesOkto, ...componentesKYC, ...componentesCloudflare];

  const todosIncidentes  = [
    ...(oktoResult.incidentes        || []),
    ...(cloudflareResult.incidentes  || []),
    ...kycResults.flatMap(r => r.incidentes  || [])
  ];
  const todasManutencoes = [
    ...(oktoResult.manutencoes       || []),
    ...(cloudflareResult.manutencoes || []),
    ...kycResults.flatMap(r => r.manutencoes || [])
  ];

  // Incidentes ATIVOS — Okto e Cloudflare
  const incidentesAtivosOkto       = oktoResult.incidentesAtivos       || [];
  const incidentesAtivosCloudflare = cloudflareResult.incidentesAtivos  || [];
  const todosIncidentesAtivos      = [...incidentesAtivosOkto, ...incidentesAtivosCloudflare];

  // Alerta Slack para novos incidentes ativos (Okto + Cloudflare)
  for (const inc of todosIncidentesAtivos) {
    const chave = `incidente-${inc.id}`;
    if (!estadoAnterior[chave]) {
      estadoAnterior[chave] = inc.status;
      continue; // Primeiro ciclo: registra sem alertar
    }
    if (estadoAnterior[chave] !== inc.status) {
      console.log(`[Incidente] Novo status: "${inc.nome}" (${inc.provedor}) → ${inc.status}`);
      const pseudo = {
        id:              inc.id,
        nome:            inc.nome,
        provedor:        inc.provedor,
        categoria:       inc.provedor === 'Cloudflare' ? 'infraestrutura' : 'pagamentos',
        grupo:           null,
        status:          inc.status === 'resolved' ? 'UP' : 'DEGRADED',
        status_original: inc.status,
        label:           inc.status === 'resolved' ? 'OPERACIONAL' : 'INCIDENTE ATIVO'
      };
      const statusPrev = estadoAnterior[chave] === 'resolved' ? 'UP' : 'DEGRADED';
      await Promise.allSettled([
        enviarSlack(pseudo, pseudo.status, statusPrev),
        enviarEmail(pseudo, pseudo.status, statusPrev)
      ]);
      estadoAnterior[chave] = inc.status;
    }
  }

  // Dashboard:
  //   • Okto        → cards individuais (bancos + APIs)
  //   • KYC         → 1 card por processadora
  //   • Cloudflare  → 1 card agregado
  const componentesDashboard = [
    ...componentesOkto,
    ...kycResults.map(r => r.card),
    cloudflareResult.card
  ];

  const porCategoria = {
    pagamentos:     componentesOkto,
    kyc:            componentesKYC,
    infraestrutura: componentesCloudflare
  };

  const nUp       = todosComponentes.filter(c => c.status === 'UP').length;
  const nDegraded = todosComponentes.filter(c => c.status === 'DEGRADED').length;
  const nDown     = todosComponentes.filter(c => c.status === 'DOWN').length;
  const temIncidenteAtivo = todosIncidentesAtivos.length > 0;

  ultimosResultados = {
    timestamp:             new Date().toISOString(),
    componentes:           todosComponentes,
    componentes_dashboard: componentesDashboard,
    por_categoria:         porCategoria,
    geral: {
      indicator: nDown > 0 ? 'critical'
               : nDegraded > 0 ? 'minor'
               : temIncidenteAtivo ? 'minor'
               : 'none'
    },
    incidentes:        todosIncidentes,
    incidentes_ativos: todosIncidentesAtivos,
    manutencoes:       todasManutencoes,
    resumo: {
      total:             todosComponentes.length,
      up:                nUp,
      degraded:          nDegraded,
      down:              nDown,
      incidentes_ativos: todosIncidentesAtivos.length,
      dashboard_cards:   componentesDashboard.length,
      okto_cards:        componentesOkto.length,
      kyc_cards:         kycResults.length,
      cloudflare_cards:  1
    }
  };

  // Histórico
  historicoDia.push({
    timestamp: new Date().toISOString(),
    hora:      new Date().toLocaleTimeString('pt-BR'),
    componentes: todosComponentes.map(c => ({
      id: c.id, nome: c.nome, provedor: c.provedor,
      categoria: c.categoria, grupo: c.grupo || null,
      status: c.status, status_original: c.status_original
    }))
  });

  if (historicoDia.length > 1440) historicoDia.shift();

  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[Sistema] Resetando histórico (meia-noite)');
    historicoDia = [];
  }

  await verificarAlertas(todosComponentes);

  // Broadcast WebSocket
  const msg = JSON.stringify({ tipo: 'atualizacao', dados: ultimosResultados });
  clientesConectados.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  // Log em arquivo
  try {
    fs.appendFileSync('monitoramento.log', JSON.stringify({
      timestamp: ultimosResultados.timestamp,
      resumo:    ultimosResultados.resumo
    }) + '\n');
  } catch (e) {}

  console.log(`\n[Monitor] RESUMO:`);
  console.log(`  Cards dashboard   : ${componentesDashboard.length}  (${componentesOkto.length} Okto + ${kycResults.length} KYC + 1 Cloudflare)`);
  console.log(`  Status geral      : UP=${nUp} | DEGRADED=${nDegraded} | DOWN=${nDown}`);
  if (todosIncidentesAtivos.length > 0) {
    console.log(`  Incidentes ativos : ${todosIncidentesAtivos.length}`);
    todosIncidentesAtivos.forEach(i => console.log(`    ↳ [${i.provedor}] "${i.nome}" [${i.status}] afeta: ${i.afetados.join(', ') || 'n/a'}`));
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
    status:             'alive',
    timestamp:          new Date().toISOString(),
    uptime_segundos:    Math.floor(process.uptime()),
    clientes_ws:        clientesConectados.length,
    historico_size:     historicoDia.length,
    ultima_verificacao: ultimosResultados.timestamp || null,
    config: {
      timeout_ms:         TIMEOUT_MS,
      max_retries:        MAX_RETRIES,
      intervalo_segundos: INTERVALO_SEGUNDOS
    },
    endpoints: {
      okto:       OKTO_CONFIG.urlSummary,
      serasa:     KYC_CONFIGS[0].urlStatus,
      legitimuz:  KYC_CONFIGS[1].urlStatus,
      unico:      KYC_CONFIGS[2].urlStatus,
      cloudflare: CLOUDFLARE_CONFIG.urlStatus
    }
  });
});

app.get('/api/historico', (req, res) => {
  const { inicio, fim, componente, provedor, categoria } = req.query;
  let dados = [...historicoDia];

  if (inicio && fim) {
    dados = dados.filter(item => {
      const h = new Date(item.timestamp).getHours();
      return h >= parseInt(inicio) && h <= parseInt(fim);
    });
  }
  if (provedor)   dados = dados.map(item => ({ ...item, componentes: item.componentes.filter(c => c.provedor  === provedor) }));
  if (categoria)  dados = dados.map(item => ({ ...item, componentes: item.componentes.filter(c => c.categoria === categoria) }));
  if (componente) dados = dados.map(item => ({ ...item, componentes: item.componentes.filter(c => c.id === componente || c.nome === componente) }));

  res.json({
    total: dados.length,
    periodo: {
      inicio: dados[0]?.timestamp                || null,
      fim:    dados[dados.length - 1]?.timestamp || null
    },
    dados
  });
});

app.get('/api/historico/exportar', (req, res) => {
  if (!historicoDia.length) return res.status(404).send('Nenhum dado disponível para exportar.');

  const dataHoje  = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
  const cabecalho = ['data','hora','provedor','categoria','componente_id','componente_nome','grupo','status','status_original'].join(';');
  const linhas    = [];

  historicoDia.forEach(item => {
    const data = new Date(item.timestamp).toLocaleDateString('pt-BR');
    const hora = item.hora || new Date(item.timestamp).toLocaleTimeString('pt-BR');
    item.componentes.forEach(c => {
      linhas.push([data, hora, c.provedor, c.categoria, c.id, c.nome, c.grupo || '', c.status, c.status_original].join(';'));
    });
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio_${dataHoje}.csv"`);
  res.send('\uFEFF' + cabecalho + '\n' + linhas.join('\n'));
});

app.get('/api/oscilacoes', (req, res) => {
  if (historicoDia.length < 5) {
    return res.json({ mensagem: 'Dados insuficientes (mínimo 5 verificações)', porHora: [] });
  }

  const porHora = {};
  historicoDia.forEach(item => {
    const h = new Date(item.timestamp).getHours();
    if (!porHora[h]) porHora[h] = { hora: `${String(h).padStart(2,'0')}:00`, verificacoes: 0, incidentes: 0, afetados: new Set() };
    porHora[h].verificacoes++;
    item.componentes.forEach(c => {
      if (c.status !== 'UP') { porHora[h].incidentes++; porHora[h].afetados.add(`${c.provedor}/${c.nome}`); }
    });
  });

  const resultado = Object.values(porHora).map(h => ({
    hora:                 h.hora,
    verificacoes:         h.verificacoes,
    incidentes:           h.incidentes,
    componentes_afetados: h.afetados.size,
    nomes_afetados:       Array.from(h.afetados)
  })).sort((a, b) => a.hora.localeCompare(b.hora));

  res.json({
    horarioCritico: resultado.reduce((max, h) => h.incidentes > (max?.incidentes || 0) ? h : max, null),
    porHora:        resultado
  });
});

// ─────────────────────────────────────────────
// KEEP-ALIVE
// ─────────────────────────────────────────────

function iniciarKeepAlive() {
  setInterval(async () => {
    try {
      const selfUrl  = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`;
      const response = await axios.get(`${selfUrl}/api/health`, {
        timeout: 5000, headers: { 'User-Agent': 'Internal-KeepAlive/1.0' }
      });
      console.log(`[Keep-Alive] OK — Uptime: ${response.data.uptime_segundos}s | Histórico: ${response.data.historico_size} registros`);
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
  console.log('\n' + '='.repeat(65));
  console.log('Pix Health Monitor — Multi-Provider');
  console.log('='.repeat(65));
  console.log(`Servidor  : http://0.0.0.0:${PORTA}`);
  console.log(`Intervalo : ${INTERVALO_SEGUNDOS}s | Timeout: ${TIMEOUT_MS / 1000}s | Retries: ${MAX_RETRIES}`);
  console.log(`\nEndpoints configurados:`);
  console.log(`  • Okto Payments  [CARDS INDIVIDUAIS]  → summary.json`);
  KYC_CONFIGS.forEach(k => {
    console.log(`  • ${k.nome.padEnd(12)} [1 CARD AGREGADO]    → status.json  (+summary.json se degradado/down)`);
  });
  console.log(`  • Cloudflare     [1 CARD AGREGADO]    → status.json  (+summary.json sempre, para incidentes)`);
  console.log(`\nIgnorados Okto : ${IGNORADOS_OKTO.join(' | ')}`);
  console.log(`Slack          : ✓ webhook ativo | Menções: ${SLACK_MENTIONS.length} usuários`);
  console.log(`Email          : ${ALERT_EMAIL_TO ? '✓ configurado' : '✗ não configurado'}`);
  console.log('='.repeat(65) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
