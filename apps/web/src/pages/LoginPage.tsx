import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Lock } from 'lucide-react';
import { authApi } from '../api/auth.api.js';
import { API_URL } from '../api/client.js';
import { useAuthStore } from '../store/auth.store.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { setAuth } = useAuthStore();
  const [isRegister, setIsRegister] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (isRegister) {
        const res = await authApi.register({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
        });
        setAuth(res.user, res.accessToken);
      } else {
        const res = await authApi.login({
          email: email.trim().toLowerCase(),
          password,
        });
        setAuth(res.user, res.accessToken);
      }
      navigate('/endpoints');
    } catch (err: unknown) {
      const axiosErr = err as {
        message?: string;
        response?: { data?: { error?: { message?: string }; message?: string } };
      };
      if (!axiosErr.response) {
        setError(
          `Unable to connect to backend at ${API_URL}. If you just added VITE_API_URL on Vercel, please trigger a Redeploy so the frontend picks it up.`,
        );
      } else {
        setError(
          axiosErr.response.data?.error?.message ||
            axiosErr.response.data?.message ||
            'Invalid email or password. If you do not have an account yet, please click Sign Up below.',
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col justify-center items-center p-6 selection:bg-[#ccff00]/20 selection:text-[#ccff00] relative overflow-hidden font-sans">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 rounded-2xl bg-zinc-900 border border-white/20 text-[#ccff00] items-center justify-center shadow-lg mb-4 ring-1 ring-white/10 font-mono font-bold text-lg">
            H
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100 font-sans">
            HookPilot Platform
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
            High-reliability webhook receiving, forwarding & inspection
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-8 shadow-2xl backdrop-blur-xl ring-1 ring-white/[0.03]">
          {/* Tabs */}
          <div className="grid grid-cols-2 p-1 rounded-xl bg-zinc-950/80 border border-white/[0.08] mb-6 shadow-inner font-mono text-xs">
            <button
              type="button"
              onClick={() => {
                setIsRegister(false);
                setError(null);
              }}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                !isRegister
                  ? 'bg-white text-zinc-950 shadow-sm font-bold'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setIsRegister(true);
                setError(null);
              }}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                isRegister
                  ? 'bg-white text-zinc-950 shadow-sm font-bold'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Create Account
            </button>
          </div>

          {error && (
            <div className="mb-6">
              <ErrorAlert message={error} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegister && (
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex Mercer"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 text-zinc-100 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-all font-sans placeholder:text-zinc-600"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Work Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="developer@company.com"
                className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 text-zinc-100 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-all font-sans placeholder:text-zinc-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 text-zinc-100 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-all font-sans placeholder:text-zinc-600"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 py-3 px-4 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              <span>
                {isSubmitting ? 'Authenticating...' : isRegister ? 'Register' : 'Sign In'}
              </span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-white/[0.06] grid grid-cols-2 gap-4 text-center">
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-400 font-mono">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>JWT & bcrypt(10)</span>
            </div>
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-400 font-mono">
              <Lock className="h-3.5 w-3.5 text-indigo-400" />
              <span>AES-256 Vault</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
