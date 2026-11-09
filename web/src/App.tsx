import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { api, getSession, type Session } from './api';
import { EmptyState, EnvironmentBadge, Loading, Notice, operatorIdentity } from './components';
import { BrandMark, Icon } from './icons';
import { QueuePage } from './pages/Queue';
import { DisputeDetailPage } from './pages/DisputeDetail';
import { AuditPage, SettingsPage } from './pages/Other';

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card login stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.login(pw);
          onDone();
        } catch {
          setErr('That password is incorrect.');
        }
      }}
    >
      <div className="row">
        <BrandMark size={36} />
        <div>
          <h1 style={{ fontSize: 20 }}>Sign in to DisputeDesk</h1>
          <p className="muted small">Enter the workspace access password.</p>
        </div>
      </div>
      <label className="field">
        Password
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </label>
      {err && <Notice tone="danger">{err}</Notice>}
      <button className="btn btn-primary" type="submit">
        Sign in
      </button>
    </form>
  );
}

function Header({ session }: { session: Session }) {
  const who = operatorIdentity(session.operator);
  return (
    <header className="app-header">
      <div className="header-inner">
        <Link to="/" className="brand" aria-label="DisputeDesk home">
          <BrandMark />
          <span className="brand-name">DisputeDesk</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            <Icon name="inbox" size={15} />
            Disputes
          </NavLink>
          <NavLink to="/audit">
            <Icon name="list" size={15} />
            Audit log
          </NavLink>
          <NavLink to="/settings">
            <Icon name="layers" size={15} />
            Settings
          </NavLink>
        </nav>
        <div className="header-right">
          <EnvironmentBadge mode={session.mode} />
          <span className="vr" aria-hidden="true" />
          <span className="user-chip" title={`Signed in as ${who.name}`}>
            <span className="avatar" aria-hidden="true">
              {who.initials}
            </span>
            <span className="name">{who.name}</span>
          </span>
        </div>
      </div>
    </header>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getSession()
      .then(setSession)
      .catch(() => setError('The DisputeDesk service is not reachable. Check that the server is running and reload.'));
  useEffect(() => void load(), []);

  if (error) {
    return (
      <main className="page">
        <Notice tone="danger" title="Service unavailable">
          {error}
        </Notice>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="page">
        <Loading />
      </main>
    );
  }

  return (
    <BrowserRouter>
      <Header session={session} />
      <main className="page">
        {session.authRequired && !session.authenticated ? (
          <Login onDone={() => void load()} />
        ) : (
          <Routes>
            <Route path="/" element={<QueuePage />} />
            <Route path="/disputes/:id" element={<DisputeDetailPage mode={session.mode} />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <div className="card">
                  <EmptyState icon="search" title="Page not found">
                    <Link to="/">Return to disputes</Link>
                  </EmptyState>
                </div>
              }
            />
          </Routes>
        )}
      </main>
    </BrowserRouter>
  );
}
