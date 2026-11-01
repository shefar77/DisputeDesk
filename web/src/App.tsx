import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, Link } from 'react-router-dom';
import { api, getSession, type Session } from './api';
import { Alert, SandboxBanner } from './components';
import { QueuePage } from './pages/Queue';
import { DisputeDetailPage } from './pages/DisputeDetail';
import { AuditPage, SettingsPage } from './pages/Other';

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card card-b login stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.login(pw);
          onDone();
        } catch {
          setErr('Incorrect password.');
        }
      }}
    >
      <h1>DisputeDesk</h1>
      <p className="muted" style={{ margin: 0 }}>Enter the demo password from the README.</p>
      <label className="field">Password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
      {err && <Alert tone="danger">{err}</Alert>}
      <button className="btn primary" type="submit">Sign in</button>
    </form>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => getSession().then(setSession).catch(() => setError('Cannot reach the DisputeDesk API. Is the server running?'));
  useEffect(() => void load(), []);

  if (error) return <main className="page"><Alert tone="danger">{error}</Alert></main>;
  if (!session) return <main className="page muted row"><span className="spinner" /> Loading…</main>;

  return (
    <BrowserRouter>
      <SandboxBanner mode={session.mode} />
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">D</span>DisputeDesk</Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Queue</NavLink>
          <NavLink to="/audit">Audit log</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <span className="mode-pill">{session.mode === 'demo' ? 'Demo · fixtures' : 'PayPal sandbox'}</span>
        <span className="small" style={{ opacity: 0.8 }}>{session.operator}</span>
      </header>
      <main className="page">
        {session.authRequired && !session.authenticated ? (
          <Login onDone={() => void load()} />
        ) : (
          <Routes>
            <Route path="/" element={<QueuePage />} />
            <Route path="/disputes/:id" element={<DisputeDetailPage mode={session.mode} />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Alert tone="warn">Page not found. <Link to="/">Back to the queue</Link>.</Alert>} />
          </Routes>
        )}
      </main>
    </BrowserRouter>
  );
}
