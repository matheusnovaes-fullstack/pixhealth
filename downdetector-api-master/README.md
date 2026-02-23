Visão Geral do Sistema
O projeto é um monitor de saúde bancária em tempo real, construído em Node.js no backend e HTML/CSS/JS puro no frontend. Ele verifica periodicamente a disponibilidade e latência de 11 bancos brasileiros e exibe tudo em um dashboard ao vivo.

Backend — servidor_dashboard.js
O servidor é construído com Express.js para as rotas HTTP e ws para comunicação em tempo real via WebSocket.

Ciclo de monitoramento
A função principal é monitorarBancos(), que roda a cada 60 segundos via setInterval. Para cada banco ela tenta as URLs em ordem de prioridade, usando 3 estratégias de fallback:

Estratégia	Confiança	Quando usa
URL Direta (axios.get)	100%	Sempre tenta primeiro
Status API Oficial	95%	Se URL retorna 403 e banco tem statusAPI
Downdetector	70%	Último recurso se as anteriores falharem
Bloqueado/Protegido	10%	Todas as tentativas bloqueadas por WAF
Sistema de severidade
Cada resultado recebe um score de 0 a 100% calculado por calcularScoreSeveridade(), somando pontos por fatores como latência alta, erros HTTP 5xx, timeouts, desvio do baseline e comportamento isolado. Esse score é então convertido em prioridade P1 a P4 por classificarPrioridade().

Baseline adaptativo
O calcularBaseline() aprende o tempo de resposta normal de cada banco ao longo do tempo, mantendo as últimas 30 medições em historicoLatencias. Isso evita falsos positivos — um banco naturalmente lento não vira alerta só por ser lento.

Armazenamento em memória
Todos os dados ficam em variáveis globais:

ultimosResultados → snapshot atual, servido pelo WebSocket e /api/status

historicoDia → todas as rodadas do dia, usado pelos relatórios e exportação CSV

historicoLatencias e historicoTimeouts → base para cálculo de baseline e timeout rate

APIs disponíveis
text
GET /api/status              → snapshot atual de todos os bancos
GET /api/health              → uptime, contagem de clientes WS, tamanho do histórico
GET /api/metrics             → métricas simplificadas por banco
GET /api/historico           → histórico do dia com filtros por hora e banco
GET /api/oscilacoes          → análise de qual hora do dia teve mais oscilação
GET /api/historico/exportar  → download do dia inteiro em CSV (UTF-8 com BOM)
Anti-hibernação
Dois mecanismos evitam que o Render hiberne o serviço gratuito:

keepalive.js → ping externo a cada 10 minutos via serviço terceiro

Self-ping interno → o próprio servidor chama /api/health a cada 14 minutos

Frontend — Dashboard (index.html)
A página principal se conecta ao backend via WebSocket logo ao carregar. Quando chega uma mensagem do tipo atualizacao, ela re-renderiza os cards dos bancos sem recarregar a página. Um setInterval de 30 segundos faz uma reconexão automática caso o WebSocket caia.

Cada banco é exibido em um card com:

Indicador colorido de status (verde/amarelo/vermelho)

Latência atual vs baseline

Score de severidade em barra de progresso

Badge de prioridade (P1–P4)

Frontend — Relatórios (relatorios.html)
A página de relatórios é totalmente separada e consome as APIs REST (não WebSocket), se auto-atualizando a cada 60 segundos.

Elementos visuais usados
Elemento	Biblioteca	Função
Gráfico de linha	Chart.js 4.4	Latência média por hora
Gráfico de barras	Chart.js 4.4	Desvio/oscilação por hora
Tabela paginada	HTML puro + JS	Histórico detalhado com "Ver Mais"
Cards de destaque	CSS Grid	Horário mais crítico do dia
Filtros	<select> + <input>	Filtrar por banco e intervalo de hora
Botão exportar	JS + <a> dinâmico	Baixa CSV via /api/historico/exportar
Estrutura de layout
Todo o layout usa CSS Grid com repeat(auto-fit, minmax(...)), o que o torna responsivo sem nenhuma biblioteca externa como Bootstrap. Em telas menores que 768px, as colunas empilham automaticamente via @media.

Paleta e estilo
O visual segue um tema dark minimalista:

Fundo: #0a0a0a

Cards: #1a1a1a com borda #2a2a2a

Verde (OK): #4ade80

Amarelo (lento): #fbbf24

Vermelho (crítico): #ef4444

Azul (exportar): #60a5fa

Todas as fontes usam a system font stack (-apple-system, BlinkMacSystemFont, 'Segoe UI'...), que carrega a fonte nativa do sistema operacional do usuário, garantindo leitura rápida sem carregar nenhum arquivo externo.

Alertas por email — alertas.js
Usa Nodemailer com autenticação via Senha de App do Gmail. Um sistema de cooldown de 30 minutos por banco evita spam caso a instabilidade persista. O email gerado é um HTML inline com tabela estilizada, compatível com a maioria dos clientes de email.
