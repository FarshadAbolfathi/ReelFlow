/**
 * Network policy tests with real sockets: a local target server and a local
 * HTTP CONNECT proxy standing in for sing-box's mixed inbound.
 */
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetworkClient, checkProxyHealth, toHttpProxyUrl } from "../src/index";

interface Target {
  server: http.Server;
  port: number;
  hits: string[];
}

async function startTarget(): Promise<Target> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 2_000);
      return;
    }
    if (req.url === "/generate_204") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.end(`hello ${req.url}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

interface FakeProxy {
  server: http.Server;
  port: number;
  tunnels: string[];
}

async function startProxy(): Promise<FakeProxy> {
  const tunnels: string[] = [];
  const server = http.createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  server.on("connect", (req, clientSocket, head) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, tunnels };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

let target: Target;
let proxy: FakeProxy;

beforeAll(async () => {
  target = await startTarget();
  proxy = await startProxy();
});

afterAll(async () => {
  target.server.close();
  proxy.server.close();
});

const healthy = async () => ({
  status: "HEALTHY" as const,
  checkedAt: new Date(),
  latencyMs: 5,
  failedStep: null,
  error: null,
});

describe("DIRECT mode", () => {
  it("reaches the target without any proxy", async () => {
    const client = new NetworkClient({ mode: "DIRECT", ssrfProtection: false });
    const before = proxy.tunnels.length;
    const res = await client.get(`http://127.0.0.1:${target.port}/direct`);
    expect(await res.text()).toBe("hello /direct");
    expect(proxy.tunnels.length).toBe(before);
    await client.close();
  });

  it("blocks loopback targets when SSRF protection is on", async () => {
    const client = new NetworkClient({ mode: "DIRECT" });
    await expect(client.get(`http://127.0.0.1:${target.port}/x`)).rejects.toMatchObject({ code: "URL_BLOCKED" });
    await client.close();
  });

  it("ignores HTTP_PROXY / HTTPS_PROXY environment variables", async () => {
    const saved = { h: process.env.HTTP_PROXY, s: process.env.HTTPS_PROXY };
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    try {
      const client = new NetworkClient({ mode: "DIRECT", ssrfProtection: false });
      const before = proxy.tunnels.length;
      await (await client.get(`http://127.0.0.1:${target.port}/env`)).text();
      expect(proxy.tunnels.length).toBe(before);
      await client.close();
    } finally {
      process.env.HTTP_PROXY = saved.h;
      process.env.HTTPS_PROXY = saved.s;
    }
  });

  it("times out slow requests", async () => {
    const client = new NetworkClient({ mode: "DIRECT", ssrfProtection: false });
    await expect(client.get(`http://127.0.0.1:${target.port}/slow`, { timeoutMs: 200 })).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    await client.close();
  });
});

