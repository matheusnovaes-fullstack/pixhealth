const https = require('https');
const http = require('http');

const APP_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutos

function ping() {
  const url = `${APP_URL}/api/status`;
  const isHttps = url.startsWith('https');
  const client = isHttps ? https : http;
  
  const startTime = Date.now();
  
  client.get(url, (res) => {
    const duration = Date.now() - startTime;
    console.log(`[Keep-Alive] ✅ Ping bem-sucedido | Status: ${res.statusCode} | Tempo: ${duration}ms | ${new Date().toLocaleString('pt-BR')}`);
  }).on('error', (err) => {
    console.error(`[Keep-Alive] ❌ Erro no ping: ${err.message} | ${new Date().toLocaleString('pt-BR')}`);
  });
}

// Executa o primeiro ping após 5 minutos (para dar tempo do app subir)
setTimeout(() => {
  console.log('[Keep-Alive] 🚀 Iniciando sistema de keep-alive...');
  ping();
  
  // Depois continua a cada 10 minutos
  setInterval(ping, PING_INTERVAL);
}, 5 * 60 * 1000);

console.log('[Keep-Alive] ⏳ Sistema agendado para iniciar em 5 minutos');

module.exports = { ping };
