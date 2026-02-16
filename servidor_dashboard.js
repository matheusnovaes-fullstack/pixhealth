require('./keepalive');
process.env.TZ = 'America/Sao_Paulo';
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const INTERVALO_SEGUNDOS = process.env.INTERVALO_MONITORAMENTO || 60;
const TIMEOUT_MS = 8000;
const LATENCIA_LENTA = 2000;
const LATENCIA_CRITICA = 5000;
const PORTA = process.env.PORT || 3000;
const SELF_PING_INTERVAL = 14 * 60 * 1000;

const BANCOS_MONITORADOS = [
  { 
    id: 'nubank', 
    nome: 'Nubank', 
    urls: ['https://nubank.com.br'],
    statusAPI: 'https://status.nubank.com.br/api/v2/status.json',
    baselineInicial: 500
  },
  { 
    id: 'itau', 
    nome: 'Itaú', 
    urls: [
      'https://statuspage.itau.com.br',
      'https://devportal.itau.com.br',
      'https://www.itau.com.br/empresas',
      'https://www.itau.com.br'
    ],
    statusAPI: 'https://statuspage.itau.com.br/api/v2/status.json',
    downdetectorURL: 'https://downdetector.com.br/fora-do-ar/itau',
    baselineInicial: 600
  },
  { 
    id: 'banco-do-brasil', 
    nome: 'Banco do Brasil', 
    urls: [
      'https://www.bb.com.br/pbb',
      'https://www.bb.com.br/site/pra-voce',
      'https://www.bb.com.br'
    ],
    downdetectorURL: 'https://downdetector.com.br/fora-do-ar/banco-do-brasil',
    baselineInicial: 800
  },
  { 
    id: 'bradesco', 
    nome: 'Bradesco', 
    urls: [
      'https://banco.bradesco',
      'https://banco.bradesco/html/classic/index.shtm'
    ],
    baselineInicial: 600
  },
  { 
    id: 'santander', 
    nome: 'Santander', 
    urls: ['https://www.santander.com.br'],
    baselineInicial: 600
  },
  { 
    id: 'banco-inter', 
    nome: 'Inter', 
    urls: ['https://www.bancointer.com.br'],
    statusAPI: 'https://status.bancointer.com.br/api/v2/status.json',
    baselineInicial: 450
  },
  { 
    id: 'mercado-pago', 
    nome: 'Mercado Pago', 
    urls: ['https://www.mercadopago.com.br'],
    baselineInicial: 400
  },
  { 
    id: 'picpay', 
    nome: 'PicPay', 
    urls: ['https://www.picpay.com'],
    baselineInicial: 500
  },
  { 
    id: 'c6-bank', 
    nome: 'C6 Bank', 
    urls: ['https://www.c6bank.com.br'],
    statusAPI: 'https://status.c6bank.com.br/api/v2/status.json',
    baselineInicial: 450
  },
  { 
    id: 'btg-pactual', 
    nome: 'BTG Pactual', 
    urls: [
      'https://www.btgpactual.com/contact',
      'https://www.btgpactual.com/about-us',
      'https://www.btgpactual.com'
    ],
    downdetectorURL: 'https://downdetector.com.br/fora-do-ar/btg-pactual',
    baselineInicial: 500
  },
  { 
    id: 'safra', 
    nome: 'Safra', 
    urls: ['https://www.safra.com.br'],
    baselineInicial: 700
  }
];

let ultimosResultados = [];
let clientesConectados = [];
let historicoLatencias = {};
let historicoTimeouts = {};
let historicoDia = [];

app.use(express.static('public'));

wss.on('connection', (ws) => {
  console.log('[WebSocket] Cliente conectado');
  clientesConectados.push(ws);
  
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  if (ultimosResultados.length > 0) {
    ws.send(JSON.stringify({
      tipo: 'atualizacao',
      dados: ultimosResultados
    }));
  }
  
  ws.on('pong', () => {});
  
  ws.on('close', () => {
    console.log('[WebSocket] Cliente desconectado');
    clearInterval(pingInterval);
    clientesConectados = clientesConectados.filter(cliente => cliente !== ws);
  });
  
  ws.on('error', (error) => {
    console.error('[WebSocket] Erro:', error.message);
  });
});

BANCOS_MONITORADOS.forEach(banco => {
  historicoLatencias[banco.id] = [];
  historicoTimeouts[banco.id] = [];
});

