export type ReportType = "chats";
export type ChatsReportFormat = "txt" | "csv" | "pdf";
export type ChatsReportStatus = "pending" | "completed" | "failed";

export interface ChatsReport {
    id: number;
    userId: string;
    fileId: number;
    instance: string;
    startDate: string;
    endDate: string;
    exportDate: string;
    chats: number;
    messages: number;
    format: ChatsReportFormat;
    status: ChatsReportStatus;
}

export interface GenerateChatsReportOptions {
    userId: string;
    format: ChatsReportFormat;
    startDate: string;
    endDate: string;
}

export interface SQLReportColumn {
  name: string;
  type: string;
}

export type SQLReportRow = Record<string, any>;

export interface SqlReport {
  id: string;
  description: string;
  sql: string;
  createdAt: string;
  status: "pending" | "completed" | "failed";
  resultUrl?: string;
}

export interface ExecuteSqlReportOptions {
  sql: string;
  description?: string;
}

export interface ExportSqlReportOptions extends ExecuteSqlReportOptions {
	format: ChatsReportFormat;
}
