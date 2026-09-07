import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Entry } from '../types';
import { api } from '../api';
import { blocksToMarkdown, parseBlocks, type Block } from '../lib/blocks';
import { allowImageUrlTransform } from '../lib/image';
import BlocksEditor from './BlocksEditor';

export default function EntryItem({
  entry,
  onChanged,
  onDeleted,
}: {
  entry: Entry;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftBlocks, setDraftBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);

  const time = new Date(entry.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  function startEdit() {
    setDraftBlocks(parseBlocks(entry.content));
    setEditing(true);
  }

  async function save() {
    const md = blocksToMarkdown(draftBlocks);
    if (!md.trim()) return;
    setBusy(true);
    try {
      await api.update(entry.id, { content: md });
      setEditing(false);
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('删除这条记录?删除后无法恢复。')) return;
    setBusy(true);
    try {
      await api.remove(entry.id);
      onDeleted();
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <article className="entry">
      <div className="entry-meta">
        <span className="entry-time">{time}</span>
        <span className="entry-actions">
          {editing ? (
            <>
              <button onClick={save} disabled={busy}>保存</button>
              <button onClick={() => setEditing(false)}>取消</button>
            </>
          ) : (
            <>
              <button onClick={startEdit}>编辑</button>
              <button onClick={remove} disabled={busy}>删除</button>
            </>
          )}
        </span>
      </div>

      {editing ? (
        <BlocksEditor blocks={draftBlocks} onChange={setDraftBlocks} />
      ) : (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={allowImageUrlTransform}>
            {entry.content}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}
