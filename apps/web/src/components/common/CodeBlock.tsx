import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import clsx from 'clsx';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, language = 'json', maxHeight = 'max-h-80' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="relative rounded-xl border border-slate-800 bg-slate-950/80 overflow-hidden group">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/80 bg-slate-900/50">
        <span className="text-xs font-mono font-medium text-slate-400 uppercase">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-800/50 hover:bg-slate-800 transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre
        className={clsx(
          'p-4 text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre leading-relaxed select-text',
          maxHeight,
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
