import { NavLink } from 'react-router-dom';
import { Webhook, Activity, Settings } from 'lucide-react';
import clsx from 'clsx';

export function Sidebar() {
  const links = [
    {
      to: '/endpoints',
      label: 'Endpoints',
      icon: Webhook,
    },
    {
      to: '/events',
      label: 'Event Inspector',
      icon: Activity,
    },
    {
      to: '/settings',
      label: 'Settings',
      icon: Settings,
    },
  ];

  return (
    <aside className="w-60 border-r border-slate-800 bg-slate-900/30 flex flex-col justify-between shrink-0 hidden md:flex">
      <div className="p-4 space-y-1">
        <div className="px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          Platform
        </div>
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-colors',
                  isActive
                    ? 'bg-indigo-600/15 text-indigo-400 border border-indigo-500/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{link.label}</span>
            </NavLink>
          );
        })}
      </div>

      <div className="p-4 border-t border-slate-800/60">
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-semibold text-slate-300">Live Realtime</span>
          </div>
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Connected to Socket.IO & Redis channel.
          </p>
        </div>
      </div>
    </aside>
  );
}
