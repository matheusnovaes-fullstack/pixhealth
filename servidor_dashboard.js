const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORTA = process.env.PORT || 3000;
const INTERVALO_SEGUNDOS = process.env.INTERVALO_MONITORAMENTO || 60;
const TIMEOUT_MS = 10000;

// ============================================================================
// CONFIGURAÇÃO DOS BANCOS
// ============================================================================

const bancosConfig = {
  nubank: {
    nome: 'Nubank',
    urls: ['https://nubank.com.br'],
    statusApi: 'https://status.nubank.com.br/api/v2/status.json',
    downdetectorSlug: null,
    prioridade: 'P1'
  },
  itau: {
    nome: 'Itaú',
    urls: [
      'https://statuspage.itau.com.br',
      'https://www.itau.com.br'
    ],
    statusApi: 'https://statuspage.itau.com.br/api/v2/status.json',
    downdetectorSlug: 'itau',
    prioridade: 'P1'
  },
  inter: {
    nome: 'Inter',
    urls: ['https://www.bancointer.com.br'],
    statusApi: 'https://inter.statuspage.io/api/v2/status.json',
    downdetectorSlug: null,
    prioridade: 'P2'
  },
  bb: {
    nome: 'Banco do Brasil',
    urls: [
      'https://www.bb.com.br/pbb/pagina-inicial',
      'https://www.bb.com.br'
    ],
    statusApi: null,
    downdetectorSlug: 'banco-do-brasil',
    prioridade: 'P1'
  },
  bradesco: {
    nome: 'Bradesco',
    urls: ['https://banco.bradesco'],
    statusApi: null,
    downdetectorSlug: null,
    prioridade: 'P2'
  },
  santander: {
    nome: 'Santander',
    urls: ['https://www.santander.com.br'],
    statusApi: null,
    downdetectorSlug: null,
    prioridade: 'P2'
  },
  caixa: {
    nome: 'Caixa Econômica',
    urls: ['https://www.caixa.gov.br'],
    statusApi: null,
    downdetectorSlug: null,
    prioridade: 'P2'
  },
  c6: {
    nome: 'C6 Bank',
    urls: ['https://www.c6bank.com.br'],
    statusApi: 'https://c6bank.statuspage.io/api/v2/status.json',
    downdetectorSlug: null,
    prioridade: 'P3'
  },
  btg: {
    nome: 'BTG Pactual',
    urls: ['https://www.btgpactual.com'],
    statusApi: null,
    downdetectorSlug: 'btg-pactual',
    prioridade: 'P3'
  },
  pagbank: {
    nome: 'PagBank',
    urls: ['https://pagseguro.uol.com.br'],
    statusApi: null,
    downdetectorSlug: null,
    prioridade: 'P3'
  },
  mercadopago: {
    nome: 'Mercado Pago',
    urls: ['https://www.mercadopago.com.br'],
    statusApi: null,
    downdetectorSlug: null,
    prioridade: 'P4'
  }
};

// ============================================================================
// ESTADO GLOBAL
// ============================================================================

let estadoGlobal = {
  bancos: {},
  ultimaAtualizacao: null,
  baselines: {},
  historico: {}
};

// ============================================================================
// FUNÇÕES DE MONITORAMENTO
// ============================================================================

async function verificarStatusAPI(url) {
  try {
    const resposta = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    const status = resposta.data?.status?.indicator || 'unknown';
    
    if (status === 'none' || status === 'operational') {
      return { online: true, descricao: 'Online', confianca: 95 };
    } else if (status === 'minor' || status === 'major') {
      return { online: false, descricao: resposta.data?.status?.description || 'Problema reportado', confianca: 95 };
    }
    
    return { online: true, descricao: 'Status desconhecido', confianca: 70 };
  } catch (erro) {
    return null;
  }
}

async function verificarDowndetector(slug) {
  try {
    const url = `https://downdetector.com.br/fora-do-ar/${slug}/`;
    const resposta = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(resposta.data);
    const reclamacoes = parseInt($('.stats-table .stat-value').first().text().replace(/\D/g, '')) || 0;

    if (reclamacoes > 100) {
      return { online: false, reclamacoes, confianca: 70 };
    } else if (reclamacoes > 50) {
      return { online: true, alerta: true, reclamacoes, confianca: 75 };
    }
    
    return { online: true, reclamacoes, confianca: 85 };
  } catch (erro) {
    return null;
  }
}

async function verificarURLDireta(url) {
  const inicio = Date.now();
  try {
    await axios.get(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9'
      }
    });
    const latencia = Date.now() - inicio;
    return { sucesso: true, latencia };
  } catch (erro) {
    if (erro.code === 'ECONNABORTED' || erro.code === 'ETIMEDOUT') {
      return { sucesso: false, erro: 'Timeout', latencia: TIMEOUT_MS };
    }
    return { sucesso: false, erro: erro.message, latencia: Date.now() - inicio };
  }
}

