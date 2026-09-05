import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { zhCN } from 'date-fns/locale';

export const todayStr = (): string => format(new Date(), 'yyyy-MM-dd');

/** 把 'YYYY-MM-DD' 解析为本地时间(避免 UTC 偏移导致日期漂移)。 */
export const toDate = (s: string): Date => parseISO(s);

export const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'];

/** 生成月视图所需的完整网格(含前后月补齐的日期)。month 为 1-12。 */
export function monthGrid(year: number, month: number): Date[] {
  const start = startOfMonth(new Date(year, month - 1, 1));
  const end = endOfMonth(start);
  const gridStart = startOfWeek(start, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(end, { weekStartsOn: 1 });
  return eachDayOfInterval({ start: gridStart, end: gridEnd });
}

export const shiftDate = (s: string, delta: number): string =>
  format(addDays(toDate(s), delta), 'yyyy-MM-dd');

export const friendlyDate = (s: string): string => {
  const d = toDate(s);
  return format(d, 'M 月 d 日 EEEE', { locale: zhCN });
};
