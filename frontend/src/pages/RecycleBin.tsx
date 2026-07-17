import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { Trash2, RotateCcw, AlertTriangle, FileText, Landmark } from 'lucide-react';

interface RecycleData {
  bank_statements: any[];
  files: any[];
  retention_days: number;
}

function daysUntilPurge(deletedAt: string, retentionDays: number): number {
  const deleted = new Date(deletedAt).getTime();
  const purgeAt = deleted + retentionDays * 86400_000;
  const days = Math.ceil((purgeAt - Date.now()) / 86400_000);
  return Math.max(0, days);
}

export default function RecycleBin() {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showConfirmPurge, setShowConfirmPurge] = useState<{ type: string; id: string; name: string } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['recycle-bin'],
    queryFn: () => api('/bank-statements/recycle/list') as Promise<RecycleData>,
  });

  // Restore bank statement → then navigate to review page
  const restoreStatementMut = useMutation({
    mutationFn: (id: string) =>
      api(`/bank-statements/recycle/bank_statement/${id}/restore`, { method: 'POST' }),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ['recycle-bin'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      // Navigate to review so user can verify before re-saving
      navigate(`/bank-statements/review/${id}`);
    },
    onError: (e: any) => alert(`Restore failed: ${e?.error || e?.message || 'unknown'}`),
  });

  // Restore file → if it was an invoice, trigger re-import to review page; if bank statement file, just restore
  const restoreFileMut = useMutation({
    mutationFn: async (f: { id: string; category: string; original_name: string }) => {
      // First restore the file record
      await api(`/bank-statements/recycle/file/${f.id}/restore`, { method: 'POST' });
      return f;
    },
    onSuccess: async (f) => {
      queryClient.invalidateQueries({ queryKey: ['recycle-bin'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });

      // If it was an invoice or receipt file, trigger re-import → review page
      if (f.category === 'invoice' || f.category === 'receipt') {
        setRestoringId(f.id);
        try {
          const token = localStorage.getItem('token') || '';
          const activeClient = localStorage.getItem('activeClient');
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };
          try { const c = JSON.parse(activeClient || '{}'); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
          const resp = await fetch(
            `${WORKER_API_BASE}/file-storage/${f.id}/import-document?force=true`,
            { method: 'POST', headers }
          );
          const result: any = await resp.json();
          if (result?.invoice_id) {
            navigate(`/invoices/review/${result.invoice_id}`);
          } else if (result?.statement_id) {
            navigate(`/bank-statements/review/${result.statement_id}`);
          } else {
            alert(`File restored to File Storage. Re-import failed: ${result?.error || 'unknown'}. You can re-process it from File Storage.`);
          }
        } catch (err: any) {
          alert(`File restored but re-import failed: ${err?.message || 'unknown'}. Re-process from File Storage.`);
        } finally {
          setRestoringId(null);
        }
      } else {
        // Non-invoice file (contract, BR, etc.) — just restore, no review needed
        alert('Restored successfully. File is back in File Storage.');
      }
    },
    onError: (e: any) => alert(`Restore failed: ${e?.error || e?.message || 'unknown'}`),
  });

  const purgeMut = useMutation({
    mutationFn: ({ type, id }: { type: string; id: string }) =>
      api(`/bank-statements/recycle/${type}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recycle-bin'] });
      setShowConfirmPurge(null);
    },
    onError: (e: any) => {
      alert(`Permanent delete failed: ${e?.error || e?.message || 'unknown'}`);
      setShowConfirmPurge(null);
    },
  });

  const purgeOldMut = useMutation({
    mutationFn: () => api('/bank-statements/recycle/purge-old', { method: 'POST' }),
    onSuccess: (res: any) => {
      const p = res?.purged || {};
      alert(`Purged: ${p.statements || 0} statement(s), ${p.transactions || 0} transaction(s), ${p.files || 0} file(s) older than 30 days.`);
      queryClient.invalidateQueries({ queryKey: ['recycle-bin'] });
    },
    onError: (e: any) => alert(`Purge failed: ${e?.error || e?.message || 'unknown'}`),
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{i18n.language === 'en' ? 'Loading recycle bin…' : '載入回收站中…'}</div>;

  if (error) {
    const msg = (error as any)?.error || (error as any)?.message || '';
    if (/higher permission/i.test(msg)) {
      return (
        <div className="p-8 max-w-2xl">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-6">
            <AlertTriangle className="h-8 w-8 text-amber-600 mb-2" />
            <h2 className="text-lg font-bold">{i18n.language === 'en' ? 'Restricted' : '存取受限'}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {i18n.language === 'en'
                ? <>The recycle bin is only accessible to users with the <b>higher</b> permission tier (account owner or boss). Ask your admin to grant you access or perform the restore.</>
                : <>回收站僅對具有<b>較高</b>權限的用戶開放（帳戶擁有者或管理員）。請聯繫管理員授權或進行還原操作。</>}
            </p>
          </div>
        </div>
      );
    }
    return <div className="p-8 text-red-600">Failed to load recycle bin: {msg}</div>;
  }

  const stmts = data?.bank_statements || [];
  const files = data?.files || [];
  const retentionDays = data?.retention_days || 30;
  const total = stmts.length + files.length;

  const isWorking = restoreStatementMut.isPending || restoreFileMut.isPending || !!restoringId;

  return (
    <div className="space-y-6 max-w-6xl">
      {restoringId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-card border rounded-xl p-8 text-center shadow-2xl">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-3" />
            <p className="font-medium">Restoring and re-processing file…</p>
            <p className="text-sm text-muted-foreground mt-1">You'll be taken to the review page</p>
          </div>
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Trash2 className="h-6 w-6 text-muted-foreground" />
          {i18n.language === 'en' ? 'Recycle Bin' : '回收站 Recycle Bin'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {i18n.language === 'en' ? (
            <>Deleted items are kept here for <b>{retentionDays} days</b>, then permanently removed.
            Only higher-tier users can restore or permanently delete.
            <b className="text-foreground"> Restoring an invoice or receipt takes you back to the review page.</b></>
          ) : (
            <>已刪除的項目將保留 <b>{retentionDays} 天</b>，之後永久刪除。
            僅高級權限用戶可還原或永久刪除。
            <b className="text-foreground">還原發票或收據後將跳轉至審核頁面。</b></>
          )}
        </p>
      </div>

      <div className="bg-card border rounded-lg p-4 flex items-center gap-4">
        <div className="text-sm">
          <b>{total}</b> {i18n.language === 'en' ? 'item(s) in recycle bin' : '個項目在回收站'}
          {stmts.length > 0 && <span className="text-muted-foreground"> · {stmts.length} {i18n.language === 'en' ? 'statement(s)' : '份月結單'}</span>}
          {files.length > 0 && <span className="text-muted-foreground"> · {files.length} {i18n.language === 'en' ? 'file(s)' : '個文件'}</span>}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => { if (confirm(i18n.language === 'en' ? `Permanently purge everything older than ${retentionDays} days?` : `永久清除所有超過 ${retentionDays} 天的項目？`)) purgeOldMut.mutate(); }}
          className="text-xs px-3 py-1.5 border border-red-300 text-red-600 rounded hover:bg-red-50"
          disabled={purgeOldMut.isPending}
        >
          {purgeOldMut.isPending
            ? (i18n.language === 'en' ? 'Purging…' : '清除中…')
            : (i18n.language === 'en' ? `Purge items > ${retentionDays} days` : `清除超過 ${retentionDays} 天的項目`)}
        </button>
      </div>

      {total === 0 && (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Trash2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>{i18n.language === 'en' ? 'Recycle bin is empty.' : '回收站是空的。'}</p>
        </div>
      )}

      {stmts.length > 0 && (
        <div>
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Landmark className="h-4 w-4" /> {i18n.language === 'en' ? `Bank Statements (${stmts.length})` : `銀行月結單 (${stmts.length})`}
          </h2>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Bank' : '銀行'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Account' : '帳號'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Period' : '期間'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Deleted' : '刪除日期'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Days until purge' : '距清除天數'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Actions' : '操作'}</th>
                </tr>
              </thead>
              <tbody>
                {stmts.map(s => {
                  const days = daysUntilPurge(s.deleted_at, retentionDays);
                  return (
                    <tr key={s.id} className="border-t">
                      <td className="px-3 py-2">{s.bank_name || '-'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.account_number || '-'}</td>
                      <td className="px-3 py-2">{s.statement_year}-{String(s.statement_month || '').padStart(2, '0')}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{s.deleted_at?.slice(0, 10)}</td>
                      <td className="px-3 py-2">
                        <span className={days <= 7 ? 'text-red-600 font-bold' : 'text-muted-foreground'}>
                          {days} day{days === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <button
                            onClick={() => restoreStatementMut.mutate(s.id)}
                            className="text-xs px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 inline-flex items-center gap-1"
                            disabled={isWorking}
                          >
                            <RotateCcw className="h-3 w-3" /> {i18n.language === 'en' ? 'Restore + Review' : '還原並審核'}
                          </button>
                          <button
                            onClick={() => setShowConfirmPurge({ type: 'bank_statement', id: s.id, name: `${s.bank_name} ${s.statement_year}-${s.statement_month}` })}
                            className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
                          >
                            {i18n.language === 'en' ? 'Delete forever' : '永久刪除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div>
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <FileText className="h-4 w-4" /> {i18n.language === 'en' ? `Files (${files.length})` : `文件 (${files.length})`}
          </h2>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Filename' : '文件名'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Folder' : '資料夾'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Type' : '類型'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Deleted' : '刪除日期'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Days until purge' : '距清除天數'}</th>
                  <th className="px-3 py-2 text-left">{i18n.language === 'en' ? 'Actions' : '操作'}</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => {
                  const days = daysUntilPurge(f.deleted_at, retentionDays);
                  const isInvoiceFile = f.category === 'invoice' || f.category === 'receipt';
                  return (
                    <tr key={f.id} className="border-t">
                      <td className="px-3 py-2 truncate max-w-xs" title={f.original_name || f.filename}>{f.original_name || f.filename}</td>
                      <td className="px-3 py-2">{f.folder || '-'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{f.category || '-'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{f.deleted_at?.slice(0, 10)}</td>
                      <td className="px-3 py-2">
                        <span className={days <= 7 ? 'text-red-600 font-bold' : 'text-muted-foreground'}>
                          {days} day{days === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <button
                            onClick={() => restoreFileMut.mutate({ id: f.id, category: f.category, original_name: f.original_name || f.filename })}
                            className="text-xs px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 inline-flex items-center gap-1"
                            disabled={isWorking}
                          >
                            <RotateCcw className="h-3 w-3" />
                            {isInvoiceFile
                              ? (i18n.language === 'en' ? 'Restore + Review' : '還原並審核')
                              : (i18n.language === 'en' ? 'Restore' : '還原')}
                          </button>
                          <button
                            onClick={() => setShowConfirmPurge({ type: 'file', id: f.id, name: f.original_name || f.filename })}
                            className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
                          >
                            {i18n.language === 'en' ? 'Delete forever' : '永久刪除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Confirmation modal for permanent delete */}
      {showConfirmPurge && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card border rounded-lg max-w-md p-6 shadow-2xl">
            <AlertTriangle className="h-8 w-8 text-red-600 mb-3" />
            <h3 className="text-lg font-bold mb-2">{i18n.language === 'en' ? 'Permanent deletion' : '永久刪除'}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {i18n.language === 'en' ? (
                <>You are about to <b>permanently delete</b> <span className="font-mono">{showConfirmPurge.name}</span>.
                This cannot be undone — no restore is possible after this.</>
              ) : (
                <>您即將<b>永久刪除</b> <span className="font-mono">{showConfirmPurge.name}</span>。
                此操作無法撤銷，刪除後無法還原。</>
              )}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowConfirmPurge(null)} className="px-3 py-1.5 border rounded text-sm">
                {i18n.language === 'en' ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={() => purgeMut.mutate({ type: showConfirmPurge.type, id: showConfirmPurge.id })}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                disabled={purgeMut.isPending}
              >
                {purgeMut.isPending
                  ? (i18n.language === 'en' ? 'Deleting…' : '刪除中…')
                  : (i18n.language === 'en' ? 'Yes, delete forever' : '是，永久刪除')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
