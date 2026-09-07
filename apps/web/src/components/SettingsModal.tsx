import { useState } from 'react';
import { getApiBase, setApiBase } from '../api';

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(getApiBase());
  const [saved, setSaved] = useState(false);

  function save() {
    setApiBase(value);
    setSaved(true);
    setTimeout(() => {
      onClose();
      window.location.reload();
    }, 500);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">日记服务器</h2>
        <p className="modal-hint">
          留空 = 使用当前页面自带的日记服务。手机端 App 请填你电脑上日记服务的地址,例如{' '}
          <code>http://192.168.1.10:4520</code>(需手机与电脑同一网络)。
        </p>
        <input
          className="settings-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://电脑IP:4520(留空 = 同源)"
          autoFocus
        />
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>关闭</button>
          <button className="primary" onClick={save}>{saved ? '已保存…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
