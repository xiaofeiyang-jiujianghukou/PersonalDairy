import { useState } from 'react';
import { api } from '../api';
import { blocksToMarkdown, newId, type Block } from '../lib/blocks';
import { scheduleSync } from '../lib/syncAuto';
import BlocksEditor from './BlocksEditor';

export default function Composer({
  date,
  onSaved,
}: {
  date: string;
  onSaved: () => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>([{ id: newId(), kind: 'text', text: '' }]);
  const [busy, setBusy] = useState(false);

  async function save() {
    const md = blocksToMarkdown(blocks);
    if (!md.trim()) return;
    setBusy(true);
    try {
      await api.create({ date, content: md });
      setBlocks([{ id: newId(), kind: 'text', text: '' }]);
      onSaved();
      scheduleSync();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="composer">
      <BlocksEditor blocks={blocks} onChange={setBlocks} />
      <div className="composer-bar">
        <span className="hint">支持 Markdown · 保存后即属于 {date}</span>
        <span className="composer-actions">
          <button className="primary" onClick={save} disabled={busy || !blocksToMarkdown(blocks).trim()}>
            记下来
          </button>
        </span>
      </div>
    </div>
  );
}
