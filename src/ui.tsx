import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Settings,
  PluginMessage,
  RawCollection,
  TokenFile,
  SetVariablesResult,
  OAuthStatus,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { GitHubProvider } from './lib/github';
import { GitLabProvider } from './lib/gitlab';
import { collectionsToTokenFiles, tokenFilesToCollections } from './lib/tokens';
import type { GitProvider } from './lib/provider';
import { GITHUB_CLIENT_ID, requestDeviceCode, pollForToken } from './lib/github-oauth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildProvider(s: Settings): GitProvider {
  if (s.provider === 'gitlab') return new GitLabProvider(s.token, s.owner, s.repo, s.branch);
  return new GitHubProvider(s.token, s.owner, s.repo, s.branch);
}

function normaliseTokensPath(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, ...rest] = fullName.split('/');
  return { owner, repo: rest.join('/') };
}

function formatCountdown(expiresAt: number): string {
  const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DotState = 'idle' | 'working' | 'ok' | 'error';

interface LogLine {
  text: string;
  kind: 'info' | 'ok' | 'error';
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<'sync' | 'settings'>('settings');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dot, setDot] = useState<DotState>('idle');
  const [statusText, setStatusText] = useState('Ready');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Settings-tab state ──
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>({ kind: 'idle' });
  const [showPat, setShowPat] = useState(false);       // fallback PAT input toggle
  const [patValue, setPatValue] = useState('');
  const [patValidating, setPatValidating] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [repoFullName, setRepoFullName] = useState('');

  // Countdown ticker for device flow
  const [, setTick] = useState(0);
  const oauthAbortRef = useRef<AbortController | null>(null);

  // ── Communication with code.ts ──
  const postMsg = useCallback((msg: PluginMessage) => {
    parent.postMessage({ pluginMessage: msg }, '*');
  }, []);

  useEffect(() => {
    postMsg({ type: 'GET_SETTINGS' });
    const handler = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as PluginMessage | undefined;
      if (!msg) return;
      handlePluginMessage(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown ticker — only runs during device flow pending state
  useEffect(() => {
    if (oauthStatus.kind !== 'pending') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [oauthStatus.kind]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs((prev) => [...prev, { text, kind }]);
  }, []);

  const setStatus = useCallback((text: string, state: DotState) => {
    setStatusText(text);
    setDot(state);
  }, []);

  const variablesResolver = useRef<((c: RawCollection[]) => void) | null>(null);
  const setVarsResolver = useRef<((r: SetVariablesResult) => void) | null>(null);

  function handlePluginMessage(msg: PluginMessage) {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        if (msg.payload) {
          const s = msg.payload as Settings;
          setSettings(s);
          if (s.owner && s.repo) setRepoFullName(`${s.owner}/${s.repo}`);
          if (s.token && s.connectedLogin) {
            setOauthStatus({ kind: 'idle' }); // already connected
          }
          if (s.token && s.owner && s.repo && s.branch) setTab('sync');
        }
        break;
      case 'VARIABLES_DATA':
        variablesResolver.current?.(msg.payload as RawCollection[]);
        variablesResolver.current = null;
        break;
      case 'SET_VARIABLES_RESULT':
        setVarsResolver.current?.(msg.payload as SetVariablesResult);
        setVarsResolver.current = null;
        break;
      case 'ERROR':
        addLog(String(msg.payload), 'error');
        setStatus(String(msg.payload), 'error');
        setBusy(false);
        break;
    }
  }

  function getVariables(): Promise<RawCollection[]> {
    return new Promise((resolve) => {
      variablesResolver.current = resolve;
      postMsg({ type: 'GET_VARIABLES' });
    });
  }

  function applyVariables(collections: RawCollection[]): Promise<SetVariablesResult> {
    return new Promise((resolve) => {
      setVarsResolver.current = resolve;
      postMsg({ type: 'SET_VARIABLES', payload: collections });
    });
  }

  // ── GitHub Device Flow ──
  async function handleConnectGitHub() {
    setOauthStatus({ kind: 'requesting' });
    try {
      const result = await requestDeviceCode();
      const expiresAt = Date.now() + result.expiresIn * 1000;
      setOauthStatus({ kind: 'pending', userCode: result.userCode, verificationUri: result.verificationUri, expiresAt });

      const abort = new AbortController();
      oauthAbortRef.current = abort;

      setOauthStatus((prev) => prev.kind === 'pending' ? { ...prev } : prev);

      // Start polling in the background
      pollForToken(result.deviceCode, result.interval, abort.signal)
        .then(async ({ token }) => {
          await onTokenReceived(token);
        })
        .catch((e: Error) => {
          if (e.message !== 'Cancelled') {
            setOauthStatus({ kind: 'error', message: e.message });
          } else {
            setOauthStatus({ kind: 'idle' });
          }
        });
    } catch (e) {
      setOauthStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Connection failed' });
    }
  }

  function handleCancelOAuth() {
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = null;
    setOauthStatus({ kind: 'idle' });
  }

  async function onTokenReceived(token: string) {
    setOauthStatus({ kind: 'polling' });
    try {
      const provider = new GitHubProvider(token, '', '', '');
      const { login } = await provider.validateToken();
      const updated = { ...settings, token, connectedLogin: login };
      setSettings(updated);
      postMsg({ type: 'SAVE_SETTINGS', payload: updated });
      setOauthStatus({ kind: 'idle' });
      setStatus(`Connected as ${login}`, 'ok');
      await loadRepos(token, updated.provider);
    } catch (e) {
      setOauthStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to verify token' });
    }
  }

  function handleDisconnect() {
    const updated = { ...settings, token: '', connectedLogin: '', owner: '', repo: '', branch: 'main' };
    setSettings(updated);
    setRepoFullName('');
    setRepos([]);
    setBranches([]);
    postMsg({ type: 'SAVE_SETTINGS', payload: updated });
    setOauthStatus({ kind: 'idle' });
    setShowPat(false);
    setPatValue('');
    setStatus('Disconnected', 'idle');
  }

  // ── PAT fallback ──
  async function handleConnectPat() {
    if (!patValue) return;
    setPatValidating(true);
    try {
      const provider = settings.provider === 'gitlab'
        ? new GitLabProvider(patValue, '', '', '')
        : new GitHubProvider(patValue, '', '', '');
      const { login } = await provider.validateToken();
      await onTokenReceived(patValue);
      setShowPat(false);
      setStatus(`Connected as ${login}`, 'ok');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Token rejected', 'error');
    } finally {
      setPatValidating(false);
    }
  }

  // ── Repo / branch loading ──
  async function loadRepos(token: string, provider: Settings['provider']) {
    setReposLoading(true);
    try {
      const p = provider === 'gitlab'
        ? new GitLabProvider(token, '', '', '')
        : new GitHubProvider(token, '', '', '');
      const list = await p.listRepos();
      setRepos(list);
    } catch { /* ignore */ } finally {
      setReposLoading(false);
    }
  }

  async function handleRepoChange(fullName: string) {
    setRepoFullName(fullName);
    const { owner, repo } = splitFullName(fullName);
    setSettings((prev) => ({ ...prev, owner, repo, branch: '' }));
    setBranches([]);
    if (!owner || !repo) return;
    setBranchesLoading(true);
    try {
      const p = settings.provider === 'gitlab'
        ? new GitLabProvider(settings.token, owner, repo, '')
        : new GitHubProvider(settings.token, owner, repo, '');
      const list = await p.listBranches(owner, repo);
      setBranches(list);
      if (list.length > 0) setSettings((prev) => ({ ...prev, branch: list[0] }));
    } catch { /* ignore */ } finally {
      setBranchesLoading(false);
    }
  }

  // ── Push ──
  async function handlePush() {
    if (!validateSettings()) return;
    setBusy(true);
    setLogs([]);
    setStatus('Reading Figma variables…', 'working');
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const created = await provider.ensureBranch(settings.owner, settings.repo, settings.branch);
      if (created) addLog(`Created branch "${settings.branch}" from default branch`, 'ok');
      const collections = await getVariables();
      addLog(`Found ${collections.length} collection(s)`);
      const tokenFiles = collectionsToTokenFiles(collections);
      for (const { fileName, content } of Object.values(tokenFiles)) {
        const filePath = basePath + fileName;
        setStatus(`Pushing ${fileName}…`, 'working');
        addLog(`→ ${filePath}`);
        const existing = await provider.getFile(filePath);
        await provider.putFile(filePath, JSON.stringify(content, null, 2), `chore: sync tokens from Figma (${fileName})`, existing?.sha);
        addLog(`✓ ${fileName} pushed`, 'ok');
      }
      setStatus(`Pushed ${Object.keys(tokenFiles).length} file(s)`, 'ok');
      addLog('Done!', 'ok');
    } catch (e) {
      addLog(e instanceof Error ? e.message : String(e), 'error');
      setStatus('Push failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Pull ──
  async function handlePull() {
    if (!validateSettings()) return;
    setBusy(true);
    setLogs([]);
    setStatus('Listing token files…', 'working');
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const files = await provider.listFiles(basePath);
      if (files.length === 0) {
        addLog('No JSON files found at the tokens path.', 'error');
        setStatus('No files found', 'error');
        setBusy(false);
        return;
      }
      addLog(`Found ${files.length} file(s)`);
      const tokenFiles: Record<string, TokenFile> = {};
      for (const f of files) {
        setStatus(`Downloading ${f.name}…`, 'working');
        addLog(`← ${f.path}`);
        const fc = await provider.getFile(f.path);
        if (!fc) { addLog(`  ✗ ${f.name} not found — skipped`, 'error'); continue; }
        try {
          tokenFiles[f.name] = JSON.parse(fc.content) as TokenFile;
          addLog(`✓ ${f.name} downloaded`, 'ok');
        } catch {
          addLog(`  ✗ ${f.name} is not valid JSON — skipped`, 'error');
        }
      }
      setStatus('Applying to Figma…', 'working');
      const collections = tokenFilesToCollections(tokenFiles);
      const result = await applyVariables(collections);
      addLog(`Created ${result.created} variable(s), updated ${result.updated}`, 'ok');
      result.errors.forEach((e) => addLog(`  ⚠ ${e}`, 'error'));
      setStatus(`Applied ${result.created + result.updated} variable(s)`, 'ok');
      addLog('Done!', 'ok');
    } catch (e) {
      addLog(e instanceof Error ? e.message : String(e), 'error');
      setStatus('Pull failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function validateSettings(): boolean {
    const problems = [
      !settings.token  && 'Not connected to a repository',
      !settings.owner  && 'Repository is required',
      !settings.repo   && 'Repository is required',
      !settings.branch && 'Branch is required',
    ].filter(Boolean) as string[];
    if (problems.length) {
      problems.forEach((p) => addLog(p, 'error'));
      setStatus(problems[0], 'error');
      return false;
    }
    return true;
  }

  function saveSettings() {
    postMsg({ type: 'SAVE_SETTINGS', payload: settings });
    setStatus('Settings saved', 'ok');
    if (settings.token && settings.owner && settings.repo && settings.branch) setTab('sync');
  }

  const isConnected = !!settings.token && !!settings.connectedLogin;
  const oauthAppConfigured = GITHUB_CLIENT_ID !== 'YOUR_OAUTH_APP_CLIENT_ID';
  const providerLabel = settings.provider === 'gitlab' ? 'GitLab' : 'GitHub';

  // ── Render ──
  return (
    <>
      <div className="status-bar">
        <div className={`dot ${dot}`} />
        <span className="status-text">{statusText}</span>
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'sync' ? ' active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
        <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>

      {/* ── Sync tab ── */}
      {tab === 'sync' && (
        <div className="panel">
          {!isConnected && (
            <div className="notice">
              Connect your repository in <strong>Settings</strong> before syncing.
            </div>
          )}
          <div className="sync-card">
            <h3>↑ Push to {providerLabel}</h3>
            <p>Export all Figma variable collections as W3C design token JSON files.</p>
            <button className="btn btn-primary" disabled={busy} onClick={handlePush}>
              {busy ? 'Working…' : 'Push tokens'}
            </button>
          </div>
          <div className="sync-card">
            <h3>↓ Pull from {providerLabel}</h3>
            <p>Import W3C design token JSON files and create/update Figma variables.</p>
            <button className="btn btn-secondary" disabled={busy} onClick={handlePull}>
              {busy ? 'Working…' : 'Pull tokens'}
            </button>
          </div>
          {logs.length > 0 && (
            <div className="log-area" ref={logRef}>
              {logs.map((l, i) => (
                <div key={i} className={l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : ''}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Settings tab ── */}
      {tab === 'settings' && (
        <div className="panel">
          {!isConnected && (
            <div className="onboarding-header">
              <strong>Welcome!</strong> Connect your {providerLabel} account below to start syncing Figma variables as W3C design tokens.
            </div>
          )}

          <div className="section-title">Provider</div>
          <div className="field">
            <label>Git Provider</label>
            <select
              value={settings.provider}
              onChange={(e) => {
                const p = e.target.value as Settings['provider'];
                setSettings((prev) => ({ ...prev, provider: p }));
                setRepos([]);
                setBranches([]);
              }}
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </div>

          <hr className="divider" />
          <div className="section-title">Authentication</div>

          {/* ── Connected state ── */}
          {isConnected ? (
            <div className="connected-card">
              <div className="connected-avatar">
                {settings.connectedLogin.charAt(0).toUpperCase()}
              </div>
              <div className="connected-info">
                <div className="connected-name">@{settings.connectedLogin}</div>
                <div className="connected-sub">Connected to {providerLabel}</div>
              </div>
              <button className="btn btn-danger-ghost" onClick={handleDisconnect}>
                Disconnect
              </button>
            </div>
          ) : (
            <>
              {/* ── Device Flow (GitHub only) ── */}
              {settings.provider === 'github' && !showPat && (
                <>
                  {oauthStatus.kind === 'idle' && (
                    <button
                      className="btn btn-github"
                      onClick={handleConnectGitHub}
                      disabled={!oauthAppConfigured}
                    >
                      <GithubIcon />
                      {oauthAppConfigured ? 'Sign in with GitHub' : 'OAuth App not configured'}
                    </button>
                  )}

                  {oauthStatus.kind === 'requesting' && (
                    <div className="oauth-waiting">Requesting code from GitHub…</div>
                  )}

                  {oauthStatus.kind === 'pending' && (
                    <div className="device-flow-card">
                      <p className="device-flow-label">Open GitHub and enter this code:</p>
                      <div className="device-code">{oauthStatus.userCode}</div>
                      <div className="device-flow-actions">
                        <a
                          className="btn btn-primary"
                          href={oauthStatus.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open GitHub ↗
                        </a>
                        <button className="btn btn-secondary" onClick={handleCancelOAuth}>
                          Cancel
                        </button>
                      </div>
                      <div className="device-flow-footer">
                        <span className="pulse-dot" /> Waiting for approval…
                        <span className="device-flow-countdown">
                          {formatCountdown(oauthStatus.expiresAt)}
                        </span>
                      </div>
                    </div>
                  )}

                  {oauthStatus.kind === 'polling' && (
                    <div className="oauth-waiting">Verifying…</div>
                  )}

                  {oauthStatus.kind === 'error' && (
                    <div className="oauth-error">
                      ✗ {oauthStatus.message}
                      <button className="btn-link" onClick={() => setOauthStatus({ kind: 'idle' })}>Try again</button>
                    </div>
                  )}

                  {!oauthAppConfigured && (
                    <div className="hint">See the README to register a GitHub OAuth App.</div>
                  )}

                  {oauthStatus.kind === 'idle' && (
                    <button className="btn-link pat-toggle" onClick={() => setShowPat(true)}>
                      Use a personal access token instead
                    </button>
                  )}
                </>
              )}

              {/* ── PAT input (GitLab always, GitHub fallback) ── */}
              {(settings.provider === 'gitlab' || showPat) && (
                <div className="field">
                  {showPat && (
                    <button className="btn-link pat-toggle" onClick={() => setShowPat(false)} style={{ marginBottom: 8 }}>
                      ← Back to Sign in with GitHub
                    </button>
                  )}
                  <label>Personal Access Token</label>
                  <div className="input-row">
                    <input
                      type="password"
                      placeholder={settings.provider === 'github' ? 'github_pat_…' : 'glpat-…'}
                      value={patValue}
                      onChange={(e) => setPatValue(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleConnectPat()}
                    />
                    <button
                      className="btn btn-secondary btn-inline"
                      onClick={handleConnectPat}
                      disabled={!patValue || patValidating}
                    >
                      {patValidating ? '…' : 'Connect'}
                    </button>
                  </div>
                  <div className="hint">
                    Needs <strong>{settings.provider === 'github' ? 'Contents: Read & Write' : 'api'}</strong> scope.
                    Token is stored locally in Figma only.
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Repo + branch (only shown once connected) ── */}
          {isConnected && (
            <>
              <hr className="divider" />
              <div className="section-title">Repository</div>

              <div className="field">
                <label>
                  Repository {reposLoading && <span className="loading-label">Loading…</span>}
                </label>
                {repos.length > 0 ? (
                  <select value={repoFullName} onChange={(e) => handleRepoChange(e.target.value)}>
                    <option value="">— select a repository —</option>
                    {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="owner/repo-name"
                    value={repoFullName}
                    onChange={(e) => handleRepoChange(e.target.value)}
                  />
                )}
              </div>

              <div className="field">
                <label>
                  Branch {branchesLoading && <span className="loading-label">Loading…</span>}
                </label>
                <input
                  list="branch-datalist"
                  placeholder="main"
                  value={settings.branch}
                  onChange={(e) => setSettings((prev) => ({ ...prev, branch: e.target.value }))}
                />
                <datalist id="branch-datalist">
                  {branches.map((b) => <option key={b} value={b} />)}
                </datalist>
                {settings.branch && !branches.includes(settings.branch) && branches.length > 0 && (
                  <div className="hint ok">✓ "{settings.branch}" will be created on first push</div>
                )}
              </div>

              <div className="field">
                <label>Tokens path</label>
                <input
                  type="text"
                  placeholder="tokens/"
                  value={settings.tokensPath}
                  onChange={(e) => setSettings((prev) => ({ ...prev, tokensPath: e.target.value }))}
                />
                <div className="hint">Directory where token JSON files are stored.</div>
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={saveSettings}>
                  Save settings
                </button>
              </div>
            </>
          )}

          <div className="persist-note">
            Settings are saved locally in Figma — you won't need to sign in again.
          </div>
        </div>
      )}
    </>
  );
}

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