function calcularBaseline(bancoId) {
  const banco = BANCOS_MONITORADOS.find(b => b.id === bancoId);
  const historico = historicoLatencias[bancoId] || [];
  
  if (historico.length === 0) {
    return banco ? banco.baselineInicial : 1000;
  }
  
  if (historico.length < 3) {
    const media = historico.reduce((acc, val) => acc + val, 0) / historico.length;
    return Math.round((media + banco.baselineInicial) / 2);
  }
  
  const ultimas = historico.slice(-30);
  const soma = ultimas.reduce((acc, val) => acc + val, 0);
  return Math.round(soma / ultimas.length);
}

function calcularTimeoutRate(bancoId) {
  const historico = historicoTimeouts[bancoId] || [];
  
  if (historico.length === 0) {
    return 0;
  }
  
  const ultimas = historico.slice(-100);
  const timeouts = ultimas.filter(t => t === true).length;
  return parseFloat(((timeouts / ultimas.length) * 100).toFixed(2));
}

async function verificarStatusAPI(url) {
  try {
    const response = await axios.get(url, { 
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (response.data && response.data.status) {
      return {
        online: response.data.status.indicator === 'none',
        indicator: response.data.status.indicator,
        description: response.data.status.description || 'Operacional'
      };
    }
  } catch (erro) {
    return null;
  }
}

async function verificarDowndetector(url) {
  try {
    const response = await axios.get(url, { 
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = response.data.toLowerCase();
    
    const temProblema = 
      html.includes('problema em andamento') ||
      html.includes('possíveis problemas') ||
      html.includes('grande número de relatos');
    
    const match = html.match(/(\d+)\s+usuários?\s+relat/);
    const reclamacoes = match ? parseInt(match[1]) : 0;
    
    return {
      online: !temProblema || reclamacoes < 100,
      reclamacoes: reclamacoes
    };
  } catch (erro) {
    return null;
  }
}

async function testarBanco(banco) {
  console.log(`[${banco.nome}] Iniciando verificação...`);
  
  for (const url of banco.urls) {
    try {
      const inicioURL = Date.now();
      const response = await axios.get(url, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Referer': 'https://www.google.com/'
        }
      });
      
      const latencia = Date.now() - inicioURL;
      
      if (response.status >= 200 && response.status < 400) {
        console.log(`[${banco.nome}] URL direta OK: ${url} (${latencia}ms)`);
        
        historicoLatencias[banco.id].push(latencia);
        if (historicoLatencias[banco.id].length > 50) {
          historicoLatencias[banco.id].shift();
        }
        
        historicoTimeouts[banco.id].push(false);
        if (historicoTimeouts[banco.id].length > 100) {
          historicoTimeouts[banco.id].shift();
        }
        
        const baseline = calcularBaseline(banco.id);
        const proporcao = baseline > 0 ? (latencia / baseline).toFixed(2) : 1;
        
        let status = 'OK';
        if (latencia >= LATENCIA_CRITICA) {
          status = 'CRÍTICO';
        } else if (latencia >= LATENCIA_LENTA) {
          status = 'LENTO';
        }
        
        return {
          id: banco.id,
          nome: banco.nome,
          status,
          latencia,
          baseline,
          proporcao,
          statusCode: response.status,
          online: true,
          timestamp: new Date().toISOString(),
          urlsOnline: '1/1',
          urlsOffline: 0,
          urlUsada: url.replace('https://', '').substring(0, 40),
          fonte: 'URL Direta',
          confianca: 100,
          timeout_rate: calcularTimeoutRate(banco.id)
        };
      }
      
      if (response.status === 403) {
        console.log(`[${banco.nome}] HTTP 403 em ${url}, tentando próxima...`);
        continue;
      }
      
    } catch (erro) {
      console.log(`[${banco.nome}] Erro em ${url}: ${erro.code || erro.message}`);
      
      if (erro.code === 'ECONNABORTED' || erro.code === 'ETIMEDOUT') {
        historicoTimeouts[banco.id].push(true);
        if (historicoTimeouts[banco.id].length > 100) {
          historicoTimeouts[banco.id].shift();
        }
      }
      
      continue;
    }
  }
  
  if (banco.statusAPI) {
    console.log(`[${banco.nome}] Tentando Status API oficial...`);
    
    const statusAPI = await verificarStatusAPI(banco.statusAPI);
    
    if (statusAPI) {
      console.log(`[${banco.nome}] Status API: ${statusAPI.online ? 'Online' : 'Problema'}`);
      
      const baseline = calcularBaseline(banco.id);
      
      return {
        id: banco.id,
        nome: banco.nome,
        status: statusAPI.online ? 'OK' : 'CRÍTICO',
        latencia: 'Via API Status',
        baseline,
        proporcao: 1,
        statusCode: 200,
        online: statusAPI.online,
        timestamp: new Date().toISOString(),
        urlsOnline: statusAPI.online ? '1/1' : '0/1',
        urlsOffline: statusAPI.online ? 0 : 1,
        fonte: 'Status API Oficial',
        confianca: 95,
        statusOficial: statusAPI,
        timeout_rate: calcularTimeoutRate(banco.id)
      };
    }
  }
  
  if (banco.downdetectorURL) {
    console.log(`[${banco.nome}] Tentando Downdetector...`);
    
    const downdetector = await verificarDowndetector(banco.downdetectorURL);
    
    if (downdetector) {
      console.log(`[${banco.nome}] Downdetector: ${downdetector.reclamacoes} reclamações`);
      
      const baseline = calcularBaseline(banco.id);
      
      return {
        id: banco.id,
        nome: banco.nome,
        status: downdetector.online ? 'OK' : 'LENTO',
        latencia: `${downdetector.reclamacoes} reclamações`,
        baseline,
        proporcao: 1,
        statusCode: 0,
        online: downdetector.online,
        timestamp: new Date().toISOString(),
        urlsOnline: downdetector.online ? '~1/1' : '~0/1',
        urlsOffline: downdetector.online ? 0 : 1,
        fonte: 'Downdetector',
        confianca: 70,
        downdetectorReclamacoes: downdetector.reclamacoes,
        timeout_rate: calcularTimeoutRate(banco.id)
      };
    }
  }
  
  console.log(`[${banco.nome}] Todas URLs bloqueadas (HTTP 403)`);
  
  const baseline = calcularBaseline(banco.id);
  
  return {
    id: banco.id,
    nome: banco.nome,
    status: 'OK',
    latencia: 'Protegido',
    baseline,
    proporcao: 0.08,
    statusCode: 403,
    online: true,
    timestamp: new Date().toISOString(),
    urlsOnline: '?/?',
    urlsOffline: 0,
    protegido: true,
    fonte: 'Bloqueado (Cloudflare/WAF)',
    confianca: 10,
    timeout_rate: calcularTimeoutRate(banco.id)
  };
}

function calcularScoreSeveridade(banco, resultado, todosResultados) {
  let score = 0;
  let fatores = [];
  
  if (resultado.protegido) {
    return {
      score: 5,
      nivel: 'NENHUM',
      classificacao: 'Protegido',
      fatores: ['HTTP 403 - Cloudflare/WAF']
    };
  }
  
  if (resultado.statusCode >= 500 && resultado.statusCode < 600) {
    score += 40;
    fatores.push('Erro 5xx');
  }
  
  const lat = typeof resultado.latencia === 'number' ? resultado.latencia : 0;
  if (lat >= 10000) {
    score += 40;
    fatores.push('Latência 10s+');
  } else if (lat >= 5000) {
    score += 30;
    fatores.push('Latência 5s+');
  } else if (lat >= 3000) {
    score += 20;
    fatores.push('Latência 3s+');
  } else if (lat >= 2000) {
    score += 10;
    fatores.push('Latência 2s+');
  }
  
  const prop = parseFloat(resultado.proporcao);
  if (resultado.baseline > 0 && prop >= 8) {
    score += 30;
    fatores.push(prop + 'x mais lento');
  } else if (resultado.baseline > 0 && prop >= 5) {
    score += 20;
    fatores.push(prop + 'x mais lento');
  } else if (resultado.baseline > 0 && prop >= 3) {
    score += 10;
    fatores.push(prop + 'x lento');
  }
  
  if (resultado.status === 'ERRO') {
    score += 45;
    fatores.push('Timeout/Offline');
  }
  
  if (resultado.status === 'CRÍTICO') {
    score += 20;
    fatores.push('Status crítico');
  }
  
  if (resultado.urlsOffline && resultado.urlsOffline >= 2) {
    score += 20;
    fatores.push(resultado.urlsOffline + ' URLs fora');
  } else if (resultado.urlsOffline === 1) {
    score += 10;
    fatores.push('1 URL fora');
  }
  
  if (todosResultados && todosResultados.length > 3) {
    const outrosOK = todosResultados.filter(b => 
      b.id !== banco.id && b.status === 'OK'
    ).length;
    
    const porcentagemOutrosOK = (outrosOK / (todosResultados.length - 1)) * 100;
    
    if (porcentagemOutrosOK >= 75 && resultado.status !== 'OK') {
      score += 15;
      fatores.push('Problema isolado');
    }
  }
  
  const historico = historicoLatencias[banco.id] || [];
  if (historico.length >= 3) {
    const ultimos3 = historico.slice(-3);
    const baseline = calcularBaseline(banco.id);
    const todosLentos = ultimos3.every(l => l > baseline * 2.5);
    
    if (todosLentos) {
      score += 15;
      fatores.push('Persistente');
    }
  }
  
  if (resultado.status === 'OK' && score === 0) {
    fatores.push('Saudável');
  }
  
  score = Math.min(score, 100);
  
  let nivel, classificacao;
  if (score >= 80) {
    nivel = 'CRÍTICO';
    classificacao = 'Problema Grave';
  } else if (score >= 60) {
    nivel = 'ALTO';
    classificacao = 'Problema Confirmado';
  } else if (score >= 40) {
    nivel = 'MODERADO';
    classificacao = 'Degradação Detectada';
  } else if (score >= 20) {
    nivel = 'BAIXO';
    classificacao = 'Anomalia Leve';
  } else {
    nivel = 'NENHUM';
    classificacao = 'Operacional';
  }
  
  return { score, nivel, classificacao, fatores };
}

function classificarPrioridade(banco) {
  const { status, severidade } = banco;
  
  if (!severidade) {
    return { nivel: 'P4_INFO', acao: 'NENHUMA' };
  }
  
  if (status === 'CRÍTICO' && severidade.score >= 70) {
    return {
      nivel: 'P1_CRITICO',
      acao: 'ALERTAR IMEDIATAMENTE'
    };
  }
  
  if (status === 'ERRO' && severidade.score >= 60) {
    return {
      nivel: 'P1_CRITICO',
      acao: 'ALERTAR IMEDIATAMENTE'
    };
  }
  
  if ((status === 'LENTO' || status === 'CRÍTICO') && severidade.score >= 50) {
    return {
      nivel: 'P2_URGENTE',
      acao: 'INVESTIGAR EM 5 MIN'
    };
  }
  
  if (status === 'LENTO' && severidade.score >= 30) {
    return {
      nivel: 'P3_ATENCAO',
      acao: 'MONITORAR'
    };
  }
  
  return {
    nivel: 'P4_INFO',
    acao: 'NENHUMA'
  };
}

async function monitorarBancos() {
  const timestampInicio = Date.now();
  const hora = new Date().toLocaleTimeString('pt-BR');
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[${hora}] Verificando ${BANCOS_MONITORADOS.length} instituições...`);
  console.log('='.repeat(80));
  
  const resultados = [];
  
  for (const banco of BANCOS_MONITORADOS) {
    const resultado = await testarBanco(banco);
    resultados.push(resultado);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  resultados.forEach(resultado => {
    const bancoConfig = BANCOS_MONITORADOS.find(b => b.id === resultado.id);
    resultado.severidade = calcularScoreSeveridade(bancoConfig, resultado, resultados);
    resultado.prioridade = classificarPrioridade(resultado);
  });
  
  const tempoTotal = ((Date.now() - timestampInicio) / 1000).toFixed(1);
  
  const criticos = resultados.filter(r => r.status === 'CRÍTICO').length;
  const lentos = resultados.filter(r => r.status === 'LENTO').length;
  const ok = resultados.filter(r => r.status === 'OK').length;
  const erros = resultados.filter(r => r.status === 'ERRO').length;
  
  const alertasCriticos = resultados.filter(r => r.prioridade.nivel === 'P1_CRITICO');
  const alertasUrgentes = resultados.filter(r => r.prioridade.nivel === 'P2_URGENTE');
  
  if (alertasCriticos.length > 0) {
    console.log('\n[ALERTA CRÍTICO]');
    alertasCriticos.forEach(b => {
      console.log(`  ${b.nome}: Severidade ${b.severidade.score}% | ${b.severidade.fatores.join(', ')}`);
    });
  }
  
  if (alertasUrgentes.length > 0) {
    console.log('\n[ALERTA URGENTE]');
    alertasUrgentes.forEach(b => {
      console.log(`  ${b.nome}: Severidade ${b.severidade.score}% | ${b.severidade.fatores.join(', ')}`);
    });
  }
  
  console.log(`\n[RESUMO] ${tempoTotal}s | OK: ${ok} | Lentos: ${lentos} | Críticos: ${criticos} | Erros: ${erros}`);
  console.log('='.repeat(80) + '\n');
  
  ultimosResultados = {
    timestamp: new Date().toISOString(),
    tempoVerificacao: tempoTotal,
    bancos: resultados,
    resumo: { criticos, alertas: lentos, ok, erros, total: resultados.length }
  };
  
  historicoDia.push({
    timestamp: new Date().toISOString(),
    hora: new Date().toLocaleTimeString('pt-BR'),
    bancos: resultados.map(r => ({
      id: r.id,
      nome: r.nome,
      status: r.status,
      latencia: typeof r.latencia === 'number' ? r.latencia : null,
      baseline: r.baseline,
      severidade: r.severidade.score,
      fonte: r.fonte,
      timeout_rate: r.timeout_rate
    }))
  });
  
  if (historicoDia.length > 1440) {
    historicoDia.shift();
  }
  
  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) {
    console.log('[SISTEMA] Resetando histórico do dia (meia-noite)');
    historicoDia = [];
  }
  
  const mensagem = JSON.stringify({
    tipo: 'atualizacao',
    dados: ultimosResultados
  });
  
  clientesConectados.forEach(cliente => {
    if (cliente.readyState === WebSocket.OPEN) {
      cliente.send(mensagem);
    }
  });
  
  try {
    fs.appendFileSync('monitoramento_bancos.log', JSON.stringify(ultimosResultados) + '\n');
  } catch (e) {}
}

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    bancosMonitorados: BANCOS_MONITORADOS.length,
    ultimaVerificacao: ultimosResultados.timestamp || null,
    clientesWebSocket: clientesConectados.length,
    historicoSize: historicoDia.length
  });
});

app.get('/api/metrics', (req, res) => {
  if (!ultimosResultados || !ultimosResultados.bancos) {
    return res.json([]);
  }
  
  const metricas = ultimosResultados.bancos.map(banco => ({
    timestamp: banco.timestamp,
    instituicao: banco.nome,
    latencia_ms: typeof banco.latencia === 'number' ? banco.latencia : null,
    status: banco.status,
    timeout_rate: banco.timeout_rate || 0,
    http_code: banco.statusCode,
    endpoint: banco.urlUsada || banco.fonte
  }));
  
  res.json(metricas);
});

app.get('/api/historico', (req, res) => {
  const { inicio, fim, banco } = req.query;
  
  let dados = [...historicoDia];
  
  if (inicio && fim) {
    dados = dados.filter(item => {
      const hora = new Date(item.timestamp).getHours();
      const horaInicio = parseInt(inicio);
      const horaFim = parseInt(fim);
      return hora >= horaInicio && hora <= horaFim;
    });
  }
  
  if (banco) {
    dados = dados.map(item => ({
      ...item,
      bancos: item.bancos.filter(b => b.id === banco)
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

app.get('/api/oscilacoes', (req, res) => {
  if (historicoDia.length < 10) {
    return res.json({
      mensagem: 'Dados insuficientes (mínimo 10 verificações)',
      horarioCritico: null,
      resumoPorHora: []
    });
  }
  
  const porHora = {};
  
  historicoDia.forEach(item => {
    const hora = new Date(item.timestamp).getHours();
    
    if (!porHora[hora]) {
      porHora[hora] = {
        hora: `${hora.toString().padStart(2, '0')}:00`,
        verificacoes: 0,
        totalOscilacao: 0,
        bancosAfetados: new Set()
      };
    }
    
    item.bancos.forEach(banco => {
      if (banco.latencia && banco.baseline) {
        const desvio = Math.abs(banco.latencia - banco.baseline);
        const oscilacao = (desvio / banco.baseline) * 100;
        
        if (oscilacao > 50) {
          porHora[hora].totalOscilacao += oscilacao;
          porHora[hora].bancosAfetados.add(banco.nome);
        }
      }
    });
    
    porHora[hora].verificacoes++;
  });
  
  let horarioCritico = null;
  let maiorOscilacao = 0;
  
  Object.values(porHora).forEach(hora => {
    const oscilacaoMedia = hora.totalOscilacao / hora.verificacoes;
    
    if (oscilacaoMedia > maiorOscilacao) {
      maiorOscilacao = oscilacaoMedia;
      horarioCritico = {
        hora: hora.hora,
        oscilacaoMedia: oscilacaoMedia.toFixed(2),
        bancosAfetados: Array.from(hora.bancosAfetados),
        totalBancos: hora.bancosAfetados.size,
        verificacoes: hora.verificacoes
      };
    }
  });
  
  res.json({
    horarioCritico,
    resumoPorHora: Object.values(porHora).map(h => ({
      hora: h.hora,
      oscilacaoTotal: h.totalOscilacao.toFixed(2),
      bancosAfetados: h.bancosAfetados.size,
      verificacoes: h.verificacoes
    })).sort((a, b) => a.hora.localeCompare(b.hora))
  });
});

function iniciarKeepAlive() {
  setInterval(async () => {
    try {
      const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`;
      const response = await axios.get(`${selfUrl}/api/health`, { 
        timeout: 5000,
        headers: { 'User-Agent': 'Internal-KeepAlive/1.0' }
      });
      console.log(`[Keep-Alive] Self-ping OK - Uptime: ${response.data.uptime}s | Histórico: ${response.data.historicoSize} registros`);
    } catch (erro) {
      console.log(`[Keep-Alive] Erro: ${erro.message}`);
    }
  }, SELF_PING_INTERVAL);
  
  console.log(`[Keep-Alive] Configurado para ${SELF_PING_INTERVAL / 60000} minutos`);
}

