const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

async function main() {
  const bundlePath = process.argv[2], configurationPath = process.argv[3];
  if (!bundlePath || !configurationPath) throw new Error("Usage: node scripts/test-flow-editor-bundle.cjs <local-bundle.js> <prepared-flow.json> [playwright-module]");
  const { chromium } = require(process.argv[4] || "playwright");
  const bundle = await fs.readFile(bundlePath);
  const bundleSha256 = crypto.createHash("sha256").update(bundle).digest("hex");
  const prepared = JSON.parse(await fs.readFile(configurationPath, "utf8"));
  const configuration = prepared.configuration || prepared;
  const stamp = "2026-11-13T15:00:00.000Z";
  const flow = { id: 8, instance: configuration.instance, sectorId: configuration.sectorId, enabled: true,
    description: "Odim QA — artefato Linux", createdAt: stamp, updatedAt: stamp,
    WppMessageFlowStep: configuration.steps.map((step) => ({ ...step, id: 900 + step.stepNumber, messageFlowId: 8,
      config: step.config || {}, connections: step.connections || null, nextStepId: step.nextStepId ?? null,
      fallbackStepId: step.fallbackStepId ?? null, description: `Etapa QA ${step.stepNumber}`, createdAt: stamp, updatedAt: stamp })) };
  const output = path.resolve(__dirname, "../public/dist/flow-editor-bundle-qa");
  await fs.mkdir(output, { recursive: true });
  const requests = [], unexpectedRequests = [], blockedExternalRequests = [];
  let origin;
  let failNextSave = true;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/dist/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle); return; }
    if (url.pathname === "/api/instances") { res.end(JSON.stringify({ message: "QA fixtures", data: [
      { id: 1, name: "Odim", clientName: "odim", createdAt: stamp, updatedAt: stamp },
      { id: 2, name: "vollo", clientName: "vollo", createdAt: stamp, updatedAt: stamp }
    ] })); return; }
    if (url.pathname === "/api/message-flows" && req.method === "GET") {
      res.end(JSON.stringify(url.searchParams.get("instance")?.toLowerCase() === "odim" ? [flow] : [])); return;
    }
    if (url.pathname === "/api/message-flows/meta/step-types") { res.end(JSON.stringify(["QUERY", "CONDITION", "ROUTER", "ASSIGN", "CHECK_ONLY_ADMIN", "CHECK_LOALTY", "CHECK_AVAILABLE_USERS", "SEND_TO_ADMIN"])); return; }
    if (url.pathname.startsWith("/api/message-flows/steps/") && req.method === "PUT") {
      let body = ""; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); requests.push({ path: url.pathname, ...data });
      if (failNextSave) { failNextSave = false; res.statusCode = 500; res.end(JSON.stringify({ message: "Falha QA ao salvar" })); return; }
      const step = flow.WppMessageFlowStep.find((item) => item.id === Number(url.pathname.split("/").at(-1)));
      if (!step) { res.statusCode = 404; res.end(JSON.stringify({ message: "Fixture step unavailable" })); return; }
      Object.assign(step, data); res.end(JSON.stringify(step)); return;
    }
    if (url.pathname === "/" || url.pathname === "/flows") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="pt-BR"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QA Flow Manager</title><div id="root"></div><script>window.APP_CONFIG={INSTANCES_API_URL:${JSON.stringify(origin)}};</script><script src="/dist/bundle.js"></script></html>`); return;
    }
    if (url.pathname === "/favicon.ico") { res.statusCode = 204; res.end(); return; }
    unexpectedRequests.push({ method: req.method, path: url.pathname });
    res.statusCode = 404; res.end(JSON.stringify({ message: "Unknown QA route" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  const pageErrors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 1120 }, serviceWorkers: "block" });
    // Deny everything except this exact loopback origin before any navigation.
    await context.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== origin) { blockedExternalRequests.push(requestUrl.origin); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage(); page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/flows");
    await page.getByRole("heading", { name: "Flow Manager", exact: true }).waitFor();
    const selector = page.getByRole("combobox", { name: "Instância", exact: true });
    await selector.fill("Odim");
    await page.getByRole("option", { name: "Odim", exact: true }).click();
    await page.getByRole("heading", { name: flow.description, exact: true }).click();
    await page.getByText("Passo 2", { exact: true }).click();
    await page.getByLabel("Variável do resultado").waitFor();
    assert.equal(await page.getByLabel("Query SQL").count(), 0);
    assert.equal(await page.getByLabel("Variável do resultado").inputValue(), "customerResolution");
    assert.match(await page.getByRole("combobox", { name: "Próximo Passo", exact: true }).innerText(), /Passo #3/);
    assert.match(await page.getByRole("combobox", { name: "Passo Alternativo (Fallback)", exact: true }).innerText(), /Passo #12/);
    await page.getByLabel("Variável do resultado").fill("contact");
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByText(/Informe uma variável de resultado válida/).waitFor();
    assert.equal(requests.length, 0);
    await page.getByLabel("Variável do resultado").fill("customerResolution");
    await page.screenshot({ path: path.join(output, "linux-query.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByText("Falha QA ao salvar", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1, "failed API save does not close whole-app editor");
    assert.equal(await page.getByLabel("Variável do resultado").inputValue(), "customerResolution");
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(requests.at(-1).config.operation, "resolveContactCustomer");
    assert.equal(requests.at(-1).config.query, undefined);
    await page.getByText("Passo 10", { exact: true }).click();
    await page.getByLabel("ID do Usuário", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("ID do Usuário", { exact: true }).inputValue(), "510");
    assert.equal(await page.getByLabel("Validar usuário ativo e setor antes de atribuir", { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel("Exigir administrador na contingência", { exact: true }).isChecked(), true);
    await page.getByLabel("ID do Usuário", { exact: true }).fill("511");
    await page.getByLabel("ID do Usuário", { exact: true }).fill("510");
    await page.screenshot({ path: path.join(output, "linux-assignment.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(requests.at(-1).config.userId, 510);
    assert.equal(requests.at(-1).config.fallbackUserId, 9);
    assert.equal(requests.at(-1).config.validateUser, true);
    assert.equal(requests.at(-1).config.fallbackRequireAdmin, true);
    assert.equal(requests.at(-1).config.decisionReason, "customer_not_found");
    assert.deepEqual(pageErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(blockedExternalRequests, []);
    const result = { passed: true, bundleSha256, bundlePath: path.resolve(bundlePath), cases: ["whole app loads", "Odim flow opens", "QUERY operation edits", "invalid binding rejected", "API failure preserves edits", "ASSIGN 510 retains fallback guards"], requests: requests.length, pageErrors, blockedExternalRequests, unexpectedRequests, providerCalls: 0,
      hostingVerified: false, hostingLimitation: "Local exact-artifact QA only. Existing deployment cwd/static/public paths were not changed or enabled." };
    await fs.writeFile(path.join(output, "linux-result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    await context.close();
  } catch (error) {
    if (page) { console.error(JSON.stringify({ pageErrors, unexpectedRequests, blockedExternalRequests, body: (await page.locator("body").innerText()).slice(0, 4000) })); await page.screenshot({ path: path.join(output, "linux-failure.png"), fullPage: true }); }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
