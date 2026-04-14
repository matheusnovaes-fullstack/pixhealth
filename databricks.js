// ─────────────────────────────────────────────────────────────────────────────
// databricks.js — Integração Pix Health → Databricks (tabela GOLD)
//
// Variáveis de ambiente necessárias (configurar no Render):
//   DATABRICKS_HOST        → https://dbc-94cc563b-108f.cloud.databricks.com
//   DATABRICKS_TOKEN       → dapi...
//   DATABRICKS_HTTP_PATH   → /sql/1.0/warehouses/a6204e25a947c83d
//   DATABRICKS_CATALOG     → (opcional, default: operacoes_cactus_corporation)
//   DATABRICKS_SCHEMA      → (opcional, default: gold)
//   DATABRICKS_TABLE       → (opcional, default: gold_pix_health_status)
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const DATABRICKS_HOST      = (process.env.DATABRICKS_HOST || '').replace(/\/$/, '');
const DATABRICKS_TOKEN     = process.env.DATABRICKS_TOKEN     || '';
const DATABRICKS_HTTP_PATH = process.env.DATABRICKS_HTTP_PATH || '/sql/1.0/warehouses/a6204e25a947c83d';
const DATABRICKS_CATALOG   = process.env.DATABRICKS_CATALOG   || 'operacoes_cactus_corporation';
const DATABRICKS_SCHEMA    = process.env.DATABRICKS_SCHEMA    || 'gold';
const DATABRICKS_TABLE     = process.env.DATABRICKS_TABLE     || 'gold_pix_health_status';

const TABLE_FQN = `${DATABRICKS_CATALOG}.${DATABRICKS_SCHEMA}.${DATABRICKS_TABLE}`;

// ─────────────────────────────────────────────
// HTTP helper — Databricks Statement API
// ─────────────────────────────────────────────

function executarSQL(statement) {
  return new Promise((resolve, reject) => {
    if (!DATABRICKS_HOST || !DATABRICKS_TOKEN) {
      return reject(new Error('[Databricks] DATABRICKS_HOST ou DATABRICKS_TOKEN não configurados.'));
    }

    const url    = new URL(`${DATABRICKS_HOST}/api/2.0/sql/statements`);
    const body   = JSON.stringify({
      warehouse_id: DATABRICKS_HTTP_PATH.split('/').pop(),
      statement,
      wait_timeout: '30s',
      on_wait_timeout: 'CANCEL'
    });

    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${DATABRICKS_TOKEN}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status?.state === 'FAILED') {
            return reject(new Error(`[Databricks] SQL falhou: ${json.status?.error?.message || JSON.stringify(json.status)}`));
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`[Databricks] Resposta inválida: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// Escape seguro para strings SQL
// ─────────────────────────────────────────────

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

// ─────────────────────────────────────────────
// INSERT principal — chamado a cada ciclo
// ─────────────────────────────────────────────

/**
 * Recebe o array todosComponentes + o timestamp do ciclo e insere
 * uma linha por componente na tabela GOLD.
 *
 * @param {Array}  componentes    — array de objetos { id, nome, provedor, categoria, grupo, status, status_original }
 * @param {string} timestampColeta — ISO string do momento da coleta (new Date().toISOString())
 */
async function inserirNoDataBricks(componentes, timestampColeta) {
  if (!componentes || componentes.length === 0) {
    console.log('[Databricks] Nenhum componente para inserir, pulando.');
    return;
  }

  // data_insercao = momento exato que estamos mandando para o banco (UTC)
  const dataInsercao = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const tsColeta     = timestampColeta
    ? new Date(timestampColeta).toISOString().replace('T', ' ').replace('Z', '')
    : dataInsercao;

  // Monta VALUES em lotes de até 500 linhas para não estourar limite de payload
  const LOTE = 500;
  let inseridos = 0;

  for (let i = 0; i < componentes.length; i += LOTE) {
    const lote = componentes.slice(i, i + LOTE);

    const values = lote.map(c => {
      const grupo = c.grupo || (
        c.categoria === 'kyc'            ? 'Processadoras KYC' :
        c.categoria === 'infraestrutura' ? 'Infraestrutura'    :
        'APIs & Infraestrutura'
      );
      return `(${[
        esc(dataInsercao),   // data_insercao
        esc(tsColeta),       // timestamp_coleta
        esc(c.provedor),     // provedor
        esc(c.categoria),    // categoria
        esc(grupo),          // grupo
        esc(c.id),           // componente_id
        esc(c.nome),         // componente_nome
        esc(c.status),       // status
        esc(c.status_original) // status_original
      ].join(', ')})`;
    }).join(',\n  ');

    const sql = `
INSERT INTO ${TABLE_FQN}
  (data_insercao, timestamp_coleta, provedor, categoria, grupo,
   componente_id, componente_nome, status, status_original)
VALUES
  ${values}
`;

    await executarSQL(sql);
    inseridos += lote.length;
  }

  console.log(`[Databricks] ✓ ${inseridos} linhas inseridas em ${TABLE_FQN} (data_insercao: ${dataInsercao})`);
}

module.exports = { inserirNoDataBricks };
