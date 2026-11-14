import React from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation, useSearchParams } from "react-router-dom";

const API_BASE = "http://localhost:4000";

class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function endSession() {
  localStorage.clear();
  window.location.replace("/");
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem("token");
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function fetchWithTimeout(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(API_BASE + path, { ...init, signal: controller.signal }).finally(() => window.clearTimeout(timer));
}

async function apiGet<T = any>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(path, { headers: authHeaders() });
  } catch {
    throw new ApiError("The server is taking too long to respond. Please try again.", 0, null);
  }
  const data = await readJson(res);
  if (res.status === 401) {
    endSession();
    throw new ApiError("Your session has expired. Please sign in again.", res.status, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (HTTP ${res.status}).`, res.status, data);
  return data as T;
}

async function apiSend<T = any>(path: string, method: string, body?: any): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(path, {
      method,
      headers: authHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The server is taking too long to respond. Please try again.", 0, null);
  }
  const data = await readJson(res);
  if (res.status === 401) {
    endSession();
    throw new ApiError("Your session has expired. Please sign in again.", res.status, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (HTTP ${res.status}).`, res.status, data);
  return data as T;
}

// Public services are shared by the catalog and booking pages; cache them briefly
// so navigating between the two never re-fetches or flashes empty content.
let servicesCache: { data: any[]; at: number } | null = null;
async function fetchServices(force = false): Promise<any[]> {
  if (!force && servicesCache && Date.now() - servicesCache.at < 60000) return servicesCache.data;
  const data: any = await apiGet("/api/public/services");
  const list: any[] = Array.isArray(data) ? data : data?.value ?? [];
  servicesCache = { data: list, at: Date.now() };
  return list;
}

function portalForRole(role: string) {
  if (role === "MANAGER") return "/manager";
  if (role === "RESERVATION_OFFICER") return "/officer";
  if (role === "CLIENT") return "/client";
  return "/";
}

function roleLabel(role?: string) {
  if (role === "MANAGER") return "Manager";
  if (role === "RESERVATION_OFFICER") return "Reservation Officer";
  if (role === "CLIENT") return "Client";
  return role || "User";
}

function readStoredUser(): any | null {
  try {
    const token = localStorage.getItem("token");
    const raw = localStorage.getItem("user");
    if (!token || !raw) return null;

    const [header, payloadPart] = token.split(".");
    if (!header || !payloadPart) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      return null;
    }
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    if (payload.exp && payload.exp * 1000 <= Date.now()) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      return null;
    }

    const parsed = JSON.parse(raw);
    return parsed?.role ? parsed : null;
  } catch {
    return null;
  }
}

function money(value: any) {
  return "KES " + Number(value || 0).toLocaleString();
}

function dateInput(value: any) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function displayDate(value: any) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function shortRef(value: any) {
  const text = String(value || "");
  if (!text) return "—";
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function reservationRef(reservation: any) {
  return reservation?.confirmation?.confirmationCode || shortRef(reservation?.id);
}

function nightsBetween(checkIn: string, checkOut: string) {
  const start = new Date(checkIn).getTime();
  const end = new Date(checkOut).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 1;
  return Math.max(1, Math.ceil((end - start) / 86400000));
}

function computeTotal(service: any, checkIn: string, checkOut: string, guests: number) {
  if (!service || !checkIn || !checkOut) return 0;
  if (service.serviceType === "ACCOMMODATION") return Math.round(service.pricePerUnit * nightsBetween(checkIn, checkOut));
  if (service.serviceType === "TOUR") return Math.round(service.pricePerUnit * Math.max(1, Number(guests) || 1));
  return Math.round(service.pricePerUnit);
}

function serviceUnit(service: any) {
  if (!service) return "";
  if (service.serviceType === "ACCOMMODATION") return "night";
  if (service.serviceType === "TOUR") return "guest";
  return "booking";
}

const BADGE_TONES: Record<string, [string, string]> = {
  CONFIRMED: ["#dcfce7", "#166534"],
  PENDING: ["#fef3c7", "#92400e"],
  CANCELLED: ["#f1f5f9", "#475569"],
  FLAGGED_DUPLICATE: ["#fee2e2", "#991b1b"],
  SYNCED: ["#dcfce7", "#166534"],
  PENDING_RETRY: ["#fef3c7", "#92400e"],
  FAILED: ["#fee2e2", "#991b1b"],
  SENT: ["#dcfce7", "#166534"],
  ACTIVE: ["#dcfce7", "#166534"],
  INACTIVE: ["#f1f5f9", "#475569"],
  MANAGER: ["#dbeafe", "#1e40af"],
  RESERVATION_OFFICER: ["#e0e7ff", "#3730a3"],
  CLIENT: ["#e0f2fe", "#075985"],
  COMPLETED: ["#dcfce7", "#166534"],
};

function Badge({ value }: { value: string }) {
  const tone = BADGE_TONES[value] || ["#f1f5f9", "#475569"];
  return <span className="badge" style={{ background: tone[0], color: tone[1] }}>{value.replace(/_/g, " ")}</span>;
}

function Alert({ tone, children, onClose }: { tone: "error" | "success" | "info"; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onClose && <button type="button" className="alert-close" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, width = 560 }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="portal-modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="portal-modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-labelledby="portal-modal-title">
        <div className="portal-modal-head">
          <div>
            <h2 id="portal-modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <label className="portal-field">
      <span className="portal-field-label">{label}{required && <span style={{ color: "#DC2626" }}> *</span>}</span>
      {children}
      {hint && <span className="portal-field-hint">{hint}</span>}
    </label>
  );
}

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