describe("PROXY mode", () => {
  it("routes requests through the proxy tunnel", async () => {
    const client = new NetworkClient({
      mode: "PROXY",
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      ssrfProtection: false,
      healthCheck: healthy,
    });
    const before = proxy.tunnels.length;
    const res = await client.get(`http://127.0.0.1:${target.port}/via-proxy`);
    expect(await res.text()).toBe("hello /via-proxy");
    expect(proxy.tunnels.length).toBe(before + 1);
    expect(proxy.tunnels.at(-1)).toBe(`127.0.0.1:${target.port}`);
    await client.close();
  });

  it("accepts a socks5 URL for a mixed inbound and uses HTTP CONNECT on the same port", () => {
    expect(toHttpProxyUrl("socks5://127.0.0.1:10808")).toBe("http://127.0.0.1:10808");
  });

  it("FAILS CLOSED when the proxy is not running — the target is never contacted", async () => {
    const deadPort = await freePort();
    const client = new NetworkClient({
      mode: "PROXY",
      proxyUrl: `http://127.0.0.1:${deadPort}`,
      healthUrl: `http://127.0.0.1:${target.port}/generate_204`,
      healthTimeoutMs: 1_000,
      ssrfProtection: false,
    });
    const hitsBefore = target.hits.length;
    await expect(client.get(`http://127.0.0.1:${target.port}/must-not-arrive`)).rejects.toMatchObject({
      code: "NETWORK_UNAVAILABLE",
    });
    expect(target.hits.slice(hitsBefore)).not.toContain("/must-not-arrive");
    await client.close();
  });

  it("fails closed when the proxy dies after a healthy check (no direct fallback)", async () => {
    const p = await startProxy();
    let status: "HEALTHY" | "UNAVAILABLE" = "HEALTHY";
    const client = new NetworkClient({
      mode: "PROXY",
      proxyUrl: `http://127.0.0.1:${p.port}`,
      ssrfProtection: false,
      healthCacheMs: 0,
      healthCheck: async () => ({ ...(await healthy()), status, error: status === "HEALTHY" ? null : "down" }),
    });
    await (await client.get(`http://127.0.0.1:${target.port}/first`)).text();
    await new Promise((r) => p.server.close(r));
    p.server.closeAllConnections();
    status = "UNAVAILABLE";
    const hitsBefore = target.hits.length;
    await expect(client.get(`http://127.0.0.1:${target.port}/second`)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(target.hits.slice(hitsBefore)).not.toContain("/second");
    await client.close();
  });

  it("maps a transport failure in proxy mode to NETWORK_UNAVAILABLE", async () => {
    const deadPort = await freePort();
    const client = new NetworkClient({
      mode: "PROXY",
      proxyUrl: `http://127.0.0.1:${deadPort}`,
      ssrfProtection: false,
      healthCheck: healthy, // stale "healthy" result — the request itself must still fail closed
    });
    await expect(client.get(`http://127.0.0.1:${target.port}/x`)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await client.close();
  });

  it("requires a proxy URL", () => {
    expect(() => new NetworkClient({ mode: "PROXY" })).toThrow();
  });
});

describe("proxy health check", () => {
  it("reports HEALTHY through a working proxy", async () => {
    const r = await checkProxyHealth({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      healthUrl: `http://127.0.0.1:${target.port}/generate_204`,
      timeoutMs: 5_000,
    });
    expect(r.status).toBe("HEALTHY");
  });

  it("reports UNAVAILABLE at the tcp step when nothing listens", async () => {
    const r = await checkProxyHealth({
      proxyUrl: `http://127.0.0.1:${await freePort()}`,
      healthUrl: `http://127.0.0.1:${target.port}/generate_204`,
      timeoutMs: 1_000,
    });
    expect(r).toMatchObject({ status: "UNAVAILABLE", failedStep: "tcp" });
  });
});

describe("redirects and downloads (mocked transport)", () => {
  it("re-validates every redirect hop and blocks redirects to metadata IPs", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get("https://example.com").intercept({ path: "/start" }).reply(302, "", {
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
    const client = new NetworkClient({ mode: "DIRECT", dispatcher: mock });
    await expect(client.get("https://example.com/start")).rejects.toMatchObject({ code: "URL_BLOCKED" });
  });

  it("follows safe redirects", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://example.com");
    pool.intercept({ path: "/a" }).reply(301, "", { headers: { location: "/b" } });
    pool.intercept({ path: "/b" }).reply(200, "done");
    const client = new NetworkClient({ mode: "DIRECT", dispatcher: mock });
    expect(await (await client.get("https://example.com/a")).text()).toBe("done");
  });

  it("downloads atomically with sha256 and enforces the byte limit", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://example.com");
    pool.intercept({ path: "/ok.bin" }).reply(200, Buffer.from("abc"));
    pool.intercept({ path: "/big.bin" }).reply(200, Buffer.alloc(2048));
    const client = new NetworkClient({ mode: "DIRECT", dispatcher: mock });
    const dir = mkdtempSync(path.join(tmpdir(), "rf-dl-"));
    const r = await client.download("https://example.com/ok.bin", path.join(dir, "ok.bin"), { maxBytes: 1024 });
    expect(r.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(readFileSync(r.path, "utf8")).toBe("abc");
    await expect(
      client.download("https://example.com/big.bin", path.join(dir, "big.bin"), { maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });
});
