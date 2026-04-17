require('./keepalive');
process.env.TZ = 'America/Sao_Paulo';

const express   = require('express');
const axios     = require('axios');
const fs        = require('fs');

const { inserirNoDataBricks } = require('./databricks');

const app    = express();

const PORTA              = process.env.PORT || 3000;
const INTERVALO_SEGUNDOS = process.env.INTERVALO_MONITORAMENTO || 60;
const SELF_PING_INTERVAL = 14 * 60 * 1000;
const TIMEOUT_MS         = 30000;
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 2000;

const OKTO_CONFIG = {
  nome:       'Okto Payments',
  urlSummary: 'https://oktopaymentsbrazil.statuspage.io/api/v2/summary.json',
  categoria:  'pagamentos'
};

const PAAG_CONFIG = {
  nome:       'Paag',
  urlSummary: 'https://statuspage.paag.com.br/api/v2/summary.json',
  categoria:  'infraestrutura',
  filtro:     ['PIX']
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

const CLOUDFLARE_CONFIG = {
  nome:       'Cloudflare',
  urlStatus:  'https://www.cloudflarestatus.com/api/v2/status.json',
  urlSummary: 'https://www.cloudflarestatus.com/api/v2/summary.json',
  categoria:  'infraestrutura'
};

const BACEN_CONFIG = {
  nome:        'Banco Central',
  urlInterrup: 'https://olinda.bcb.gov.br/olinda/servico/SPI/versao/v1/odata/PixInterrupcaoSPI?$format=json',
  categoria:   'infraestrutura'
};

const IGNORADOS_OKTO = ['RTM', 'JD'];

const BANCO_MAP = [
  { chave: 'Itaú',            okto: 'Itau',                   paag: 'Itaú'                    },
  { chave: 'Nubank',          okto: 'Nubank',                 paag: 'Nubank'                  },
  { chave: 'Santander',       okto: 'Santander',              paag: 'Santander'               },
  { chave: 'Bradesco',        okto: 'Bradesco',               paag: 'Bradesco'                },
  { chave: 'C6 Bank',         okto: 'C6 Bank',                paag: 'C6 Bank'                 },
  { chave: 'Banco do Brasil', okto: 'Banco do Brasil',        paag: 'Banco do Brasil'         },
  { chave: 'Caixa Econômica', okto: 'Caixa Economica',        paag: 'Caixa Econômica Federal' },
  { chave: 'PicPay',          okto: 'PicPay',                 paag: 'PicPay'                  },
  { chave: 'Inter',           okto: 'Inter',                  paag: 'Banco Inter'             },
];

function aplicarDoubleCheck(componentesOkto, componentesPaag) {
  const idxOkto = {};
  componentesOkto.forEach(c => { idxOkto[c.nome] = c; });

  const idxPaag = {};
  componentesPaag.forEach(c => { idxPaag[c.nome] = c; });

  const conflitos = [];
  const prioridade = { DOWN: 3, DEGRADED: 2, UP: 1 };

  for (const banco of BANCO_MAP) {
    const cOkto = idxOkto[banco.okto];
    const cPaag = idxPaag[banco.paag];

    if (!cOkto || !cPaag) continue;

    const statusOkto = cOkto.status;
    const statusPaag = cPaag.status;

    if (statusOkto === statusPaag) continue;

    const piorStatus = (prioridade[statusOkto] || 1) >= (prioridade[statusPaag] || 1)
      ? statusOkto : statusPaag;
    const fontePior  = (prioridade[statusOkto] || 1) >= (prioridade[statusPaag] || 1)
      ? 'Okto' : 'Paag';

    conflitos.push({ banco: banco.chave, statusOkto, statusPaag, piorStatus, fontePior });

    console.log(`[DoubleCheck] ⚠️  DIVERGÊNCIA em "${banco.chave}": Okto=${statusOkto} | Paag=${statusPaag} → elevando para ${piorStatus} (fonte: ${fontePior})`);

    if ((prioridade[piorStatus] || 1) > (prioridade[cOkto.status] || 1)) {
      cOkto.status         = piorStatus;
      cOkto.status_display = piorStatus;
      cOkto.label          = labelStatus(piorStatus);
      cOkto.double_check   = true;
      cOkto.double_check_info = `Confirmado via Paag: ${statusPaag} → status elevado para ${piorStatus}`;
    }
  }

  if (conflitos.length === 0) {
    console.log(`[DoubleCheck] ✓ ${BANCO_MAP.length} bancos verificados nas duas fontes — sem divergências`);
  } else {
    console.log(`[DoubleCheck] ${conflitos.length} divergência(s) detectada(s) e elevada(s)`);
  }

  return conflitos;
}

const SLACK_WEBHOOK  = process.env.SLACK_WEBHOOK;
const SLACK_MENTIONS = process.env.SLACK_MENTION ? process.env.SLACK_MENTION.split(',') : [];

const ALERT_EMAIL_TO   = process.env.ALERT_EMAIL_TO   || null;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || null;
const SMTP_HOST        = process.env.SMTP_HOST        || null;
const SMTP_PORT        = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER        = process.env.SMTP_USER        || null;
const SMTP_PASS        = process.env.SMTP_PASS        || null;

const estadoAnterior = {};

let ultimosResultados = {
  timestamp:             null,
  componentes:           [],
  componentes_dashboard: [],
  incidentes:            [],
  manutencoes:           [],
  resumo:                {},
  por_categoria:         { pagamentos: [], kyc: [] }
};

let historicoDia = [];

app.use(express.static('public'));
app.use(express.json());

const ERRO_THRESHOLD = 3;
const ERRO_JANELA_MS = 5 * 60 * 1000;
const ERRO_TTL_MS    = 10 * 60 * 1000;

const errosPlataforma = {};

const PROVEDORES_ACEITOS = {
  'okto':      { label: 'Okto Payments', categoria: 'pagamentos'     },
  'paag':      { label: 'Paag',          categoria: 'infraestrutura' },
  'serasa':    { label: 'Serasa',        categoria: 'kyc'            },
  'legitimuz': { label: 'Legitimuz',     categoria: 'kyc'            },
  'unico':     { label: 'Unico',         categoria: 'kyc'            },
};

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
  const grupos = {};
  rawComponents.filter(c => c.group === true).forEach(g => { grupos[g.id] = g.name; });

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

  const incidentes = (data.incidents || [])
    .filter(i => i.status !== 'resolved')
    .map(i => {
      const afetados = (i.components || []).map(c => c.name);
      return {
        id:         `Okto Payments-${i.id}`,
        provedor:   'Okto Payments',
        nome:       i.name,
        status:     i.status,
        impacto:    i.impact,
        atualizado: i.updated_at,
        url:        i.shortlink || null,
        afetados,
        updates:    (i.incident_updates || []).map(u => ({
          status:     u.status,
          body:       u.body,
          updated_at: u.updated_at
        }))
      };
    });

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

  const incidentePorBanco = {};
  incidentes.forEach(i => {
    (i.afetados || []).forEach(nome => {
      if (!incidentePorBanco[nome]) incidentePorBanco[nome] = i;
    });
  });

  const manutencaoPorBanco = {};
  (data.scheduled_maintenances || [])
    .filter(m => m.status !== 'completed')
    .forEach(m => {
      (m.components || []).forEach(c => {
        if (!manutencaoPorBanco[c.name]) {
          manutencaoPorBanco[c.name] = {
            nome:   m.name,
            inicio: m.scheduled_for,
            fim:    m.scheduled_until,
            status: m.status
          };
        }
      });
    });

  const componentesMarcados = componentes.map(c => {
    const inc  = incidentePorBanco[c.nome];
    const man  = manutencaoPorBanco[c.nome];
    const temIncidente = !!inc;

    let motivo = null;
    if (inc) {
      const ultimoUpdate = inc.updates?.[0];
      motivo = ultimoUpdate?.body || inc.nome || null;
    } else if (man) {
      motivo = `Manutenção programada: ${man.nome}` +
               (man.inicio ? ` (${new Date(man.inicio).toLocaleString('pt-BR')} → ${new Date(man.fim).toLocaleString('pt-BR')})` : '');
    }

    return {
      ...c,
      incidente_ativo:  temIncidente,
      status_display:   temIncidente && c.status === 'UP' ? 'WARNING' : c.status,
      motivo_incidente: motivo,
      incidente_nome:   inc?.nome || null,
      incidente_status: inc?.status || null,
      incidente_url:    inc?.url || null,
    };
  });

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

async function consultarPaag() {
  console.log(`[Paag] Consultando summary.json (filtro: PIX)...`);
  const inicio = Date.now();
  const { data, sucesso, tipoErro } = await httpGet(PAAG_CONFIG.urlSummary);

  if (!sucesso || !data) {
    console.error(`[Paag] ✗ Falha total: ${tipoErro}`);
    return {
      componentes: [{
        id:              'Paag-erro',
        nome:            '⚠️ Erro de Comunicação - PIX',
        provedor:        'Paag',
        categoria:       'infraestrutura',
        grupo:           'API & Infraestrutura',
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
  console.log(`[Paag] ✓ Resposta em ${latencia}ms`);

  const rawComponents = data.components || [];

  const componentePIX = rawComponents
    .filter(c => c.group === false)
    .find(c => PAAG_CONFIG.filtro.includes(c.name));

  if (!componentePIX) {
    console.warn(`[Paag] ⚠️ Componente 'PIX' não encontrado na API`);
    return {
      componentes: [{
        id:              'Paag-pix-nao-encontrado',
        nome:            'PIX',
        provedor:        'Paag',
        categoria:       'infraestrutura',
        grupo:           'API & Infraestrutura',
        status:          'DEGRADED',
        status_original: 'component_not_found',
        label:           'Não Encontrado',
        descricao:       'Componente PIX não está disponível na StatusPage',
        atualizado_em:   new Date().toISOString()
      }],
      incidentes:  [],
      manutencoes: []
    };
  }

  const status = mapearStatus(componentePIX.status);

  const incidentePIX = (data.incidents || [])
    .filter(i => i.status !== 'resolved')
    .find(i => (i.components || []).some(c => c.name === 'PIX'));

  const manutencaoPIX = (data.scheduled_maintenances || [])
    .filter(m => m.status !== 'completed')
    .find(m => (m.components || []).some(c => c.name === 'PIX'));

  let motivoPIX = null;
  if (incidentePIX) {
    const ultimoUpdate = (incidentePIX.incident_updates || [])[0];
    motivoPIX = ultimoUpdate?.body || incidentePIX.name || null;
  } else if (manutencaoPIX) {
    motivoPIX = `Manutenção programada: ${manutencaoPIX.name}` +
                (manutencaoPIX.scheduled_for ? ` (${new Date(manutencaoPIX.scheduled_for).toLocaleString('pt-BR')})` : '');
  }

  const componente = {
    id:              `Paag-${componentePIX.id}`,
    nome:            `PIX`,
    provedor:        'Paag',
    categoria:       'infraestrutura',
    grupo:           'API & Infraestrutura',
    status,
    status_original: componentePIX.status,
    label:           labelStatus(status),
    descricao:       componentePIX.description || null,
    atualizado_em:   componentePIX.updated_at || new Date().toISOString(),
    motivo_incidente: motivoPIX,
    incidente_nome:   incidentePIX?.name || null,
    incidente_status: incidentePIX?.status || null,
    incidente_url:    incidentePIX?.shortlink || null,
  };

  const incidentes = (data.incidents || [])
    .filter(i => i.status !== 'resolved')
    .filter(i => (i.components || []).some(c => c.name === 'PIX'))
    .map(i => ({
      id:         `Paag-${i.id}`,
      provedor:   'Paag',
      nome:       i.name,
      status:     i.status,
      impacto:    i.impact,
      atualizado: i.updated_at,
      url:        i.shortlink || null,
      afetados:   ['PIX'],
      updates:    (i.incident_updates || []).map(u => ({
        status:     u.status,
        body:       u.body,
        updated_at: u.updated_at
      }))
    }));

  const manutencoes = (data.scheduled_maintenances || [])
    .filter(m => (m.components || []).some(c => c.name === 'PIX'))
    .map(m => ({
      id: `Paag-${m.id}`, provedor: 'Paag',
      nome: m.name, status: m.status,
      inicio: m.scheduled_for, fim: m.scheduled_until, atualizado: m.updated_at
    }));

  if (incidentes.length > 0) {
    console.log(`[Paag] ⚠️  ${incidentes.length} incidente(s) ativo(s) no PIX`);
  }

  const PAAG_GRUPO_BANCOS = 'x58y2bm5mcph';
  const bancosDoubleCheck = rawComponents
    .filter(c => c.group === false && c.group_id === PAAG_GRUPO_BANCOS)
    .map(c => ({
      id:              `Paag-banco-${c.id}`,
      nome:            c.name,
      provedor:        'Paag',
      categoria:       'pagamentos',
      grupo:           'Operadores Bancários',
      status:          mapearStatus(c.status),
      status_original: c.status,
      label:           labelStatus(mapearStatus(c.status)),
      atualizado_em:   c.updated_at || new Date().toISOString(),
      _doubleCheckOnly: true
    }));

  console.log(`[Paag] 1 card: PIX (${status}) | ${bancosDoubleCheck.length} bancos carregados para double check`);
  return {
    componentes:      [componente],
    bancosDoubleCheck,
    incidentes,
    incidentesAtivos: incidentes,
    manutencoes
  };
}

async function consultarKYC(config) {
  console.log(`[${config.nome}] Consultando status.json...`);

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

    const incKYC = (summaryData.incidents || []).find(i => i.status !== 'resolved');
    const motivoKYC = incKYC
      ? ((incKYC.incident_updates || [])[0]?.body || incKYC.name || mensagem)
      : mensagem;

    componentesInternos = [{
      id:              `${config.nome}-geral`,
      nome:            config.nome,
      provedor:        config.nome,
      categoria:       'kyc',
      status:          statusGeral,
      status_original: indicator,
      label:           labelStatus(statusGeral),
      descricao:       mensagem,
      motivo_incidente: statusGeral !== 'UP' ? motivoKYC : null,
      incidente_nome:   incKYC?.name || null,
      incidente_status: incKYC?.status || null,
      incidente_url:    incKYC?.shortlink || null,
      atualizado_em:   new Date().toISOString()
    }];

  } else {
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

async function consultarBacen() {
  console.log(`[Bacen] Consultando PixInterrupcaoSPI...`);
  const inicio = Date.now();
  const { data, sucesso, tipoErro } = await httpGet(BACEN_CONFIG.urlInterrup);

  if (!sucesso || !data) {
    console.error(`[Bacen] ✗ Falha: ${tipoErro}`);
    return {
      card: {
        id:              'agregado-Bacen',
        nome:            'Banco Central (SPI)',
        provedor:        'Banco Central',
        categoria:       'infraestrutura',
        status:          'DEGRADED',
        label:           'DEGRADAÇÃO',
        mensagem:        `Não foi possível verificar o status (${tipoErro})`,
        detalhes:        [],
        atualizado_em:   new Date().toISOString(),
        agregado:        true
      },
      componentesInternos: [],
      incidentes:  [],
      manutencoes: []
    };
  }

  const latencia = Date.now() - inicio;
  console.log(`[Bacen] ✓ Resposta em ${latencia}ms`);

  const interrupcoes    = (data.value || []);
  const interrupcaoAtiva = interrupcoes.find(i =>
    i.DataHoraInicioInt &&
    i.DataHoraInicioInt !== 'TOTAL' &&
    i.DataHoraInicioInt !== '-' &&
    (!i.DataHoraTerminoInt || i.DataHoraTerminoInt === '-')
  );

  let statusGeral     = 'UP';
  let mensagem        = 'SPI operacional — nenhuma interrupção ativa';
  let motivoIncidente = null;

  if (interrupcaoAtiva) {
    statusGeral     = 'DOWN';
    mensagem        = `Interrupção do SPI desde ${interrupcaoAtiva.DataHoraInicioInt}`;
    motivoIncidente = interrupcaoAtiva.Interrupcao && interrupcaoAtiva.Interrupcao !== '-'
      ? interrupcaoAtiva.Interrupcao
      : `Interrupção oficial do SPI reportada pelo Banco Central desde ${interrupcaoAtiva.DataHoraInicioInt}`;
    console.log(`[Bacen] ⚠️  INTERRUPÇÃO ATIVA do SPI: ${interrupcaoAtiva.DataHoraInicioInt}`);
  } else {
    console.log(`[Bacen] ✓ SPI operacional — nenhuma interrupção ativa`);
  }

  const componentesInternos = [{
    id:              'Bacen-spi',
    nome:            'Banco Central (SPI)',
    provedor:        'Banco Central',
    categoria:       'infraestrutura',
    grupo:           null,
    status:          statusGeral,
    status_original: statusGeral.toLowerCase(),
    label:           labelStatus(statusGeral),
    descricao:       mensagem,
    motivo_incidente: motivoIncidente,
    incidente_nome:   interrupcaoAtiva ? 'Interrupção SPI — Banco Central' : null,
    incidente_url:    'https://www.bcb.gov.br/estabilidadefinanceira/pix',
    atualizado_em:    new Date().toISOString()
  }];

  return {
    card: {
      id:              'agregado-Bacen',
      nome:            'Banco Central (SPI)',
      provedor:        'Banco Central',
      categoria:       'infraestrutura',
      status:          statusGeral,
      label:           labelStatus(statusGeral),
      mensagem,
      detalhes:        [],
      atualizado_em:   new Date().toISOString(),
      agregado:        true
    },
    componentesInternos,
    incidentes:  [],
    manutencoes: []
  };
}

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

  let statusGeral = 'UP';
  let labelGeral  = 'OPERACIONAL';
  let mensagem    = 'Nenhum incidente ativo';

  if (incidentesAtivos.length > 0) {
    const inc        = incidentesAtivos[0];
    const isCritical = incidentesAtivos.some(i => i.impacto === 'critical');
    statusGeral      = isCritical ? 'DOWN' : 'DEGRADED';
    labelGeral       = isCritical ? 'DOWN' : 'DEGRADAÇÃO';
    mensagem         = inc.nome;

    console.log(`[Cloudflare] ⚠️  ${incidentesAtivos.length} incidente(s) ativo(s):`);
    incidentesAtivos.forEach(i => console.log(`  ↳ "${i.nome}" [${i.status}] impact=${i.impacto}`));
  } else {
    console.log(`[Cloudflare] ✓ Nenhum incidente ativo`);
  }

  let motivoCloudflare = mensagem;
  if (incidentesAtivos.length > 0) {
    const ultimoUpdate = incidentesAtivos[0].updates?.[0];
    if (ultimoUpdate?.body) motivoCloudflare = ultimoUpdate.body;
  }

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
    motivo_incidente: statusGeral !== 'UP' ? motivoCloudflare : null,
    incidente_nome:   incidentesAtivos[0]?.nome || null,
    incidente_status: incidentesAtivos[0]?.status || null,
    incidente_url:    incidentesAtivos[0]?.url || null,
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
      detalhes:         [],
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
            : `${mencoes} — Atenção! Problema detectado no monitoramento Pix Health.`
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
          { type: 'mrkdwn', text: `*🕐 Detectado:*\n${horaAgora} de ${dataAgora}` },
          ...(componente.double_check ? [{ type: 'mrkdwn', text: `*🔁 Double Check:*\n${componente.double_check_info || 'Confirmado por fonte secundária (Paag)'}` }] : [])
        ]
      },
      ...(!isRecovery && (componente.descricao || componente.updates?.length) ? [
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              '*🔍 Detalhes do problema:*',
              componente.descricao ? `> ${componente.descricao}` : null,
              componente.updates?.length
                ? `*📋 Último update (${componente.updates[0].status}):*\n> ${componente.updates[0].body}`
                : null
            ].filter(Boolean).join('\n')
          }
        }
      ] : []),
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

      const componenteEnriquecido = {
        ...c,
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

async function monitorar() {
  console.log('\n' + '='.repeat(80));
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} — Consultando APIs...`);
  console.log('='.repeat(80));

  const [oktoResult, paagResult, cloudflareResult, bacenResult, ...kycResults] = await Promise.all([
    consultarOkto(),
    consultarPaag(),
    consultarCloudflare(),
    consultarBacen(),
    ...KYC_CONFIGS.map(c => consultarKYC(c))
  ]);

  const componentesOkto        = oktoResult.componentes;
  const componentesPaag        = paagResult.componentes;
  const componentesKYC         = kycResults.flatMap(r => r.componentesInternos);
  const componentesCloudflare  = cloudflareResult.componentesInternos;
  const componentesBacen       = bacenResult.componentesInternos;

  const bancosDoubleCheck      = paagResult.bancosDoubleCheck || [];
  const conflitosDoubleCheck   = aplicarDoubleCheck(componentesOkto, bancosDoubleCheck);
  if (conflitosDoubleCheck.length > 0) {
    conflitosDoubleCheck.forEach(c =>
      console.log(`[DoubleCheck] 🔺 "${c.banco}" elevado para ${c.piorStatus} (Okto: ${c.statusOkto} | Paag: ${c.statusPaag})`)
    );
  }

  const todosComponentes = [...componentesOkto, ...componentesPaag, ...componentesKYC, ...componentesCloudflare, ...componentesBacen];

  const todosIncidentes  = [
    ...(oktoResult.incidentes        || []),
    ...(paagResult.incidentes        || []),
    ...(cloudflareResult.incidentes  || []),
    ...kycResults.flatMap(r => r.incidentes  || [])
  ];
  const todasManutencoes = [
    ...(oktoResult.manutencoes       || []),
    ...(paagResult.manutencoes       || []),
    ...(cloudflareResult.manutencoes || []),
    ...kycResults.flatMap(r => r.manutencoes || [])
  ];

  const incidentesAtivosOkto       = oktoResult.incidentesAtivos       || [];
  const incidentesAtivosPaag       = paagResult.incidentesAtivos       || [];
  const incidentesAtivosCloudflare = cloudflareResult.incidentesAtivos  || [];
  const todosIncidentesAtivos      = [...incidentesAtivosOkto, ...incidentesAtivosPaag, ...incidentesAtivosCloudflare];

  for (const inc of todosIncidentesAtivos) {
    const chave = `incidente-${inc.id}`;
    if (!estadoAnterior[chave]) {
      estadoAnterior[chave] = inc.status;
      continue;
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

  const componentesDashboard = [
    ...componentesOkto,
    ...componentesPaag,
    ...kycResults.map(r => r.card),
    cloudflareResult.card,
    bacenResult.card
  ];

  const porCategoria = {
    pagamentos:     componentesOkto,
    kyc:            componentesKYC,
    infraestrutura: [...componentesCloudflare, ...componentesPaag, ...componentesBacen]
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
      paag_cards:        componentesPaag.length,
      kyc_cards:         kycResults.length,
      cloudflare_cards:  1,
      bacen_cards:       1
    }
  };

  const timestampCiclo = new Date().toISOString();

  // Salva no historicoDia com todos os campos necessários para o endpoint de incidentes
  historicoDia.push({
    timestamp: timestampCiclo,
    hora:      new Date().toLocaleTimeString('pt-BR'),
    componentes: todosComponentes.map(c => ({
      id:               c.id,
      nome:             c.nome,
      provedor:         c.provedor,
      categoria:        c.categoria,
      grupo:            c.grupo            || null,
      status:           c.status,
      status_original:  c.status_original,
      double_check:     c.double_check     || false,
      double_check_info: c.double_check_info || null,
      motivo_incidente: c.motivo_incidente || null,
      incidente_nome:   c.incidente_nome   || null,
      incidente_url:    c.incidente_url    || null,
    }))
  });

  if (historicoDia.length > 1440) historicoDia.shift();

  inserirNoDataBricks(
    todosComponentes.map(c => ({
      id:              c.id,
      nome:            c.nome,
      provedor:        c.provedor,
      categoria:       c.categoria,
      grupo:           c.grupo || null,
      status:          c.status,
      status_original: c.status_original,
      double_check:    c.double_check    || false,
      double_check_info: c.double_check_info || null
    })),
    timestampCiclo
  ).catch(err => console.error('[Databricks] Erro ao inserir:', err.message));

  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[Sistema] Resetando histórico (meia-noite)');
    historicoDia = [];
  }

  await verificarAlertas(todosComponentes);

  try {
    fs.appendFileSync('monitoramento.log', JSON.stringify({
      timestamp: ultimosResultados.timestamp,
      resumo:    ultimosResultados.resumo
    }) + '\n');
  } catch (e) {}

  console.log(`\n[Monitor] RESUMO:`);
  console.log(`  Cards dashboard   : ${componentesDashboard.length}  (${componentesOkto.length} Okto + ${componentesPaag.length} Paag + ${kycResults.length} KYC + 1 Cloudflare)`);
  console.log(`  Status geral      : UP=${nUp} | DEGRADED=${nDegraded} | DOWN=${nDown}`);
  if (todosIncidentesAtivos.length > 0) {
    console.log(`  Incidentes ativos : ${todosIncidentesAtivos.length}`);
    todosIncidentesAtivos.forEach(i => console.log(`    ↳ [${i.provedor}] "${i.nome}" [${i.status}] afeta: ${i.afetados.join(', ') || 'n/a'}`));
  }
  console.log('='.repeat(80) + '\n');
}

function processarErroPlataforma(provedor, rota, httpStatus, mensagem) {
  const agora = Date.now();

  if (!errosPlataforma[provedor]) {
    errosPlataforma[provedor] = { erros: [], statusElevado: false, elevadoEm: null };
  }

  const estado = errosPlataforma[provedor];
  estado.erros.push({ timestamp: agora, rota, httpStatus, mensagem });
  estado.erros = estado.erros.filter(e => agora - e.timestamp < ERRO_JANELA_MS);

  const qtd  = estado.erros.length;
  const info = PROVEDORES_ACEITOS[provedor];

  console.log(`[ErroPlataforma] ${info.label} — ${qtd} erro(s) nos últimos 5min (threshold: ${ERRO_THRESHOLD}) | rota: ${rota} | HTTP ${httpStatus}`);

  if (qtd >= ERRO_THRESHOLD && !estado.statusElevado) {
    estado.statusElevado = true;
    estado.elevadoEm     = agora;

    console.log(`[ErroPlataforma] 🔺 ELEVANDO status de "${info.label}" para DEGRADED (${qtd} erros em 5min)`);

    if (ultimosResultados.componentes) {
      ultimosResultados.componentes = ultimosResultados.componentes.map(c => {
        if (c.provedor === info.label && c.status === 'UP') {
          return {
            ...c,
            status:           'DEGRADED',
            status_display:   'DEGRADED',
            label:            'DEGRADAÇÃO',
            plataforma_erro:  true,
            plataforma_info:  `${qtd} erros detectados pela plataforma nos últimos 5min`
          };
        }
        return c;
      });

      ultimosResultados.componentes_dashboard = ultimosResultados.componentes_dashboard.map(c => {
        if (c.provedor === info.label && c.status === 'UP') {
          return { ...c, status: 'DEGRADED', label: 'DEGRADAÇÃO', plataforma_erro: true };
        }
        return c;
      });

      const nUp       = ultimosResultados.componentes.filter(c => c.status === 'UP').length;
      const nDegraded = ultimosResultados.componentes.filter(c => c.status === 'DEGRADED').length;
      const nDown     = ultimosResultados.componentes.filter(c => c.status === 'DOWN').length;
      ultimosResultados.resumo = { ...ultimosResultados.resumo, up: nUp, degraded: nDegraded, down: nDown };

      const componenteAfetado = ultimosResultados.componentes.find(c => c.provedor === info.label);
      if (componenteAfetado) {
        verificarAlertas([{ ...componenteAfetado, status: 'DEGRADED' }]).catch(() => {});
      }
    }
  }

  if (estado.statusElevado) {
    clearTimeout(estado._recuperacaoTimer);
    estado._recuperacaoTimer = setTimeout(() => {
      console.log(`[ErroPlataforma] ✓ "${info.label}" sem novos erros por 10min — aguardando próximo ciclo para recuperar`);
      estado.statusElevado = false;
      estado.erros         = [];
    }, ERRO_TTL_MS);
  }
}

// ─────────────────────────────────────────────
// ROTAS API
// ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(ultimosResultados);
});

// ─────────────────────────────────────────────
// GET /api/historico/incidentes
// Retorna incidentes do dia (DEGRADED/DOWN) agrupados por componente
// com horário real de início e fim — 1 registro por ocorrência, sem duplicatas
// ─────────────────────────────────────────────
app.get('/api/historico/incidentes', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // incidentesAtivos: componente id → incidente em andamento
  const incidentesAtivos = {};
  // todosIncidentes: lista final (ativos + resolvidos)
  const todosIncidentes  = [];

  historicoDia.forEach(item => {
    item.componentes.forEach(c => {
      const chave = c.id;

      if (c.status === 'UP') {
        // Componente voltou ao normal — fecha incidente ativo se existir
        if (incidentesAtivos[chave]) {
          incidentesAtivos[chave].em_andamento = false;
          incidentesAtivos[chave].fim          = item.timestamp;
          delete incidentesAtivos[chave];
        }
      } else {
        // DEGRADED ou DOWN
        if (!incidentesAtivos[chave]) {
          // Novo incidente — cria e adiciona na lista final
          const novoIncidente = {
            id:               `${c.id}_${item.timestamp}`,
            nome:             c.nome,
            provedor:         c.provedor,
            categoria:        c.categoria,
            grupo:            c.grupo             || null,
            status:           c.status,
            status_original:  c.status_original,
            motivo_incidente: c.motivo_incidente  || null,
            incidente_nome:   c.incidente_nome    || null,
            incidente_url:    c.incidente_url     || null,
            double_check:     c.double_check      || false,
            double_check_info: c.double_check_info || null,
            inicio:           item.timestamp,
            fim:              null,
            em_andamento:     true
          };
          incidentesAtivos[chave] = novoIncidente;
          todosIncidentes.push(novoIncidente);
        } else {
          // Incidente já existe e continua ativo
          // Apenas atualiza status e motivo — NÃO cria novo registro
          incidentesAtivos[chave].status           = c.status;
          incidentesAtivos[chave].motivo_incidente  = c.motivo_incidente || incidentesAtivos[chave].motivo_incidente;
          incidentesAtivos[chave].incidente_nome    = c.incidente_nome   || incidentesAtivos[chave].incidente_nome;
        }
      }
    });
  });

  const incidentesOrdenados = todosIncidentes
    .sort((a, b) => new Date(b.inicio) - new Date(a.inicio));

  res.json({
    total:         incidentesOrdenados.length,
    em_andamento:  incidentesOrdenados.filter(i => i.em_andamento).length,
    resolvidos:    incidentesOrdenados.filter(i => !i.em_andamento).length,
    data:          new Date().toLocaleDateString('pt-BR'),
    atualizado_em: new Date().toISOString(),
    incidentes:    incidentesOrdenados
  });
});

app.post('/api/erros/reportar', (req, res) => {
  const { provedor, rota, httpStatus, mensagem, token } = req.body || {};

  const MONITOR_TOKEN = process.env.MONITOR_TOKEN;
  if (MONITOR_TOKEN && token !== MONITOR_TOKEN) {
    return res.status(401).json({ erro: 'Token inválido' });
  }

  if (!provedor || !PROVEDORES_ACEITOS[provedor.toLowerCase()]) {
    return res.status(400).json({
      erro: 'Provedor inválido',
      provedores_aceitos: Object.keys(PROVEDORES_ACEITOS)
    });
  }

  processarErroPlataforma(
    provedor.toLowerCase(),
    rota       || 'não informado',
    httpStatus || 0,
    mensagem   || 'não informado'
  );

  res.json({ ok: true, provedor: provedor.toLowerCase(), recebido_em: new Date().toISOString() });
});

app.get('/api/erros', (req, res) => {
  const agora = Date.now();
  const resumo = {};
  for (const [prov, estado] of Object.entries(errosPlataforma)) {
    const errosRecentes = estado.erros.filter(e => agora - e.timestamp < ERRO_JANELA_MS);
    resumo[prov] = {
      erros_5min:     errosRecentes.length,
      status_elevado: estado.statusElevado,
      elevado_em:     estado.elevadoEm ? new Date(estado.elevadoEm).toISOString() : null,
      ultimo_erro:    errosRecentes.length > 0
        ? new Date(errosRecentes[errosRecentes.length - 1].timestamp).toISOString()
        : null
    };
  }
  res.json({ threshold: ERRO_THRESHOLD, janela_minutos: 5, provedores: resumo });
});

app.get('/api/health', (req, res) => {
  res.json({
    status:             'alive',
    timestamp:          new Date().toISOString(),
    uptime_segundos:    Math.floor(process.uptime()),
    historico_size:     historicoDia.length,
    ultima_verificacao: ultimosResultados.timestamp || null,
    config: {
      timeout_ms:         TIMEOUT_MS,
      max_retries:        MAX_RETRIES,
      intervalo_segundos: INTERVALO_SEGUNDOS
    },
    endpoints: {
      okto:       OKTO_CONFIG.urlSummary,
      paag:       PAAG_CONFIG.urlSummary,
      serasa:     KYC_CONFIGS[0].urlStatus,
      legitimuz:  KYC_CONFIGS[1].urlStatus,
      unico:      KYC_CONFIGS[2].urlStatus,
      cloudflare: CLOUDFLARE_CONFIG.urlStatus,
      bacen:      BACEN_CONFIG.urlInterrup
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

app.listen(PORTA, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(65));
  console.log('Pix Health Monitor — Multi-Provider');
  console.log('='.repeat(65));
  console.log(`Servidor  : http://0.0.0.0:${PORTA}`);
  console.log(`Intervalo : ${INTERVALO_SEGUNDOS}s | Timeout: ${TIMEOUT_MS / 1000}s | Retries: ${MAX_RETRIES}`);
  console.log(`\nEndpoints configurados:`);
  console.log(`  • Okto Payments  [CARDS INDIVIDUAIS]     → summary.json`);
  console.log(`  • Paag           [1 CARD: PIX]           → summary.json (filtrado)`);
  KYC_CONFIGS.forEach(k => {
    console.log(`  • ${k.nome.padEnd(12)} [1 CARD AGREGADO]       → status.json  (+summary.json se degradado/down)`);
  });
  console.log(`  • Cloudflare     [1 CARD AGREGADO]       → status.json  (+summary.json sempre, para incidentes)`);
  console.log(`  • Banco Central  [1 CARD AGREGADO]       → PixInterrupcaoSPI (API oficial Bacen)`);
  console.log(`\nIgnorados Okto : ${IGNORADOS_OKTO.join(' | ')}`);
  console.log(`Slack          : ✓ webhook ativo | Menções: ${SLACK_MENTIONS.length} usuários`);
  console.log(`Email          : ${ALERT_EMAIL_TO ? '✓ configurado' : '✗ não configurado'}`);
  console.log(`\nNovo endpoint  : GET /api/historico/incidentes`);
  console.log('='.repeat(65) + '\n');

  iniciarKeepAlive();
  monitorar();
  setInterval(monitorar, INTERVALO_SEGUNDOS * 1000);
});
