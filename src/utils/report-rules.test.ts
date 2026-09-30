import assert from "node:assert/strict";
import { getReportMessageType, resolveReportUserId, SYSTEM_OPERATOR_ID } from "./report-rules";

// Classificação: espelha OPERATION/CUSTOMER_MESSAGE_SQL_CONDITION de operator-performance.service.ts.
assert.equal(getReportMessageType({ from: "me:5511888888888", to: "5511999999999", userId: 10 }), "SENT");
assert.equal(getReportMessageType({ from: "me:5511888888888", to: "5511999999999", userId: null }), "SENT");
assert.equal(getReportMessageType({ from: "user:10", to: "5511999999999", userId: null }), "SENT");
assert.equal(getReportMessageType({ from: "5511999999999", to: "me:5511888888888", userId: null }), "RECEIVED");
assert.equal(getReportMessageType({ from: "system", to: "system", userId: null }), null);
assert.equal(getReportMessageType({ from: "thirdparty:crm", to: "system", userId: null }), null);
assert.equal(getReportMessageType({ from: "bot:5511888888888", to: "5511999999999", userId: null }), null);
assert.equal(getReportMessageType({ from: "lid:abc", to: "me:5511888888888", userId: null }), null);
// Como no SQL, user_id preenchido conta como enviada mesmo em mensagem de sistema, e 0 não é nulo.
assert.equal(getReportMessageType({ from: "system", to: "system", userId: 7 }), "SENT");
assert.equal(getReportMessageType({ from: "5511999999999", to: "me:5511888888888", userId: 0 }), "SENT");
assert.equal(getReportMessageType({ from: "ME:5511888888888", to: "5511999999999", userId: null }), "SENT");

// Atribuição: código 1 fora, sistema e sem cadastro em Sistema/Admin.
const registered = new Set([10, 20]);
assert.equal(resolveReportUserId(10, registered), 10);
assert.equal(resolveReportUserId(1, registered), null);
assert.equal(resolveReportUserId(null, registered), null);
assert.equal(resolveReportUserId(undefined, registered), null);
assert.equal(resolveReportUserId(-1, registered), SYSTEM_OPERATOR_ID);
assert.equal(resolveReportUserId(0, registered), SYSTEM_OPERATOR_ID);
assert.equal(resolveReportUserId(99, registered), SYSTEM_OPERATOR_ID);

console.log("report-rules: ok");
