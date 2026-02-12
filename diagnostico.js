const { downdetector } = require('downdetector-api');
const fs = require('fs');


const INTERVALO_MINUTOS = 3;
const THRESHOLD_ALERTA = 50;
const THRESHOLD_CRITICO = 200;
const MAX_DELAY_MINUTOS = 30; 

const BANCOS_MONITORADOS = [
  'nubank',
  'itau',
  'banco-do-brasil',
  'caixa',
  'bradesco',
  'santander',
  'banco-inter',
  'mercado-pago',
  'picpay',
  'c6-bank'
];

function calcularIdadeDados(timestamp) {
  const dataRelatorio = new Date(timestamp);
  const agora = new Date();
  const diferencaMinutos = Math.floor((agora - dataRelatorio) / 1000 / 60);
  return diferencaMinutos;
}

function formatarTempo(minutos) {
  if (minutos < 60) {
    return `${minutos}min`;
  }
  const horas = Math.floor(minutos / 60);
  const mins = minutos % 60;
  return `${horas}h${mins}min`;
}

async function verificarStatus(banco) {
  const inicioRequisicao = Date.now();
  
  try {
    const resultado = await downdetector(banco);
    const tempoRequisicao = Date.now() - inicioRequisicao;
    
    if (!resultado.reports || resultado.reports.length === 0) {
      return {
        banco,
        status: 'OK',
        relatorios: 0,
        baseline: 0,
        timestamp: new Date().toISOString(),
        tempoRequisicao,
        idadeDados: null,
        dadosAtualizados: true
      };
    }
    
    const ultimo = resultado.reports[resultado.reports.length - 1];
    const baseline = resultado.baseline[resultado.baseline.length - 1];
    const proporcao = baseline.value > 0 ? ultimo.value / baseline.value : 1;
    
    
    const idadeDados = calcularIdadeDados(ultimo.date);
    const dadosAtualizados = idadeDados <= MAX_DELAY_MINUTOS;
    
    let status = 'OK';
    if (ultimo.value >= THRESHOLD_CRITICO || proporcao >= 5) {
      status = 'CRÍTICO';
    } else if (ultimo.value >= THRESHOLD_ALERTA || proporcao >= 3) {
      status = 'ALERTA';
    }
    
    return {
      banco,
      status,
      relatorios: ultimo.value,
      baseline: baseline.value,
      proporcao: proporcao.toFixed(2),
      timestamp: new Date().toISOString(),
      timestampDados: ultimo.date,
      idadeDados,
      dadosAtualizados,
      tempoRequisicao
    };
    
  } catch (erro) {
    const tempoRequisicao = Date.now() - inicioRequisicao;
    return {
      banco,
      status: 'ERRO',
      mensagem: erro.message,
      timestamp: new Date().toISOString(),
      tempoRequisicao,
      dadosAtualizados: false
    };
  }
}

async function monitorarTodosBancos() {
  const timestampInicio = Date.now();
  const timestamp = new Date().toLocaleString('pt-BR');
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🏦 MONITORAMENTO DE BANCOS - ${timestamp}`);
  console.log(`${'='.repeat(80)}\n`);
  
  const resultados = [];
  let bancosComProblema = [];
  let bancosCriticos = [];
  let dadosDesatualizados = [];
  
  for (const banco of BANCOS_MONITORADOS) {
    const status = await verificarStatus(banco);
    resultados.push(status);
    

    if (!status.dadosAtualizados && status.status !== 'ERRO') {
      dadosDesatualizados.push(`${banco} (${formatarTempo(status.idadeDados)})`);
    }
    

    let emoji = '✅';
    if (status.status === 'CRÍTICO') {
      emoji = '🔴';
      bancosCriticos.push(banco);
    } else if (status.status === 'ALERTA') {
      emoji = '⚠️';
      bancosComProblema.push(banco);
    } else if (status.status === 'ERRO') {
      emoji = '❌';
    }
    
   
    let freshnessIcon = '';
    if (status.idadeDados !== null) {
      if (status.idadeDados <= 20) {
        freshnessIcon = '🟢'; 
      } else if (status.idadeDados <= MAX_DELAY_MINUTOS) {
        freshnessIcon = '🟡'; 
      } else {
        freshnessIcon = '🔴'; 
      }
    }
    
    if (status.status === 'ERRO') {
      console.log(`${emoji} ${banco.toUpperCase()}: ${status.mensagem} (${status.tempoRequisicao}ms)`);
    } else if (status.relatorios > 0) {
      const idade = status.idadeDados ? ` | Dados de ${formatarTempo(status.idadeDados)} atrás ${freshnessIcon}` : '';
      console.log(`${emoji} ${banco.toUpperCase()}: ${status.relatorios} relatórios (baseline: ${status.baseline}, ${status.proporcao}x) | ${status.tempoRequisicao}ms${idade}`);
    } else {
      console.log(`${emoji} ${banco.toUpperCase()}: Operando normalmente | ${status.tempoRequisicao}ms`);
    }
    

    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const tempoTotalSegundos = ((Date.now() - timestampInicio) / 1000).toFixed(1);
  
 
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`📊 RESUMO:`);
  console.log(`   🔴 Críticos: ${bancosCriticos.length > 0 ? bancosCriticos.join(', ') : 'Nenhum'}`);
  console.log(`   ⚠️  Alertas: ${bancosComProblema.length > 0 ? bancosComProblema.join(', ') : 'Nenhum'}`);
  console.log(`   ✅ OK: ${BANCOS_MONITORADOS.length - bancosCriticos.length - bancosComProblema.length}`);
  
  if (dadosDesatualizados.length > 0) {
    console.log(`   ⏰ Dados desatualizados (>${MAX_DELAY_MINUTOS}min): ${dadosDesatualizados.join(', ')}`);
  }
  
  console.log(`\n   ⚡ Tempo total de verificação: ${tempoTotalSegundos}s`);
  console.log(`   📅 Próxima verificação em: ${INTERVALO_MINUTOS} minutos`);
  console.log(`${'='.repeat(80)}\n`);
  
  // Salva log
  const logEntry = {
    timestamp: new Date().toISOString(),
    tempoVerificacao: tempoTotalSegundos,
    resultados,
    resumo: {
      criticos: bancosCriticos,
      alertas: bancosComProblema,
      dadosDesatualizados,
      total: BANCOS_MONITORADOS.length
    }
  };
  
  fs.appendFileSync('monitoramento_bancos.log', JSON.stringify(logEntry) + '\n');
  
 
  if (bancosCriticos.length > 0) {
    console.log('\n🚨🚨🚨 ALERTA CRÍTICO! Bancos com problemas graves! 🚨🚨🚨\n');
  }
  
  if (dadosDesatualizados.length > 0) {
    console.log(`\n⚠️ ATENÇÃO: ${dadosDesatualizados.length} banco(s) com dados desatualizados\n`);
  }
}


console.log('🚀 Iniciando monitoramento de bancos brasileiros...');
console.log(`⏰ Intervalo: ${INTERVALO_MINUTOS} minutos`);
console.log(`📋 Monitorando ${BANCOS_MONITORADOS.length} instituições financeiras`);
console.log(`🕐 Alertando se dados tiverem mais de ${MAX_DELAY_MINUTOS} minutos\n`);

monitorarTodosBancos();

setInterval(monitorarTodosBancos, INTERVALO_MINUTOS * 60 * 1000);