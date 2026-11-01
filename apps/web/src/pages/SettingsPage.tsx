import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  Shield,
  Key,
  Trash2,
  UserPlus,
  Building,
  CheckCircle2,
  Lock,
  Link2,
} from 'lucide-react';
import type { WorkspaceRole } from '@hookpilot/shared';
import { workspacesApi, type WorkspaceMember } from '../api/workspaces.api.js';
import { authApi } from '../api/auth.api.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { useAuthStore } from '../store/auth.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { Modal } from '../components/common/Modal.js';
import { GitHubIcon, GoogleIcon } from '../components/common/BrandIcons.js';
import { getOAuthErrorMessage } from '../utils/oauth.js';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const wsStore = useWorkspaceStore();
  const currentWorkspace =
    wsStore.currentWorkspace || useWorkspaceStore.getState().currentWorkspace;
  const setCurrentWorkspace = wsStore.setCurrentWorkspace;

  const authStore = useAuthStore();
  const user = authStore.user || useAuthStore.getState().user;
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

  // Connected accounts state
  const [accountSuccess, setAccountSuccess] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<'github' | 'google' | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  useEffect(() => {
    if (currentWorkspace) {
      setWorkspaceName(currentWorkspace.name);
      setRetentionDays(currentWorkspace.retentionDays || 30);
    }
  }, [currentWorkspace]);

  // Fetch current user and identities
  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await authApi.getMe();
      return res.user;
    },
    initialData: user || undefined,
  });

  const currentUser = meData || user;

  // Fetch configured OAuth providers
  const { data: providersConfig } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () => authApi.getProviders(),
  });
  const providers = providersConfig?.providers ?? { github: true, google: true };

  // Inspect query params for linking feedback
  useEffect(() => {
    const success = searchParams.get('success');
    if (success === 'oauth_linked') {
      setAccountSuccess('Connected account successfully linked!');
      authApi.getMe().then((res) => {
        if (res?.user) {
          useAuthStore.getState().setAuth(res.user, useAuthStore.getState().accessToken!);
          queryClient.invalidateQueries({ queryKey: ['me'] });
        }
      });
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.delete('success');
        return next;
      });
      setTimeout(() => setAccountSuccess(null), 4000);
    }

    const err = searchParams.get('error');
    if (err) {
      setAccountError(getOAuthErrorMessage(err));
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.delete('error');
        return next;
      });
      setTimeout(() => setAccountError(null), 6000);
    }
    setConnectingProvider(null);
  }, [searchParams, setSearchParams, queryClient]);

  // Reset connectingProvider if user returns via bfcache (Back button) or window focus
  useEffect(() => {
    const handleReactivate = () => {
      setConnectingProvider(null);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setConnectingProvider(null);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', handleReactivate);
      window.addEventListener('focus', handleReactivate);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', handleReactivate);
        window.removeEventListener('focus', handleReactivate);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  // Check if a linked identity is the user's only login method
  const githubIdentity = currentUser?.identities?.find((i) => i.provider === 'github');
  const googleIdentity = currentUser?.identities?.find((i) => i.provider === 'google');
  const isLastLoginMethod =
    !currentUser?.hasPassword && (currentUser?.identities?.length || 0) <= 1;

  const handleConnect = async (provider: 'github' | 'google') => {
    if (connectingProvider) return;
    setConnectingProvider(provider);
    setAccountError(null);
    try {
      const res = await authApi.linkStart(provider, '/settings');
      if (res?.url) {
        window.location.href = res.url;
        setTimeout(() => {
          setConnectingProvider(null);
        }, 6000);
      } else {
        setConnectingProvider(null);
      }
    } catch (err: unknown) {
      setConnectingProvider(null);
      const axiosErr = err as { response?: { data?: { error?: { message?: string } } } };
      setAccountError(
        axiosErr.response?.data?.error?.message || `Failed to initiate ${provider} connection`,
      );
    }
  };

  const handleDisconnect = async (identityId: string) => {
    if (disconnectingId || isLastLoginMethod) return;
    setDisconnectingId(identityId);
    setAccountError(null);
    try {
      await authApi.unlinkIdentity(identityId);
      const res = await authApi.getMe();
      if (res?.user) {
        useAuthStore.getState().setAuth(res.user, useAuthStore.getState().accessToken!);
        queryClient.invalidateQueries({ queryKey: ['me'] });
      }
      setAccountSuccess('Account disconnected successfully');
      setTimeout(() => setAccountSuccess(null), 3000);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { message?: string } } } };
      setAccountError(axiosErr.response?.data?.error?.message || 'Failed to disconnect account');
    } finally {
      setDisconnectingId(null);
    }
  };

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
          Manage workspace profile, retention TTL policy, connected logins, team access, and role
          permissions.
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

      {/* Connected Accounts */}
      <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2.5 text-sm font-bold text-zinc-100 font-sans tracking-tight">
              <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Link2 className="h-4 w-4" />
              </div>
              <span>Connected Accounts</span>
            </div>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              Link your GitHub or Google accounts to log in with a single click.
            </p>
          </div>
        </div>

        {accountSuccess && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2 font-sans">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>{accountSuccess}</span>
          </div>
        )}

        {accountError && (
          <div className="mb-4">
            <ErrorAlert message={accountError} />
          </div>
        )}

        <div className="space-y-3">
          {/* GitHub Provider Row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-white/[0.08] bg-zinc-950/60 gap-4">
            <div className="flex items-center gap-3.5">
              <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/[0.1] text-zinc-100 flex items-center justify-center shrink-0">
                <GitHubIcon className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-zinc-100">GitHub</span>
                  {githubIdentity ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
                      Connected
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-white/[0.06] uppercase tracking-wider">
                      Not Connected
                    </span>
                  )}
                </div>
                {githubIdentity ? (
                  <div className="flex items-center gap-2 mt-1">
                    {githubIdentity.avatarUrl && (
                      <img
                        src={githubIdentity.avatarUrl}
                        alt="GitHub avatar"
                        className="h-4 w-4 rounded-full border border-white/20 object-cover"
                      />
                    )}
                    <span className="text-[11px] text-zinc-400 font-mono">
                      {githubIdentity.email}
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    Link your GitHub account for instant sign-in.
                  </p>
                )}
              </div>
            </div>

            <div>
              {githubIdentity ? (
                <div className="relative group/tip inline-block">
                  <button
                    type="button"
                    disabled={isLastLoginMethod || disconnectingId === githubIdentity.id}
                    onClick={() => handleDisconnect(githubIdentity.id)}
                    title={
                      isLastLoginMethod
                        ? 'Cannot disconnect your only login method. Please add a password or connect another provider first.'
                        : undefined
                    }
                    className="px-3.5 py-2 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <span>
                      {disconnectingId === githubIdentity.id ? 'Disconnecting...' : 'Disconnect'}
                    </span>
                  </button>
                  {isLastLoginMethod && (
                    <div className="absolute right-0 bottom-full mb-1.5 hidden group-hover/tip:block z-20 w-64 p-2 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-zinc-300 shadow-xl leading-snug">
                      Cannot disconnect your only login method. Please add a password or connect
                      another provider first.
                    </div>
                  )}
                </div>
              ) : providers.github ? (
                <button
                  type="button"
                  disabled={!!connectingProvider}
                  onClick={() => handleConnect('github')}
                  className="px-3.5 py-2 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5"
                >
                  <GitHubIcon className="h-3.5 w-3.5" />
                  <span>
                    {connectingProvider === 'github' ? 'Connecting...' : 'Connect GitHub'}
                  </span>
                </button>
              ) : (
                <span className="text-[11px] text-zinc-500 font-mono italic">
                  Not configured on server
                </span>
              )}
            </div>
          </div>

          {/* Google Provider Row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-white/[0.08] bg-zinc-950/60 gap-4">
            <div className="flex items-center gap-3.5">
              <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/[0.1] text-zinc-100 flex items-center justify-center shrink-0">
                <GoogleIcon className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-zinc-100">Google</span>
                  {googleIdentity ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
                      Connected
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-white/[0.06] uppercase tracking-wider">
                      Not Connected
                    </span>
                  )}
                </div>
                {googleIdentity ? (
                  <div className="flex items-center gap-2 mt-1">
                    {googleIdentity.avatarUrl && (
                      <img
                        src={googleIdentity.avatarUrl}
                        alt="Google avatar"
                        className="h-4 w-4 rounded-full border border-white/20 object-cover"
                      />
                    )}
                    <span className="text-[11px] text-zinc-400 font-mono">
                      {googleIdentity.email}
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    Link your Google account for single sign-on access.
                  </p>
                )}
              </div>
            </div>

            <div>
              {googleIdentity ? (
                <div className="relative group/tip inline-block">
                  <button
                    type="button"
                    disabled={isLastLoginMethod || disconnectingId === googleIdentity.id}
                    onClick={() => handleDisconnect(googleIdentity.id)}
                    title={
                      isLastLoginMethod
                        ? 'Cannot disconnect your only login method. Please add a password or connect another provider first.'
                        : undefined
                    }
                    className="px-3.5 py-2 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <span>
                      {disconnectingId === googleIdentity.id ? 'Disconnecting...' : 'Disconnect'}
                    </span>
                  </button>
                  {isLastLoginMethod && (
                    <div className="absolute right-0 bottom-full mb-1.5 hidden group-hover/tip:block z-20 w-64 p-2 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-zinc-300 shadow-xl leading-snug">
                      Cannot disconnect your only login method. Please add a password or connect
                      another provider first.
                    </div>
                  )}
                </div>
              ) : providers.google ? (
                <button
                  type="button"
                  disabled={!!connectingProvider}
                  onClick={() => handleConnect('google')}
                  className="px-3.5 py-2 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5"
                >
                  <GoogleIcon className="h-3.5 w-3.5" />
                  <span>
                    {connectingProvider === 'google' ? 'Connecting...' : 'Connect Google'}
                  </span>
                </button>
              ) : (
                <span className="text-[11px] text-zinc-500 font-mono italic">
                  Not configured on server
                </span>
              )}
            </div>
          </div>
        </div>
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
