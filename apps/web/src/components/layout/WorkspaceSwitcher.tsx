import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Plus, Building2 } from 'lucide-react';
import { workspacesApi } from '../../api/workspaces.api.js';
import type { WorkspaceResponse } from '@hookpilot/shared';
import { useWorkspaceStore } from '../../store/workspace.store.js';
import { Modal } from '../common/Modal.js';
import { realtimeSocket } from '../../realtime/socket.js';

export function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const { currentWorkspace, setCurrentWorkspace, setWorkspaces } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceRetention, setNewWorkspaceRetention] = useState(30);

  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const res = await workspacesApi.listMine();
      setWorkspaces(res.workspaces);
      return res.workspaces;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      return workspacesApi.create({
        name: newWorkspaceName.trim(),
        retentionDays: newWorkspaceRetention,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      const newWs: WorkspaceResponse = { ...res.workspace, role: 'owner' };
      setCurrentWorkspace(newWs);
      realtimeSocket.joinWorkspace(newWs.id);
      setIsCreateOpen(false);
      setNewWorkspaceName('');
    },
  });

  const handleSelect = (ws: WorkspaceResponse) => {
    setCurrentWorkspace(ws);
    realtimeSocket.joinWorkspace(ws.id);
    setIsOpen(false);
  };

  const workspaces = data || [];

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800/80 text-left transition-colors"
        >
          <div className="h-7 w-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white truncate max-w-[140px] sm:max-w-[180px]">
              {currentWorkspace?.name || (isLoading ? 'Loading...' : 'Select Workspace')}
            </div>
            {currentWorkspace?.role && (
              <div className="text-[10px] font-medium text-slate-400 capitalize">
                {currentWorkspace.role}
              </div>
            )}
          </div>
          <ChevronDown className="h-4 w-4 text-slate-400 shrink-0 ml-1" />
        </button>

        {isOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setIsOpen(false)} />
            <div className="absolute left-0 mt-2 w-64 rounded-xl border border-slate-800 bg-slate-900 shadow-2xl p-1.5 z-30">
              <div className="px-2.5 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Workspaces
              </div>
              <div className="max-h-60 overflow-y-auto space-y-0.5">
                {workspaces.map((ws) => {
                  const isSelected = ws.id === currentWorkspace?.id;
                  return (
                    <button
                      key={ws.id}
                      onClick={() => handleSelect(ws)}
                      className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium text-left hover:bg-slate-800 text-slate-200 transition-colors"
                    >
                      <div className="truncate mr-2">
                        <div className="text-slate-100 font-semibold truncate">{ws.name}</div>
                        <div className="text-[10px] text-slate-400 capitalize">{ws.role}</div>
                      </div>
                      {isSelected && <Check className="h-4 w-4 text-indigo-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-slate-800 mt-1 pt-1">
                <button
                  onClick={() => {
                    setIsOpen(false);
                    setIsCreateOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Workspace</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create Workspace Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create New Workspace"
        description="Workspaces isolate your endpoints, webhooks, and team members."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newWorkspaceName.trim()) {
              createMutation.mutate();
            }
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Workspace Name
            </label>
            <input
              type="text"
              required
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="e.g. Acme Production"
              className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Webhook Retention (Days)
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={newWorkspaceRetention}
              onChange={(e) => setNewWorkspaceRetention(parseInt(e.target.value, 10) || 30)}
              className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Webhooks older than this period are automatically purged.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || !newWorkspaceName.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
