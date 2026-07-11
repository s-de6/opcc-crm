import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
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
  const queryClient = useQueryClient();
  const [showConfirmPurge, setShowConfirmPurge] = useState<{ type: string; id: string; name: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['recycle-bin'],
    queryFn: () => api('/bank-statements/recycle/list') as Promise<RecycleData>,
  });

  const restoreMut = useMutation({
    mutationFn: ({ type, id }: { type: string; id: string }) =>
      api(`/bank-statements/recycle/${type}/${id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recycle-bin'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      alert('Restored successfully.');
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

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading recycle bin…</div>;

  if (error) {
    const msg = (error as any)?.error || (error as any)?.message || '';
    if (/higher permission/i.test(msg)) {
      return (
        <div className="p-8 max-w-2xl">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-6">
            <AlertTriangle className="h-8 w-8 text-amber-600 mb-2" />
            <h2 className="text-lg font-bold">Restricted</h2>
            <p className="text-sm text-muted-foreground mt-1">
              The recycle bin is only accessible to users with the <b>higher</b> permission tier
              (account owner or boss). Ask your admin to grant you access or perform the restore.
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

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Trash2 className="h-6 w-6 text-muted-foreground" /> Recycle Bin 回收站
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Deleted items are kept here for <b>{retentionDays} days</b>, then permanently removed.
          Only higher-tier users can restore or permanently delete.
        </p>
      </div>

      <div className="bg-card border rounded-lg p-4 flex items-center gap-4">
        <div className="text-sm">
          <b>{total}</b> item(s) in recycle bin
          {stmts.length > 0 && <span className="text-muted-foreground"> · {stmts.length} statement(s)</span>}
          {files.length > 0 && <span className="text-muted-foreground"> · {files.length} file(s)</span>}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => { if (confirm(`Permanently purge everything older than ${retentionDays} days?`)) purgeOldMut.mutate(); }}
          className="text-xs px-3 py-1.5 border border-red-300 text-red-600 rounded hover:bg-red-50"
          disabled={purgeOldMut.isPending}
        >
          {purgeOldMut.isPending ? 'Purging…' : `Purge items > ${retentionDays} days`}
        </button>
      </div>

      {total === 0 && (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Trash2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>Recycle bin is empty.</p>
        </div>
      )}

      {stmts.length > 0 && (
        <div>
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Bank Statements ({stmts.length})
          </h2>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Bank</th>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-left">Period</th>
                  <th className="px-3 py-2 text-left">Deleted</th>
                  <th className="px-3 py-2 text-left">Days until purge</th>
                  <th className="px-3 py-2 text-left">Actions</th>
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
                            onClick={() => restoreMut.mutate({ type: 'bank_statement', id: s.id })}
                            className="text-xs px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 inline-flex items-center gap-1"
                            disabled={restoreMut.isPending}
                          >
                            <RotateCcw className="h-3 w-3" /> Restore
                          </button>
                          <button
                            onClick={() => setShowConfirmPurge({ type: 'bank_statement', id: s.id, name: `${s.bank_name} ${s.statement_year}-${s.statement_month}` })}
                            className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
                          >
                            Delete forever
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
            <FileText className="h-4 w-4" /> Files ({files.length})
          </h2>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Filename</th>
                  <th className="px-3 py-2 text-left">Folder</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Deleted</th>
                  <th className="px-3 py-2 text-left">Days until purge</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => {
                  const days = daysUntilPurge(f.deleted_at, retentionDays);
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
                            onClick={() => restoreMut.mutate({ type: 'file', id: f.id })}
                            className="text-xs px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 inline-flex items-center gap-1"
                            disabled={restoreMut.isPending}
                          >
                            <RotateCcw className="h-3 w-3" /> Restore
                          </button>
                          <button
                            onClick={() => setShowConfirmPurge({ type: 'file', id: f.id, name: f.original_name || f.filename })}
                            className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
                          >
                            Delete forever
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
            <h3 className="text-lg font-bold mb-2">Permanent deletion</h3>
            <p className="text-sm text-muted-foreground mb-4">
              You are about to <b>permanently delete</b> <span className="font-mono">{showConfirmPurge.name}</span>.
              This cannot be undone — no restore is possible after this.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowConfirmPurge(null)} className="px-3 py-1.5 border rounded text-sm">Cancel</button>
              <button
                onClick={() => purgeMut.mutate({ type: showConfirmPurge.type, id: showConfirmPurge.id })}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                disabled={purgeMut.isPending}
              >
                {purgeMut.isPending ? 'Deleting…' : 'Yes, delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
