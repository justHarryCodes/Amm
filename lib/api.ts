import axios from 'axios';

// Relative URLs — works in the browser and on the same Next.js origin
export const api = axios.create({ baseURL: '' });

// Session cookie is set by /api/auth/login and sent automatically by the browser.
// No API key injection needed — the httpOnly cookie handles browser auth.

// Extract the server's { error: "..." } body so callers see the real message, not "status 500".
api.interceptors.response.use(
  res => res,
  err => {
    const serverMsg = err?.response?.data?.error;
    if (serverMsg) err.message = serverMsg;
    return Promise.reject(err);
  }
);

// ── App Settings ───────────────────────────────────────
export const getAppSettings    = () => api.get('/api/settings').then(r => r.data);
export const updateAppSettings = (s: Record<string, string>) => api.put('/api/settings', s).then(r => r.data);

// ── Dashboard ──────────────────────────────────────────
export const getDashboard = () => api.get('/api/dashboard').then(r => r.data);

// ── Peg Maintainer ─────────────────────────────────────
export const getPegStatus    = (slot = 0) => api.get('/api/peg/status',   { params: { slot } }).then(r => r.data);
export const getPegConfig    = (slot = 0) => api.get('/api/peg/config',   { params: { slot } }).then(r => r.data);
export const updatePegConfig = (cfg: Record<string, number | string>, slot = 0) =>
  api.put('/api/peg/config', cfg, { params: { slot } }).then(r => r.data);
export const startBot    = (mode: string, slot = 0) =>
  api.post('/api/peg/start', { mode }, { params: { slot } }).then(r => r.data);
export const stopBot     = (slot = 0) => api.post('/api/peg/stop',   null, { params: { slot } }).then(r => r.data);
export const pauseBot    = (slot = 0) => api.post('/api/peg/pause',  null, { params: { slot } }).then(r => r.data);
export const resumeBot   = (slot = 0) => api.post('/api/peg/resume', null, { params: { slot } }).then(r => r.data);
export const getTradeHistory = (limit = 50, offset = 0, slot = 0) =>
  api.get('/api/peg/trades', { params: { limit, offset, slot } }).then(r => r.data);
export const getPriceHistory = (hours = 24) =>
  api.get('/api/peg/prices', { params: { hours } }).then(r => r.data);
export const getBotBalance   = ()         => api.get('/api/peg/balance').then(r => r.data);
export const findPegPair     = (slot = 0) => api.get('/api/peg/find-pair', { params: { slot } }).then(r => r.data);
export const initPool        = (tokenAmount: number, stableAmount: number) =>
  api.post('/api/peg/init-pool', { tokenAmount, stableAmount }).then(r => r.data);
export const getPegAllowances = ()        => api.get('/api/peg/allowances').then(r => r.data);
export const approveToken     = ()        => api.post('/api/peg/approve', { target: 'token'  }).then(r => r.data);
export const approveStable    = ()        => api.post('/api/peg/approve', { target: 'stable' }).then(r => r.data);

// ── Admin Wallets ───────────────────────────────────────
export const getAdminWallets   = ()                      => api.get('/api/admin/wallets').then(r => r.data);
export const addAdminWallet    = (address: string)       => api.post('/api/admin/wallets', { address }).then(r => r.data);
export const removeAdminWallet = (address: string)       => api.delete(`/api/admin/wallets/${encodeURIComponent(address)}`).then(r => r.data);

// ── Bulk Sender ────────────────────────────────────────
export const getBulkConfig     = ()          => api.get('/api/bulk/config').then(r => r.data);

export const uploadCsv = (file: File) => {
  const fd = new FormData(); fd.append('csv', file);
  return api.post('/api/bulk/upload', fd).then(r => r.data);
};

export const sendBulk = (file: File, tokenAddress: string, multiSenderAddress: string, batchSize: number, chain: 'bsc' | 'ethereum' = 'bsc') => {
  const fd = new FormData();
  fd.append('csv', file);
  fd.append('tokenAddress', tokenAddress);
  fd.append('multiSenderAddress', multiSenderAddress);
  fd.append('batchSize', String(batchSize));
  fd.append('chain', chain);
  return api.post('/api/bulk/send', fd).then(r => r.data);
};

export const getBulkJobs       = ()       => api.get('/api/bulk/jobs').then(r => r.data);
export const getBulkJobStatus  = (id: number) => api.get(`/api/bulk/jobs/${id}`).then(r => r.data);
export const exportBulkJob     = (id: number) =>
  api.get(`/api/bulk/jobs/${id}/export`, { responseType: 'blob' }).then(r => r.data);

// ── Solana Bulk Sender ──────────────────────────────────
export const getSolanaConfig = () => api.get('/api/solana/bulk/config').then(r => r.data);

export const uploadSolanaCsv = (file: File, tokenMint?: string) => {
  const fd = new FormData();
  fd.append('csv', file);
  if (tokenMint) fd.append('tokenMint', tokenMint);
  return api.post('/api/solana/bulk/upload', fd).then(r => r.data);
};

export const sendSolanaBulk = (file: File, tokenMint: string, batchSize: number, priorityFee?: number) => {
  const fd = new FormData();
  fd.append('csv', file);
  fd.append('tokenMint', tokenMint);
  fd.append('batchSize', String(batchSize));
  if (priorityFee !== undefined) fd.append('priorityFee', String(priorityFee));
  return api.post('/api/solana/bulk/send', fd).then(r => r.data);
};

export const getSolanaJobs      = ()           => api.get('/api/solana/bulk/jobs').then(r => r.data);
export const getSolanaJobStatus = (id: number) => api.get(`/api/solana/bulk/jobs/${id}`).then(r => r.data);
export const exportSolanaJob    = (id: number) =>
  api.get(`/api/solana/bulk/jobs/${id}/export`, { responseType: 'blob' }).then(r => r.data);
