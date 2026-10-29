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
    <div className="h-screen w-screen overflow-hidden bg-[#08080a] text-zinc-100 flex flex-col pt-16 font-sans selection:bg-[#ccff00]/20 selection:text-[#ccff00]">
      <Navbar />

      <div className="flex-1 flex overflow-hidden min-h-0">
        <Sidebar />
        <main className="flex-1 my-3 mr-3.5 ml-1 rounded-[2rem] border border-white/[0.08] bg-[#0b0b0e] bg-dot-grid shadow-[0_8px_32px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col ring-1 ring-white/[0.04]">
          <div className="flex-1 overflow-y-auto px-6 lg:px-10 py-7 pb-24 md:pb-8">
            <div className="max-w-7xl mx-auto w-full">
              <Outlet />
            </div>
          </div>
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (Floating Pill) */}
      <nav className="md:hidden fixed bottom-3 inset-x-4 h-14 bg-zinc-950/90 border border-white/[0.1] rounded-full backdrop-blur-xl flex items-center justify-around px-4 z-40 shadow-2xl">
        {mobileLinks.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center justify-center h-10 w-10 rounded-full transition-all',
                  isActive
                    ? 'bg-[#ccff00] text-black shadow-[0_0_12px_rgba(204,255,0,0.4)]'
                    : 'text-zinc-400 hover:text-white',
                )
              }
            >
              <Icon className="h-4 w-4" />
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
