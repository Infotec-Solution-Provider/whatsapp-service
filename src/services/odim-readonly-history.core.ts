export type HistoryDb = { query: (sql: string, values: unknown[]) => Promise<any[]> };
export type HistoryKind = "chats" | "contacts";
const domains = { chats: "w_atendimentos", contacts: "w_clientes_numeros" };
const parse = (row: any) => typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
export function historyPage(value: unknown, fallback: number, max: number): number {
 const n = value === undefined ? fallback : Number(value);
 if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("INVALID_HISTORY_PAGE");
 return n;
}
export function historyId(value: unknown): number {
 if (!/^-?\d{1,10}$/.test(String(value))) throw new Error("INVALID_HISTORY_ID");
 const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("INVALID_HISTORY_ID"); return n;
}
export class OdimReadonlyHistory {
 constructor(private readonly db: HistoryDb, readonly snapshot: { id: string; source_snapshot_at: string; manifest: string }) {}
 metadata() {
  const m = JSON.parse(this.snapshot.manifest);
  return { snapshotAt: this.snapshot.source_snapshot_at, readOnly: true, attachmentsAvailable: false,
   counts: Object.fromEntries(m.tables.map((t: any) => [t.table, t.rows])) };
 }
 async list(kind: HistoryKind, options: { page?: unknown; limit?: unknown; search?: unknown; finished?: unknown }) {
  const page = historyPage(options.page, 1, 100000), limit = historyPage(options.limit, 20, 100);
  const search = String(options.search || "").slice(0, 100).trim();
  let where = "r.snapshot_id=? AND r.domain=?"; const values: unknown[] = [this.snapshot.id, domains[kind]];
  const join = kind === "chats" ? " LEFT JOIN legacy_readonly_history_rows c ON c.snapshot_id=r.snapshot_id AND c.domain='w_clientes_numeros' AND c.source_id=r.contact_id" : "";
  if (search) {
   const alias = kind === "chats" ? "c" : "r";
   const like = "%" + search.replace(/[!%_]/g, s => "!" + s) + "%";
   where += ` AND (${alias}.name_text LIKE ? ESCAPE '!' OR ${alias}.phone_text LIKE ? ESCAPE '!' OR r.source_id=?)`;
   values.push(like, like, /^-?\d+$/.test(search) ? Number(search) : -999999999);
  }
  if (kind === "chats" && options.finished !== undefined && options.finished !== "all") {
   if (options.finished !== "true" && options.finished !== "false") throw new Error("INVALID_HISTORY_FILTER");
   where += " AND r.is_finished=?"; values.push(options.finished === "true" ? 1 : 0);
  }
  const count = await this.db.query(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) n FROM legacy_readonly_history_rows r${join} WHERE ${where}`, values);
  const rows = await this.db.query(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ r.source_id,r.contact_id,r.payload${kind === "chats" ? ",c.payload contact_payload" : ""} FROM legacy_readonly_history_rows r${join} WHERE ${where} ORDER BY r.source_id DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
  return { items: rows.map(r => this.item(kind, r)), total: Number(count[0]?.n || 0), page, limit, ...this.metadata() };
 }
 private item(kind: HistoryKind, row: any) {
  const raw = parse(row);
  const contact = kind === "contacts" ? raw : row.contact_payload ? JSON.parse(row.contact_payload) : null;
  return { id: Number(row.source_id), contactId: kind === "contacts" ? Number(row.source_id) : row.contact_id === null ? null : Number(row.contact_id),
   name: String(contact?.NOME || contact?.NUMERO || "Contato sem cadastro"), phone: contact?.NUMERO ? String(contact.NUMERO) : null,
   customerId: contact?.CODIGO_CLIENTE ?? raw.CODIGO_CLIENTE ?? null,
   operatorId: raw.CODIGO_OPERADOR ?? null, finished: raw.CONCLUIDO === undefined ? null : Number(raw.CONCLUIDO) === 1,
   startedCivil: raw.DATA_INICIO ?? null, finishedCivil: raw.DATA_FIM ?? null, originalType: raw.TIPO ?? null };
 }
 async itemExists(kind: HistoryKind, id: number) {
  const rows = await this.db.query("SELECT source_id FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain=? AND source_id=? LIMIT 1", [this.snapshot.id, domains[kind], id]);
  return rows.length === 1;
 }
 async messages(kind: HistoryKind, id: number, options: { before?: unknown; limit?: unknown }, events = false) {
  if (!await this.itemExists(kind, id)) return null;
  const limit = historyPage(options.limit, 50, 100);
  const before = options.before === undefined ? null : historyId(options.before);
  const domain = events ? "w_atendimentos_historico" : "w_mensagens";
  const column = kind === "chats" ? "parent_id" : "contact_id";
  const rows = await this.db.query(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ source_id,payload FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain=? AND ${column}=?${before === null ? "" : " AND source_id<?"} ORDER BY source_id DESC LIMIT ?`, [this.snapshot.id, domain, id, ...(before === null ? [] : [before]), limit + 1]);
  const hasMore = rows.length > limit, page = rows.slice(0, limit);
  const attachments = events || !page.length ? [] : await this.db.query(`SELECT parent_id,payload FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain='w_mensagens_arquivos' AND parent_id IN (${page.map(() => "?").join(",")}) ORDER BY source_id`, [this.snapshot.id, ...page.map(r => r.source_id)]);
  const entries = page.map(row => {
   const raw = parse(row);
   return { id: Number(row.source_id), body: String(raw.MENSAGEM ?? ""), type: String(raw.TIPO ?? "texto"), fromMe: Number(raw.FROM_ME) === 1,
    operatorId: raw.CODIGO_OPERADOR ?? null, status: raw.STATUS ?? null, civilDate: raw.DATA_HORA ?? null,
    unixTimestamp: raw.TIMESTAMP == null ? null : String(raw.TIMESTAMP), quotedProviderId: raw.ID_REFERENCIA ?? null,
    attachments: attachments.filter(file => Number(file.parent_id) === Number(row.source_id)).map(file => { const f = parse(file), name = String(f.NOME_ORIGINAL || f.NOME_ARQUIVO || "Anexo legado").split(/[\\/]/).pop() || "Anexo legado"; return { name: /[?&#:]/.test(name) ? "Anexo legado" : name.slice(0, 255), type: String(f.TIPO || "arquivo").slice(0, 100), available: false }; }) };
  });
  return { entries, nextBefore: hasMore ? entries.at(-1)?.id ?? null : null, ...this.metadata() };
 }
}
