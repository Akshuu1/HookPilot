import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Shield, Key, Trash2, UserPlus, Building, CheckCircle2, Lock } from 'lucide-react';
import type { WorkspaceRole } from '@hookpilot/shared';
import { workspacesApi, type WorkspaceMember } from '../api/workspaces.api.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { useAuthStore } from '../store/auth.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { Modal } from '../components/common/Modal.js';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspace, setCurrentWorkspace } = useWorkspaceStore();
  const { user } = useAuthStore();
  const workspaceId = currentWorkspace?.id;

  // Workspace settings state
  const [workspaceName, setWorkspaceName] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Invite modal state
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('member');
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (currentWorkspace) {
      setWorkspaceName(currentWorkspace.name);
      setRetentionDays(currentWorkspace.retentionDays || 30);
    }
  }, [currentWorkspace]);

  // Fetch workspace members
  const {
    data: membersData,
    isLoading: isMembersLoading,
    error: membersError,
    refetch: refetchMembers,
  } = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await workspacesApi.listMembers(workspaceId);
      return res.members;
    },
    enabled: !!workspaceId,
  });

  // Update workspace mutation
  const updateWorkspaceMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace selected');
      return workspacesApi.update(workspaceId, {
        name: workspaceName.trim(),
        retentionDays,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      if (currentWorkspace) {
        setCurrentWorkspace({
          ...res.workspace,
          role: currentWorkspace.role,
        });
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    },
  });

  // Add member mutation
  const addMemberMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace selected');
      return workspacesApi.addMember(workspaceId, {
        email: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members', workspaceId] });
      setIsInviteOpen(false);
      setInviteEmail('');
      setInviteRole('member');
      setInviteError(null);
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { error?: { message?: string } } } };
      setInviteError(axiosErr.response?.data?.error?.message || 'Failed to add member');
    },
  });

  // Change role mutation
  const changeRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: WorkspaceRole }) => {
      if (!workspaceId) throw new Error('No workspace');
      return workspacesApi.changeRole(workspaceId, userId, role);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members', workspaceId] });
    },
  });

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      if (!workspaceId) throw new Error('No workspace');
      return workspacesApi.removeMember(workspaceId, userId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members', workspaceId] });
    },
  });

  const isOwnerOrAdmin = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'admin';
  const members = membersData || [];

  return (
    <div className="max-w-4xl space-y-8">
      {/* Page Title */}
      <div className="border-b border-white/[0.08] pb-6">
        <h2 className="text-2xl font-bold text-zinc-100 tracking-tight font-sans">
          Workspace Settings
        </h2>
        <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
          Manage workspace profile, retention TTL policy, team access, and role permissions.
        </p>
      </div>

      {/* Workspace General Config */}
      <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
        <div className="flex items-center gap-2.5 mb-5 text-sm font-bold text-zinc-100 font-sans tracking-tight">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Building className="h-4 w-4" />
          </div>
          <span>General Configuration</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isOwnerOrAdmin && workspaceName.trim()) {
              updateWorkspaceMutation.mutate();
            }
          }}
          className="space-y-4 max-w-lg"
        >
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
              Workspace Name
            </label>
            <input
              type="text"
              required
              disabled={!isOwnerOrAdmin}
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 text-zinc-100 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 disabled:opacity-50 transition-all font-sans"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
              Webhook Retention Policy (Days)
            </label>
            <input
              type="number"
              min={1}
              max={365}
              disabled={!isOwnerOrAdmin}
              value={retentionDays}
              onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 30)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 text-zinc-100 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 disabled:opacity-50 transition-all font-mono"
            />
            <p className="text-[11px] text-zinc-500 mt-1.5 font-sans leading-relaxed">
              Events are automatically pruned via MongoDB TTL index when expiresAt passes.
            </p>
          </div>

          {isOwnerOrAdmin && (
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={updateWorkspaceMutation.isPending || !workspaceName.trim()}
                className="px-4 py-2.5 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {updateWorkspaceMutation.isPending ? 'Saving...' : 'Save Settings'}
              </button>

              {saveSuccess && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold animate-fade-in font-mono">
                  <CheckCircle2 className="h-4 w-4" />
                  Saved!
                </span>
              )}
            </div>
          )}
        </form>
      </section>

      {/* Team Members & Roles */}
      <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2.5 text-sm font-bold text-zinc-100 font-sans tracking-tight">
              <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Users className="h-4 w-4" />
              </div>
              <span>Team Members & Roles</span>
            </div>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              Role permissions: Owner & Admin (full access), Member (create endpoints & replay),
              Viewer (read-only).
            </p>
          </div>

          {isOwnerOrAdmin && (
            <button
              onClick={() => {
                setInviteError(null);
                setIsInviteOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] shrink-0"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>Add Member</span>
            </button>
          )}
        </div>

        {isMembersLoading ? (
          <LoadingSpinner message="Loading team members..." />
        ) : membersError ? (
          <ErrorAlert message="Failed to load members." onRetry={() => refetchMembers()} />
        ) : (
          <div className="rounded-xl border border-white/[0.08] bg-zinc-950 overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.08] bg-zinc-900/80 text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Joined</th>
                  {isOwnerOrAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {members.map((m: WorkspaceMember) => {
                  const memberUserId = m.userId?.id || m.userId?._id;
                  const isSelf = memberUserId === user?.id;

                  return (
                    <tr key={m.id} className="hover:bg-white/[0.03] transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-zinc-200">
                          {m.userId?.name || 'User'}{' '}
                          {isSelf && (
                            <span className="text-[10px] text-emerald-400 font-normal">(you)</span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 font-mono">{m.userId?.email}</div>
                      </td>

                      <td className="px-4 py-3">
                        {isOwnerOrAdmin && !isSelf && m.role !== 'owner' ? (
                          <select
                            value={m.role}
                            onChange={(e) =>
                              changeRoleMutation.mutate({
                                userId: memberUserId!,
                                role: e.target.value as WorkspaceRole,
                              })
                            }
                            className="px-2 py-1 rounded-lg border border-white/[0.08] bg-zinc-900 text-zinc-200 text-xs focus:outline-none"
                          >
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        ) : (
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${
                              m.role === 'owner'
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : m.role === 'admin'
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                  : 'bg-zinc-800 text-zinc-300 border-white/[0.08]'
                            }`}
                          >
                            {m.role}
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-zinc-400 font-mono text-[11px]">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </td>

                      {isOwnerOrAdmin && (
                        <td className="px-4 py-3 text-right">
                          {!isSelf && m.role !== 'owner' && (
                            <button
                              onClick={() => {
                                if (confirm(`Remove ${m.userId?.email} from workspace?`)) {
                                  removeMemberMutation.mutate(memberUserId!);
                                }
                              }}
                              className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                              title="Remove member"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Security & Cryptography Information */}
      <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
        <div className="flex items-center gap-2.5 mb-3 text-sm font-bold text-white">
          <Shield className="h-4 w-4 text-emerald-400" />
          <span>Security & Encryption Vault</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="p-3.5 rounded-xl border border-white/[0.08] bg-zinc-950">
            <div className="font-semibold text-zinc-200 mb-1 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
              <span>AES-256-GCM Vault</span>
            </div>
            <p className="text-zinc-400 leading-relaxed text-[11px]">
              All webhook secrets (Stripe, GitHub, Generic) are encrypted with an authenticated
              256-bit AES cipher before storage. Raw secrets are never returned in API payloads.
            </p>
          </div>

          <div className="p-3.5 rounded-xl border border-white/[0.08] bg-zinc-950">
            <div className="font-semibold text-zinc-200 mb-1 flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5 text-emerald-400" />
              <span>SSRF & DNS Guard</span>
            </div>
            <p className="text-zinc-400 leading-relaxed text-[11px]">
              Destination delivery URLs resolve via isolated DNS checks to block loopback
              (127.0.0.1, ::1), private subnets (10.0.0.0/8, 192.168.0.0/16), and cloud metadata
              services.
            </p>
          </div>
        </div>
      </section>

      {/* Invite Member Modal */}
      <Modal
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
        title="Add Workspace Member"
        description="Grant access to this workspace by email address."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (inviteEmail.trim()) {
              addMemberMutation.mutate();
            }
          }}
          className="space-y-4"
        >
          {inviteError && <ErrorAlert message={inviteError} />}

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              User Email Address
            </label>
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">Role Level</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
            >
              <option value="admin">Admin (Full workspace and member management)</option>
              <option value="member">Member (Create endpoints, trigger replays)</option>
              <option value="viewer">Viewer (Read-only observation)</option>
            </select>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={() => setIsInviteOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={addMemberMutation.isPending || !inviteEmail.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-white text-zinc-950 hover:bg-zinc-200 shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {addMemberMutation.isPending ? 'Adding...' : 'Add Member'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
