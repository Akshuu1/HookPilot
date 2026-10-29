import type { EventStatus } from '@hookpilot/shared';
import clsx from 'clsx';

interface StatusBadgeProps {
  status: EventStatus | string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const styles: Record<string, { bg: string; text: string; border: string; dot: string }> = {
    delivered: {
      bg: 'bg-emerald-500/10',
      text: 'text-emerald-400',
      border: 'border-emerald-500/20',
      dot: 'bg-emerald-400',
    },
    delivering: {
      bg: 'bg-cyan-500/10',
      text: 'text-cyan-400',
      border: 'border-cyan-500/20',
      dot: 'bg-cyan-400 animate-ping',
    },
    pending: {
      bg: 'bg-amber-500/10',
      text: 'text-amber-400',
      border: 'border-amber-500/20',
      dot: 'bg-amber-400',
    },
    failed: {
      bg: 'bg-rose-500/10',
      text: 'text-rose-400',
      border: 'border-rose-500/20',
      dot: 'bg-rose-400',
    },
    dead: {
      bg: 'bg-red-950/40',
      text: 'text-red-400',
      border: 'border-red-500/30',
      dot: 'bg-red-500',
    },
  };

  const current = styles[status] || {
    bg: 'bg-zinc-800/80',
    text: 'text-zinc-300',
    border: 'border-white/[0.08]',
    dot: 'bg-zinc-400',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 font-mono uppercase tracking-wider font-semibold border rounded-full',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
        current.bg,
        current.text,
        current.border,
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full ring-2 ring-current/20', current.dot)} />
      {status}
    </span>
  );
}
