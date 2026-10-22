import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_TTL_MS, cursorScope, decodeCursor, encodeCursor } from "./session-change-cursor";

const session = { instance: "alpha", userId: 2, sectorId: 1, role: "RECEP", name: "Operator" };
test("cursor stays exact above Number.MAX_SAFE_INTEGER and is bound to current permissions", () => {
	const scope = cursorScope(session, [9, 3]);
	assert.equal(scope, cursorScope(session, [3, 9]));
	const cursor = encodeCursor(scope, "epoch", "9007199254740993", 1000);
	assert.equal(decodeCursor(cursor, scope, 2000)?.sequence, "9007199254740993");
	for (const changed of [{ ...session, instance: "beta" }, { ...session, userId: 3 },
		{ ...session, sectorId: 2 }, { ...session, role: "ADMIN" }]) {
		assert.equal(decodeCursor(cursor, cursorScope(changed, [3, 9]), 2000), null);
	}
	assert.equal(decodeCursor(cursor, cursorScope(session, [3]), 2000), null);
});
test("malformed, expired, oversized and future cursors require a new snapshot", () => {
	const scope = cursorScope(session, []);
	for (const value of [undefined, ["cursor"], "%bad", "a".repeat(1025),
		Buffer.from("null").toString("base64url"),
		encodeCursor(scope, "epoch", "-1", 1000), encodeCursor(scope, "epoch", "1 OR 1=1", 1000),
		encodeCursor(scope, "epoch", "1", 1000 - CURSOR_TTL_MS - 1), encodeCursor(scope, "epoch", "1", 62000)]) {
		assert.equal(decodeCursor(value, scope, 1000), null);
	}
});
