import { useEffect } from 'react';
import { onDataChanged } from './dataEvents';

/**
 * 订阅"本地数据变更"(如同步合并了对端条目)并触发重载。
 * 用法:把视图里已有的 load 函数传进来即可,数据同步过来后界面会自动刷新。
 * reload 需为稳定引用(useCallback),否则会频繁重订阅。
 */
export function useDataRefresh(reload: () => void): void {
  useEffect(() => {
    if (!reload) return;
    return onDataChanged(reload);
  }, [reload]);
}
