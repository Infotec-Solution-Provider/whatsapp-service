import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { format } from "mysql2";
import { persistSurveyAnswer, type SurveyQuery } from "./satisfaction-answer-persistence";

const container = process.env["EXATRON_TEST_MYSQL_CONTAINER"] || "";
assert.match(container, /^infotec-exatron-test-mysql(8|55)$/);
assert.equal(execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "codex.task"}}', container], { encoding: "utf8" }).trim(), "INF-20261019-004");
const sql = (input: string) => execFileSync("docker", ["exec", "-i", container, "mysql", "-uroot", "--batch", "--raw"], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

async function run() {
	sql("DROP DATABASE IF EXISTS exatron_survey_fixture; CREATE DATABASE exatron_survey_fixture;");
	for (const legacy of [false, true]) {
		sql(`USE exatron_survey_fixture; DROP TABLE IF EXISTS w_questionarios_respostas;
		CREATE TABLE w_questionarios_respostas (CODIGO_ATENDIMENTO INT, CODIGO_NUMERO INT, PERGUNTA TEXT, RESPOSTA TEXT, NOTA INT${legacy ? "" : ", QUESTION_KEY VARCHAR(10), SURVEY_VERSION VARCHAR(50), QUESTION_INDEX INT, IS_NOT_APPLICABLE INT, SCALE_MIN INT, SCALE_MAX INT"});`);
		let inserts = 0;
		const query: SurveyQuery = async (statement, values) => {
			if (statement.startsWith("INSERT")) inserts++;
			let output: string;
			const fixtureValues = values.map(value => {
				assert.ok(value === null || typeof value === "string" || typeof value === "number");
				return value as string | number | null;
			});
			try { output = sql("USE exatron_survey_fixture; " + format(statement, fixtureValues)); }
			catch (error) { throw new Error(String((error as { stderr?: Buffer }).stderr || "SQL failed")); }
			if (!statement.startsWith("SELECT")) return {};
			const [headers, ...data] = output.split("\n");
			return data.map(line => Object.fromEntries(headers!.split("\t").map((header,index) => [header,line.split("\t")[index]])));
		};
		const input = { chatId: 100, numberId: 9, messageId: 501, questionKey: "q2", question: "Fixture question", questionIndex: 1, answer: "99", rating: 99 };
		await persistSurveyAnswer(query,input);
		const before = inserts;
		await persistSurveyAnswer(query,input);
		assert.equal(inserts,before);
		assert.equal(sql("USE exatron_survey_fixture; SELECT COUNT(*) AS total FROM w_questionarios_respostas;"), "total\n1");
	}
	console.log(`${container}: real survey INSERT/readback/replay passed with current and legacy schemas`);
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