function Layout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = readStoredUser();
  const links = user?.role === "MANAGER"
    ? [
        { to: "/manager", label: "Dashboard" },
        { to: "/manager/users", label: "Users" },
        { to: "/manager/reports", label: "Reports" },
        { to: "/manager/audit", label: "Audit Trail" },
      ]
    : user?.role === "RESERVATION_OFFICER"
      ? [
          { to: "/officer", label: "Reservations" },
          { to: "/officer/sync", label: "Sync Log" },
          { to: "/officer/confirmations", label: "Confirmations" },
        ]
      : user?.role === "CLIENT"
        ? [
            { to: "/client", label: "My Bookings" },
            { to: "/client/confirmations", label: "Confirmations" },
          ]
        : [];

  return (
    <div className="portal-shell">
      <header className="portal-nav">
        <div className="portal-nav-inner">
          <Link to={user?.role ? portalForRole(user.role) : "/"} className="portal-brand">
            <span className="portal-brand-mark">Boma</span>
            <span className="portal-brand-sub">Reservation Management</span>
          </Link>
          <nav className="portal-links" aria-label="Main navigation">
            {links.map(link => (
              <Link
                key={link.to}
                to={link.to}
                className={`portal-link${location.pathname === link.to ? " active" : ""}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="portal-user">
            {user && (
              <div className="portal-user-meta">
                <strong>{user.fullName}</strong>
                <span>{roleLabel(user.role)}</span>
              </div>
            )}
            <button
              type="button"
              className="btn btn-ghost-light"
              onClick={() => { localStorage.clear(); navigate("/"); }}
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      <main className="portal-main">
        <div className="portal-heading">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
      </main>
      <footer className="portal-footer">© {new Date().getFullYear()} Boma · Online Reservation Management System</footer>
    </div>
  );
}

function PublicLayout({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  const location = useLocation();
  const user = readStoredUser();
  const links = [
    { to: "/catalog", label: "Catalog" },
    { to: "/book", label: "Book now" },
    user ? { to: portalForRole(user.role), label: "My account" } : { to: "/register", label: "Create account" },
  ];

  return (
    <div className="portal-shell">
      <header className="portal-nav">
        <div className="portal-nav-inner">
          <Link to="/catalog" className="portal-brand">
            <span className="portal-brand-mark">Boma</span>
            <span className="portal-brand-sub">Online Reservation</span>
          </Link>
          <nav className="portal-links" aria-label="Public navigation">
            {links.map(link => (
              <Link
                key={link.to}
                to={link.to}
                className={`portal-link${location.pathname === link.to ? " active" : ""}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="portal-user">
            {user && (
              <div className="portal-user-meta">
                <strong>{user.fullName}</strong>
                <span>{roleLabel(user.role)}</span>
              </div>
            )}
            {user ? (
              <Link to={portalForRole(user.role)} className="btn btn-ghost-light">Go to portal</Link>
            ) : (
              <Link to="/" className="btn btn-ghost-light">Sign in</Link>
            )}
          </div>
        </div>
      </header>
      <main className="portal-main">
        {title && (
          <div className="portal-heading">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
        )}
        {children}
      </main>
      <footer className="portal-footer">© {new Date().getFullYear()} Boma · Online Reservation Management System</footer>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C37 41.2 44 36 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}

type LoginToast = { id: number; type: "error" | "success"; message: string };

function Login() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);
  const [failedAttempts, setFailedAttempts] = React.useState(0);
  const [locked, setLocked] = React.useState(false);
  const [toasts, setToasts] = React.useState<LoginToast[]>([]);
  const [modal, setModal] = React.useState<{ title: string; message: string } | null>(null);
  const toastId = React.useRef(0);
  const navigate = useNavigate();

  const pushToast = (type: "error" | "success", message: string) => {
    const id = ++toastId.current;
    setToasts(list => [...list, { id, type, message }]);
    window.setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 5500);
  };
  const openModal = (title: string, message: string) => setModal({ title, message });
  const disabled = loading || cooldown > 0 || locked;

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(c => (c <= 1 ? 0 : c - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  React.useEffect(() => {
    if (cooldown === 0 && failedAttempts >= 3) setFailedAttempts(0);
  }, [cooldown, failedAttempts]);

  React.useEffect(() => {
    if (!modal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modal]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    if (!email.trim() || !password) {
      pushToast("error", "Please enter both your email and password.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetchWithTimeout("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.token) {
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));
        navigate(portalForRole(data.user.role), { replace: true });
        return;
      }

      if (res.status === 423) {
        setLocked(true);
        openModal(
          "Account temporarily locked",
          data.error || "Too many failed sign-in attempts. Please wait before trying again or contact the system administrator."
        );
        return;
      }

      if (res.status === 429) {
        setCooldown(60);
        pushToast("error", data.error || "Too many attempts. Please wait 60 seconds and try again.");
        return;
      }

      if (res.status === 401) {
        const next = failedAttempts + 1;
        setFailedAttempts(next);
        if (next >= 3) {
          setCooldown(60);
          pushToast("error", "Too many failed attempts. Sign-in is paused for 60 seconds.");
        } else {
          pushToast("error", data.error || "Invalid email or password. Please try again.");
        }
        return;
      }

      pushToast("error", data.error || `Sign-in failed (HTTP ${res.status}). Please try again.`);
    } catch {
      pushToast("error", "Cannot reach the server. Make sure the Boma backend is running on http://localhost:4000.");
    } finally {
      setLoading(false);
    }
  }

  function handleGoogle() {
    if (googleLoading || disabled) return;
    setGoogleLoading(true);
    window.setTimeout(() => {
      setGoogleLoading(false);
      pushToast("error", "Google sign-in is not configured for this system. Please use your Boma email and password.");
    }, 1400);
  }

  function openPolicy(name: string) {
    openModal(name, `The ${name} page is not included in this system. For data requests, contact admin@Boma.local.`);
  }

  const primaryText = loading
    ? "Signing in..."
    : cooldown > 0
      ? `Try again in ${cooldown}s`
      : locked
        ? "Account locked"
        : "Sign in";

  return (
    <div className="Boma-login-page">
      <style>{`
        html, body, #root { min-height: 100%; margin: 0; padding: 0; }
        .Boma-login-page, .Boma-login-page * { box-sizing: border-box; }
        .Boma-login-page {
          min-height: 100vh;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 48px 16px;
          background:
            radial-gradient(1100px 650px at 18% 8%, rgba(37, 99, 235, 0.10), transparent 60%),
            radial-gradient(900px 600px at 88% 92%, rgba(30, 64, 175, 0.12), transparent 55%),
            linear-gradient(160deg, #0F172A 0%, #111C2E 52%, #0B1220 100%);
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .Boma-login-column { width: 100%; max-width: 448px; display: flex; flex-direction: column; gap: 24px; }
        .Boma-login-card {
          width: 100%;
          max-width: 448px;
          background: #FFFFFF;
          border-radius: 14px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.55);
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .Boma-login-form { display: flex; flex-direction: column; gap: 16px; }
        .Boma-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #475569;
          margin-bottom: 6px;
        }
        .Boma-input {
          width: 100%;
          background: #FFFFFF;
          color: #0F172A;
          border: 1px solid #CBD5E1;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 16px;
          line-height: 1.5;
          font-family: inherit;
          transition: border-color 120ms ease, box-shadow 120ms ease;
        }
        .Boma-input::placeholder { color: #94A3B8; }
        .Boma-input:focus { outline: none; border-color: #2563EB; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.22); }
        .Boma-input:disabled { background: #F8FAFC; color: #64748B; }
        .Boma-link {
          background: none;
          border: none;
          padding: 0;
          color: #2563EB;
          font-size: 14px;
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
          text-decoration: none;
        }
        .Boma-link:hover { color: #1D4ED8; text-decoration: underline; }
        .Boma-primary, .Boma-secondary {
          width: 100%;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 14px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
        }
        .Boma-primary { background: #2563EB; color: #FFFFFF; border: 1px solid #2563EB; }
        .Boma-primary:hover:not(:disabled) { background: #1D4ED8; border-color: #1D4ED8; }
        .Boma-primary:disabled, .Boma-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
        .Boma-secondary {
          background: #FFFFFF;
          color: #334155;
          border: 1px solid #CBD5E1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          text-decoration: none;
        }
        .Boma-secondary:hover:not(:disabled) { background: #F8FAFC; border-color: #94A3B8; }
        .Boma-link:focus-visible, .Boma-primary:focus-visible, .Boma-secondary:focus-visible {
          outline: 2px solid #2563EB;
          outline-offset: 2px;
        }
        .Boma-divider { display: flex; align-items: center; gap: 12px; color: #94A3B8; font-size: 12px; }
        .Boma-divider::before, .Boma-divider::after { content: ""; flex: 1; height: 1px; background: #E2E8F0; }
        .Boma-footer { text-align: center; color: #94A3B8; font-size: 12px; line-height: 1.6; }
        .Boma-footer-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; }
        .Boma-footer-links a { color: #94A3B8; text-decoration: none; }
        .Boma-footer-links a:hover { color: #CBD5E1; text-decoration: underline; }
        .Boma-footer-links a:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; border-radius: 2px; }
        .Boma-copyright { margin-top: 6px; color: #64748B; }
        .Boma-toast-container {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 130;
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: min(360px, calc(100vw - 32px));
        }
        .Boma-toast {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 12px 14px;
          border-radius: 10px;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.3);
          font-size: 14px;
          line-height: 1.4;
        }
        .Boma-toast.error { background: #FEF2F2; color: #991B1B; border: 1px solid #FECACA; }
        .Boma-toast.success { background: #F0FDF4; color: #166534; border: 1px solid #BBF7D0; }
        .Boma-toast button {
          background: none;
          border: none;
          color: inherit;
          font-size: 18px;
          line-height: 1;
          padding: 0;
          margin-left: auto;
          cursor: pointer;
          opacity: 0.7;
        }
        .Boma-toast button:hover { opacity: 1; }
        .Boma-modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 120;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          background: rgba(15, 23, 42, 0.72);
        }
        .Boma-modal {
          width: 100%;
          max-width: 448px;
          background: #FFFFFF;
          border-radius: 14px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
          padding: 20px;
        }
        .Boma-modal h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; color: #0F172A; }
        .Boma-modal p { margin: 0; font-size: 14px; line-height: 1.55; color: #475569; }
        .Boma-modal-actions { display: flex; gap: 10px; margin-top: 18px; }
        .Boma-modal-actions .Boma-primary, .Boma-modal-actions .Boma-secondary { width: auto; flex: 1; }
        @media (min-width: 640px) {
          .Boma-input { font-size: 14px; }
        }
        @media (max-width: 639px) {
          .Boma-login-page { padding: 32px 16px; }
          .Boma-login-card { padding: 16px; }
          .Boma-toast-container { top: 12px; right: 50%; transform: translateX(50%); }
        }
      `}</style>

      <div className="Boma-toast-container" aria-live="polite" aria-atomic="false">
        {toasts.map(t => (
          <div key={t.id} className={`Boma-toast ${t.type}`} role="status">
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => setToasts(list => list.filter(x => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>

      <div className="Boma-login-column">
        <div className="Boma-login-card">
          <div>
            <h1 style={{ margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 700, color: "#0F172A" }}>Boma — Login</h1>
            <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.5, color: "#64748B" }}>Sign in to continue.</p>
          </div>

          <form className="Boma-login-form" onSubmit={handleLogin}>
            <div>
              <label className="Boma-label" htmlFor="login-email">Email <span aria-hidden="true" style={{ color: "#DC2626" }}>*</span></label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="Boma-input"
                placeholder="you@example.com"
                value={email}
                disabled={loading}
                onChange={e => {
                  setEmail(e.target.value);
                  if (locked) setLocked(false);
                }}
              />
            </div>

            <div>
              <label className="Boma-label" htmlFor="login-password">Password <span aria-hidden="true" style={{ color: "#DC2626" }}>*</span></label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="Boma-input"
                placeholder="••••••••"
                value={password}
                disabled={loading}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            <div style={{ textAlign: "right", marginTop: -6 }}>
              <Link to="/reset-password" className="Boma-link">
                Forgot password?
              </Link>
            </div>

            <button type="submit" className="Boma-primary" disabled={disabled} aria-live="polite">
              {primaryText}
            </button>

            <div className="Boma-divider" aria-hidden="true"><span>or</span></div>

            <button type="button" className="Boma-secondary" onClick={handleGoogle} disabled={googleLoading || disabled}>
              <GoogleMark />
              {googleLoading ? "Redirecting to Google..." : "Continue with Google"}
            </button>
          </form>

          <p style={{ margin: 0, textAlign: "center", fontSize: 14, color: "#475569" }}>
            New here?{" "}
            <Link to="/catalog" className="Boma-link">Explore stays, tours &amp; transfers</Link>
          </p>
          <p style={{ margin: 0, textAlign: "center", fontSize: 14, color: "#475569" }}>
            No account?{" "}
            <Link to="/register" className="Boma-link">Create an account</Link>
          </p>
        </div>

        <footer className="Boma-footer">
          <div className="Boma-footer-links">
            {["Privacy", "Terms", "Cookies", "Disclaimer", "SLA"].map(name => (
              <a
                key={name}
                href={`#${name.toLowerCase()}`}
                onClick={e => {
                  e.preventDefault();
                  openPolicy(name);
                }}
              >
                {name}
              </a>
            ))}
          </div>
          <div className="Boma-copyright">© {new Date().getFullYear()} Boma. All rights reserved.</div>
        </footer>
      </div>

      {modal && (
        <div
          className="Boma-modal-overlay"
          role="presentation"
          onMouseDown={e => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div className="Boma-modal" role="dialog" aria-modal="true" aria-labelledby="Boma-modal-title">
            <h2 id="Boma-modal-title">{modal.title}</h2>
            <p>{modal.message}</p>
            <div className="Boma-modal-actions">
              <button type="button" className="Boma-primary" autoFocus onClick={() => setModal(null)}>Close</button>
              <a className="Boma-secondary" href="mailto:admin@Boma.local">Contact administrator</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManagerDashboard() {
  const [summary, setSummary] = React.useState<any>({});
  const [logs, setLogs] = React.useState<any[]>([]);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    apiGet("/api/dashboard/summary")
      .then(data => setSummary(data && typeof data === "object" && !Array.isArray(data) ? data : {}))
      .catch((e: any) => setError(e?.message || "Could not load dashboard summary."));
    apiGet("/api/audit-logs")
      .then(data => setLogs(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  return (
    <Layout title="Manager Dashboard" subtitle="Operational overview of reservations, revenue and system activity.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}

      <div className="portal-grid">
        <StatCard label="Created Today" value={summary.totalToday ?? 0} hint="New reservations today" />
        <StatCard label="Confirmed" value={summary.confirmed ?? 0} hint="All confirmed bookings" />
        <StatCard label="Pending" value={summary.pending ?? 0} hint="Awaiting confirmation" />
        <StatCard label="Flagged" value={summary.flagged ?? 0} hint="Duplicate warnings" />
        <StatCard label="Confirmed Revenue" value={money(summary.revenue)} hint="Excludes cancelled bookings" />
      </div>

      <div className="portal-quick-actions">
        <Link className="btn btn-primary" to="/manager/users">Manage Users</Link>
        <Link className="btn btn-secondary" to="/manager/reports">Generate Report</Link>
        <Link className="btn btn-secondary" to="/manager/audit">View Audit Trail</Link>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Latest System Activity</h2>
            <p>The most recent actions recorded in the audit trail.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>
              {logs.length === 0 && <tr><td colSpan={4} className="empty-cell">No audit entries yet.</td></tr>}
              {logs.slice(0, 10).map(log => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(log.timestamp).toLocaleString()}</td>
                  <td>{log.user?.fullName || log.user?.email || "System"}</td>
                  <td><strong>{log.action}</strong></td>
                  <td>{log.entityType}{log.entityId ? ` / ${shortRef(log.entityId)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function ManagerUsers() {
  const [users, setUsers] = React.useState<any[]>([]);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [modal, setModal] = React.useState<"add" | "edit" | "password" | null>(null);
  const [selected, setSelected] = React.useState<any>(null);
  const [form, setForm] = React.useState<any>({ fullName: "", email: "", role: "CLIENT", phoneNumber: "", address: "", isActive: true, password: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const perPage = 6;

  const load = () => apiGet("/api/users")
    .then(data => setUsers(Array.isArray(data) ? data : []))
    .catch((e: any) => setError(e?.message || "Could not load users."));

  React.useEffect(() => { void load(); }, []);

  const filtered = users.filter((u: any) =>
    (u.fullName || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.email || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.role || "").toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  React.useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function openAdd() {
    setSelected(null);
    setForm({ fullName: "", email: "", role: "CLIENT", phoneNumber: "", address: "", isActive: true, password: "Client@123" });
    setError("");
    setModal("add");
  }
  function openEdit(user: any) {
    setSelected(user);
    setForm({
      fullName: user.fullName || "",
      email: user.email || "",
      role: user.role,
      phoneNumber: user.client?.phoneNumber || "",
      address: user.client?.address || "",
      isActive: Boolean(user.isActive),
      password: "",
    });
    setError("");
    setModal("edit");
  }
  function openPassword(user: any) {
    setSelected(user);
    setForm({ ...form, password: "" });
    setError("");
    setModal("password");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (modal === "add") {
        await apiSend("/api/users", "POST", {
          fullName: form.fullName,
          email: form.email,
          role: form.role,
          phoneNumber: form.phoneNumber,
          address: form.address,
          password: form.password,
        });
        setNotice("User account created successfully.");
      } else if (modal === "edit" && selected) {
        await apiSend(`/api/users/${selected.id}`, "PUT", {
          fullName: form.fullName,
          email: form.email,
          role: form.role,
          isActive: form.isActive,
          phoneNumber: form.phoneNumber,
          address: form.address,
        });
        setNotice("User account updated.");
      } else if (modal === "password" && selected) {
        await apiSend(`/api/users/${selected.id}/reset-password`, "POST", { password: form.password });
        setNotice(`Password reset for ${selected.email}.`);
      }
      setModal(null);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not save the user account.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(user: any) {
    setError(""); setNotice("");
    try {
      await apiSend(`/api/users/${user.id}`, "PUT", { isActive: !user.isActive });
      setNotice(`${user.email} is now ${user.isActive ? "inactive" : "active"}.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not update the account status.");
    }
  }

  return (
    <Layout title="User Accounts" subtitle="Create and manage manager, officer and client accounts.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <div className="portal-grid portal-grid-compact">
        <StatCard label="Total Users" value={users.length} />
        <StatCard label="Active" value={users.filter(u => u.isActive).length} />
        <StatCard label="Locked" value={users.filter(u => u.lockedUntil && new Date(u.lockedUntil) > new Date()).length} />
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={openAdd}>+ Add New User</button>
        <input
          className="portal-input toolbar-search"
          placeholder="Search by name, email or role..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Phone</th><th>Actions</th></tr></thead>
            <tbody>
              {paginated.length === 0 && <tr><td colSpan={6} className="empty-cell">No users match your search.</td></tr>}
              {paginated.map((u: any) => (
                <tr key={u.id}>
                  <td><strong>{u.fullName || "Unnamed"}</strong></td>
                  <td>{u.email}</td>
                  <td><Badge value={u.role} /></td>
                  <td><Badge value={u.isActive ? "ACTIVE" : "INACTIVE"} /></td>
                  <td>{u.client?.phoneNumber || "—"}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-small btn-secondary" onClick={() => openEdit(u)}>Edit</button>
                      <button className="btn btn-small btn-secondary" onClick={() => toggleActive(u)}>{u.isActive ? "Deactivate" : "Activate"}</button>
                      <button className="btn btn-small btn-secondary" onClick={() => openPassword(u)}>Reset PW</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <button className="btn btn-small btn-secondary" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-small btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</button>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === "add" ? "Add New User" : modal === "edit" ? "Edit User" : "Reset Password"}
          subtitle={modal === "password" ? `Set a new password for ${selected?.email}.` : "All fields marked with * are required."}
          onClose={() => setModal(null)}
        >
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={submit} className="form-stack">
            {modal !== "password" && (
              <>
                <Field label="Full name" required>
                  <input className="portal-input" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} required />
                </Field>
                <Field label="Email address" required>
                  <input className="portal-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
                </Field>
                <Field label="Role" required>
                  <select className="portal-input" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                    <option value="MANAGER">Manager</option>
                    <option value="RESERVATION_OFFICER">Reservation Officer</option>
                    <option value="CLIENT">Client</option>
                  </select>
                </Field>
                {form.role === "CLIENT" && (
                  <div className="form-grid">
                    <Field label="Phone number">
                      <input className="portal-input" value={form.phoneNumber} onChange={e => setForm({ ...form, phoneNumber: e.target.value })} placeholder="+254..." />
                    </Field>
                    <Field label="Address">
                      <input className="portal-input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Optional" />
                    </Field>
                  </div>
                )}
                {modal === "add" && (
                  <Field label="Initial password" required hint="The user can change it after signing in.">
                    <input className="portal-input" type="text" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={6} />
                  </Field>
                )}
                {modal === "edit" && (
                  <label className="portal-check">
                    <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />
                    Account is active
                  </label>
                )}
              </>
            )}
            {modal === "password" && (
              <Field label="New password" required hint="Minimum 6 characters.">
                <input className="portal-input" type="text" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={6} />
              </Field>
            )}
            <div className="modal-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving..." : modal === "password" ? "Reset Password" : "Save User"}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setModal(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}

function ManagerReports() {
  const [reports, setReports] = React.useState<any[]>([]);
  const [form, setForm] = React.useState({ reportType: "RESERVATIONS", from: "", to: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [generating, setGenerating] = React.useState(false);

  const load = () => apiGet("/api/reports")
    .then(data => setReports(Array.isArray(data) ? data : []))
    .catch((e: any) => setError(e?.message || "Could not load reports."));

  React.useEffect(() => { void load(); }, []);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true); setError(""); setNotice("");
    try {
      await apiSend("/api/reports", "POST", form);
      setNotice("Report generated. Use Download CSV to export it.");
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not generate the report.");
    } finally {
      setGenerating(false);
    }
  }

  async function download(report: any) {
    setError(""); setNotice("");
    try {
      const res = await fetch(`${API_BASE}/api/reports/${report.id}/export`, { headers: authHeaders() });
      if (res.status === 401) { endSession(); return; }
      if (!res.ok) {
        const data = await readJson(res);
        throw new Error(data?.error || "Could not download the report.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Boma-${String(report.reportType).toLowerCase()}-${report.id}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Report downloaded as CSV.");
    } catch (err: any) {
      setError(err?.message || "Could not download the report.");
    }
  }

  const period = (report: any) => {
    try {
      const filters = JSON.parse(report.filtersJson || "{}");
      if (!filters.from && !filters.to) return "All dates";
      return `${filters.from || "Start"} to ${filters.to || "Today"}`;
    } catch {
      return "All dates";
    }
  };

  return (
    <Layout title="Reports" subtitle="Generate operational reports and download them as CSV files.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <div><h2>Generate a New Report</h2><p>Choose a report type and optional check-in date range.</p></div>
        </div>
        <form onSubmit={generate} className="report-form">
          <Field label="Report type" required>
            <select className="portal-input" value={form.reportType} onChange={e => setForm({ ...form, reportType: e.target.value })}>
              <option value="RESERVATIONS">Reservation Register</option>
              <option value="REVENUE">Revenue by Service</option>
              <option value="OCCUPANCY">Occupancy by Service</option>
            </select>
          </Field>
          <Field label="From (check-in)">
            <input className="portal-input" type="date" value={form.from} onChange={e => setForm({ ...form, from: e.target.value })} />
          </Field>
          <Field label="To (check-in)">
            <input className="portal-input" type="date" value={form.to} onChange={e => setForm({ ...form, to: e.target.value })} />
          </Field>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn btn-primary" type="submit" disabled={generating}>{generating ? "Generating..." : "Generate Report"}</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Generated Reports</h2><p>Reports available for download.</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Period</th><th>Status</th><th>Generated By</th><th>Generated</th><th>Action</th></tr></thead>
            <tbody>
              {reports.length === 0 && <tr><td colSpan={6} className="empty-cell">No reports generated yet.</td></tr>}
              {reports.map((report: any) => (
                <tr key={report.id}>
                  <td><strong>{String(report.reportType).replace(/_/g, " ")}</strong></td>
                  <td>{period(report)}</td>
                  <td><Badge value={report.status} /></td>
                  <td>{report.generatedBy?.fullName || report.generatedBy?.email || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(report.generatedAt).toLocaleString()}</td>
                  <td><button className="btn btn-small btn-secondary" onClick={() => download(report)}>Download CSV</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function OfficerPortal() {
  const [reservations, setReservations] = React.useState<any[]>([]);
  const [clients, setClients] = React.useState<any[]>([]);
  const [services, setServices] = React.useState<any[]>([]);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("ALL");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<any>(null);
  const [createForm, setCreateForm] = React.useState<any>({ clientId: "", serviceId: "", checkInDate: "", checkOutDate: "", numberOfGuests: 1, notes: "" });
  const [editForm, setEditForm] = React.useState<any>({ checkInDate: "", checkOutDate: "", numberOfGuests: 1, notes: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const rows = Array.isArray(reservations) ? reservations : [];

  const load = React.useCallback(async () => {
    try {
      const [reservationData, clientData, serviceData] = await Promise.all([
        apiGet("/api/reservations"),
        apiGet("/api/clients"),
        apiGet("/api/services"),
      ]);
      setReservations(Array.isArray(reservationData) ? reservationData : []);
      setClients(Array.isArray(clientData) ? clientData : []);
      setServices(Array.isArray(serviceData) ? serviceData : []);
    } catch (err: any) {
      setError(err?.message || "Could not load reservations.");
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const selectedService = services.find((s: any) => s.id === createForm.serviceId);
  const createTotal = computeTotal(selectedService, createForm.checkInDate, createForm.checkOutDate, Number(createForm.numberOfGuests));
  const editService = editing ? services.find((s: any) => s.id === editing.serviceId) || editing.service : null;
  const editTotal = computeTotal(editService, editForm.checkInDate, editForm.checkOutDate, Number(editForm.numberOfGuests));

  const filtered = rows.filter((r: any) => {
    const statusMatch = statusFilter === "ALL" || r.status === statusFilter;
    const query = search.trim().toLowerCase();
    const searchMatch = !query || [r.id, r.client?.fullName, r.client?.email, r.service?.name, r.confirmation?.confirmationCode]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(query));
    return statusMatch && searchMatch;
  });

  function openCreate() {
    setCreateForm({ clientId: "", serviceId: "", checkInDate: "", checkOutDate: "", numberOfGuests: 1, notes: "" });
    setError("");
    setCreateOpen(true);
  }

  function openEdit(reservation: any) {
    setEditing(reservation);
    setEditForm({
      checkInDate: dateInput(reservation.checkInDate),
      checkOutDate: dateInput(reservation.checkOutDate),
      numberOfGuests: reservation.numberOfGuests,
      notes: reservation.notes || "",
    });
    setError("");
  }

  async function createReservation(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const data = await apiSend("/api/reservations", "POST", {
        ...createForm,
        numberOfGuests: Number(createForm.numberOfGuests),
      });
      setNotice(`Reservation created. Confirmation code ${data.confirmationCode || "generated"}.`);
      setCreateOpen(false);
      await load();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(`Duplicate warning: ${err.message}${err.data?.existingId ? ` (existing reservation ${err.data.existingId})` : ""}`);
      } else {
        setError(err?.message || "Could not create the reservation.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await apiSend(`/api/reservations/${editing.id}`, "PUT", {
        ...editForm,
        numberOfGuests: Number(editForm.numberOfGuests),
        version: editing.version,
      });
      setNotice(`Reservation ${reservationRef(editing)} updated.`);
      setEditing(null);
      await load();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(`${err.message} The latest record has been reloaded.`);
        setEditing(null);
        await load();
      } else {
        setError(err?.message || "Could not update the reservation.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmReservation(reservation: any) {
    setError(""); setNotice("");
    try {
      await apiSend(`/api/reservations/${reservation.id}`, "PUT", { status: "CONFIRMED", version: reservation.version });
      setNotice(`Reservation ${reservationRef(reservation)} confirmed.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not confirm the reservation.");
    }
  }

  async function cancelReservation(reservation: any) {
    if (!window.confirm(`Cancel reservation ${reservation.id}?`)) return;
    setError(""); setNotice("");
    try {
      await apiSend(`/api/reservations/${reservation.id}/cancel`, "POST");
      setNotice(`Reservation ${reservationRef(reservation)} cancelled.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not cancel the reservation.");
    }
  }

  async function retrySync(reservation: any) {
    setError(""); setNotice("");
    try {
      await apiSend("/api/sync-logs/retry", "POST", { reservationId: reservation.id });
      setNotice(`Sync retry completed for ${reservationRef(reservation)}.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not retry sync.");
    }
  }

  return (
    <Layout title="Officer Portal" subtitle="Create, confirm, reschedule and synchronise reservations.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <div className="portal-grid portal-grid-compact">
        <StatCard label="Total Reservations" value={rows.length} />
        <StatCard label="Pending" value={rows.filter(r => r.status === "PENDING").length} />
        <StatCard label="Confirmed" value={rows.filter(r => r.status === "CONFIRMED").length} />
        <StatCard label="Flagged" value={rows.filter(r => r.status === "FLAGGED_DUPLICATE").length} />
        <StatCard label="Sync Issues" value={rows.filter(r => r.syncStatus !== "SYNCED").length} />
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={openCreate}>+ New Reservation</button>
        <input
          className="portal-input toolbar-search"
          placeholder="Search by client, service, reservation or confirmation..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="portal-input toolbar-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="ALL">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="FLAGGED_DUPLICATE">Flagged duplicate</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <button className="btn btn-secondary" onClick={() => void load()}>Refresh</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Confirmation</th><th>Client</th><th>Service</th><th>Dates</th><th>Guests</th>
                <th>Amount</th><th>Status</th><th>Sync</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9} className="empty-cell">No reservations match the current filters.</td></tr>}
              {filtered.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <strong className="code-ref">{reservationRef(r)}</strong>
                    <div className="cell-sub" title={r.id}>{shortRef(r.id)}</div>
                  </td>
                  <td>{r.client?.fullName || r.clientId}</td>
                  <td>{r.service?.name || r.serviceId}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{displayDate(r.checkInDate)} – {displayDate(r.checkOutDate)}</td>
                  <td>{r.numberOfGuests}</td>
                  <td>{money(r.totalAmount)}</td>
                  <td><Badge value={r.status} /></td>
                  <td><Badge value={r.syncStatus} /></td>
                  <td>
                    <div className="row-actions">
                      {r.status !== "CANCELLED" && <button className="btn btn-small btn-secondary" onClick={() => openEdit(r)}>Edit</button>}
                      {r.status === "PENDING" && <button className="btn btn-small btn-primary" onClick={() => confirmReservation(r)}>Confirm</button>}
                      {r.status !== "CANCELLED" && <button className="btn btn-small btn-danger" onClick={() => cancelReservation(r)}>Cancel</button>}
                      {r.syncStatus !== "SYNCED" && <button className="btn btn-small btn-secondary" onClick={() => retrySync(r)}>Retry Sync</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {createOpen && (
        <Modal title="Create Reservation" subtitle="The confirmation code is generated automatically." onClose={() => setCreateOpen(false)} width={640}>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={createReservation} className="form-stack">
            <div className="form-grid">
              <Field label="Client" required>
                <select className="portal-input" value={createForm.clientId} onChange={e => setCreateForm({ ...createForm, clientId: e.target.value })} required>
                  <option value="">Select client...</option>
                  {clients.map((client: any) => <option key={client.id} value={client.id}>{client.fullName} ({client.email})</option>)}
                </select>
              </Field>
              <Field label="Service" required>
                <select className="portal-input" value={createForm.serviceId} onChange={e => setCreateForm({ ...createForm, serviceId: e.target.value })} required>
                  <option value="">Select service...</option>
                  {services.map((service: any) => (
                    <option key={service.id} value={service.id}>{service.name} · {money(service.pricePerUnit)}/{serviceUnit(service)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Check-in" required>
                <input className="portal-input" type="date" value={createForm.checkInDate} onChange={e => setCreateForm({ ...createForm, checkInDate: e.target.value })} required />
              </Field>
              <Field label="Check-out" required>
                <input className="portal-input" type="date" value={createForm.checkOutDate} onChange={e => setCreateForm({ ...createForm, checkOutDate: e.target.value })} required />
              </Field>
              <Field label="Guests" required>
                <input className="portal-input" type="number" min={1} max={selectedService?.capacity || undefined} value={createForm.numberOfGuests} onChange={e => setCreateForm({ ...createForm, numberOfGuests: e.target.value })} required />
              </Field>
              <Field label="Estimated total">
                <div className="amount-preview">{money(createTotal)}</div>
              </Field>
            </div>
            <Field label="Notes">
              <textarea className="portal-input" rows={3} value={createForm.notes} onChange={e => setCreateForm({ ...createForm, notes: e.target.value })} placeholder="Special requests, arrival time..." />
            </Field>
            <div className="modal-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Creating..." : "Create Reservation"}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.id}`} subtitle="Updates use optimistic locking to prevent lost changes." onClose={() => setEditing(null)} width={620}>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={saveEdit} className="form-stack">
            <div className="form-grid">
              <Field label="Check-in" required>
                <input className="portal-input" type="date" value={editForm.checkInDate} onChange={e => setEditForm({ ...editForm, checkInDate: e.target.value })} required />
              </Field>
              <Field label="Check-out" required>
                <input className="portal-input" type="date" value={editForm.checkOutDate} onChange={e => setEditForm({ ...editForm, checkOutDate: e.target.value })} required />
              </Field>
              <Field label="Guests" required>
                <input className="portal-input" type="number" min={1} max={editService?.capacity || undefined} value={editForm.numberOfGuests} onChange={e => setEditForm({ ...editForm, numberOfGuests: e.target.value })} required />
              </Field>
              <Field label="Recalculated total">
                <div className="amount-preview">{money(editTotal)}</div>
              </Field>
            </div>
            <Field label="Notes">
              <textarea className="portal-input" rows={3} value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
            </Field>
            <div className="modal-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save Changes"}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}

function ClientPortal() {
  const [reservations, setReservations] = React.useState<any[]>([]);
  const [services, setServices] = React.useState<any[]>([]);
  const [bookingOpen, setBookingOpen] = React.useState(false);
  const [bookingForm, setBookingForm] = React.useState<any>({ serviceId: "", checkInDate: "", checkOutDate: "", numberOfGuests: 1, notes: "" });
  const [reschedule, setReschedule] = React.useState<any>(null);
  const [rescheduleForm, setRescheduleForm] = React.useState<any>({ checkInDate: "", checkOutDate: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [payingId, setPayingId] = React.useState<string | null>(null);
  const payPollRef = React.useRef<number | null>(null);
  const rows = Array.isArray(reservations) ? reservations : [];
  React.useEffect(() => () => { if (payPollRef.current) window.clearInterval(payPollRef.current); }, []);

  const load = React.useCallback(async () => {
    try {
      const [reservationData, serviceData] = await Promise.all([
        apiGet("/api/reservations"),
        apiGet("/api/services"),
      ]);
      setReservations(Array.isArray(reservationData) ? reservationData : []);
      setServices(Array.isArray(serviceData) ? serviceData : []);
    } catch (err: any) {
      setError(err?.message || "Could not load your reservations.");
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function payForReservation(r: any) {
    setError(""); setNotice("");
    setPayingId(r.id);
    try {
      const data = await apiSend("/api/payments/mpesa/initiate", "POST", { reservationId: r.id });
      const depositPercent = Number(data?.depositPercent || 100);
      const charged = Number(data?.amount || 0);
      setNotice(
        charged > 0 && depositPercent < 100
          ? `Deposit of KES ${charged.toLocaleString()} requested (${depositPercent}% of KES ${Number(data?.totalAmount || 0).toLocaleString()}). The balance is payable at the property. Enter your M-Pesa PIN.`
          : (data?.message || "Check your phone and enter your M-Pesa PIN to complete the payment.")
      );
      if (payPollRef.current) window.clearInterval(payPollRef.current);
      payPollRef.current = window.setInterval(async () => {
        try {
          const s = await apiGet(`/api/payments/status/${r.id}`);
          if (s?.status === "COMPLETED") {
            if (payPollRef.current) window.clearInterval(payPollRef.current);
            setNotice(`Payment received${s.receipt ? ` — receipt ${s.receipt}` : ""}. Your reservation is confirmed.`);
            await load();
          } else if (s?.status === "FAILED") {
            if (payPollRef.current) window.clearInterval(payPollRef.current);
            setError("The M-Pesa payment was not completed. You can try again.");
          }
        } catch { /* keep polling; transient network flaps are expected */ }
      }, 5000);
    } catch (err: any) {
      setError(err?.message || "Could not start M-Pesa payment.");
    } finally {
      setPayingId(null);
    }
  }

  const selectedService = services.find((s: any) => s.id === bookingForm.serviceId);
  const bookingTotal = computeTotal(selectedService, bookingForm.checkInDate, bookingForm.checkOutDate, Number(bookingForm.numberOfGuests));
  const rescheduleService = reschedule ? services.find((s: any) => s.id === reschedule.serviceId) || reschedule.service : null;
  const rescheduleTotal = computeTotal(rescheduleService, rescheduleForm.checkInDate, rescheduleForm.checkOutDate, Number(reschedule?.numberOfGuests || 1));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = rows.filter(r => r.status !== "CANCELLED" && new Date(r.checkOutDate) >= today);
  const confirmed = rows.filter(r => r.status === "CONFIRMED");
  const totalValue = rows.filter(r => r.status !== "CANCELLED").reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);

  function openBooking() {
    setBookingForm({ serviceId: "", checkInDate: "", checkOutDate: "", numberOfGuests: 1, notes: "" });
    setError("");
    setBookingOpen(true);
  }

  async function createBooking(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const data = await apiSend("/api/reservations", "POST", {
        ...bookingForm,
        numberOfGuests: Number(bookingForm.numberOfGuests),
      });
      setNotice(`Booking confirmed. Your confirmation code is ${data.confirmationCode}.`);
      setBookingOpen(false);
      await load();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(`Duplicate booking: ${err.message}${err.data?.existingId ? ` (existing reservation ${err.data.existingId})` : ""}`);
      } else {
        setError(err?.message || "Could not create the booking.");
      }
    } finally {
      setSaving(false);
    }
  }

  function openReschedule(reservation: any) {
    setReschedule(reservation);
    setRescheduleForm({ checkInDate: dateInput(reservation.checkInDate), checkOutDate: dateInput(reservation.checkOutDate) });
    setError("");
  }

  async function saveReschedule(e: React.FormEvent) {
    e.preventDefault();
    if (!reschedule) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await apiSend(`/api/reservations/${reschedule.id}/reschedule`, "POST", {
        ...rescheduleForm,
        version: reschedule.version,
      });
      setNotice(`Reservation ${reservationRef(reschedule)} has been rescheduled.`);
      setReschedule(null);
      await load();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(`${err.message} Your booking list has been refreshed.`);
        setReschedule(null);
        await load();
      } else {
        setError(err?.message || "Could not reschedule the booking.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function cancelBooking(reservation: any) {
    if (!window.confirm(`Cancel booking ${reservation.id}?`)) return;
    setError(""); setNotice("");
    try {
      await apiSend(`/api/reservations/${reservation.id}/cancel-self`, "POST");
      setNotice(`Booking ${reservationRef(reservation)} cancelled.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not cancel the booking.");
    }
  }

  return (
    <Layout title="My Bookings" subtitle="Book services, manage your dates and download confirmation codes.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <div className="portal-grid portal-grid-compact">
        <StatCard label="Total Bookings" value={rows.length} />
        <StatCard label="Upcoming" value={upcoming.length} hint="Not cancelled" />
        <StatCard label="Confirmed" value={confirmed.length} />
        <StatCard label="Booking Value" value={money(totalValue)} hint="Excludes cancelled" />
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={openBooking}>+ New Booking</button>
        <button className="btn btn-secondary" onClick={() => void load()}>Refresh</button>
        <span className="toolbar-note">Need help? Contact the reservations desk.</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Confirmation</th><th>Service</th><th>Dates</th><th>Guests</th><th>Amount</th><th>Status</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="empty-cell">You have no bookings yet. Use “+ New Booking” to get started.</td></tr>}
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <strong className="code-ref">{reservationRef(r)}</strong>
                    <div className="cell-sub" title={r.id}>{shortRef(r.id)}</div>
                  </td>
                  <td>{r.service?.name || r.serviceId}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{displayDate(r.checkInDate)} – {displayDate(r.checkOutDate)}</td>
                  <td>{r.numberOfGuests}</td>
                  <td>{money(r.totalAmount)}</td>
                  <td><Badge value={r.status} /></td>
                  <td>
                    {(() => {
                      const payments = r.payments || [];
                      const paid = payments.find((p: any) => p.status === "COMPLETED");
                      if (paid) return <span className="cell-sub" title={paid.transactionId ? `M-Pesa receipt ${paid.transactionId}` : "Paid"}>Paid{paid.transactionId ? ` · ${paid.transactionId}` : ""}</span>;
                      const pending = payments.find((p: any) => p.status === "PENDING");
                      if (pending) return <span className="cell-sub">Pending…</span>;
                      if (r.status === "CANCELLED") return <span className="cell-sub">—</span>;
                      return <button className="btn btn-small btn-primary" disabled={payingId === r.id} onClick={() => payForReservation(r)}>{payingId === r.id ? "Sending…" : "Pay"}</button>;
                    })()}
                  </td>
                  <td>
                    <div className="row-actions">
                      {r.status !== "CANCELLED" && <button className="btn btn-small btn-secondary" onClick={() => openReschedule(r)}>Reschedule</button>}
                      {r.status !== "CANCELLED" && <button className="btn btn-small btn-danger" onClick={() => cancelBooking(r)}>Cancel</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bookingOpen && (
        <Modal title="New Booking" subtitle="Choose a service and dates; the price is calculated automatically." onClose={() => setBookingOpen(false)} width={620}>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={createBooking} className="form-stack">
            <Field label="Service" required>
              <select className="portal-input" value={bookingForm.serviceId} onChange={e => setBookingForm({ ...bookingForm, serviceId: e.target.value })} required>
                <option value="">Select a service...</option>
                {services.map((service: any) => (
                  <option key={service.id} value={service.id}>{service.name} · {money(service.pricePerUnit)}/{serviceUnit(service)} · {service.location}</option>
                ))}
              </select>
            </Field>
            <div className="form-grid">
              <Field label="Check-in" required>
                <input className="portal-input" type="date" value={bookingForm.checkInDate} onChange={e => setBookingForm({ ...bookingForm, checkInDate: e.target.value })} required />
              </Field>
              <Field label="Check-out" required>
                <input className="portal-input" type="date" value={bookingForm.checkOutDate} onChange={e => setBookingForm({ ...bookingForm, checkOutDate: e.target.value })} required />
              </Field>
              <Field label="Guests" required>
                <input className="portal-input" type="number" min={1} max={selectedService?.capacity || undefined} value={bookingForm.numberOfGuests} onChange={e => setBookingForm({ ...bookingForm, numberOfGuests: e.target.value })} required />
              </Field>
              <Field label="Estimated total">
                <div className="amount-preview">{money(bookingTotal)}</div>
              </Field>
            </div>
            <Field label="Notes">
              <textarea className="portal-input" rows={3} value={bookingForm.notes} onChange={e => setBookingForm({ ...bookingForm, notes: e.target.value })} placeholder="Special requests, arrival time..." />
            </Field>
            <div className="modal-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Booking..." : "Confirm Booking"}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setBookingOpen(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {reschedule && (
        <Modal title={`Reschedule ${reservationRef(reschedule)}`} subtitle="Your confirmation code stays the same." onClose={() => setReschedule(null)} width={540}>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={saveReschedule} className="form-stack">
            <div className="form-grid">
              <Field label="New check-in" required>
                <input className="portal-input" type="date" value={rescheduleForm.checkInDate} onChange={e => setRescheduleForm({ ...rescheduleForm, checkInDate: e.target.value })} required />
              </Field>
              <Field label="New check-out" required>
                <input className="portal-input" type="date" value={rescheduleForm.checkOutDate} onChange={e => setRescheduleForm({ ...rescheduleForm, checkOutDate: e.target.value })} required />
              </Field>
            </div>
            <div className="amount-preview">Updated total: {money(rescheduleTotal)}</div>
            <div className="modal-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save New Dates"}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setReschedule(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}

function ManagerAudit() {
  const [logs, setLogs] = React.useState<any[]>([]);
  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState("");
  const rows = Array.isArray(logs) ? logs : [];

  React.useEffect(() => {
    apiGet("/api/audit-logs")
      .then(data => setLogs(Array.isArray(data) ? data : []))
      .catch((e: any) => setError(e?.message || "Could not load the audit trail."));
  }, []);

  const filtered = rows.filter(log => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return [log.action, log.entityType, log.entityId, log.user?.fullName, log.user?.email]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(query));
  });

  return (
    <Layout title="Audit Trail" subtitle="A permanent record of security and reservation activity.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      <div className="toolbar">
        <input
          className="portal-input toolbar-search"
          placeholder="Search by user, action or entity..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="toolbar-note">{filtered.length} of {rows.length} entries</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Entity</th><th>IP Address</th></tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={5} className="empty-cell">No audit entries match your search.</td></tr>}
              {filtered.map(log => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(log.timestamp).toLocaleString()}</td>
                  <td>{log.user?.fullName || log.user?.email || "System"}</td>
                  <td><strong>{log.action}</strong></td>
                  <td>{log.entityType}{log.entityId ? ` / ${shortRef(log.entityId)}` : ""}</td>
                  <td>{log.ipAddress || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function SyncLogPage() {
  const [logs, setLogs] = React.useState<any[]>([]);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const rows = Array.isArray(logs) ? logs : [];

  const load = () => apiGet("/api/sync-logs")
    .then(data => setLogs(Array.isArray(data) ? data : []))
    .catch((e: any) => setError(e?.message || "Could not load sync logs."));

  React.useEffect(() => { void load(); }, []);

  async function retry(log: any) {
    setBusy(log.id); setError(""); setNotice("");
    try {
      await apiSend(`/api/sync-logs/retry/${log.id}`, "POST");
      setNotice(`Sync retry completed for ${shortRef(log.reservationId)}.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Sync retry failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Layout title="Sync Log" subtitle="Every external schedule-sync attempt is recorded here.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <div className="portal-grid portal-grid-compact">
        <StatCard label="Sync Attempts" value={rows.length} />
        <StatCard label="Synced" value={rows.filter(l => l.status === "SYNCED").length} />
        <StatCard label="Pending Retry" value={rows.filter(l => l.status === "PENDING_RETRY").length} />
        <StatCard label="Failed" value={rows.filter(l => l.status === "FAILED").length} />
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Reservation</th><th>Client / Service</th><th>Status</th><th>Retries</th><th>Attempted</th><th>Error</th><th>Action</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="empty-cell">No sync attempts recorded.</td></tr>}
              {rows.map(log => (
                <tr key={log.id}>
                  <td><strong className="code-ref" title={log.reservationId}>{shortRef(log.reservationId)}</strong></td>
                  <td>{log.reservation?.client?.fullName || "—"} / {log.reservation?.service?.name || "—"}</td>
                  <td><Badge value={log.status} /></td>
                  <td>{log.retryCount}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(log.attemptedAt).toLocaleString()}</td>
                  <td style={{ color: "#b91c1c", fontSize: 13 }}>{log.errorMessage || "—"}</td>
                  <td>
                    {log.status === "SYNCED"
                      ? <span className="muted">Up to date</span>
                      : <button className="btn btn-small btn-secondary" disabled={busy === log.id} onClick={() => retry(log)}>{busy === log.id ? "Retrying..." : "Retry"}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function ConfirmationsPage() {
  const [confirmations, setConfirmations] = React.useState<any[]>([]);
  const [q, setQ] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const rows = Array.isArray(confirmations) ? confirmations : [];

  const load = () => apiGet("/api/confirmations")
    .then(data => setConfirmations(Array.isArray(data) ? data : []))
    .catch((e: any) => setError(e?.message || "Could not load confirmations."));

  React.useEffect(() => { void load(); }, []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setNotice("");
    if (!q.trim()) return load();
    try {
      const data = await apiGet(`/api/confirmations/search?q=${encodeURIComponent(q.trim())}`);
      setConfirmations(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message || "Search failed.");
    }
  }

  async function resend(confirmation: any) {
    setBusy(confirmation.id); setError(""); setNotice("");
    try {
      await apiSend(`/api/confirmations/${confirmation.id}/resend`, "POST");
      setNotice(`Confirmation ${confirmation.confirmationCode} resent.`);
      await load();
    } catch (err: any) {
      setError(err?.message || "Could not resend the confirmation.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Layout title="Confirmations" subtitle="Search confirmation codes and resend booking confirmations.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}

      <form onSubmit={search} className="toolbar">
        <input
          className="portal-input toolbar-search"
          placeholder="Search by confirmation code, client name or email..."
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">Search</button>
        <button className="btn btn-secondary" type="button" onClick={() => { setQ(""); void load(); }}>Reset</button>
      </form>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Client</th><th>Service</th><th>Issued</th><th>Delivery</th><th>Action</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="empty-cell">No confirmations found.</td></tr>}
              {rows.map(confirmation => (
                <tr key={confirmation.id}>
                  <td><strong>{confirmation.confirmationCode}</strong></td>
                  <td>{confirmation.reservation?.client?.fullName || "—"}</td>
                  <td>{confirmation.reservation?.service?.name || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(confirmation.issuedAt).toLocaleString()}</td>
                  <td><Badge value={confirmation.deliveryStatus} /></td>
                  <td>
                    <button className="btn btn-small btn-secondary" disabled={busy === confirmation.id} onClick={() => resend(confirmation)}>
                      {busy === confirmation.id ? "Sending..." : "Resend"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

// -------- PUBLIC SERVICE CATALOG (Booking.com style) --------
function ServiceCard({ service }: { service: any }) {
  const unit = service.serviceType === "ACCOMMODATION" ? "night" : service.serviceType === "TOUR" ? "guest" : "booking";
  const tags = service.serviceType === "ACCOMMODATION"
    ? ["Breakfast included", "Free cancellation", "Wi-Fi"]
    : service.serviceType === "TOUR"
      ? ["Transfer included", "Free cancellation", "Expert guide"]
      : ["24/7 availability", "Free cancellation", "Professional driver"];
  return (
    <div className="card">
      {service.imageUrl && <img src={service.imageUrl} alt={service.name} loading="lazy" decoding="async" width={640} height={160} style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: 10 }} />}
      <h3 style={{ margin: "14px 0 4px", fontSize: 15, color: "#0F172A" }}>{service.name}</h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#475569" }}>
        {service.location}{service.capacity ? <span> · Up to {service.capacity} guests</span> : null}
      </p>
      <div className="amount-preview" style={{ background: "#EFF6FF", borderColor: "#BFDBFE" }}>From KES {Number(service.pricePerUnit || 0).toLocaleString()} <span style={{ fontSize: 11, color: "#64748B" }}>/{unit}</span></div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {tags.map(t => <span key={t} className="badge" style={{ background: "#DCFCE7", color: "#166534", fontSize: 9.5, padding: "3px 8px" }}>{t}</span>)}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "#334155" }}>{service.description || ""}</p>
      <div style={{ marginTop: 12 }}>
        <Link className="btn btn-primary" to={`/book?service=${service.id}`}>Book this</Link>
      </div>
    </div>
  );
}

function ServiceCatalog() {
  const [services, setServices] = React.useState<any[]>([]);
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("");
  const [loadError, setLoadError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const load = React.useCallback((force = false) => {
    setLoadError(""); setLoading(true);
    fetchServices(force)
      .then(setServices)
      .catch(() => setLoadError("We couldn't load the stay options. Please check your connection and try again."))
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { load(); }, [load]);
  const filtered = services.filter((s: any) => {
    const haystack = `${s.name} ${s.location} ${s.description || ""}`.toLowerCase();
    const matchesQuery = !query || haystack.includes(query.toLowerCase());
    const matchesType = !typeFilter || s.serviceType === typeFilter;
    return matchesQuery && matchesType;
  });
  const serviceTypes: string[] = Array.from(new Set(services.map((s: any) => String(s.serviceType)))).sort();
  return (
    <PublicLayout>
      <section style={{ background: "linear-gradient(135deg, #0F172A 0%, #1E3A8A 55%, #2563EB 100%)", borderRadius: 16, padding: "44px 32px", textAlign: "center", color: "#FFFFFF", marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 30 }}>Find your Kenya stay</h1>
        <p style={{ margin: "8px 0 0", color: "#CBD5E1", fontSize: 15 }}>Accommodation, safari tours, beach excursions, transfers and conference halls across the Mara, Diani and Nairobi.</p>
        <form onSubmit={(e) => e.preventDefault()} style={{ display: "flex", gap: 12, justifyContent: "center", maxWidth: "760px", margin: "22px auto 0", flexWrap: "wrap" }}>
          <input aria-label="Search destinations" className="portal-input" type="text" placeholder="Where would you like to go?" value={query} onChange={e => setQuery(e.target.value)} style={{ flex: "1 1 220px", borderRadius: 10 }} />
          <select aria-label="Filter by type" className="portal-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ flex: "0 1 180px", borderRadius: 10 }}>
            <option value="">All types</option>
            {serviceTypes.map(t => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
        </form>
      </section>
      <div className="portal-grid">
        {loadError && (
          <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 24 }}>
            <p className="muted" style={{ margin: "0 0 12px" }}>{loadError}</p>
            <button className="btn btn-primary" onClick={() => load(true)}>Try again</button>
          </div>
        )}
        {!loadError && filtered.length === 0 && (
          <p className="muted" style={{ textAlign: "center", padding: 30 }}>
            {loading || services.length === 0 ? "Loading your stay options…" : "No results match your search. Try a different destination."}
          </p>
        )}
        {filtered.map((s: any) => <ServiceCard key={s.id} service={s} />)}
      </div>
      <section aria-label="Why book with Boma" style={{ marginTop: 26, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        {[
          ["Instant confirmation", "Get a unique Boma code by email and SMS the moment you book — it's your proof of reservation at check-in."],
          ["Secure M-Pesa payment", "Pay with an STK push straight from your phone. Your PIN never leaves Safaricom's secure prompt."],
          ["Free cancellation", "Change or cancel free of charge up to 48 hours before check-in. Later cancellations may retain the deposit."],
          ["24/7 reservations desk", "Real people, real help — around the clock, every day of the week."],
        ].map(([t, d]) => (
          <div key={t} className="card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, color: "#0F172A", marginBottom: 5 }}>{t}</div>
            <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.55 }}>{d}</div>
          </div>
        ))}
      </section>
      <section aria-label="Every booking includes" style={{ marginTop: 12, background: "#0F172A", borderRadius: 16, padding: "22px 24px", color: "#CBD5E1" }}>
        <h2 style={{ margin: 0, fontSize: 16, color: "#FFFFFF" }}>Every booking includes</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 12, fontSize: 13.5, lineHeight: 1.6 }}>
          <div>• A Boma-XXXX confirmation code, stored and retrievable any time</div>
          <div>• Duplicate-booking protection at the moment of reservation</div>
          <div>• Real-time schedule sync with our front-office teams</div>
          <div>• Transparent pricing in KES — the total is shown before you confirm</div>
        </div>
      </section>
      <section aria-label="Frequently asked questions" style={{ marginTop: 22, marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, margin: "0 0 10px", color: "#0F172A" }}>Good to know</h2>
        {[
          ["How do I get my confirmation code?", "Immediately after booking you receive a unique Boma code by email and SMS. It also appears under My Bookings when you sign in. Keep it handy — you'll show it at check-in."],
          ["How do I pay?", "Tap “Pay now with M-Pesa” on the booking confirmation and an STK prompt pops up on your phone. Enter your PIN and you're done. The prompt shows exactly what you are paying — the full amount or the deposit. Any balance is payable at check-in. If M-Pesa is temporarily unavailable, you can still pay at the front desk — your reservation remains valid."],
          ["Can I change or cancel my booking?", "Yes. Sign in, open My Bookings and reschedule or cancel. Changes and cancellations are free up to 48 hours before check-in. Within 48 hours of check-in, the first night or deposit may be retained. Your confirmation code stays valid until you cancel."],
          ["What is your refund policy?", "Deposits and payments for bookings cancelled at least 48 hours before check-in are eligible for a full refund. The reservations desk processes approved refunds to the original M-Pesa number within 3–5 business days. Refunds for late cancellations or no-shows are assessed case by case."],
          ["What happens after I book?", "Your Boma code is issued immediately and sent by email and SMS. We also send a reminder 24–48 hours before check-in and again on the day of arrival, with your dates and confirmation code."],
          ["What if the email never arrives?", "Your code is safely stored in My Bookings. You can also reach the reservations desk and we'll resend it to your registered email or phone."],
          ["Is my payment secure?", "Yes. Payments run through Safaricom Daraja's STK push directly from your phone. Boma never sees or stores your M-Pesa PIN."],
        ].map(([q, a]) => (
          <details key={q} style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "11px 16px", marginBottom: 8 }}>
            <summary style={{ fontWeight: 600, cursor: "pointer", color: "#0F172A", fontSize: 14 }}>{q}</summary>
            <p style={{ margin: "9px 0 0", fontSize: 13, color: "#334155", lineHeight: 1.65 }}>{a}</p>
          </details>
        ))}
      </section>
    </PublicLayout>
  );
}

// -------- PUBLIC REGISTRATION --------
function RegisterPage() {
  const [form, setForm] = React.useState({ fullName: "", email: "", password: "", phoneNumber: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await apiSend("/api/public/register", "POST", form);
      setNotice("Account created. You can now sign in.");
      setForm({ fullName: "", email: "", password: "", phoneNumber: "" });
    } catch (err: any) { setError(err?.message || "Could not create the account."); }
    finally { setBusy(false); }
  }
  return (
    <PublicLayout title="Create your account" subtitle="Register to book stays, tours and transfers.">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <div className="portal-main" style={{ maxWidth: 520 }}>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Full name" required><input className="portal-input" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Email" required><input className="portal-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password" required><input className="portal-input" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Phone number"><input className="portal-input" value={form.phoneNumber} onChange={e => setForm({ ...form, phoneNumber: e.target.value })} placeholder="+254..." /></Field>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create account"}</button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: "#475569" }}>Already have an account? <Link to="/">Sign in</Link></p>
      </div>
    </PublicLayout>
  );
}

// -------- PUBLIC PASSWORD RESET --------
function PasswordResetPage() {
  const [searchParams] = useSearchParams();
  const [step, setStep] = React.useState<"request" | "confirm">(searchParams.get("token") ? "confirm" : "request");
  const [resetToken, setResetToken] = React.useState(searchParams.get("token") || "");
  const [form, setForm] = React.useState({ email: "", newPassword: "" });
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState(searchParams.get("token") ? "Choose a new password for your account." : "");
  const [busy, setBusy] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (step === "request") {
        const res = await fetchWithTimeout("/api/public/password-reset-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.email }) });
        const data = await readJson(res);
        if (!res.ok) throw new Error(data?.error || "Could not send reset request.");
        if (data?.devToken) {
          setResetToken(data.devToken);
          setStep("confirm");
          setNotice("No mail server is configured, so the reset token is shown here for development. Set a new password.");
        } else {
          setNotice(data?.message || "If an account exists for that email, a reset link has been sent.");
        }
        return;
      }
      if (!resetToken) throw new Error("No reset token available. Request a new reset link.");
      await apiSend("/api/public/password-reset", "POST", { token: resetToken, password: form.newPassword });
      setNotice("Password reset successfully. You can sign in now.");
      setForm({ email: "", newPassword: "" });
      setStep("request");
      setResetToken("");
    } catch (err: any) { setError(err?.message || "Something went wrong."); }
    finally { setBusy(false); }
  }
  return (
    <PublicLayout title="Reset your password" subtitle="Choose a new password so you can sign in again.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert tone="success" onClose={() => setNotice("")}>{notice}</Alert>}
      <div className="card">
        {step === "request" && (
            <form className="form-stack" onSubmit={submit}>
              <Field label="Email" required><input className="portal-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
              <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Sending..." : "Send reset link"}</button>
            </form>
          )}
          {step === "confirm" && (
            <form className="form-stack" onSubmit={submit}>
              <Field label="New password" required><input className="portal-input" type="password" value={form.newPassword} onChange={e => setForm({ ...form, newPassword: e.target.value })} /></Field>
              <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Reset password"}</button>
            </form>
          )}
          <p style={{ marginTop: 14, fontSize: 13, color: "#475569" }}>Already have an account? <Link to="/">Sign in</Link></p>
        </div>
      </PublicLayout>
  );
}

// -------- PUBLIC BOOKING FLOW --------
function BookingPage() {
  const [searchParams] = useSearchParams();
  const [services, setServices] = React.useState<any[]>([]);
  const [selectedId, setSelectedId] = React.useState(searchParams.get("service") || "");
  const [checkIn, setCheckIn] = React.useState("");
  const [checkOut, setCheckOut] = React.useState("");
  const [guests, setGuests] = React.useState("1");
  const [fullName, setFullName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");
  const [booking, setBooking] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [payState, setPayState] = React.useState<"idle" | "sending" | "pending" | "done" | "failed" | "unavailable">("idle");
  const [payNotice, setPayNotice] = React.useState("");
  const pollRef = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);
  React.useEffect(() => { fetchServices().then(setServices).catch(() => setError("Could not load the stay options. Check your connection and refresh the page.")); }, []);
  const selected = services.find((x: any) => x.id === selectedId);
  const total = !selected || !checkIn || !checkOut ? 0
    : selected.serviceType === "ACCOMMODATION" ? Math.round(selected.pricePerUnit * nightsBetween(checkIn, checkOut))
    : selected.serviceType === "TOUR" ? Math.round(selected.pricePerUnit * Math.max(1, Number(guests) || 1))
    : Math.round(selected.pricePerUnit);
  async function confirmBooking() {
    if (!selectedId || !checkIn || !checkOut) { setError("Choose a service, check-in and check-out date."); return; }
    if (checkOut <= checkIn) { setError("Check-out date must be after the check-in date."); return; }
    if (!fullName.trim()) { setError("Enter the lead guest's full name."); return; }
    if (!phone.trim()) { setError("Enter a phone number — we use it to confirm the booking and for M-Pesa."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetchWithTimeout("/api/public/reservations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: selectedId, checkInDate: checkIn, checkOutDate: checkOut, numberOfGuests: Math.max(1, Number(guests) || 1), notes: "", fullName: fullName.trim(), phoneNumber: phone.trim(), email: email.trim() || undefined }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error || "Could not complete the booking.");
      setBooking(data);
      setPayState("idle"); setPayNotice("");
    } catch (err: any) { setError(err?.message || "Could not complete the booking."); }
    finally { setBusy(false); }
  }
  async function payNow() {
    if (!booking) return;
    setPayState("sending"); setPayNotice("");
    try {
      const res = await fetchWithTimeout("/api/public/payments/mpesa/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: booking.id, confirmationCode: booking.confirmationCode, phone: phone.trim() }),
      });
      const data = await readJson(res);
      if (res.status === 503) { setPayState("unavailable"); setPayNotice(data?.error || "M-Pesa is not available on this server yet. Please pay at the front desk on arrival."); return; }
      if (!res.ok) { setPayState("failed"); setPayNotice(data?.error || `Could not start M-Pesa payment (HTTP ${res.status}).`); return; }
      setPayState("pending");
      const depositPercent = Number(data?.depositPercent || 100);
      const charged = Number(data?.amount || 0);
      setPayNotice(
        charged > 0 && depositPercent < 100
          ? `Deposit of KES ${charged.toLocaleString()} requested (${depositPercent}% of KES ${Number(data?.totalAmount || 0).toLocaleString()}). The balance is payable at the property. Enter your M-Pesa PIN.`
          : (data?.message || "Check your phone and enter your M-Pesa PIN to complete the payment.")
      );
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await fetchWithTimeout(`/api/public/payments/status/${booking.id}?code=${encodeURIComponent(booking.confirmationCode)}`);
          const d = await readJson(r);
          if (d?.status === "COMPLETED") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setPayState("done");
            setPayNotice(`Payment received${d.receipt ? ` — receipt ${d.receipt}` : ""}. Your reservation is confirmed.`);
          } else if (d?.status === "FAILED") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setPayState("failed");
            setPayNotice("The M-Pesa payment was not completed. You can try again.");
          }
        } catch { /* transient network/TLS flap — keep polling */ }
      }, 5000);
    } catch {
      setPayState("unavailable");
      setPayNotice("The server is not responding. Your booking is saved — please pay at the front desk on arrival.");
    }
  }
  return (
    <PublicLayout title="Book your stay" subtitle="Pick a service, dates and guests — then we'll confirm.">
      {error && <Alert tone="error" onClose={() => setError("")}>{error}</Alert>}
      {booking && (
        <div className="card" style={{ marginBottom: 18, borderLeft: "4px solid #2563EB" }}>
          <div style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "#475569" }}>Booking received — keep this code</div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 4, color: "#1D4ED8", margin: "8px 0 10px" }}>{booking.confirmationCode}</div>
          <p style={{ margin: "0 0 14px", color: "#0F172A" }}>Total <strong>KES {Number(booking.totalAmount || total).toLocaleString()}</strong>{email ? <> · confirmation sent to <strong>{email}</strong></> : null}</p>
          {payState === "idle" && (
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn btn-primary" type="button" onClick={payNow}>Pay now with M-Pesa</button>
              <button className="btn btn-secondary" type="button" onClick={() => setBooking(null)}>Done</button>
            </div>
          )}
          {(payState === "sending" || payState === "pending") && (
            <p style={{ margin: 0, color: "#1D4ED8", fontWeight: 600 }}>{payState === "sending" ? "Contacting M-Pesa…" : `Waiting for M-Pesa — ${payNotice}`}</p>
          )}
          {payState === "done" && <Alert tone="success">{payNotice}</Alert>}
          {payState === "unavailable" && <Alert tone="error">{payNotice}</Alert>}
          {payState === "failed" && (
            <Alert tone="error">{payNotice} <button className="btn btn-secondary" type="button" onClick={() => setPayState("idle")} style={{ marginLeft: 8 }}>Try again</button></Alert>
          )}
        </div>
      )}
      <form className="form-stack" style={{ maxWidth: 720 }} onSubmit={e => { e.preventDefault(); confirmBooking(); }}>
        <Field label="Service" required>
          <select className="portal-input" value={selectedId} onChange={e => setSelectedId(e.target.value)} required>
            <option value="">Select a service...</option>
            {services.map((s: any) => <option key={s.id} value={s.id}>{s.name} · KES {Number(s.pricePerUnit).toLocaleString()}/{s.serviceType === "ACCOMMODATION" ? "night" : s.serviceType === "TOUR" ? "guest" : "stay"}</option>)}
          </select>
        </Field>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Field label="Full name" required><input className="portal-input" value={fullName} onChange={e => setFullName(e.target.value)} required placeholder="e.g. Amina Noor" autoComplete="name" /></Field>
          <Field label="Phone (M-Pesa)" required><input className="portal-input" value={phone} onChange={e => setPhone(e.target.value)} required placeholder="07XXXXXXXX" autoComplete="tel" /></Field>
          <Field label="Email (for your confirmation)"><input className="portal-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /></Field>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Field label="Check-in" required><input className="portal-input" type="date" value={checkIn} onChange={e => setCheckIn(e.target.value)} required /></Field>
          <Field label="Check-out" required><input className="portal-input" type="date" value={checkOut} onChange={e => setCheckOut(e.target.value)} required /></Field>
          <Field label="Guests" required><input className="portal-input" type="number" min={1} max={selected?.capacity || 20} value={guests} onChange={e => setGuests(e.target.value)} required style={{ maxWidth: 110 }} /></Field>
        </div>
        <div className="amount-preview" style={{ background: "#EFF6FF", borderColor: "#BFDBFE", marginBottom: 4, fontSize: 15 }}>Total: KES {total.toLocaleString()}</div>
        <div className="modal-actions" style={{ justifyContent: "stretch", marginBottom: 18 }}>
          <Link to="/catalog" className="btn btn-secondary">Back to catalog</Link>
          <button className="btn btn-primary" type="submit" disabled={busy || !selectedId}>{busy ? "Booking..." : "Confirm booking"}</button>
        </div>
      </form>
      <section aria-label="Booking, cancellation and refund policy" className="card" style={{ maxWidth: 720, padding: 20 }}>
        <h2 style={{ margin: "0 0 10px", fontSize: 16, color: "#0F172A" }}>Booking, cancellation & refund policy</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "10px 24px", fontSize: 13, color: "#334155", lineHeight: 1.6 }}>
          <div><strong style={{ color: "#0F172A" }}>Payment and deposits.</strong> Pay securely by M-Pesa when you book — the STK prompt shows whether you are paying in full or a deposit. Any balance is shown clearly and payable at check-in.</div>
          <div><strong style={{ color: "#0F172A" }}>Free cancellation.</strong> Change or cancel free of charge up to 48 hours before check-in. Within 48 hours, the first night or the deposit may be retained.</div>
          <div><strong style={{ color: "#0F172A" }}>Refunds.</strong> Eligible refunds are processed to the original M-Pesa number within 3–5 business days. Late cancellations and no-shows are reviewed case by case.</div>
          <div><strong style={{ color: "#0F172A" }}>Reminders.</strong> We send a reminder 24–48 hours before check-in and again on arrival day, using the email and phone number on your booking.</div>
        </div>
        <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "#64748B" }}>Questions before you book? The Boma reservations desk is available 24/7 — call or reply to your confirmation message and a real person will help.</p>
      </section>
    </PublicLayout>
  );
}

export default function App() {
  useLocation();
  const user = readStoredUser();
  return (
    <Routes>
      <Route path="/" element={user ? <Navigate to={portalForRole(user.role)} replace /> : <Login />} />
      <Route path="/manager" element={user?.role === "MANAGER" ? <ManagerDashboard /> : <Navigate to="/" replace />} />
      <Route path="/manager/users" element={user?.role === "MANAGER" ? <ManagerUsers /> : <Navigate to="/" replace />} />
      <Route path="/manager/reports" element={user?.role === "MANAGER" ? <ManagerReports /> : <Navigate to="/" replace />} />
      <Route path="/manager/audit" element={user?.role === "MANAGER" ? <ManagerAudit /> : <Navigate to="/" replace />} />
      <Route path="/officer" element={user?.role === "RESERVATION_OFFICER" ? <OfficerPortal /> : <Navigate to="/" replace />} />
      <Route path="/officer/sync" element={user?.role === "RESERVATION_OFFICER" ? <SyncLogPage /> : <Navigate to="/" replace />} />
      <Route path="/officer/confirmations" element={user?.role === "RESERVATION_OFFICER" ? <ConfirmationsPage /> : <Navigate to="/" replace />} />
      <Route path="/client" element={user?.role === "CLIENT" ? <ClientPortal /> : <Navigate to="/" replace />} />
      <Route path="/client/confirmations" element={user?.role === "CLIENT" ? <ConfirmationsPage /> : <Navigate to="/" replace />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<PasswordResetPage />} />
      <Route path="/catalog" element={<ServiceCatalog />} />
      <Route path="/book" element={<BookingPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
