'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Upload, Send, Download, RefreshCw, CheckCircle, XCircle, Clock, FileText, AlertTriangle, Loader2, Info, Wallet, ExternalLink } from 'lucide-react';
import { getSolanaConfig, uploadSolanaCsv, sendSolanaBulk, getSolanaJobs, getSolanaJobStatus, exportSolanaJob } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import clsx from 'clsx';

interface SolanaConfig {
  walletAddress: string; solBalance: string; network: string;
  defaultBatchSize: number; concurrency: number; priorityFee: number;
}
interface PreviewResult {
  fileName: string; valid: number; invalid: number; duplicates: number;
  totalAmount: string; decimals: number | null;
  preview: Array<{ address: string; amount: string }>;
  invalidRows: Array<{ line: number; raw: string; reason: string }>;
}
interface SolanaBatch {
  batchIndex: number; tx_signature: string | null; status: string;
  recipient_count: number; atas_created: number; error_message?: string;
}
interface SolanaJob {
  id: number; file_name: string; token_mint: string; total_recipients: number;
  total_amount_raw: string; batch_size: number; status: string;
  success_batches: number; failed_batches: number; atas_created: number;
  recipients_sent: number; created_at: string; completed_at: string | null;
  batches?: SolanaBatch[];
}

const STATUS_BADGE: Record<string, string> = {
  PENDING: 'badge-yellow', RUNNING: 'badge-yellow', COMPLETED: 'badge-green',
  PARTIAL: 'badge-yellow', FAILED: 'badge-red',
};
const NETWORK_BADGE: Record<string, string> = {
  'mainnet-beta': 'badge-green', devnet: 'badge-yellow', testnet: 'badge-yellow',
};
const NETWORK_LABEL: Record<string, string> = {
  'mainnet-beta': 'Mainnet', devnet: 'Devnet', testnet: 'Testnet',
};
const SOLSCAN = (sig: string, network: string) =>
  network === 'mainnet-beta' ? `https://solscan.io/tx/${sig}` : `https://solscan.io/tx/${sig}?cluster=${network}`;

