import { NavLink } from 'react-router-dom';
import { Webhook, Activity, Settings, TrendingUp } from 'lucide-react';
import clsx from 'clsx';

export function Sidebar() {
  const links = [
    {
      to: '/endpoints',
      label: 'Endpoints & Destinations',
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
    <aside className="fixed left-3.5 top-1/2 -translate-y-1/2 z-40 hidden md:flex flex-col items-center justify-center gap-3 select-none">
      {/* Floating Pill Dock */}
      <div className="w-12 rounded-full border border-white/[0.12] bg-[#121215]/95 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.7)] py-2.5 px-1.5 flex flex-col items-center gap-2 ring-1 ring-white/[0.06]">
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              title={link.label}
              className={({ isActive }) =>
                clsx(
                  'relative h-9 w-9 rounded-full flex items-center justify-center transition-all duration-200 group',
                  isActive
                    ? 'bg-[#ccff00] text-black shadow-[0_0_16px_rgba(204,255,0,0.5)] ring-2 ring-[#ccff00]/40'
                    : 'text-zinc-400 hover:text-white hover:bg-white/[0.08]',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={clsx(
                      'h-4 w-4 transition-transform group-hover:scale-110',
                      isActive ? 'text-black stroke-[2.5]' : 'text-zinc-400 group-hover:text-white',
                    )}
                  />
                  {/* Tooltip on hover */}
                  <span className="pointer-events-none absolute left-full ml-3 px-2 py-1 rounded-md bg-zinc-900 border border-white/10 text-[10px] font-mono text-zinc-200 whitespace-nowrap shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-50">
                    {link.label}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>

      {/* Live Stream Pulse Pill */}
      <div
        title="WebSocket live stream active"
        className="h-7 w-7 rounded-full border border-white/[0.1] bg-[#121215]/95 flex items-center justify-center backdrop-blur-md shadow-lg"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#ccff00]"></span>
        </span>
      </div>
    </aside>
  );
}
