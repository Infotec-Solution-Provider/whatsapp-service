const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium } = require(process.argv[2] || "playwright");

async function main() {
  const output = path.resolve(__dirname, "../public/dist/flow-editor-qa");
  await fs.mkdir(output, { recursive: true });
  const bundle = await esbuild.build({ write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, stdin: { resolveDir: path.resolve(__dirname, ".."), loader: "tsx", contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ThemeProvider,createTheme,CssBaseline} from '@mui/material';
      import {StepEditor} from './src/frontend/components/step-editor/StepEditor';
      const common={flowId:8,enabled:true,createdAt:'2026-11-13',updatedAt:'2026-11-13',connections:null,description:'Fixture'};
      const source=location.pathname==='/assign'
        ? {...common,id:912,stepNumber:12,stepType:'ASSIGN',nextStepId:null,fallbackStepId:null,config:{userId:510,validateUser:true,fallbackUserId:9,fallbackRequireAdmin:true,decisionReason:'customer_not_found',customOption:'preserve'}}
        : {...common,id:901,stepNumber:1,stepType:'QUERY',nextStepId:3,fallbackStepId:12,config:{operation:'resolveContactCustomer',storeAs:'customerResolution',customOption:'preserve'}};
      const steps=[{...common,id:901,stepNumber:1,stepType:'QUERY'}, {...common,id:903,stepNumber:3,stepType:'ROUTER'}, {...common,id:912,stepNumber:12,stepType:'ASSIGN'}];
      function App(){const [saved,setSaved]=useState(null);return saved ? <pre data-testid="saved">{JSON.stringify(saved)}</pre> : <StepEditor flowId={8} step={source} steps={steps} onSave={setSaved} onCancel={()=>{}}/>;}
      createRoot(document.getElementById('root')).render(<ThemeProvider theme={createTheme()}><CssBaseline/><App/></ThemeProvider>);
    ` } });
  const requests = [];
  let failNextSave = true;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (req.url === "/api/message-flows/meta/step-types") { res.end(JSON.stringify(["QUERY", "ASSIGN", "ROUTER"])); return; }
    if (req.method === "PUT") {
      let body = ""; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); requests.push(data);
      if (failNextSave) { failNextSave = false; res.statusCode = 500; res.end(JSON.stringify({ message: "Falha simulada ao salvar" })); return; }
      res.end(JSON.stringify({ id: req.url.endsWith("901") ? 901 : 912, ...data })); return;
    }
    res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html lang="pt-BR"><meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/query");
    await page.getByLabel("Variável do resultado").waitFor().catch(async (error) => {
      console.error(JSON.stringify({ pageErrors, body: (await page.locator("body").innerText()).slice(0, 3000) }));
      await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
      throw error;
    });
    assert.equal(await page.getByLabel("Query SQL").count(), 0, "resolver does not request SQL");
    assert.match(await page.getByRole("combobox", { name: "Próximo Passo", exact: true }).innerText(), /Passo #3/);
    assert.match(await page.getByRole("combobox", { name: "Passo Alternativo (Fallback)", exact: true }).innerText(), /Passo #12/);
    await page.getByLabel("Variável do resultado").fill("contact");
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByText(/Informe uma variável de resultado válida/).waitFor();
    assert.equal(requests.length, 0, "invalid context binding never reaches API");
    await page.getByLabel("Variável do resultado").fill("lookupResult");
    await page.getByRole("combobox", { name: "Operação da consulta", exact: true }).click();
    await page.getByRole("option", { name: "Consultar SQL", exact: true }).click();
    await page.getByLabel("Query SQL").fill("SELECT 1");
    await page.getByRole("combobox", { name: "Operação da consulta", exact: true }).click();
    await page.getByRole("option", { name: "Identificar e vincular cliente pelo telefone", exact: true }).click();
    await page.screenshot({ path: path.join(output, "query.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByText("Falha simulada ao salvar", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("saved").count(), 0, "failed save keeps editor open");
    assert.equal(await page.getByLabel("Variável do resultado").inputValue(), "lookupResult", "failed save preserves edit");
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByTestId("saved").waitFor();
    const query = requests.at(-1);
    assert.deepEqual(query.config, { operation: "resolveContactCustomer", storeAs: "lookupResult", customOption: "preserve" });
    assert.equal(query.nextStepId, 3); assert.equal(query.fallbackStepId, 12);
    await page.goto(origin + "/assign");
    await page.getByLabel("ID do Usuário", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Validar usuário ativo e setor antes de atribuir", { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel("Exigir administrador na contingência", { exact: true }).isChecked(), true);
    await page.getByLabel("ID do Usuário", { exact: true }).fill("9");
    const count = requests.length;
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByText("Informe usuários principal e de contingência válidos e diferentes.", { exact: true }).waitFor();
    assert.equal(requests.length, count);
    await page.getByLabel("ID do Usuário", { exact: true }).fill("511");
    await page.screenshot({ path: path.join(output, "assignment.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Salvar Alterações", exact: true }).click();
    await page.getByTestId("saved").waitFor();
    assert.deepEqual(requests.at(-1).config, { userId: 511, validateUser: true, fallbackUserId: 9, fallbackRequireAdmin: true, decisionReason: "customer_not_found", customOption: "preserve" });
    assert.deepEqual(pageErrors, []);
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, cases: ["resolver without SQL", "SQL mode compatibility", "validated storeAs", "step number references", "failure keeps edit", "assignment guard retention"], outboundProviderCalls: 0 }, null, 2));
    console.log("Flow editor browser tests passed; evidence: " + output);
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
