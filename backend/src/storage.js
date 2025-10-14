const fs = require('fs');
const path = require('path');

function cloneDefault(defaultStateProvider) {
  return typeof defaultStateProvider === 'function' ? defaultStateProvider() : {};
}

class FileStorage {
  constructor(options) {
    this.dataPath = options.dataPath;
    this.defaultStateProvider = options.defaultStateProvider;
  }

  ensureFile() {
    if (!this.dataPath) return;
    if (!fs.existsSync(this.dataPath)) {
      const initial = cloneDefault(this.defaultStateProvider);
      if (!initial || typeof initial !== 'object') {
        throw new Error('초기 상태를 생성할 수 없습니다.');
      }
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  async load() {
    this.ensureFile();
    const raw = fs.readFileSync(this.dataPath, 'utf8');
    return JSON.parse(raw);
  }

  async save(payload) {
    this.ensureFile();
    fs.writeFileSync(this.dataPath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

class PostgresStorage {
  constructor(options) {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: options.connectionString,
      ssl: options.ssl
    });
    this.defaultStateProvider = options.defaultStateProvider;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    this.initialized = true;
  }

  async load() {
    await this.init();
    const result = await this.pool.query('SELECT payload FROM app_state WHERE id = $1 LIMIT 1', ['singleton']);
    if (result.rows.length > 0 && result.rows[0].payload) {
      return result.rows[0].payload;
    }
    const initial = cloneDefault(this.defaultStateProvider);
    await this.save(initial);
    return initial;
  }

  async save(payload) {
    await this.init();
    await this.pool.query(
      'INSERT INTO app_state (id, payload, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()',
      ['singleton', payload]
    );
  }
}

function createStorage({ dataPath, defaultStateProvider }) {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (connectionString) {
    const sslConfig = process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false };
    return new PostgresStorage({
      connectionString,
      ssl: sslConfig,
      defaultStateProvider
    });
  }
  return new FileStorage({ dataPath, defaultStateProvider });
}

module.exports = { createStorage };
