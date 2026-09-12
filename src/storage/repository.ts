import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountSnapshotRecord,
  ConnectionRecord,
  PersistentState,
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
});

/** Atomic, append-friendly persistent store. The JSON format can later be migrated to SQL. */
export class Repository {
  private state: PersistentState;

  constructor(private readonly path: string) {
    try {
      this.state = JSON.parse(readFileSync(path, "utf8")) as PersistentState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  listConnections(): ConnectionRecord[] {
    return structuredClone(this.state.connections);
  }
  getConnection(id: string): ConnectionRecord | undefined {
    const found = this.state.connections.find((item) => item.id === id);
    return found ? structuredClone(found) : undefined;
  }
  findConnectionByAccountId(accountId: string): ConnectionRecord | undefined {
    const key = accountId.toLowerCase();
    const found = this.state.connections.find(
      (item) =>
        item.x_account_id === accountId ||
        item.username.toLowerCase() === key ||
        item.id === accountId,
    );
    return found ? structuredClone(found) : undefined;
  }
  saveConnection(record: ConnectionRecord): void {
    const index = this.state.connections.findIndex((item) => item.id === record.id);
    if (index >= 0) this.state.connections[index] = record;
    else this.state.connections.push(record);
    this.persist();
  }
  deleteConnection(id: string): boolean {
    const connection = this.state.connections.find((item) => item.id === id);
    if (!connection) return false;
    this.state.connections = this.state.connections.filter((item) => item.id !== id);
    this.state.secrets = this.state.secrets.filter(
      (item) => item.id !== connection.credential_secret_reference,
    );
    this.persist();
    return true;
  }

  getSecret(id: string): StoredSecret | undefined {
    return this.state.secrets.find((item) => item.id === id);
  }
  saveSecret(secret: StoredSecret): void {
    const index = this.state.secrets.findIndex((item) => item.id === secret.id);
    if (index >= 0) this.state.secrets[index] = secret;
    else this.state.secrets.push(secret);
    this.persist();
  }

  saveSnapshot(
    account: AccountSnapshotRecord,
    posts: PostRecord[],
    metrics: PostMetricRecord[],
  ): void {
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
    this.state.post_metrics.push(...metrics);
    this.persist();
  }

  accountSnapshots(accountId: string): AccountSnapshotRecord[] {
    return this.state.account_snapshots.filter((item) => item.account_id === accountId);
  }
  posts(accountId: string): PostRecord[] {
    return this.state.posts.filter((item) => item.account_id === accountId);
  }
  post(accountId: string, postId: string): PostRecord | undefined {
    return this.state.posts.find(
      (item) => item.account_id === accountId && item.post_id === postId,
    );
  }
  postMetrics(accountId: string, postId?: string): PostMetricRecord[] {
    return this.state.post_metrics.filter(
      (item) => item.account_id === accountId && (!postId || item.post_id === postId),
    );
  }
}
