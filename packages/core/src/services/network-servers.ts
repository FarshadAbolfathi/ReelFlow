import type { Db, NetworkServer } from "@reelflow/database";
import type { AppConfig } from "@reelflow/config";
import { encryptSecret, secretHint } from "@reelflow/security";
import { AppError } from "@reelflow/types";
import type { AuditService } from "../infra/audit";
import type { NetworkControl } from "./network-control";
import type { UserActor } from "./sources";

export type NetworkServerView = Omit<NetworkServer, "encryptedPassword">;

export interface NetworkServerInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * CRUD for user-added SSH servers (used as SOCKS5 proxies by the Python
 * ingestion engine). Passwords are AES-256-GCM at rest — same scheme as
 * Instagram credentials (see accounts.ts) — and never returned by the API.
 */
export class NetworkServersService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly network: NetworkControl,
  ) {}

  private aad(id: string) {
    return `network_server:${id}`;
  }

  private view(s: NetworkServer): NetworkServerView {
    const { encryptedPassword: _encryptedPassword, ...rest } = s;
    return rest;
  }

  async list(): Promise<NetworkServerView[]> {
    const rows = await this.db.networkServer.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map((r) => this.view(r));
  }

  async create(input: NetworkServerInput, actor: UserActor): Promise<NetworkServerView> {
    // Encrypted with its own id as AAD, so the ciphertext is pinned to this row —
    // create the row first (empty placeholder), then fill in the real ciphertext.
    const created = await this.db.networkServer.create({
      data: { name: input.name, host: input.host, port: input.port, username: input.username, encryptedPassword: "", passwordHint: "" },
    });
    const encryptedPassword = encryptSecret(input.password, this.config.encryptionKey, this.aad(created.id));
    const row = await this.db.networkServer.update({
      where: { id: created.id },
      data: { encryptedPassword, passwordHint: secretHint(input.password) },
    });
    await this.audit.log("network_server_added", actor, `Added SSH server "${row.name}" (${row.host}:${row.port})`, { type: "network_server", id: row.id });
    return this.view(row);
  }

  async remove(id: string, actor: UserActor): Promise<void> {
    const status = await this.network.status();
    if (status?.activeServerId === id) {
      throw new AppError("VALIDATION_FAILED", "This server is currently active — switch to another target first");
    }
    const row = await this.db.networkServer.delete({ where: { id } });
    await this.audit.log("network_server_removed", actor, `Removed SSH server "${row.name}"`, { type: "network_server", id });
  }

  async test(id: string, actor: UserActor): Promise<{ ok: boolean; message: string }> {
    const r = await this.network.command("test_server", actor.id ?? "unknown", 20_000, { serverId: id });
    await this.db.networkServer.update({
      where: { id },
      data: { lastTestAt: new Date(), lastTestOk: r.ok, lastTestError: r.ok ? null : r.message, lastTestLatencyMs: parseLatency(r.message) },
    }).catch(() => undefined); // best-effort — the server may have just been deleted
    return r;
  }
}

function parseLatency(message: string): number | null {
  const m = /\((\d+) ms\)/.exec(message);
  return m ? Number(m[1]) : null;
}