export default function SolanaPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [cfg,         setCfg]         = useState<SolanaConfig | null>(null);
  const [file,        setFile]        = useState<File | null>(null);
  const [preview,     setPreview]     = useState<PreviewResult | null>(null);
  const [uploading,   setUploading]   = useState(false);
  const [sending,     setSending]     = useState(false);

  const [tokenMint,   setTokenMint]   = useState('');
  const [batchSize,   setBatchSize]   = useState(10);
  const [priorityFee, setPriorityFee] = useState(1000);

  const [jobs,        setJobs]        = useState<SolanaJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<SolanaJob | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const { on } = useSSE();

  const refreshJobs = useCallback(async () => {
    setLoadingJobs(true);
    try { setJobs(await getSolanaJobs()); } catch { /* ignore */ }
    setLoadingJobs(false);
  }, []);

  useEffect(() => {
    refreshJobs();
    getSolanaConfig()
      .then((c: SolanaConfig) => { setCfg(c); setBatchSize(c.defaultBatchSize ?? 10); setPriorityFee(c.priorityFee ?? 1000); })
      .catch(() => {});
  }, [refreshJobs]);

  useEffect(() => {
    const off1 = on('SOL_JOB_COMPLETE',    () => refreshJobs());
    const off2 = on('SOL_JOB_FAILED',      () => refreshJobs());
    const off3 = on('SOL_BATCH_CONFIRMED', () => { if (selectedJob) loadDetail(selectedJob.id); });
    return () => { off1(); off2(); off3(); };
  }, [on, refreshJobs, selectedJob]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDetail(id: number) {
    try {
      const d = await getSolanaJobStatus(id);
      setSelectedJob(d);
      setJobs(p => p.map(j => j.id === id ? { ...j, status: d.status } : j));
    } catch { /* ignore */ }
  }

  async function parseFile(f: File) {
    setFile(f); setPreview(null); setUploading(true);
    try { setPreview(await uploadSolanaCsv(f, tokenMint || undefined)); }
    catch (e: unknown) { toast.error((e as Error).message ?? 'Parse failed'); }
    setUploading(false);
  }

  async function handleSend() {
    if (!file || !preview) return;
    if (!tokenMint.trim()) { toast.error('Enter token mint address'); return; }
    if (!preview.valid)    { toast.error('No valid recipients'); return; }
    const safeBatch = Math.min(batchSize, 15);
    setSending(true);
    try {
      const res = await sendSolanaBulk(file, tokenMint.trim(), safeBatch, priorityFee);
      toast.success(`Job #${res.jobId} started — ${res.totalRecipients} recipients`);
      setFile(null); setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      await refreshJobs();
    } catch (e: unknown) { toast.error((e as Error).message ?? 'Failed'); }
    setSending(false);
  }

  async function handleExport(id: number) {
    try {
      const blob = await exportSolanaJob(id);
      const url = URL.createObjectURL(blob as Blob);
      Object.assign(document.createElement('a'), { href: url, download: `solana_job_${id}.csv` }).click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Export failed'); }
  }

  function downloadTemplate() {
    const csv = 'address,amount\nTokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,100\nSo11111111111111111111111111111111111111112,250';
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: 'solana_bulk_template.csv',
    }).click();
  }

  const network = cfg?.network ?? 'devnet';
  const txsNeeded = preview?.valid ? Math.ceil(preview.valid / Math.min(batchSize, 15)) : 0;

  return (
    <div className="page">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-50">Solana Bulk Sender</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Transfer SPL tokens to many wallets</p>
        </div>
        <div className="flex items-center gap-2">
          {cfg && <span className={clsx(NETWORK_BADGE[network] ?? 'badge-gray')}>{NETWORK_LABEL[network] ?? network}</span>}
          <button onClick={downloadTemplate} className="btn-ghost text-xs px-3 py-2">
            <FileText className="h-4 w-4" /> Template
          </button>
        </div>
      </div>

      {/* Wallet card */}
      {cfg && (
        <div className="card">
          <div className="flex flex-wrap gap-4 items-center">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-brand-400 shrink-0" />
              <div>
                <p className="text-xs text-zinc-600">Bot wallet</p>
                <p className="font-mono text-xs text-zinc-300">
                  {cfg.walletAddress.slice(0, 12)}…{cfg.walletAddress.slice(-8)}
                </p>
              </div>
            </div>
            {[
              ['SOL balance', `${parseFloat(cfg.solBalance).toFixed(4)} SOL`],
              ['Batch size', `${cfg.defaultBatchSize} max 15`],
              ['Concurrency', `${cfg.concurrency} parallel`],
            ].map(([label, val]) => (
              <div key={label}>
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="text-sm font-semibold text-zinc-100">{val}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 1 — Mint + Upload */}
      <div className="card space-y-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">1. Token Mint</p>

        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Token Mint Address</label>
          <input className="input font-mono text-xs"
            placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            value={tokenMint} onChange={e => setTokenMint(e.target.value)} />
          <p className="text-xs text-zinc-600 mt-1">Enter mint before uploading CSV to auto-resolve decimals</p>
        </div>

        <div
          className="border-2 border-dashed border-zinc-800 hover:border-brand-500/40 rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f?.name.endsWith('.csv')) parseFile(f); else toast.error('Drop a CSV file'); }}>
          <Upload className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-400">{file ? file.name : 'Click or drag CSV here'}</p>
          <p className="text-xs text-zinc-600 mt-1">Columns: address, amount</p>
          <input ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
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
                ['Total amount',preview.decimals != null
                  ? parseFloat(preview.totalAmount).toLocaleString('en', { maximumFractionDigits: 4 })
                  : preview.totalAmount + ' (raw)',                    'text-zinc-100'],
              ].map(([label, value, color]) => (
                <div key={label as string} className="surface text-center">
                  <p className="text-xs text-zinc-600">{label}</p>
                  <p className={clsx('font-bold text-base mt-0.5', color)}>{value}</p>
                </div>
              ))}
            </div>

            {preview.decimals == null && (
              <div className="surface border border-blue-800/30 text-xs text-blue-300 flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                Mint not resolved — amounts are raw units. Enter the mint and re-upload to see formatted amounts.
              </div>
            )}

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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Batch Size (max 15)</label>
            <input type="number" className="input" min={1} max={15}
              value={batchSize} onChange={e => setBatchSize(Math.min(parseInt(e.target.value) || 10, 15))} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Priority Fee (µLamports)</label>
            <input type="number" className="input" min={0}
              value={priorityFee} onChange={e => setPriorityFee(parseInt(e.target.value) || 0)} />
          </div>
        </div>

        <div className="surface text-xs text-blue-300 flex items-start gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <p>ATAs are auto-created if missing. Each costs ~0.002 SOL rent. Make sure the bot wallet has enough SOL.</p>
        </div>

        {preview && preview.valid > 0 && (
          <div className="surface border border-amber-800/30 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
            <strong>{preview.valid}</strong> recipients → <strong>{txsNeeded}</strong> transaction{txsNeeded !== 1 ? 's' : ''}
          </div>
        )}

        <button onClick={handleSend}
          disabled={!preview || !preview.valid || sending || !tokenMint.trim()}
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
                  <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600 mt-1">
                    <span>{j.total_recipients} recipients</span>
                    <span className="text-brand-400">{j.recipients_sent} sent</span>
                    {j.atas_created > 0 && <span className="text-blue-400">+{j.atas_created} ATAs</span>}
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
              <p className="font-mono text-xs text-zinc-600 mt-0.5">{selectedJob.token_mint.slice(0, 16)}…</p>
            </div>
            <button onClick={() => setSelectedJob(null)} className="text-zinc-600 hover:text-zinc-200 text-lg leading-none">×</button>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4">
            {[
              ['Recipients',     selectedJob.total_recipients],
              ['Sent',           selectedJob.recipients_sent],
              ['ATAs created',   selectedJob.atas_created],
              ['Failed batches', selectedJob.failed_batches],
            ].map(([label, value]) => (
              <div key={label as string} className="surface text-center">
                <p className="text-xs text-zinc-600">{label}</p>
                <p className="font-semibold text-zinc-100 text-sm mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {selectedJob.batches?.map(b => (
              <div key={b.batchIndex} className="surface flex items-center gap-3 text-xs">
                {b.status === 'SUCCESS' && <CheckCircle className="h-4 w-4 text-brand-400 shrink-0" />}
                {b.status === 'FAILED'  && <XCircle    className="h-4 w-4 text-red-400   shrink-0" />}
                {b.status === 'PENDING' && <Clock      className="h-4 w-4 text-amber-400 shrink-0" />}
                <span className="text-zinc-500 shrink-0">Batch {b.batchIndex}</span>
                <span className="text-zinc-600 shrink-0">{b.recipient_count} recipients</span>
                {b.atas_created > 0 && <span className="text-blue-400 shrink-0">+{b.atas_created} ATAs</span>}
                {b.tx_signature && (
                  <a href={SOLSCAN(b.tx_signature, network)} target="_blank" rel="noreferrer"
                    className="text-brand-400 font-mono truncate flex-1 hover:underline flex items-center gap-1">
                    {b.tx_signature.slice(0, 20)}… <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}
                {b.error_message && <span className="text-red-400 ml-auto truncate max-w-xs">{b.error_message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