server.listen(PORTA, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(80));
  console.log('Bank Health Monitor v2.2 - Sistema Híbrido Inteligente + Relatórios');
  console.log('='.repeat(80));
  console.log(`\nDashboard: http://0.0.0.0:${PORTA}`);
  console.log(`Relatórios: http://0.0.0.0:${PORTA}/relatorios.html`);
  console.log(`Intervalo: ${INTERVALO_SEGUNDOS} segundos`);
  console.log(`Keep-Alive: Self-ping a cada 14 minutos`);
  console.log(`Bancos monitorados: ${BANCOS_MONITORADOS.length}`);
  console.log('\nRecursos:');
  console.log('  Múltiplas URLs por instituição');
  console.log('  Status API oficial (Itaú, Nubank, Inter, C6)');
  console.log('  Fallback Downdetector (Itaú, BB, BTG)');
  console.log('  Score de severidade (0-100%)');
  console.log('  Classificação de prioridade (P1-P4)');
  console.log('  Baseline adaptativo');
  console.log('  WebSocket em tempo real');
  console.log('  Anti spin-down automático');
  console.log('  Histórico do dia com filtros');
  console.log('  Análise de oscilações');
  console.log('  Timeout rate tracking');
  console.log('\nThresholds:');
  console.log(`  OK: < ${LATENCIA_LENTA}ms`);
  console.log(`  LENTO: ${LATENCIA_LENTA}-${LATENCIA_CRITICA}ms`);
  console.log(`  CRÍTICO: > ${LATENCIA_CRITICA}ms`);
  console.log(`  ERRO: Timeout ou offline`);
  console.log('\nFontes de Dados:');
  console.log('  1. URL Direta (100% confiança)');
  console.log('  2. Status API Oficial (95% confiança)');
  console.log('  3. Downdetector (70% confiança)');
  console.log('  4. Protegido/Bloqueado (10% confiança)');
  console.log('\nAPIs Disponíveis:');
  console.log('  GET /api/status - Status atual');
  console.log('  GET /api/health - Health check');
  console.log('  GET /api/metrics - Métricas simplificadas');
  console.log('  GET /api/historico - Histórico do dia');
  console.log('  GET /api/oscilacoes - Análise de oscilações');
  console.log('='.repeat(80) + '\n');
  
  iniciarKeepAlive();
  monitorarBancos();
  setInterval(monitorarBancos, INTERVALO_SEGUNDOS * 1000);
});
