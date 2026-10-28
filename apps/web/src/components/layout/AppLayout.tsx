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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-4 sm:p-8 pb-20 md:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 h-14 bg-slate-900/90 border-t border-slate-800 backdrop-blur-lg flex items-center justify-around px-2 z-40">
        {mobileLinks.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                clsx(
                  'flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-[10px] font-semibold transition-colors',
                  isActive ? 'text-indigo-400' : 'text-slate-400 hover:text-white',
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