function calcularSeveridade(resultado, config, bancoId) {
  let severidade = 0;
  
  if (resultado.fonte === 'URL Direta') {
    if (resultado.latencia === 'Timeout') {
      severidade = 85;
    } else {
      const baseline = estadoGlobal.baselines[bancoId] || resultado.latencia * 1.5;
      const proporcao = resultado.latencia / baseline;
      
      if (proporcao > 3) severidade = 75;
      else if (proporcao > 2) severidade = 50;
      else if (proporcao > 1.5) severidade = 25;
      else severidade = 5;
    }
  } else if (resultado.fonte.includes('Status API')) {
    severidade = resultado.status === 'OK' ? 5 : 70;
  } else if (resultado.fonte.includes('Downdetector')) {
    const reclamacoes = resultado.detalhes?.reclamacoes || 0;
    if (reclamacoes > 500) severidade = 80;
    else if (reclamacoes > 200) severidade = 60;
    else if (reclamacoes > 100) severidade = 40;
    else severidade = 15;
  }

  if (resultado.urlsOnline === 0) severidade = Math.min(100, severidade + 15);
  
  return Math.min(100, severidade);
}

async function verificarBanco(bancoId, config) {
  console.log(`\n[${config.nome}] Iniciando verificação...`);
  
  let melhorResultado = null;
  let urlsOnline = 0;
  let latenciaFinal = null;

  // 1. Tentar URLs diretas
  for (const url of config.urls) {
    const resultado = await verificarURLDireta(url);
    
    if (resultado.sucesso) {
      urlsOnline++;
      console.log(`[${config.nome}] ✅ URL direta OK: ${url} (${resultado.latencia}ms)`);
      
      if (!melhorResultado || resultado.latencia < melhorResultado.latencia) {
        melhorResultado = {
          status: 'OK',
          latencia: resultado.latencia,
          fonte: 'URL Direta',
          confianca: 100,
          urlsOnline,
          totalUrls: config.urls.length
        };
        latenciaFinal = resultado.latencia;
      }
    } else {
      console.log(`[${config.nome}] ⚠️ ${resultado.erro} em ${url}, tentando próxima...`);
    }
  }

  // 2. Se URL direta falhou, tenta Status API
  if (urlsOnline === 0 && config.statusApi) {
    const apiStatus = await verificarStatusAPI(config.statusApi);
    
    if (apiStatus) {
      console.log(`[${config.nome}] ✅ Status API: ${apiStatus.descricao}`);
      melhorResultado = {
        status: apiStatus.online ? 'OK' : 'PROBLEMA',
        latencia: 'Via API Status',
        fonte: 'Status API Oficial',
        confianca: apiStatus.confianca,
        urlsOnline: apiStatus.online ? 1 : 0,
        totalUrls: config.urls.length,
        detalhes: apiStatus.descricao
      };
    }
  }

  // 3. Fallback: Downdetector
  if (!melhorResultado && config.downdetectorSlug) {
    const downStatus = await verificarDowndetector(config.downdetectorSlug);
    
    if (downStatus) {
      console.log(`[${config.nome}] ℹ️ Downdetector: ${downStatus.reclamacoes} reclamações`);
      melhorResultado = {
        status: downStatus.online ? 'OK' : 'PROBLEMA',
        latencia: 'Via Downdetector',
        fonte: 'Downdetector (Baseado em Reclamações)',
        confianca: downStatus.confianca,
        urlsOnline: downStatus.online ? 1 : 0,
        totalUrls: config.urls.length,
        detalhes: { reclamacoes: downStatus.reclamacoes }
      };
    }
  }

  // 4. Se tudo falhou
  if (!melhorResultado) {
    melhorResultado = {
      status: 'ERRO',
      latencia: 'Timeout',
      fonte: 'Todas as fontes falharam',
      confianca: 50,
      urlsOnline: 0,
      totalUrls: config.urls.length
    };
  }

  // Atualizar baseline
  if (latenciaFinal && typeof latenciaFinal === 'number') {
    if (!estadoGlobal.baselines[bancoId]) {
      estadoGlobal.baselines[bancoId] = latenciaFinal;
    } else {
      estadoGlobal.baselines[bancoId] = estadoGlobal.baselines[bancoId] * 0.9 + latenciaFinal * 0.1;
    }
  }

  // Calcular severidade
  melhorResultado.severidade = calcularSeveridade(melhorResultado, config, bancoId);
  melhorResultado.prioridade = config.prioridade;

  return melhorResultado;
}

