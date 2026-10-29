import { Radio, LogOut, Sun, Moon, User } from 'lucide-react';
import { useAuthStore } from '../../store/auth.store.js';
import { useThemeStore } from '../../store/theme.store.js';
import { authApi } from '../../api/auth.api.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export function Navbar() {
  const { user, clearAuth } = useAuthStore();
  const { isDark, toggleTheme } = useThemeStore();

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore network errors on logout
    }
    clearAuth();
  };

  return (
    <header className="h-16 border-b border-white/[0.08] bg-zinc-950/70 backdrop-blur-xl px-4 sm:px-8 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 ring-1 ring-white/20">
            <Radio className="h-4 w-4 text-white" />
          </div>
          <div>
            <span className="text-base font-bold tracking-tight text-white flex items-center gap-1.5 font-sans">
              HookPilot
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                PRO
              </span>
            </span>
          </div>
        </div>

        <div className="h-5 w-px bg-white/[0.08] hidden sm:block" />

        <WorkspaceSwitcher />
      </div>

      <div className="flex items-center gap-3">
        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/[0.05] transition-all"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* User Info */}
        <div className="flex items-center gap-2.5 pl-3 border-l border-white/[0.08]">
          <div className="h-8 w-8 rounded-full bg-zinc-800 border border-white/[0.1] text-zinc-200 flex items-center justify-center text-xs font-semibold shadow-inner">
            {user?.name ? user.name[0]?.toUpperCase() : <User className="h-3.5 w-3.5" />}
          </div>
          <div className="hidden md:block text-left mr-1">
            <div className="text-xs font-semibold text-zinc-100 leading-none mb-1 truncate max-w-[130px]">
              {user?.name || 'User'}
            </div>
            <div className="text-[11px] text-zinc-400 font-mono leading-none truncate max-w-[130px]">
              {user?.email}
            </div>
          </div>

          <button
            onClick={handleLogout}
            title="Log out"
            className="p-2 rounded-xl text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors ml-1"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
