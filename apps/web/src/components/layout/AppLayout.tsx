import { useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { Webhook, Activity, Settings } from 'lucide-react';
import clsx from 'clsx';
import { Navbar } from './Navbar.js';
import { Sidebar } from './Sidebar.js';
import { useWorkspaceStore } from '../../store/workspace.store.js';
import { realtimeSocket } from '../../realtime/socket.js';

export function AppLayout() {
  const { currentWorkspace } = useWorkspaceStore();

  useEffect(() => {
    if (currentWorkspace?.id) {
      realtimeSocket.connect();
      realtimeSocket.joinWorkspace(currentWorkspace.id);
    }
  }, [currentWorkspace?.id]);

  const mobileLinks = [
    { to: '/endpoints', label: 'Endpoints', icon: Webhook },
    { to: '/events', label: 'Inspector', icon: Activity },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-transparent text-zinc-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-8 pb-24 md:pb-8">
          <div className="max-w-7xl mx-auto w-full">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 h-16 bg-zinc-950/80 border-t border-white/[0.08] backdrop-blur-xl flex items-center justify-around px-2 z-40">
        {mobileLinks.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                clsx(
                  'flex flex-col items-center gap-1 py-1.5 px-3 rounded-xl text-[11px] font-medium transition-all',
                  isActive ? 'text-indigo-400 font-semibold' : 'text-zinc-400 hover:text-zinc-100',
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span>{link.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
