'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Upload, Send, Download, RefreshCw, CheckCircle, XCircle, Clock, FileText, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import { uploadCsv, sendBulk, getBulkJobs, getBulkJobStatus, exportBulkJob, getBulkConfig } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import clsx from 'clsx';

interface PreviewResult {
  fileName: string; valid: number; invalid: number; duplicates: number; totalAmount: string;
  preview: Array<{ address: string; amount: string }>;
  invalidRows: Array<{ line: number; raw: string; reason: string }>;
}
interface Batch { batchNumber: number; txHash: string | null; status: string; error?: string }
interface Job {
  id: number; file_name: string; total_recipients: number; total_amount: string;
  status: string; created_at: string; completed_at: string | null; batches?: Batch[];
  chain?: 'bsc' | 'ethereum';
}

const STATUS_BADGE: Record<string, string> = {
  PENDING: 'badge-yellow', RUNNING: 'badge-yellow', COMPLETED: 'badge-green',
  PARTIAL: 'badge-yellow', FAILED: 'badge-red',
};
const MULTISENDER = '0xfc13372d4747Bbf846a8ADd351aF32E0Be956836';

export default function BulkPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file,       setFile]      = useState<File | null>(null);
  const [preview,    setPreview]   = useState<PreviewResult | null>(null);
  const [uploading,  setUploading] = useState(false);
  const [sending,    setSending]   = useState(false);

  const [tokenAddr,  setTokenAddr]  = useState('');
  const [msAddr,     setMsAddr]     = useState('');
  const [batchSize,  setBatchSize]  = useState(50);
  const [chain,      setChain]      = useState<'bsc' | 'ethereum'>('bsc');

  const [jobs,        setJobs]        = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const { on } = useSSE();

  const refreshJobs = useCallback(async () => {
    setLoadingJobs(true);
    try { setJobs(await getBulkJobs()); } catch { /* ignore */ }
    setLoadingJobs(false);
  }, []);

  useEffect(() => {
    refreshJobs();
    getBulkConfig()
      .then((cfg: { multiSenderAddress: string; tokenAddress: string | null }) => {
        if (cfg.multiSenderAddress) setMsAddr(cfg.multiSenderAddress);
        if (cfg.tokenAddress)       setTokenAddr(cfg.tokenAddress);
      })
      .catch(() => setMsAddr(MULTISENDER));
  }, [refreshJobs]);

  useEffect(() => {
    const off1 = on('BULK_JOB_COMPLETE', () => refreshJobs());
    const off2 = on('BULK_JOB_FAILED',   () => refreshJobs());
    const off3 = on('BULK_BATCH_CONFIRMED', () => { if (selectedJob) loadDetail(selectedJob.id); });
    return () => { off1(); off2(); off3(); };
  }, [on, refreshJobs, selectedJob]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDetail(id: number) {
    try {
      const d = await getBulkJobStatus(id);
      setSelectedJob(d);
      setJobs(p => p.map(j => j.id === id ? { ...j, status: d.status } : j));
    } catch { /* ignore */ }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setPreview(null); setUploading(true);
    try { setPreview(await uploadCsv(f)); }
    catch (e: unknown) { toast.error((e as Error).message ?? 'Parse failed'); }
    setUploading(false);
  }

  async function handleSend() {
    if (!file || !preview) return;
    if (!tokenAddr)  { toast.error('Enter token address'); return; }
    if (!msAddr)     { toast.error('Enter multisender address'); return; }
    if (!preview.valid) { toast.error('No valid recipients'); return; }
    setSending(true);
    try {
      const res = await sendBulk(file, tokenAddr, msAddr, batchSize, chain);
      toast.success(`Job #${res.jobId} started — ${res.totalRecipients} recipients`);
      setFile(null); setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      await refreshJobs();
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
    setSending(false);
  }

  async function handleExport(id: number) {
    try {
      const blob = await exportBulkJob(id);
      const url = URL.createObjectURL(blob as Blob);
      Object.assign(document.createElement('a'), { href: url, download: `bulk_${id}.csv` }).click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Export failed'); }
  }

  function downloadTemplate() {
    const csv = 'address,amount\n0xAbCd1234...000,100\n0xEfGh5678...000,250';
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: 'bulk_template.csv',
    }).click();
  }

  return (
    <div className="page">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-50">Bulk Token Sender</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Send tokens to many wallets via CSV</p>
        </div>
        <button onClick={downloadTemplate} className="btn-ghost text-xs px-3 py-2">
          <FileText className="h-4 w-4" /> Template
        </button>
      </div>

      {/* Step 1 — Upload */}
      <div className="card space-y-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">1. Upload CSV</p>

        <div
          className="border-2 border-dashed border-zinc-800 hover:border-brand-500/40 rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => fileRef.current?.click()}>
          <Upload className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-400">{file ? file.name : 'Click to upload CSV'}</p>
          <p className="text-xs text-zinc-600 mt-1">Columns: address, amount</p>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        </div>

        {uploading && (
          <div className="flex items-center gap-2 text-amber-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Parsing CSV…
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Valid',       preview.valid,                         'text-brand-400'],
                ['Invalid',     preview.invalid + preview.duplicates,  'text-red-400'],
                ['Duplicates',  preview.duplicates,                    'text-amber-400'],
                ['Total Tokens',parseFloat(preview.totalAmount).toLocaleString('en', { maximumFractionDigits: 2 }), 'text-zinc-100'],
              ].map(([label, value, color]) => (
                <div key={label as string} className="surface text-center">
                  <p className="text-xs text-zinc-600">{label}</p>
                  <p className={clsx('font-bold text-base mt-0.5', color)}>{value}</p>
                </div>
              ))}
            </div>

            {preview.invalidRows.length > 0 && (
              <div className="surface border border-red-800/30 space-y-1">
                <p className="text-red-400 text-xs font-medium flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> Invalid rows
                </p>
                {preview.invalidRows.map((r, i) => (
                  <p key={i} className="text-red-300 text-xs">
                    Line {r.line}: {r.reason} — <span className="font-mono">{r.raw.slice(0, 40)}</span>
                  </p>
                ))}
              </div>
            )}

            <div>
              <p className="text-xs text-zinc-600 mb-2">Preview (first 10)</p>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {preview.preview.map((r, i) => (
                  <div key={i} className="flex justify-between text-xs font-mono surface !p-2">
                    <span className="text-zinc-400 truncate">{r.address}</span>
                    <span className="text-zinc-100 ml-2 shrink-0">{r.amount}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step 2 — Configure */}
      <div className="card space-y-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">2. Configure & Send</p>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Chain</label>
          <div className="flex gap-2">
            {(['bsc', 'ethereum'] as const).map(c => (
              <button key={c} onClick={() => setChain(c)}
                className={clsx('flex-1 py-2 rounded-lg text-xs font-medium border transition-colors',
                  chain === c
                    ? 'bg-brand-500/20 border-brand-500/60 text-brand-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600')}>
                {c === 'bsc' ? 'BNB Chain (BSC)' : 'Ethereum'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Token Address</label>
          <input className="input font-mono text-xs" placeholder="0x…" value={tokenAddr} onChange={e => setTokenAddr(e.target.value)} />
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5 flex items-center gap-2">
            MultiSender Contract
            {msAddr.toLowerCase() === MULTISENDER.toLowerCase() && (
              <span className="badge-green text-xs">{chain === 'bsc' ? 'BNB Mainnet' : 'Ethereum Mainnet'}</span>
            )}
          </label>
          <input className="input font-mono text-xs" placeholder="0x…" value={msAddr} onChange={e => setMsAddr(e.target.value)} />
          <a href={`${chain === 'bsc' ? 'https://bscscan.com' : 'https://etherscan.io'}/address/${msAddr || MULTISENDER}`}
            target="_blank" rel="noreferrer"
            className="text-xs text-zinc-600 hover:text-brand-400 mt-1 flex items-center gap-1">
            View on {chain === 'bsc' ? 'BscScan' : 'Etherscan'} <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Batch Size</label>
          <input type="number" className="input" min={1} max={200} value={batchSize}
            onChange={e => setBatchSize(parseInt(e.target.value) || 50)} />
          <p className="text-xs text-zinc-600 mt-1">Recommended 50–100. Larger batches = more gas per tx.</p>
        </div>

        {preview && (
          <div className="surface border border-amber-800/30 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
            Will auto-approve <strong>{parseFloat(preview.totalAmount).toLocaleString()} tokens</strong> to the multisender.
          </div>
        )}

        <button onClick={handleSend}
          disabled={!preview || !preview.valid || sending || !tokenAddr || !msAddr}
          className="btn-primary w-full disabled:opacity-40">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? 'Starting…' : `Send to ${preview?.valid ?? 0} wallets`}
        </button>
      </div>

      {/* Job history */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">Job History</p>
          <button onClick={refreshJobs} disabled={loadingJobs} className="btn-icon !p-2">
            <RefreshCw className={clsx('h-3.5 w-3.5', loadingJobs && 'animate-spin')} />
          </button>
        </div>

        {jobs.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-6">No jobs yet</p>
        ) : (
          <div className="space-y-2">
            {jobs.map(j => (
              <div key={j.id} className="surface flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-500 font-mono text-xs">#{j.id}</span>
                    <span className="text-zinc-200 truncate">{j.file_name}</span>
                    <span className={clsx('shrink-0 text-xs', STATUS_BADGE[j.status] ?? 'badge-gray')}>{j.status}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-600 mt-1">
                    <span>{j.total_recipients.toLocaleString()} recipients</span>
                    <span>{parseFloat(j.total_amount).toLocaleString('en', { maximumFractionDigits: 2 })} tokens</span>
                    <span>{new Date(j.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => { setSelectedJob(selectedJob?.id === j.id ? null : j); if (selectedJob?.id !== j.id) loadDetail(j.id); }}
                    className="btn-ghost !py-1.5 !px-2.5 text-xs">
                    {selectedJob?.id === j.id ? 'Close' : 'Detail'}
                  </button>
                  <button onClick={() => handleExport(j.id)} className="btn-icon !p-2">
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Job detail */}
      {selectedJob && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="font-semibold text-zinc-100 text-sm">Job #{selectedJob.id}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{selectedJob.file_name}</p>
            </div>
            <button onClick={() => setSelectedJob(null)} className="text-zinc-600 hover:text-zinc-200 text-lg leading-none">×</button>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4">
            {[
              ['Recipients', selectedJob.total_recipients],
              ['Amount',     parseFloat(selectedJob.total_amount).toLocaleString('en', { maximumFractionDigits: 2 })],
              ['Status',     selectedJob.status],
              ['Batches',    selectedJob.batches?.length ?? '—'],
            ].map(([label, value]) => (
              <div key={label as string} className="surface text-center">
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="font-semibold text-zinc-100 text-sm mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {selectedJob.batches?.map(b => (
              <div key={b.batchNumber} className="surface flex items-center gap-3 text-xs">
                {b.status === 'SUCCESS' && <CheckCircle className="h-4 w-4 text-brand-400 shrink-0" />}
                {b.status === 'FAILED'  && <XCircle    className="h-4 w-4 text-red-400   shrink-0" />}
                {b.status === 'PENDING' && <Clock      className="h-4 w-4 text-amber-400 shrink-0" />}
                <span className="text-zinc-500">Batch {b.batchNumber}</span>
                {b.txHash && (
                  <a href={`${selectedJob.chain === 'ethereum' ? 'https://etherscan.io' : 'https://bscscan.com'}/tx/${b.txHash}`}
                    target="_blank" rel="noreferrer"
                    className="text-brand-400 font-mono truncate flex-1 hover:underline flex items-center gap-1">
                    {b.txHash.slice(0, 20)}… <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}
                {b.error && <span className="text-red-400 ml-auto truncate max-w-xs">{b.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
