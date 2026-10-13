import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRawPagination } from "./raw-pagination";

test("raw LIMIT/OFFSET become integers while tenant/search values stay prepared", () => {
	assert.deepEqual(compileRawPagination("SELECT * FROM contacts WHERE instance = ? AND name LIKE ? ORDER BY id LIMIT ? OFFSET ?", ["homolog", "%O'Reilly\\%", 20, 40]), {
		sql: "SELECT * FROM contacts WHERE instance = ? AND name LIKE ? ORDER BY id LIMIT 20 OFFSET 40", values: ["homolog", "%O'Reilly\\%"]
	});
});

test("MySQL comma pagination preserves the offset/count order", () => {
	assert.deepEqual(compileRawPagination("SELECT id FROM contacts WHERE id > ? LIMIT ?, ?", [7, 10, 20]), { sql: "SELECT id FROM contacts WHERE id > ? LIMIT 10, 20", values: [7] });
	assert.deepEqual(compileRawPagination("SELECT id FROM contacts LIMIT 10, ?", [20]), { sql: "SELECT id FROM contacts LIMIT 10, 20", values: [] });
	assert.deepEqual(compileRawPagination("SELECT id FROM contacts LIMIT ? OFFSET 0", [20]), { sql: "SELECT id FROM contacts LIMIT 20 OFFSET 0", values: [] });
});

test("nested pagination only consumes its own placeholders", () => {
	assert.deepEqual(compileRawPagination("SELECT * FROM (SELECT * FROM contacts WHERE instance = ? LIMIT ?) c WHERE c.name = ? LIMIT ? OFFSET ?", ["homolog", 50, "Alice", 10, 0]), {
		sql: "SELECT * FROM (SELECT * FROM contacts WHERE instance = ? LIMIT 50) c WHERE c.name = ? LIMIT 10 OFFSET 0", values: ["homolog", "Alice"]
	});
});

test("strings, quoted identifiers and comments never consume bound placeholders", () => {
	const sql = "SELECT 'LIMIT ? '' OFFSET ?', \"LIMIT ?\", `OFFSET ?`, ? FROM contacts /* LIMIT ? */ WHERE name = ? -- OFFSET ?\nLIMIT /* ? */ ? OFFSET ? # ?";
	assert.deepEqual(compileRawPagination(sql, ["column", "Alice", 20, 0]), { sql: sql.replace("LIMIT /* ? */ ? OFFSET ? # ?", "LIMIT /* ? */ 20 OFFSET 0 # ?"), values: ["column", "Alice"] });
});

test("backslashes and quotes in bound values are never rendered into SQL", () => {
	const payload = "\\' OR 1=1 -- LIMIT 1000";
	assert.deepEqual(compileRawPagination("SELECT ? FROM contacts WHERE name = ? LIMIT ?", ["literal", payload, 2]), { sql: "SELECT ? FROM contacts WHERE name = ? LIMIT 2", values: ["literal", payload] });
});

test("unsigned pagination accepts safe numbers and MySQL unsigned bigint literals", () => {
	assert.deepEqual(compileRawPagination("SELECT id FROM contacts LIMIT ? OFFSET ?", [0, 18446744073709551615n]), { sql: "SELECT id FROM contacts LIMIT 0 OFFSET 18446744073709551615", values: [] });
	for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "20", null, {}, -1n, 18446744073709551616n, "1; DROP TABLE contacts"]) {
		assert.throws(() => compileRawPagination("SELECT id FROM contacts LIMIT ?", [value]), /PAGINATION_INVALID/);
	}
});

test("ordinary prepared SQL and literal pagination remain identical", () => {
	assert.deepEqual(compileRawPagination("UPDATE contacts SET name = ? WHERE id = ?", ["Alice", 5]), { sql: "UPDATE contacts SET name = ? WHERE id = ?", values: ["Alice", 5] });
	assert.deepEqual(compileRawPagination("SELECT ? FROM contacts LIMIT 20 OFFSET 0", [7]), { sql: "SELECT ? FROM contacts LIMIT 20 OFFSET 0", values: [7] });
});

test("malformed SQL and version-dependent executable placeholders fail closed", () => {
	assert.throws(() => compileRawPagination("SELECT ? LIMIT ?", [3]), /PARAMETER_COUNT_MISMATCH/);
	assert.throws(() => compileRawPagination("SELECT 'unterminated LIMIT ?", []), /UNTERMINATED_QUOTE/);
	assert.throws(() => compileRawPagination("SELECT 1 /* LIMIT ?", []), /UNTERMINATED_COMMENT/);
	assert.throws(() => compileRawPagination("SELECT 1 /*!80000 LIMIT ? */", [3]), /EXECUTABLE_COMMENT_PARAMETER/);
});
