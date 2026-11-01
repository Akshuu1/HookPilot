import { useState, useEffect } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Lock } from 'lucide-react';
import { authApi } from '../api/auth.api.js';
import { API_URL } from '../api/client.js';
import { useAuthStore } from '../store/auth.store.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { GitHubIcon, GoogleIcon } from '../components/common/BrandIcons.js';
import { sanitizeRelativePath, getOAuthErrorMessage } from '../utils/oauth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();

  const [isRegister, setIsRegister] = useState(location.pathname === '/register');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    () => getOAuthErrorMessage(searchParams.get('error')) || null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [navigatingProvider, setNavigatingProvider] = useState<'github' | 'google' | null>(null);

  // Enabled provider statuses from server
  const [providers, setProviders] = useState<{ github: boolean; google: boolean }>({
    github: true,
    google: true,
  });

  // Keep isRegister in sync if path changes between /login and /register
  useEffect(() => {
    setIsRegister(location.pathname === '/register');
  }, [location.pathname]);

  // Fetch configured providers from backend
  useEffect(() => {
    let isMounted = true;
    authApi
      .getProviders()
      .then((res) => {
        if (isMounted && res?.providers) {
          setProviders(res.providers);
        }
      })
      .catch(() => {
        // Fallback default allows discovery unless explicitly disabled
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Inspect query params for friendly OAuth error messages and reset provider loading
  useEffect(() => {
    const queryError = searchParams.get('error');
    if (queryError) {
      const friendly = getOAuthErrorMessage(queryError);
      if (friendly) {
        setError(friendly);
      }
    }
    // Always clear navigating state whenever searchParams changes (e.g. redirected with error)
    setNavigatingProvider(null);
  }, [searchParams]);

  // Reset navigatingProvider if user returns via bfcache (Back button) or window focus
  useEffect(() => {
    const handleReactivate = () => {
      setNavigatingProvider(null);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setNavigatingProvider(null);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', handleReactivate);
      window.addEventListener('focus', handleReactivate);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', handleReactivate);
        window.removeEventListener('focus', handleReactivate);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  // Determine safe intended redirect path
  const returnTo = sanitizeRelativePath(
    (location.state as { from?: { pathname?: string } })?.from?.pathname ||
      searchParams.get('returnTo'),
    '/endpoints',
  );

  const handleOAuthClick = (provider: 'github' | 'google') => {
    if (navigatingProvider) return;
    setNavigatingProvider(provider);
    // Direct full-page navigation to OAuth start endpoint
    window.location.href = `${API_URL}/auth/oauth/${provider}/start?returnTo=${encodeURIComponent(
      returnTo,
    )}`;

    // Fallback timer: if browser hasn't unloaded after 6s (e.g. cancelled before leave), re-enable
    setTimeout(() => {
      setNavigatingProvider(null);
    }, 6000);
  };

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

  const hasAnyOAuthProvider = providers.github || providers.google;

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

          {/* Social OAuth Providers */}
          {hasAnyOAuthProvider && (
            <div className="space-y-2.5 mb-6">
              {providers.github && (
                <button
                  type="button"
                  aria-label="Continue with GitHub"
                  disabled={!!navigatingProvider || isSubmitting}
                  onClick={() => handleOAuthClick('github')}
                  className="w-full py-2.5 px-4 rounded-xl border border-white/[0.12] bg-zinc-950/80 hover:bg-zinc-800 text-zinc-100 font-semibold text-xs shadow-sm flex items-center justify-center gap-2.5 transition-all active:scale-[0.98] disabled:opacity-50"
                >
                  <GitHubIcon className="h-4 w-4" />
                  <span>
                    {navigatingProvider === 'github'
                      ? 'Redirecting to GitHub...'
                      : 'Continue with GitHub'}
                  </span>
                </button>
              )}

              {providers.google && (
                <button
                  type="button"
                  aria-label="Continue with Google"
                  disabled={!!navigatingProvider || isSubmitting}
                  onClick={() => handleOAuthClick('google')}
                  className="w-full py-2.5 px-4 rounded-xl border border-white/[0.12] bg-zinc-950/80 hover:bg-zinc-800 text-zinc-100 font-semibold text-xs shadow-sm flex items-center justify-center gap-2.5 transition-all active:scale-[0.98] disabled:opacity-50"
                >
                  <GoogleIcon className="h-4 w-4" />
                  <span>
                    {navigatingProvider === 'google'
                      ? 'Redirecting to Google...'
                      : 'Continue with Google'}
                  </span>
                </button>
              )}

              {/* 'or' divider */}
              <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/[0.08]" />
                </div>
                <div className="relative flex justify-center text-[11px] uppercase">
                  <span className="bg-[#121215] px-2.5 text-zinc-500 font-mono">or</span>
                </div>
              </div>
            </div>
          )}

          {/* Email / Password Form */}
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
              disabled={isSubmitting || !!navigatingProvider}
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
