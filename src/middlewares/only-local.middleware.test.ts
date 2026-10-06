import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import onlyLocal, {
	INTERNAL_SERVICE_TOKEN_HEADER,
	getInternalServiceToken,
	isValidInternalServiceToken
} from "./only-local.middleware";

const TOKEN = "segredo-de-teste-0123456789abcdef";

class FakeResponse {
	statusCode = 200;
	body: unknown;
	status(code: number) {
		this.statusCode = code;
		return this;
	}
	json(body: unknown) {
		this.body = body;
		return this;
	}
}

function fakeRequest(hostname: string, headers: Record<string, string | string[]> = {}) {
	return {
		hostname,
		headers,
		method: "POST",
		originalUrl: "/api/internal/whatsapp/chats/1/agent-transfer",
		url: "/api/internal/whatsapp/chats/1/agent-transfer",
		ip: "10.0.0.8"
	} as unknown as Request;
}

function run(req: Request) {
	const res = new FakeResponse();
	let nextCalls = 0;
	const next: NextFunction = () => {
		nextCalls++;
	};
	onlyLocal(req, res as unknown as Response, next);
	return { res, nextCalls };
}

function expectAllowed(req: Request, label: string) {
	const { res, nextCalls } = run(req);
	assert.equal(nextCalls, 1, `${label}: deveria chamar next()`);
	assert.equal(res.statusCode, 200, `${label}: não deveria alterar o status`);
}

function expectForbidden(req: Request, label: string) {
	const { res, nextCalls } = run(req);
	assert.equal(nextCalls, 0, `${label}: não deveria chamar next()`);
	assert.equal(res.statusCode, 403, `${label}: deveria responder 403`);
	assert.deepEqual(res.body, { message: "Acesso restrito a chamadas internas." });
}

const header = INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase();
const savedToken = process.env["INTERNAL_SERVICE_TOKEN"];

try {
	// Sem INTERNAL_SERVICE_TOKEN: regra legada do hostname.
	delete process.env["INTERNAL_SERVICE_TOKEN"];
	assert.equal(getInternalServiceToken(), null);
	expectAllowed(fakeRequest("localhost"), "legado localhost");
	expectAllowed(fakeRequest("127.0.0.1"), "legado 127.0.0.1");
	expectAllowed(fakeRequest("::1"), "legado ::1");
	expectForbidden(fakeRequest("api.inpulse.com.br"), "legado host externo");
	expectForbidden(fakeRequest("api.inpulse.com.br", { [header]: TOKEN }), "legado ignora o cabeçalho");

	// Valor só com espaços conta como vazio (modo legado).
	process.env["INTERNAL_SERVICE_TOKEN"] = "   ";
	assert.equal(getInternalServiceToken(), null);
	expectAllowed(fakeRequest("localhost"), "token em branco = legado");

	// Com INTERNAL_SERVICE_TOKEN: o cabeçalho é obrigatório e suficiente.
	process.env["INTERNAL_SERVICE_TOKEN"] = `  ${TOKEN}\n`;
	assert.equal(getInternalServiceToken(), TOKEN, "o valor do ambiente é aparado");
	expectAllowed(fakeRequest("api.inpulse.com.br", { [header]: TOKEN }), "token correto com outro host");
	expectAllowed(fakeRequest("localhost", { [header]: TOKEN }), "token correto com localhost");
	expectForbidden(fakeRequest("localhost"), "token ausente mesmo em localhost");
	expectForbidden(fakeRequest("api.inpulse.com.br"), "token ausente");
	expectForbidden(fakeRequest("localhost", { [header]: "" }), "token vazio");
	expectForbidden(fakeRequest("localhost", { [header]: `${TOKEN.slice(0, -1)}x` }), "token errado (mesmo tamanho)");
	expectForbidden(fakeRequest("localhost", { [header]: `${TOKEN}0` }), "token com tamanho diferente");
	expectForbidden(fakeRequest("localhost", { [header]: TOKEN.slice(0, 4) }), "prefixo do token");
	expectForbidden(fakeRequest("localhost", { [header]: [TOKEN, TOKEN] }), "cabeçalho repetido (array)");

	// O valor é lido a cada requisição: limpar a variável volta ao modo legado.
	delete process.env["INTERNAL_SERVICE_TOKEN"];
	expectForbidden(fakeRequest("api.inpulse.com.br", { [header]: TOKEN }), "variável removida = legado");

	// Comparação isolada.
	assert.equal(isValidInternalServiceToken(TOKEN, TOKEN), true);
	assert.equal(isValidInternalServiceToken(`${TOKEN} `, TOKEN), false);
	assert.equal(isValidInternalServiceToken("", TOKEN), false);
	assert.equal(isValidInternalServiceToken(TOKEN, ""), false);
	assert.equal(isValidInternalServiceToken(undefined, TOKEN), false);
	assert.equal(isValidInternalServiceToken(null, TOKEN), false);
	assert.equal(isValidInternalServiceToken(12345, "12345"), false);
	assert.equal(isValidInternalServiceToken([TOKEN], TOKEN), false);
	assert.equal(isValidInternalServiceToken({ toString: () => TOKEN }, TOKEN), false);
	assert.equal(getInternalServiceToken({ INTERNAL_SERVICE_TOKEN: "abc" }), "abc");
	assert.equal(getInternalServiceToken({}), null);
} finally {
	if (savedToken === undefined) {
		delete process.env["INTERNAL_SERVICE_TOKEN"];
	} else {
		process.env["INTERNAL_SERVICE_TOKEN"] = savedToken;
	}
}

console.log("only-local middleware tests passed");