async function executarMonitoramento() {
  const inicio = Date.now();
  console.log('\n' + '='.repeat(80));
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando ${Object.keys(bancosConfig).length} instituições...`);
  console.log('='.repeat(80));

  const promessas = Object.entries(bancosConfig).map(([id, config]) =>
    verificarBanco(id, config).then(resultado => ({ id, resultado }))
  );

  const resultados = await Promise.all(promessas);

  resultados.forEach(({ id, resultado }) => {
    estadoGlobal.bancos[id] = {
      ...bancosConfig[id],
      ...resultado,
      ultimaVerificacao: new Date().toISOString()
    };
  });

  estadoGlobal.ultimaAtualizacao = new Date().toISOString();

  const tempoTotal = ((Date.now() - inicio) / 1000).toFixed(1);
  
  const resumo = {
    ok: 0,
    lentos: 0,
    criticos: 0,
    erros: 0
  };

  Object.values(estadoGlobal.bancos).forEach(banco => {
    if (banco.status === 'OK' && banco.severidade < 30) resumo.ok++;
    else if (banco.severidade < 60) resumo.lentos++;
    else if (banco.severidade < 85) resumo.criticos++;
    else resumo.erros++;
  });

  console.log('\n' + '='.repeat(80));
  console.log(`✅ [RESUMO] ${tempoTotal}s | OK: ${resumo.ok} | Lentos: ${resumo.lentos} | Críticos: ${resumo.criticos} | Erros: ${resumo.erros}`);
  console.log('='.repeat(80) + '\n');

  // Emitir via WebSocket
  io.emit('atualizacao', {
    bancos: estadoGlobal.bancos,
    timestamp: estadoGlobal.ultimaAtualizacao,
    resumo,
    tempoVerificacao: tempoTotal
  });
}

// ============================================================================
// ROTAS HTTP
// ============================================================================

app.use(express.static('public'));

app.get('/api/status', (req, res) => {
  res.json({
    bancos: estadoGlobal.bancos,
    timestamp: estadoGlobal.ultimaAtualizacao,
    baselines: estadoGlobal.baselines
  });
});

// ✅ NOVA ROTA: Health Check para Keep-Alive
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    bancos: Object.keys(estadoGlobal.bancos).length
  });
});

// ============================================================================
// WEBSOCKET
// ============================================================================

io.on('connection', (socket) => {
  console.log('✅ Cliente WebSocket conectado');
  
  // Envia estado atual imediatamente
  if (estadoGlobal.ultimaAtualizacao) {
    socket.emit('atualizacao', {
      bancos: estadoGlobal.bancos,
      timestamp: estadoGlobal.ultimaAtualizacao
    });
  }
  
  socket.on('disconnect', () => {
    console.log('❌ Cliente WebSocket desconectado');
  });
});

// ============================================================================
// KEEP-ALIVE (EVITA SPIN-DOWN NO RENDER FREE)
// ============================================================================

const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutos

setInterval(async () => {
  try {
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORTA}`;
    await axios.get(`${selfUrl}/api/health`, { 
      timeout: 5000,
      headers: { 'User-Agent': 'Internal-KeepAlive' }
    });
    console.log('[Keep-Alive] ✅ Self-ping enviado - App permanece ativo');
  } catch (erro) {
    console.log('[Keep-Alive] ⚠️ Erro no self-ping:', erro.message);
  }
}, SELF_PING_INTERVAL);

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

server.listen(PORTA, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(80));
  console.log('🏦 Bank Health Monitor v2.1 - Sistema Híbrido Inteligente');
  console.log('='.repeat(80));
  console.log(`\n📊 Dashboard: http://0.0.0.0:${PORTA}`);
  console.log(`⏱️  Intervalo: ${INTERVALO_SEGUNDOS} segundos`);
  console.log(`🔄 Keep-Alive: Self-ping a cada 14 minutos`);
  console.log(`🏦 Bancos monitorados: ${Object.keys(bancosConfig).length}`);
  console.log('\n🚀 Recursos:');
  console.log('  ✅ Múltiplas URLs por instituição');
  console.log('  ✅ Status API oficial (Itaú, Nubank, Inter, C6)');
  console.log('  ✅ Fallback Downdetector (Itaú, BB, BTG)');
  console.log('  ✅ Score de severidade (0-100%)');
  console.log('  ✅ Classificação de prioridade (P1-P4)');
  console.log('  ✅ Baseline adaptativo');
  console.log('  ✅ WebSocket em tempo real');
  console.log('  ✅ Anti spin-down automático');
  console.log('\n' + '='.repeat(80) + '\n');

  // Primeira execução imediata
  executarMonitoramento();

  // Execuções periódicas
  setInterval(executarMonitoramento, INTERVALO_SEGUNDOS * 1000);
});
