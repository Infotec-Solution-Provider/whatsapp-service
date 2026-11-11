import assert from "node:assert/strict";
import test from "node:test";
import { processingLogs, processingLogTimestamp, redactLog } from "./processing-logs";

test("private PEM blocks are hidden even when historical log projection truncates them", () => {
  const payload = Buffer.from("synthetic-private-key-regression-fixture").toString("base64");
  for (const prefix of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    const begin = `-----BEGIN ${prefix}PRIVATE KEY-----`;
    const complete = `${begin}\n${payload}\n-----END ${prefix}PRIVATE KEY-----`;
    for (const input of [complete, `${begin}\n${payload}`, `${begin}\n${payload.repeat(400)}`, JSON.stringify({ detail: complete })]) {
      const output = JSON.stringify(redactLog(input));
      assert.ok(!output.includes(payload.slice(0, 16)), "PEM material must never appear in administrative logs");
      assert.ok(output.includes("[sigilo]"), "A PEM block needs an explicit redaction marker");
    }
  }
  assert.equal(redactLog("before -----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY----- after"), "before [sigilo] after");
});

test("SQL DATETIME values are UTC ISO strings independently of the host timezone", () => {
  const previous = process.env["TZ"]; process.env["TZ"] = "America/Sao_Paulo";
  try {
    assert.equal(processingLogTimestamp("2026-11-11 14:18:02.123"), "2026-11-11T14:18:02.123Z");
    assert.equal(processingLogTimestamp("2026-11-11 14:18:02"), "2026-11-11T14:18:02.000Z");
    assert.equal(processingLogTimestamp(new Date("2026-11-11T14:18:02.123Z")), "2026-11-11T14:18:02.123Z");
    assert.throws(() => processingLogTimestamp("invalid"));
  } finally { if (previous === undefined) delete process.env["TZ"]; else process.env["TZ"] = previous; }
});

test("processing logs require a tenant before any owner database read", async () => {
  for (const tenant of [undefined, "", " "])
    await assert.rejects(processingLogs({ action: "getLogs", environment: "homolog", ...(tenant === undefined ? {} : { tenant }) }), error => (error as { statusCode?: number }).statusCode === 400);
});
