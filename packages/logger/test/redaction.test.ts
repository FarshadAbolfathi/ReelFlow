import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactString } from "../src/index";

function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger("test", { level: "info" }, stream);
  // pino writes synchronously to a plain Writable
  return { logger, output: () => lines.join("") };
}

describe("redactString", () => {
  it("redacts secret-looking substrings", () => {
    expect(redactString("GET /me?access_token=EAAB123&fields=id")).toBe("GET /me?access_token=********&fields=id");
    expect(redactString("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer ********");
    expect(redactString("socks5://user:hunter2@127.0.0.1:1080")).toBe("socks5://********@127.0.0.1:1080");
    expect(redactString("proxy_password=hunter2")).toBe("proxy_password=********");
  });
});

describe("createLogger", () => {
  it("redacts secret keys at top level and nested", () => {
    const { logger, output } = capturingLogger();
    logger.info({
      password: "hunter2",
      account: { accessToken: "EAAsecret" },
      headers: { authorization: "Bearer zzz", cookie: "sid=abc" },
      proxy: { proxyPassword: "pp" },
    });
    const out = output();
    for (const secret of ["hunter2", "EAAsecret", "Bearer zzz", "sid=abc", '"pp"']) expect(out).not.toContain(secret);
    expect(out).toContain("********");
  });

  it("redacts secrets inside log messages", () => {
    const { logger, output } = capturingLogger();
    logger.info("calling https://graph.facebook.com/me?access_token=SECRET123");
    expect(output()).not.toContain("SECRET123");
  });

  it("redacts secrets inside error messages", () => {
    const { logger, output } = capturingLogger();
    logger.error({ err: new Error("401 for access_token=LEAKME") }, "failed");
    expect(output()).not.toContain("LEAKME");
  });
});
