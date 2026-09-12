import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import { ConfigError } from "../lib/errors.js";
import type {
  AccountSnapshotRecord,
  ConnectionRecord,
  PersistentState,
  OAuthStateRecord,
  PostMetricRecord,
  PostRecord,
  StoredSecret,
} from "./types.js";

const emptyState = (): PersistentState => ({
  version: 1,
  connections: [],
  secrets: [],
  account_snapshots: [],
  posts: [],
  post_metrics: [],
  oauth_states: [],
});

// Retain the first metric at each useful post age. This preserves the required
// 1h/6h/24h/3d/7d/30d comparisons without writing every one of the 500-post
// timeline responses on every scheduled sync.
const metricMilestones = [0, 3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000];

export interface RepositoryOptions {
  /** Local-only fallback. Render Free does not preserve this file. */
  dataFile?: string;
  /** A Neon or other PostgreSQL connection string. Takes precedence over dataFile. */
  databaseUrl?: string;
}

function normaliseState(value: unknown): PersistentState {
  const candidate = value as Partial<PersistentState> | null;
  if (!candidate || candidate.version !== 1) return emptyState();
  return {
    version: 1,
    connections: candidate.connections ?? [],
    secrets: candidate.secrets ?? [],
    account_snapshots: candidate.account_snapshots ?? [],
    posts: candidate.posts ?? [],
    post_metrics: candidate.post_metrics ?? [],
    oauth_states: candidate.oauth_states ?? [],
  };
}

/**
 * Durable state store. With DATABASE_URL, encrypted state lives in one
 * PostgreSQL JSONB record. That preserves the existing data model without any
 * reliance on Render's local filesystem. JSON files remain for local tests.
 */
