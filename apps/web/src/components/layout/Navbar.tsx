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
    <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Radio className="h-4 w-4 text-white animate-pulse" />
          </div>
          <div>
            <span className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
              HookPilot
            </span>
          </div>
        </div>

        <div className="h-5 w-px bg-slate-800 hidden sm:block" />

        <WorkspaceSwitcher />
      </div>

      <div className="flex items-center gap-3">
        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* User Info */}
        <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
          <div className="h-7 w-7 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-xs font-semibold">
            {user?.name ? user.name[0]?.toUpperCase() : <User className="h-3.5 w-3.5" />}
          </div>
          <div className="hidden md:block text-left mr-2">
            <div className="text-xs font-semibold text-white leading-none mb-0.5 truncate max-w-[120px]">
              {user?.name || 'User'}
            </div>
            <div className="text-[10px] text-slate-400 leading-none truncate max-w-[120px]">
              {user?.email}
            </div>
          </div>

          <button
            onClick={handleLogout}
            title="Log out"
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
