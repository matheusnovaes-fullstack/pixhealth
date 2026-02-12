const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const INTERVALO_SEGUNDOS = 10;
const TIMEOUT_MS = 5000;
const LATENCIA_LENTA = 2000;
const LATENCIA_CRITICA = 5000;
const PORTA = process.env.PORT || 3000;

const BANCOS_MONITORADOS = [
  { 
    id: 'nubank', 
    nome: 'Nubank', 
    urls: ['https://nubank.com.br'],
    baselineInicial: 500
  },
  { 
    id: 'itau', 
    nome: 'Itaú', 
    urls: ['https://www.itau.com.br', 'https://www.itau.com.br/servicos'],
    baselineInicial: 600
  },
  { 
    id: 'banco-do-brasil', 
    nome: 'Banco do Brasil', 
    urls: ['https://www.bb.com.br'],
    baselineInicial: 800
  },
  { 
    id: 'bradesco', 
    nome: 'Bradesco', 
    urls: ['https://banco.bradesco', 'https://banco.bradesco/html/classic/index.shtm'],
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
    baselineInicial: 450
  },
  { 
    id: 'btg-pactual', 
    nome: 'BTG Pactual', 
    urls: ['https://www.btgpactual.com'],
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

function calcularScoreSeveridade(banco, resultado, todosResultados) {
  let score = 0;
  let fatores = [];
  
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
  
  if (resultado.statusCode === 403 || resultado.statusCode === 429) {
    score += 5;
    fatores.push('HTTP ' + resultado.statusCode);
  }
  
  if (resultado.status === 'OK' && score === 0) {
    score = 0;
    fatores.push('Saudável');
  }
  
  score = Math.min(score, 100);
  
  let nivel;
  let classificacao;
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

async function testarBanco(banco) {
  const resultadosURLs = [];
  let urlsOnline = 0;
  let urlsOffline = 0;
  let tem403 = false;
  
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
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1'
        }
      });
      
      const latenciaURL = Date.now() - inicioURL;
      
      if (response.status === 403) {
        tem403 = true;
        urlsOnline++;
        resultadosURLs.push({
          url: url.replace('https://', '').substring(0, 40),
          latencia: latenciaURL,
          status: 403,
          online: true,
          protegido: true
        });
      }
      else if (response.status >= 200 && response.status < 400) {
        urlsOnline++;
        resultadosURLs.push({
          url: url.replace('https://', '').substring(0, 40),
          latencia: latenciaURL,
          status: response.status,
          online: true
        });
      }
      else if (response.status >= 400 && response.status < 500) {
        urlsOffline++;
        resultadosURLs.push({
          url: url.replace('https://', '').substring(0, 40),
          status: response.status,
          online: false
        });
      }
      else {
        urlsOffline++;
        resultadosURLs.push({
          url: url.replace('https://', '').substring(0, 40),
          status: response.status,
          online: false
        });
      }
      
    } catch (erro) {
      urlsOffline++;
      resultadosURLs.push({
        url: url.replace('https://', '').substring(0, 40),
        online: false,
        erro: erro.code || 'TIMEOUT'
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  const latenciasValidas = resultadosURLs.filter(r => r.latencia && r.online && !r.protegido);
  let latenciaMedia = 0;
  
  if (latenciasValidas.length > 0) {
    latenciaMedia = latenciasValidas.reduce((acc, r) => acc + r.latencia, 0) / latenciasValidas.length;
  } else if (tem403) {
    const latencias403 = resultadosURLs.filter(r => r.latencia && r.protegido);
    if (latencias403.length > 0) {
      latenciaMedia = latencias403.reduce((acc, r) => acc + r.latencia, 0) / latencias403.length;
    }
  }
  
  const latencia = Math.round(latenciaMedia);
  const baseline = calcularBaseline(banco.id);
  const proporcao = baseline > 0 && latencia > 0 ? (latencia / baseline).toFixed(2) : 1;
  
  const primeiraResposta = resultadosURLs.find(r => r.status);
  const statusCode = primeiraResposta?.status || 0;
  
  let status = 'OK';
  const percentualOnline = (urlsOnline / banco.urls.length) * 100;
  
  if (percentualOnline === 0) {
    status = 'ERRO';
  } 
  else if (tem403 && percentualOnline === 100) {
    status = 'OK';
  }
  else if (statusCode >= 500) {
    status = 'CRÍTICO';
  } else if (latencia >= LATENCIA_CRITICA && latencia > 0) {
    status = 'CRÍTICO';
  } else if (percentualOnline < 100) {
    status = 'LENTO';
  } else if (latencia >= LATENCIA_LENTA && latencia > 0) {
    status = 'LENTO';
  } else if (baseline > 0 && proporcao >= 3) {
    status = 'LENTO';
  }
  
  if (latencia > 0 && !tem403) {
    historicoLatencias[banco.id].push(latencia);
    if (historicoLatencias[banco.id].length > 50) {
      historicoLatencias[banco.id].shift();
    }
  }
  
  return {
    id: banco.id,
    nome: banco.nome,
    status,
    latencia: tem403 ? 'Protegido' : (latencia || 'N/A'),
    baseline: baseline,
    proporcao: proporcao,
    statusCode: statusCode,
    online: percentualOnline > 0,
    timestamp: new Date().toISOString(),
    urlsOnline: `${urlsOnline}/${banco.urls.length}`,
    urlsOffline: urlsOffline,
    detalhesURLs: resultadosURLs,
    protegido: tem403
  };
}

async function monitorarBancos() {
  const timestampInicio = Date.now();
  const hora = new Date().toLocaleTimeString('pt-BR');
  console.log(`\n[${hora}] Verificando ${BANCOS_MONITORADOS.length} instituições...`);
  
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
  
  ultimosResultados = {
    timestamp: new Date().toISOString(),
    tempoVerificacao: tempoTotal,
    bancos: resultados,
    resumo: { criticos, alertas: lentos, ok, erros, total: resultados.length }
  };
  
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
  } catch (e) {
  }
}

app.get('/api/status', (req, res) => {
  res.json(ultimosResultados);
});

server.listen(PORTA, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(80));
  console.log('Bank Health Monitor v2.0');
  console.log('='.repeat(80));
  console.log(`\nDashboard: http://localhost:${PORTA}`);
  console.log(`Intervalo: ${INTERVALO_SEGUNDOS} segundos`);
  console.log(`Bancos monitorados: ${BANCOS_MONITORADOS.length}`);
  console.log('\nRecursos:');
  console.log('  - Múltiplas URLs por instituição');
  console.log('  - Score de severidade (0-100%)');
  console.log('  - Classificação de prioridade (P1-P4)');
  console.log('  - Baseline adaptativo');
  console.log('  - WebSocket em tempo real');
  console.log('\nThresholds:');
  console.log(`  OK: < ${LATENCIA_LENTA}ms`);
  console.log(`  LENTO: ${LATENCIA_LENTA}-${LATENCIA_CRITICA}ms`);
  console.log(`  CRÍTICO: > ${LATENCIA_CRITICA}ms`);
  console.log(`  ERRO: Timeout ou offline`);
  console.log('='.repeat(80) + '\n');
  
  monitorarBancos();
  setInterval(monitorarBancos, INTERVALO_SEGUNDOS * 1000);
});