export class Repository {
  private readonly path?: string;
  private readonly pool?: Pool;
  private state = emptyState();
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: RepositoryOptions | string) {
    const resolved = typeof options === "string" ? { dataFile: options } : options;
    this.path = resolved.databaseUrl ? undefined : resolved.dataFile;
    this.pool = resolved.databaseUrl
      ? new Pool({
          connectionString: resolved.databaseUrl,
          max: 5,
          connectionTimeoutMillis: 15_000,
        })
      : undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.pool) {
      this.loadFile();
      this.initialized = true;
      return;
    }

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x_analytics_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await this.pool.query(
        "INSERT INTO x_analytics_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
        [JSON.stringify(emptyState())],
      );
      const result = await this.pool.query<{ state: PersistentState }>(
        "SELECT state FROM x_analytics_state WHERE id = 1",
      );
      this.state = normaliseState(result.rows[0]?.state);
      this.initialized = true;
    } catch {
      await this.pool.end().catch(() => undefined);
      throw new ConfigError(
        "Could not connect to DATABASE_URL. Check the Neon connection string and network access.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private loadFile(): void {
    if (!this.path) throw new ConfigError("Repository is missing DATA_FILE.");
    try {
      this.state = normaliseState(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
    }
  }

  private assertReady(): void {
    if (!this.initialized) throw new ConfigError("Storage has not been initialized.");
  }

  private async persist(): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        "UPDATE x_analytics_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1",
        [JSON.stringify(this.state)],
      );
      return;
    }
    if (!this.path) throw new ConfigError("Repository is missing DATA_FILE.");
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    this.assertReady();
    const task = this.pendingWrite.then(async () => {
      const result = operation();
      await this.persist();
      return result;
    });
    this.pendingWrite = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async listConnections(): Promise<ConnectionRecord[]> {
    this.assertReady();
    return structuredClone(this.state.connections);
  }
  async getConnection(id: string): Promise<ConnectionRecord | undefined> {
    this.assertReady();
    const found = this.state.connections.find((item) => item.id === id);
    return found ? structuredClone(found) : undefined;
  }
  async findConnectionByAccountId(accountId: string): Promise<ConnectionRecord | undefined> {
    this.assertReady();
    const key = accountId.toLowerCase();
    const found = this.state.connections.find(
      (item) =>
        item.x_account_id === accountId ||
        item.username.toLowerCase() === key ||
        item.id === accountId,
    );
    return found ? structuredClone(found) : undefined;
  }
  async saveConnection(record: ConnectionRecord): Promise<void> {
    await this.mutate(() => {
      const index = this.state.connections.findIndex((item) => item.id === record.id);
      if (index >= 0) this.state.connections[index] = record;
      else this.state.connections.push(record);
    });
  }
  async deleteConnection(id: string): Promise<boolean> {
    return this.mutate(() => {
      const connection = this.state.connections.find((item) => item.id === id);
      if (!connection) return false;
      this.state.connections = this.state.connections.filter((item) => item.id !== id);
      this.state.secrets = this.state.secrets.filter(
        (item) => item.id !== connection.credential_secret_reference,
      );
      return true;
    });
  }

  async getSecret(id: string): Promise<StoredSecret | undefined> {
    this.assertReady();
    const secret = this.state.secrets.find((item) => item.id === id);
    return secret ? structuredClone(secret) : undefined;
  }
  async saveSecret(secret: StoredSecret): Promise<void> {
    await this.mutate(() => {
      const index = this.state.secrets.findIndex((item) => item.id === secret.id);
      if (index >= 0) this.state.secrets[index] = secret;
      else this.state.secrets.push(secret);
    });
  }
  async deleteSecret(id: string): Promise<void> {
    await this.mutate(() => {
      this.state.secrets = this.state.secrets.filter((item) => item.id !== id);
    });
  }

  async saveOAuthState(state: OAuthStateRecord): Promise<void> {
    await this.mutate(() => {
      const now = Date.now();
      this.state.oauth_states = this.state.oauth_states.filter(
        (item) => Date.parse(item.expires_at) > now && item.state !== state.state,
      );
      this.state.oauth_states.push(state);
    });
  }
  async takeOAuthState(state: string): Promise<OAuthStateRecord | undefined> {
    return this.mutate(() => {
      const index = this.state.oauth_states.findIndex((item) => item.state === state);
      if (index < 0) return undefined;
      const [record] = this.state.oauth_states.splice(index, 1);
      return record;
    });
  }

  async saveSnapshot(
    account: AccountSnapshotRecord,
    posts: PostRecord[],
    metrics: PostMetricRecord[],
  ): Promise<void> {
    await this.mutate(() => {
      this.state.account_snapshots.push(account);
      for (const post of posts) {
        const index = this.state.posts.findIndex(
          (item) => item.account_id === post.account_id && item.post_id === post.post_id,
        );
        if (index >= 0) {
          post.first_seen_at = this.state.posts[index]!.first_seen_at;
          this.state.posts[index] = post;
        } else this.state.posts.push(post);
      }
      for (const metric of metrics) {
        const existing = this.state.post_metrics.filter(
          (item) => item.account_id === metric.account_id && item.post_id === metric.post_id,
        );
        const isNewMilestone =
          metric.age_seconds !== null &&
          metricMilestones.some(
            (milestone) =>
              metric.age_seconds! >= milestone &&
              !existing.some((item) => item.age_seconds !== null && item.age_seconds >= milestone),
          );
        if (existing.length === 0 || isNewMilestone) this.state.post_metrics.push(metric);
      }
    });
  }

  async accountSnapshots(accountId: string): Promise<AccountSnapshotRecord[]> {
    this.assertReady();
    return structuredClone(
      this.state.account_snapshots.filter((item) => item.account_id === accountId),
    );
  }
  async posts(accountId: string): Promise<PostRecord[]> {
    this.assertReady();
    return structuredClone(this.state.posts.filter((item) => item.account_id === accountId));
  }
  async post(accountId: string, postId: string): Promise<PostRecord | undefined> {
    this.assertReady();
    const post = this.state.posts.find(
      (item) => item.account_id === accountId && item.post_id === postId,
    );
    return post ? structuredClone(post) : undefined;
  }
  async postMetrics(accountId: string, postId?: string): Promise<PostMetricRecord[]> {
    this.assertReady();
    return structuredClone(
      this.state.post_metrics.filter(
        (item) => item.account_id === accountId && (!postId || item.post_id === postId),
      ),
    );
  }
}
