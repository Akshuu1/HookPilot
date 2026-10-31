import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { authApi } from '../api/auth.api.js';
import { useAuthStore } from '../store/auth.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { sanitizeRelativePath, getOAuthErrorMessage } from '../utils/oauth.js';

export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(
    () => getOAuthErrorMessage(searchParams.get('error')) || null,
  );

  useEffect(() => {
    let isCancelled = false;

    async function completeOAuth() {
      // 1. Check for immediate error query parameters from provider redirect
      const queryError = searchParams.get('error');
      if (queryError) {
        setError(getOAuthErrorMessage(queryError));
        return;
      }

      try {
        // 2. Refresh session using httpOnly cookie issued by OAuth callback
        const refreshRes = await authApi.refresh();
        if (!refreshRes?.accessToken) {
          throw new Error('No access token received from authentication session.');
        }

        useAuthStore.getState().setAccessToken(refreshRes.accessToken);

        // 3. Fetch authenticated user profile and connected identities
        const meRes = await authApi.getMe();
        if (isCancelled) return;

        setAuth(meRes.user, refreshRes.accessToken);

        // 4. Extract and strictly sanitize the next destination path
        const nextParam = searchParams.get('next');
        const safeDestination = sanitizeRelativePath(nextParam, '/endpoints');

        navigate(safeDestination, { replace: true });
      } catch (err: unknown) {
        if (isCancelled) return;
        const axiosErr = err as {
          response?: { data?: { error?: { message?: string }; message?: string } };
          message?: string;
        };

        const message =
          axiosErr.response?.data?.error?.message ||
          axiosErr.response?.data?.message ||
          axiosErr.message ||
          'Failed to complete authentication. Your session could not be established.';

        setError(message);
      }
    }

    completeOAuth();

    return () => {
      isCancelled = true;
    };
  }, [navigate, searchParams, setAuth]);

  if (error) {
    return (
      <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col justify-center items-center p-6 selection:bg-[#ccff00]/20 selection:text-[#ccff00] font-sans">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/20 bg-zinc-900/40 p-8 shadow-2xl backdrop-blur-xl ring-1 ring-rose-500/10 text-center">
          <div className="inline-flex h-12 w-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 items-center justify-center mb-4">
            <AlertCircle className="h-6 w-6" />
          </div>

          <h2 className="text-lg font-bold text-zinc-100 mb-2">Authentication Failed</h2>
          <p className="text-xs text-zinc-400 mb-6 leading-relaxed">{error}</p>

          <button
            onClick={() => navigate('/login', { replace: true })}
            className="w-full py-2.5 px-4 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Sign In</span>
          </button>
        </div>
      </div>
    );
  }

  return <LoadingSpinner fullScreen message="Completing authentication..." />;
}
