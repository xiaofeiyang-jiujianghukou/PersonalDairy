/**
 * 前后端共享的类型与 API 契约。
 * 这是唯一的类型事实源,server 与 web 都从这里 import。
 */

/** 一条日记(同一日期可有多条,如早/晚各一条) */
export interface Entry {
  id: number;
  /** 本地日期,格式 YYYY-MM-DD */
  date: string;
  /** Markdown 正文 */
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntryCreateInput {
  date: string;
  content: string;
}

export interface EntryUpdateInput {
  date?: string;
  content?: string;
}

/** 月度情绪小结 */
export interface MonthSummary {
  year: number;
  month: number; // 1-12
  /** Markdown 小结正文 */
  content: string;
  /** 生成时当月日记的内容指纹,用于判断是否需要重新生成 */
  entriesHash: string;
  createdAt: string;
}

/** GET /api/summary 的读取结果 */
export interface SummaryReadResult {
  exists: boolean;
  /** 缓存小结是否已落后于当前日记 */
  stale?: boolean;
  summary?: MonthSummary;
}

export interface SearchResult {
  id: number;
  date: string;
  content: string;
  /** 命中位置附近的摘录片段 */
  snippet: string;
}

export interface ApiError {
  error: string;
}

/** 日期与月份校验正则 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;
