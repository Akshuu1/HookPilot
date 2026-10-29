import { NavLink } from 'react-router-dom';
import { Webhook, Activity, Settings, TrendingUp } from 'lucide-react';
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
      to: '/analytics',
      label: 'Analytics',
      icon: TrendingUp,
    },
    {
      to: '/settings',
      label: 'Settings',
      icon: Settings,
    },
  ];

  return (
    <aside className="w-64 border-r border-white/[0.08] bg-zinc-950/50 backdrop-blur-md flex flex-col justify-between shrink-0 hidden md:flex">
      <div className="p-4 space-y-1.5">
        <div className="px-3.5 py-2 text-[11px] font-semibold text-zinc-400 uppercase tracking-widest">
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
                  'flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all duration-150',
                  isActive
                    ? 'bg-indigo-500/10 text-indigo-400 font-semibold border border-indigo-500/25 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{link.label}</span>
            </NavLink>
          );
        })}
      </div>

      <div className="p-4 border-t border-white/[0.08]">
        <div className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-3.5 backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-xs font-semibold text-zinc-200">WebSocket Connected</span>
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Streaming live ingest events from Redis BullMQ.
          </p>
        </div>
      </div>
    </aside>
  );
}
