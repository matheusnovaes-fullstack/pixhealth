const { downdetector } = require('downdetector-api');

async function testar() {
  console.log('Testando serviços brasileiros...\n');
  
  try {
    
    console.log('📊 WhatsApp Brasil:');
    const whatsapp = await downdetector('whatsapp', 'com.br');
    console.log(whatsapp);
    console.log('\n');
    
    
    console.log('📊 Nubank:');
    const nubank = await downdetector('nubank', 'com.br');
    console.log(nubank);
    
  } catch (erro) {
    console.error('❌ Erro:', erro.message);
  }
}

testar();
