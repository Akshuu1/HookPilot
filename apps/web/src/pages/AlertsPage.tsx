import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bell,
  Mail,
  Send,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
  Trash2,
  Edit2,
  Clock,
  ShieldAlert,
  Activity,
  Play,
  RotateCw,
  ExternalLink,
  Info,
  Check,
} from 'lucide-react';
import type {
  AlertChannelResponse,
  AlertRuleResponse,
  AlertHistoryResponse,
  TestEvaluateResult,
  AlertChannelType,
  AlertConditionType,
  AlertRuleScope,
  AlertRuleCondition,
} from '@hookpilot/shared';
import { alertsApi } from '../api/alerts.api.js';
import { endpointsApi } from '../api/endpoints.api.js';
import { destinationsApi } from '../api/destinations.api.js';
import { workspacesApi } from '../api/workspaces.api.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { realtimeSocket, type AlertStatusMessage } from '../realtime/socket.js';
import { Modal } from '../components/common/Modal.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { EmptyState } from '../components/common/EmptyState.js';

export function AlertsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentWorkspace } = useWorkspaceStore();
  const workspaceId = currentWorkspace?.id;
  const isViewer = currentWorkspace?.role === 'viewer';

  // Active Tab: 'rules' | 'channels' | 'history'
  const activeTab = (searchParams.get('tab') as 'rules' | 'channels' | 'history') || 'rules';
  const setActiveTab = (tab: 'rules' | 'channels' | 'history') => {
    setSearchParams({ tab });
  };

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------
  const {
    data: channelsData,
    isLoading: isChannelsLoading,
    error: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: ['alert-channels', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await alertsApi.listChannels(workspaceId);
      return res.channels;
    },
    enabled: !!workspaceId,
  });

  const {
    data: rulesData,
    isLoading: isRulesLoading,
    error: rulesError,
    refetch: refetchRules,
  } = useQuery({
    queryKey: ['alert-rules', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await alertsApi.listRules(workspaceId);
      return res.rules;
    },
    enabled: !!workspaceId,
    refetchInterval: 10_000, // background live sync
  });

  const {
    data: historyData,
    isLoading: isHistoryLoading,
    error: historyError,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ['alert-history', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await alertsApi.getWorkspaceHistory(workspaceId, 100);
      return res.history;
    },
    enabled: !!workspaceId && activeTab === 'history',
    refetchInterval: 15_000,
  });

  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await endpointsApi.listByWorkspace(workspaceId);
      return res.endpoints;
    },
    enabled: !!workspaceId,
  });

  const { data: membersData } = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await workspacesApi.listMembers(workspaceId);
      return res.members;
    },
    enabled: !!workspaceId,
  });

  const channels = channelsData || [];
  const rules = rulesData || [];
  const history = historyData || [];
  const endpoints = endpointsData || [];
  const members = membersData || [];

  // Query destinations across all endpoints for the scope picker
  const [destinations, setDestinations] = useState<
    Array<{ id: string; name: string; endpointId: string; endpointName: string }>
  >([]);

  useEffect(() => {
    let isMounted = true;
    async function loadDestinations() {
      if (!endpoints.length) {
        if (isMounted) setDestinations([]);
        return;
      }
      try {
        const lists = await Promise.all(
          endpoints.map(async (ep) => {
            const res = await destinationsApi.listByEndpoint(ep.id);
            return res.data.map((d) => ({
              id: d.id,
              name: d.name,
              endpointId: ep.id,
              endpointName: ep.name,
            }));
          }),
        );
        if (isMounted) setDestinations(lists.flat());
      } catch {
        // Ignore destination load error
      }
    }
    loadDestinations();
    return () => {
      isMounted = false;
    };
  }, [endpoints]);

  // --------------------------------------------------------------------------
  // Realtime Live Updates
  // --------------------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = realtimeSocket.onAlertStatus((msg: AlertStatusMessage) => {
      if (msg.workspaceId === workspaceId) {
        queryClient.invalidateQueries({ queryKey: ['alert-rules', workspaceId] });
        queryClient.invalidateQueries({ queryKey: ['alert-history', workspaceId] });
      }
    });
    return () => {
      unsubscribe();
    };
  }, [workspaceId, queryClient]);

  // --------------------------------------------------------------------------
  // Channel Management State & Modals
  // --------------------------------------------------------------------------
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<AlertChannelResponse | null>(null);
  const [channelType, setChannelType] = useState<AlertChannelType>('email');
  const [channelName, setChannelName] = useState('');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [channelModalError, setChannelModalError] = useState<string | null>(null);

  // Testing Channel Feedback
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<{
    channelId: string;
    success: boolean;
    message: string;
  } | null>(null);

  // Delete Channel Confirmation
  const [deletingChannel, setDeletingChannel] = useState<AlertChannelResponse | null>(null);

  const openCreateChannelModal = () => {
    setEditingChannel(null);
    setChannelType('email');
    setChannelName('');
    setSelectedEmails([]);
    setSlackWebhookUrl('');
    setChannelModalError(null);
    setIsChannelModalOpen(true);
  };

  const openEditChannelModal = (ch: AlertChannelResponse) => {
    setEditingChannel(ch);
    setChannelType(ch.type);
    setChannelName(ch.name);
    setSelectedEmails(ch.configPreview.emails || []);
    setSlackWebhookUrl(ch.configPreview.webhookUrlMasked || '');
    setChannelModalError(null);
    setIsChannelModalOpen(true);
  };

  const saveChannelMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace selected');
      if (!channelName.trim()) throw new Error('Channel name is required');

      if (channelType === 'email') {
        if (selectedEmails.length === 0) {
          throw new Error('Please select at least one workspace member email');
        }
      } else {
        if (!slackWebhookUrl.trim()) {
          throw new Error('Slack webhook URL is required');
        }
      }

      if (editingChannel) {
        const updatePayload: { name?: string; config?: Record<string, unknown> } = {
          name: channelName.trim(),
        };
        if (channelType === 'email') {
          updatePayload.config = { emails: selectedEmails };
        } else if (slackWebhookUrl && !slackWebhookUrl.includes('••••••••')) {
          updatePayload.config = { webhookUrl: slackWebhookUrl.trim() };
        }
        return alertsApi.updateChannel(editingChannel.id, updatePayload);
      } else {
        const createPayload = {
          type: channelType,
          name: channelName.trim(),
          config:
            channelType === 'email'
              ? { emails: selectedEmails }
              : { webhookUrl: slackWebhookUrl.trim() },
        };
        return alertsApi.createChannel(workspaceId, createPayload);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-channels', workspaceId] });
      setIsChannelModalOpen(false);
    },
    onError: (err: unknown) => {
      const axiosErr = err as {
        response?: { data?: { error?: { message?: string } } };
        message?: string;
      };
      setChannelModalError(
        axiosErr.response?.data?.error?.message || axiosErr.message || 'Failed to save channel',
      );
    },
  });

  const testChannelMutation = useMutation({
    mutationFn: async (channelId: string) => {
      setTestingChannelId(channelId);
      setTestFeedback(null);
      return alertsApi.testChannel(channelId);
    },
    onSuccess: (res, channelId) => {
      setTestingChannelId(null);
      setTestFeedback({
        channelId,
        success: true,
        message:
          res.message || 'Test notification delivered successfully! Channel is now verified.',
      });
      queryClient.invalidateQueries({ queryKey: ['alert-channels', workspaceId] });
      setTimeout(() => {
        setTestFeedback((prev) => (prev?.channelId === channelId ? null : prev));
      }, 5000);
    },
    onError: (err: unknown, channelId) => {
      setTestingChannelId(null);
      const axiosErr = err as {
        response?: { data?: { error?: { message?: string } } };
        message?: string;
      };
      setTestFeedback({
        channelId,
        success: false,
        message:
          axiosErr.response?.data?.error?.message || axiosErr.message || 'Test delivery failed',
      });
    },
  });

  const deleteChannelMutation = useMutation({
    mutationFn: async (channelId: string) => {
      return alertsApi.deleteChannel(channelId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-channels', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['alert-rules', workspaceId] });
      setDeletingChannel(null);
    },
  });

  // --------------------------------------------------------------------------
  // Rule Management State & Modals
  // --------------------------------------------------------------------------
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRuleResponse | null>(null);

  // Form Fields
  const [ruleName, setRuleName] = useState('');
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [ruleScopeType, setRuleScopeType] = useState<AlertRuleScope['type']>('workspace');
  const [ruleScopeId, setRuleScopeId] = useState<string>('');
  const [ruleConditionType, setRuleConditionType] = useState<AlertConditionType>('delivery_dead');
  // Condition parameters
  const [deadCount, setDeadCount] = useState(5);
  const [deadWindow, setDeadWindow] = useState(15);
  const [failureThreshold, setFailureThreshold] = useState(20);
  const [failureWindow, setFailureWindow] = useState(30);
  const [failureMinDeliveries, setFailureMinDeliveries] = useState(10);
  const [silenceMinutes, setSilenceMinutes] = useState(60);

  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>([]);
  const [ruleCooldown, setRuleCooldown] = useState(30);
  const [ruleNotifyOnResolve, setRuleNotifyOnResolve] = useState(true);
  const [ruleModalError, setRuleModalError] = useState<string | null>(null);

  // Dry-run preview in rule builder or rule list
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<TestEvaluateResult | null>(null);
  const [dryRunModalRule, setDryRunModalRule] = useState<AlertRuleResponse | null>(null);

  // Delete Rule Confirmation
  const [deletingRule, setDeletingRule] = useState<AlertRuleResponse | null>(null);

  // Map of channel IDs to channel objects
  const channelMap = useMemo(() => {
    const map = new Map<string, AlertChannelResponse>();
    channels.forEach((c) => map.set(c.id, c));
    return map;
  }, [channels]);

  // Verified channels that can be attached
  const verifiedChannels = useMemo(() => {
    return channels.filter((c) => Boolean(c.verifiedAt));
  }, [channels]);

  const openCreateRuleModal = () => {
    setEditingRule(null);
    setRuleName('');
    setRuleEnabled(true);
    setRuleScopeType('workspace');
    setRuleScopeId('');
    setRuleConditionType('delivery_dead');
    setDeadCount(5);
    setDeadWindow(15);
    setFailureThreshold(20);
    setFailureWindow(30);
    setFailureMinDeliveries(10);
    setSilenceMinutes(60);
    // Auto-select first verified channel if available
    setRuleChannelIds(verifiedChannels.length > 0 ? [verifiedChannels[0]!.id] : []);
    setRuleCooldown(30);
    setRuleNotifyOnResolve(true);
    setRuleModalError(null);
    setDryRunResult(null);
    setIsRuleModalOpen(true);
  };

  const openEditRuleModal = (r: AlertRuleResponse) => {
    setEditingRule(r);
    setRuleName(r.name);
    setRuleEnabled(r.enabled);
    setRuleScopeType(r.scope.type);
    setRuleScopeId(r.scope.id || '');
    setRuleConditionType(r.condition.type);
    if (r.condition.type === 'delivery_dead') {
      setDeadCount(r.condition.count);
      setDeadWindow(r.condition.windowMinutes);
    } else if (r.condition.type === 'failure_rate') {
      setFailureThreshold(r.condition.thresholdPct);
      setFailureWindow(r.condition.windowMinutes);
      setFailureMinDeliveries(r.condition.minDeliveries);
    } else if (r.condition.type === 'no_events') {
      setSilenceMinutes(r.condition.silenceMinutes);
    }
    setRuleChannelIds(r.channelIds);
    setRuleCooldown(r.cooldownMinutes);
    setRuleNotifyOnResolve(r.notifyOnResolve);
    setRuleModalError(null);
    setDryRunResult(null);
    setIsRuleModalOpen(true);
  };

  // Build the dynamic plain-language string
  const plainLanguageSentence = useMemo(() => {
    let condText = '';
    if (ruleConditionType === 'delivery_dead') {
      condText = `[${deadCount}] deliveries die within [${deadWindow}] minutes`;
    } else if (ruleConditionType === 'failure_rate') {
      condText = `failure rate exceeds [${failureThreshold}%] over [${failureWindow}] minutes (min ${failureMinDeliveries} deliveries)`;
    } else if (ruleConditionType === 'no_events') {
      condText = `no events are received for [${silenceMinutes}] minutes`;
    }

    let scopeText = 'Entire Workspace';
    if (ruleScopeType === 'endpoint') {
      const ep = endpoints.find((e) => e.id === ruleScopeId);
      scopeText = ep ? `Endpoint "${ep.name}"` : 'Selected Endpoint';
    } else if (ruleScopeType === 'destination') {
      const dest = destinations.find((d) => d.id === ruleScopeId);
      scopeText = dest ? `Destination "${dest.name}"` : 'Selected Destination';
    }

    const channelNames = ruleChannelIds
      .map((id) => channelMap.get(id)?.name)
      .filter(Boolean)
      .join(', ');

    return `When ${condText} on ${scopeText}, notify ${channelNames || '[No channels selected]'}.`;
  }, [
    ruleConditionType,
    deadCount,
    deadWindow,
    failureThreshold,
    failureWindow,
    failureMinDeliveries,
    silenceMinutes,
    ruleScopeType,
    ruleScopeId,
    ruleChannelIds,
    endpoints,
    destinations,
    channelMap,
  ]);

  // Execute dry-run test from inside the modal
  const handleTestRuleNowInModal = async () => {
    if (!workspaceId) return;
    setDryRunLoading(true);
    setDryRunResult(null);
    try {
      let condition: AlertRuleCondition;
      if (ruleConditionType === 'delivery_dead') {
        condition = {
          type: 'delivery_dead',
          count: Number(deadCount),
          windowMinutes: Number(deadWindow),
        };
      } else if (ruleConditionType === 'failure_rate') {
        condition = {
          type: 'failure_rate',
          thresholdPct: Number(failureThreshold),
          windowMinutes: Number(failureWindow),
          minDeliveries: Number(failureMinDeliveries),
        };
      } else {
        condition = { type: 'no_events', silenceMinutes: Number(silenceMinutes) };
      }

      const scope: AlertRuleScope = {
        type: ruleScopeType,
        ...(ruleScopeType !== 'workspace' && ruleScopeId ? { id: ruleScopeId } : {}),
      };

      const res = await alertsApi.testEvaluatePreview(workspaceId, scope, condition);
      setDryRunResult(res);
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: { data?: { error?: { message?: string } } };
        message?: string;
      };
      setRuleModalError(
        axiosErr.response?.data?.error?.message || axiosErr.message || 'Evaluation test failed',
      );
    } finally {
      setDryRunLoading(false);
    }
  };

  // Execute dry-run test on a saved rule from list
  const handleTestRuleFromList = async (rule: AlertRuleResponse) => {
    setDryRunModalRule(rule);
    setDryRunLoading(true);
    setDryRunResult(null);
    try {
      const res = await alertsApi.testEvaluateRule(rule.id);
      setDryRunResult(res);
    } catch {
      // Handled in modal state
    } finally {
      setDryRunLoading(false);
    }
  };

  const saveRuleMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace selected');
      if (!ruleName.trim()) throw new Error('Rule name is required');
      if (ruleChannelIds.length === 0)
        throw new Error('Please attach at least one verified channel');

      if (ruleScopeType !== 'workspace' && !ruleScopeId) {
        throw new Error(`Please select an ${ruleScopeType} for the rule scope`);
      }

      let condition: AlertRuleCondition;
      if (ruleConditionType === 'delivery_dead') {
        condition = {
          type: 'delivery_dead',
          count: Number(deadCount),
          windowMinutes: Number(deadWindow),
        };
      } else if (ruleConditionType === 'failure_rate') {
        condition = {
          type: 'failure_rate',
          thresholdPct: Number(failureThreshold),
          windowMinutes: Number(failureWindow),
          minDeliveries: Number(failureMinDeliveries),
        };
      } else {
        condition = { type: 'no_events', silenceMinutes: Number(silenceMinutes) };
      }

      const scope: AlertRuleScope = {
        type: ruleScopeType,
        ...(ruleScopeType !== 'workspace' && ruleScopeId ? { id: ruleScopeId } : {}),
      };

      if (editingRule) {
        return alertsApi.updateRule(editingRule.id, {
          name: ruleName.trim(),
          enabled: ruleEnabled,
          scope,
          condition,
          channelIds: ruleChannelIds,
          cooldownMinutes: Number(ruleCooldown),
          notifyOnResolve: ruleNotifyOnResolve,
        });
      } else {
        return alertsApi.createRule(workspaceId, {
          name: ruleName.trim(),
          enabled: ruleEnabled,
          scope,
          condition,
          channelIds: ruleChannelIds,
          cooldownMinutes: Number(ruleCooldown),
          notifyOnResolve: ruleNotifyOnResolve,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules', workspaceId] });
      setIsRuleModalOpen(false);
    },
    onError: (err: unknown) => {
      const axiosErr = err as {
        response?: { data?: { error?: { message?: string } } };
        message?: string;
      };
      setRuleModalError(
        axiosErr.response?.data?.error?.message || axiosErr.message || 'Failed to save alert rule',
      );
    },
  });

  const toggleRuleEnabledMutation = useMutation({
    mutationFn: async ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) => {
      return alertsApi.updateRule(ruleId, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules', workspaceId] });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (ruleId: string) => {
      return alertsApi.deleteRule(ruleId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules', workspaceId] });
      setDeletingRule(null);
    },
  });

  // --------------------------------------------------------------------------
  // History Tab Filter
  // --------------------------------------------------------------------------
  const [historyRuleFilter, setHistoryRuleFilter] = useState<string>('all');
  const filteredHistory = useMemo(() => {
    if (historyRuleFilter === 'all') return history;
    return history.filter((h) => h.ruleId === historyRuleFilter);
  }, [history, historyRuleFilter]);

  // Click history row to open filtered Event Inspector
  const handleOpenAffectedEvents = (h: AlertHistoryResponse) => {
    const matchedRule = rules.find((r) => r.id === h.ruleId);
    const scope = matchedRule?.scope;

    const params = new URLSearchParams();
    if (scope?.type === 'endpoint' && scope.id) {
      params.set('endpointId', scope.id);
    } else if (scope?.type === 'destination' && scope.id) {
      const dest = destinations.find((d) => d.id === scope.id);
      if (dest?.endpointId) params.set('endpointId', dest.endpointId);
    } else if (endpoints.length > 0) {
      params.set('endpointId', endpoints[0]!.id);
    }

    params.set('status', 'dead');
    params.set('from', h.firedAt);
    if (h.resolvedAt) params.set('to', h.resolvedAt);

    navigate(`/events?${params.toString()}`);
  };

  // --------------------------------------------------------------------------
  // Helper: Condition Label Formatter
  // --------------------------------------------------------------------------
  const formatConditionBadge = (c: AlertRuleCondition) => {
    if (c.type === 'delivery_dead') {
      return `Dead >= ${c.count} in ${c.windowMinutes}m`;
    }
    if (c.type === 'failure_rate') {
      return `Failure >= ${c.thresholdPct}% (min ${c.minDeliveries}) in ${c.windowMinutes}m`;
    }
    return `Inactivity >= ${c.silenceMinutes}m`;
  };

  const formatScopeBadge = (scope: AlertRuleScope) => {
    if (scope.type === 'workspace') return 'Workspace';
    if (scope.type === 'endpoint') {
      const ep = endpoints.find((e) => e.id === scope.id);
      return `Endpoint: ${ep?.name || scope.id?.slice(-6) || 'Unknown'}`;
    }
    const d = destinations.find((dest) => dest.id === scope.id);
    return `Destination: ${d?.name || scope.id?.slice(-6) || 'Unknown'}`;
  };

  return (
    <div className="space-y-6">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-zinc-100 tracking-tight font-sans flex items-center gap-2.5">
              <Bell className="h-6 w-6 text-[#ccff00]" />
              Failure Alerts & Notifications
            </h2>
            {/* Live Indicator */}
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-mono font-medium">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
              </span>
              REALTIME
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            Monitor dead deliveries, failure rate spikes, and ingress silence with instant email and
            Slack notifications.
          </p>
        </div>

        {/* Action Button */}
        <div className="flex items-center gap-2">
          {activeTab === 'rules' && (
            <button
              onClick={openCreateRuleModal}
              disabled={isViewer}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              <span>New Rule</span>
            </button>
          )}

          {activeTab === 'channels' && (
            <button
              onClick={openCreateChannelModal}
              disabled={isViewer}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              <span>New Channel</span>
            </button>
          )}

          {activeTab === 'history' && (
            <button
              onClick={() => refetchHistory()}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 hover:bg-zinc-800 text-zinc-200 text-xs font-medium transition-all"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span>Refresh</span>
            </button>
          )}
        </div>
      </div>

      {/* Viewer Warning Banner */}
      {isViewer && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900/80 border border-white/[0.08] text-xs text-zinc-400">
          <Info className="h-4 w-4 text-zinc-400 shrink-0" />
          <span>
            Viewer role: You have read-only access. Alert rule and channel modifications require
            Admin role or higher.
          </span>
        </div>
      )}

      {/* Tab Navigation Navigation Bar */}
      <div className="flex items-center gap-2 border-b border-white/[0.08] pb-1">
        <button
          onClick={() => setActiveTab('rules')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'rules'
              ? 'bg-[#ccff00]/10 text-[#ccff00] border border-[#ccff00]/25 shadow-[0_0_12px_rgba(204,255,0,0.1)]'
              : 'text-zinc-400 hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <ShieldAlert className="h-4 w-4" />
          <span>Rules</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/[0.08] text-zinc-300 font-mono">
            {rules.length}
          </span>
          {rules.some((r) => r.state?.status === 'firing') && (
            <span
              className="h-2 w-2 rounded-full bg-rose-500 animate-pulse"
              title="One or more rules firing"
            />
          )}
        </button>

        <button
          onClick={() => setActiveTab('channels')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'channels'
              ? 'bg-[#ccff00]/10 text-[#ccff00] border border-[#ccff00]/25 shadow-[0_0_12px_rgba(204,255,0,0.1)]'
              : 'text-zinc-400 hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Send className="h-4 w-4" />
          <span>Channels</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/[0.08] text-zinc-300 font-mono">
            {channels.length}
          </span>
          {channels.some((c) => !c.verifiedAt) && (
            <span className="px-1.5 py-0.2 rounded-full text-[9px] bg-amber-500/20 text-amber-300 font-mono">
              Unverified
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'history'
              ? 'bg-[#ccff00]/10 text-[#ccff00] border border-[#ccff00]/25 shadow-[0_0_12px_rgba(204,255,0,0.1)]'
              : 'text-zinc-400 hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Activity className="h-4 w-4" />
          <span>History</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/[0.08] text-zinc-300 font-mono">
            {history.length}
          </span>
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: RULES TAB                                                     */}
      {/* ==================================================================== */}
      {activeTab === 'rules' && (
        <div className="space-y-4">
          {isRulesLoading ? (
            <LoadingSpinner message="Loading alert rules..." />
          ) : rulesError ? (
            <ErrorAlert message="Failed to load alert rules." onRetry={() => refetchRules()} />
          ) : rules.length === 0 ? (
            <EmptyState
              title="No alert rules created yet"
              description="Configure proactive rules to monitor failed deliveries, high error rates, or silent endpoints."
              icon={<ShieldAlert className="h-10 w-10 text-emerald-400" />}
              action={
                <button
                  onClick={openCreateRuleModal}
                  disabled={isViewer}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create First Alert Rule</span>
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {rules.map((rule) => {
                const isFiring = rule.state?.status === 'firing';
                const status = isFiring ? 'FIRING' : 'OK';

                return (
                  <div
                    key={rule.id}
                    className={`rounded-2xl border p-5 transition-all backdrop-blur-xl ${
                      isFiring
                        ? 'border-rose-500/40 bg-rose-950/10 shadow-[0_0_24px_rgba(244,63,94,0.15)] ring-1 ring-rose-500/20'
                        : 'border-white/[0.08] bg-[#0c0c0e]/80 hover:border-white/15'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      {/* Left: Status badge & Name */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          {/* Live Status Badge */}
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-semibold uppercase tracking-wider ${
                              !rule.enabled
                                ? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                                : isFiring
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse'
                                  : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                !rule.enabled
                                  ? 'bg-zinc-500'
                                  : isFiring
                                    ? 'bg-rose-500 animate-ping'
                                    : 'bg-emerald-400'
                              }`}
                            />
                            {rule.enabled ? status : 'DISABLED'}
                          </span>

                          <h3 className="text-base font-bold text-zinc-100 font-sans tracking-tight">
                            {rule.name}
                          </h3>

                          {/* Scope pill */}
                          <span className="px-2 py-0.5 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-zinc-300 font-mono">
                            {formatScopeBadge(rule.scope)}
                          </span>

                          {/* Condition pill */}
                          <span className="px-2 py-0.5 rounded-lg bg-white/[0.04] border border-white/10 text-[11px] text-zinc-400 font-mono">
                            {formatConditionBadge(rule.condition)}
                          </span>
                        </div>

                        {/* Plain Language Summary */}
                        <p className="text-xs text-zinc-300 font-mono bg-black/40 px-3 py-1.5 rounded-xl border border-white/[0.04]">
                          {rule.condition.type === 'delivery_dead' &&
                            `When ${rule.condition.count} deliveries die within ${rule.condition.windowMinutes}m on ${formatScopeBadge(
                              rule.scope,
                            )}, notify configured channels.`}
                          {rule.condition.type === 'failure_rate' &&
                            `When failure rate exceeds ${rule.condition.thresholdPct}% over ${rule.condition.windowMinutes}m (min ${rule.condition.minDeliveries} deliveries), notify configured channels.`}
                          {rule.condition.type === 'no_events' &&
                            `When no events are received for ${rule.condition.silenceMinutes}m on ${formatScopeBadge(
                              rule.scope,
                            )}, notify configured channels.`}
                        </p>

                        {/* Channels & Cooldown Meta */}
                        <div className="flex items-center gap-3 text-xs text-zinc-400 flex-wrap pt-1">
                          <span className="flex items-center gap-1.5">
                            <Send className="h-3.5 w-3.5 text-zinc-500" />
                            <span>Channels:</span>
                            <span className="flex items-center gap-1">
                              {rule.channelIds.map((cid) => {
                                const ch = channelMap.get(cid);
                                return (
                                  <span
                                    key={cid}
                                    className="px-2 py-0.5 rounded-md bg-white/[0.06] text-zinc-200 text-[10px] font-mono"
                                  >
                                    {ch ? ch.name : cid.slice(-4)}
                                  </span>
                                );
                              })}
                            </span>
                          </span>

                          <span className="h-3 w-px bg-white/10" />

                          <span className="flex items-center gap-1 text-[11px]">
                            <Clock className="h-3 w-3 text-zinc-500" />
                            <span>Cooldown: {rule.cooldownMinutes}m</span>
                          </span>

                          {rule.notifyOnResolve && (
                            <>
                              <span className="h-3 w-px bg-white/10" />
                              <span className="text-[11px] text-emerald-400/90 flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                <span>Notify on resolve</span>
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-2 self-end lg:self-center shrink-0">
                        {/* Enabled switch */}
                        <button
                          onClick={() =>
                            toggleRuleEnabledMutation.mutate({
                              ruleId: rule.id,
                              enabled: !rule.enabled,
                            })
                          }
                          disabled={isViewer}
                          title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 ${
                            rule.enabled ? 'bg-[#ccff00]' : 'bg-zinc-800'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-black transition-transform ${
                              rule.enabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>

                        {/* Test rule now button */}
                        <button
                          onClick={() => handleTestRuleFromList(rule)}
                          title="Dry-run evaluate this rule now"
                          className="px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 hover:bg-zinc-800 text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition-all"
                        >
                          <Play className="h-3.5 w-3.5 text-[#ccff00]" />
                          <span>Test rule</span>
                        </button>

                        {/* Edit button */}
                        <button
                          onClick={() => openEditRuleModal(rule)}
                          disabled={isViewer}
                          title="Edit rule"
                          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>

                        {/* Delete button */}
                        <button
                          onClick={() => setDeletingRule(rule)}
                          disabled={isViewer}
                          title="Delete rule"
                          className="p-2 rounded-xl text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: CHANNELS TAB                                                  */}
      {/* ==================================================================== */}
      {activeTab === 'channels' && (
        <div className="space-y-4">
          {isChannelsLoading ? (
            <LoadingSpinner message="Loading notification channels..." />
          ) : channelsError ? (
            <ErrorAlert
              message="Failed to load alert channels."
              onRetry={() => refetchChannels()}
            />
          ) : channels.length === 0 ? (
            <EmptyState
              title="No alert channels configured"
              description="Connect workspace member emails or incoming Slack webhooks to receive alert notifications."
              icon={<Send className="h-10 w-10 text-emerald-400" />}
              action={
                <button
                  onClick={openCreateChannelModal}
                  disabled={isViewer}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                  <span>Add First Notification Channel</span>
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {channels.map((ch) => {
                const isVerified = Boolean(ch.verifiedAt);
                const isTesting = testingChannelId === ch.id;
                const feedback = testFeedback?.channelId === ch.id ? testFeedback : null;

                return (
                  <div
                    key={ch.id}
                    className="rounded-2xl border border-white/[0.08] bg-[#0c0c0e]/80 p-5 flex flex-col justify-between gap-4 backdrop-blur-xl hover:border-white/15 transition-all"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`p-2.5 rounded-xl border ${
                              ch.type === 'email'
                                ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                                : 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                            }`}
                          >
                            {ch.type === 'email' ? (
                              <Mail className="h-4 w-4" />
                            ) : (
                              <Send className="h-4 w-4" />
                            )}
                          </div>
                          <div>
                            <h3 className="text-sm font-bold text-zinc-100 font-sans tracking-tight">
                              {ch.name}
                            </h3>
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono">
                              {ch.type === 'email' ? 'Email Digest' : 'Slack Incoming Webhook'}
                            </span>
                          </div>
                        </div>

                        {/* Verification badge */}
                        <div>
                          {isVerified ? (
                            <span
                              title={`Verified on ${new Date(ch.verifiedAt!).toLocaleDateString()}`}
                              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-mono font-medium"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              <span>Verified</span>
                            </span>
                          ) : (
                            <span
                              title="Channel must be tested and verified before attaching to rules"
                              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-mono font-medium animate-pulse"
                            >
                              <AlertTriangle className="h-3 w-3" />
                              <span>Unverified</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Config Preview */}
                      <div className="bg-black/40 rounded-xl p-3 border border-white/[0.04] text-xs font-mono space-y-1">
                        {ch.type === 'email' ? (
                          <div>
                            <span className="text-zinc-500 text-[10px] uppercase block mb-1">
                              Recipients ({ch.configPreview.emails?.length || 0}):
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {ch.configPreview.emails?.map((email) => (
                                <span
                                  key={email}
                                  className="px-2 py-0.5 rounded-md bg-white/[0.06] text-zinc-300 text-[11px]"
                                >
                                  {email}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <span className="text-zinc-500 text-[10px] uppercase block mb-1">
                              Webhook URL:
                            </span>
                            <span className="text-zinc-300 text-[11px] select-all break-all">
                              {ch.configPreview.webhookUrlMasked ||
                                'https://hooks.slack.com/services/••••••••'}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Inline Test Result Feedback */}
                      {feedback && (
                        <div
                          className={`flex items-start gap-2 p-2.5 rounded-xl border text-xs ${
                            feedback.success
                              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                              : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                          }`}
                        >
                          {feedback.success ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                          ) : (
                            <XCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                          )}
                          <span className="leading-relaxed">{feedback.message}</span>
                        </div>
                      )}
                    </div>

                    {/* Bottom Actions */}
                    <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
                      {/* Send test button */}
                      <button
                        onClick={() => testChannelMutation.mutate(ch.id)}
                        disabled={isTesting || isViewer}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 hover:bg-zinc-800 text-zinc-200 text-xs font-medium transition-all disabled:opacity-40"
                      >
                        {isTesting ? (
                          <RotateCw className="h-3 w-3 animate-spin text-[#ccff00]" />
                        ) : (
                          <Send className="h-3 w-3 text-[#ccff00]" />
                        )}
                        <span>{isTesting ? 'Sending test...' : 'Send test'}</span>
                      </button>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEditChannelModal(ch)}
                          disabled={isViewer}
                          title="Edit channel"
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeletingChannel(ch)}
                          disabled={isViewer}
                          title="Delete channel"
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: HISTORY TAB                                                   */}
      {/* ==================================================================== */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Filter by Rule:</span>
              <select
                value={historyRuleFilter}
                onChange={(e) => setHistoryRuleFilter(e.target.value)}
                className="px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-200 text-xs font-medium focus:outline-none"
              >
                <option value="all">All Alert Rules ({history.length})</option>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>

            <span className="text-[11px] text-zinc-500 font-mono">
              Showing {filteredHistory.length} alert occurrences
            </span>
          </div>

          {isHistoryLoading ? (
            <LoadingSpinner message="Loading alert history..." />
          ) : historyError ? (
            <ErrorAlert message="Failed to load alert history." onRetry={() => refetchHistory()} />
          ) : filteredHistory.length === 0 ? (
            <EmptyState
              title="No alert firings recorded"
              description="When alert rules fire, detailed history records with metrics and channel delivery statuses appear here."
              icon={<Activity className="h-10 w-10 text-emerald-400" />}
            />
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-[#0c0c0e]/80 overflow-hidden backdrop-blur-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-black/40 border-b border-white/[0.06] text-zinc-400 font-mono uppercase text-[10px]">
                    <tr>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Rule / Scope</th>
                      <th className="py-3 px-4">Fired At</th>
                      <th className="py-3 px-4">Resolved At</th>
                      <th className="py-3 px-4">Metric Value</th>
                      <th className="py-3 px-4">Summary</th>
                      <th className="py-3 px-4">Channel Notifications</th>
                      <th className="py-3 px-4 text-right">Events</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {filteredHistory.map((h) => {
                      const isFiring = !h.resolvedAt;
                      const matchedRule = rules.find((r) => r.id === h.ruleId);

                      return (
                        <tr
                          key={h.id}
                          onClick={() => handleOpenAffectedEvents(h)}
                          className="hover:bg-white/[0.03] transition-colors cursor-pointer group"
                        >
                          {/* Status */}
                          <td className="py-3.5 px-4">
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase tracking-wider ${
                                isFiring
                                  ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30 animate-pulse'
                                  : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${isFiring ? 'bg-rose-500' : 'bg-emerald-400'}`}
                              />
                              {isFiring ? 'FIRING' : 'RESOLVED'}
                            </span>
                          </td>

                          {/* Rule & Scope */}
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-zinc-100 group-hover:text-[#ccff00] transition-colors">
                              {matchedRule ? matchedRule.name : `Rule ${h.ruleId.slice(-6)}`}
                            </div>
                            <div className="text-[10px] text-zinc-500 font-mono">
                              {matchedRule ? formatScopeBadge(matchedRule.scope) : 'Workspace'}
                            </div>
                          </td>

                          {/* Fired At */}
                          <td className="py-3.5 px-4 font-mono text-zinc-300 whitespace-nowrap">
                            <div>{new Date(h.firedAt).toLocaleTimeString()}</div>
                            <div className="text-[10px] text-zinc-500">
                              {new Date(h.firedAt).toLocaleDateString()}
                            </div>
                          </td>

                          {/* Resolved At */}
                          <td className="py-3.5 px-4 font-mono whitespace-nowrap">
                            {h.resolvedAt ? (
                              <div>
                                <div className="text-zinc-300">
                                  {new Date(h.resolvedAt).toLocaleTimeString()}
                                </div>
                                <div className="text-[10px] text-zinc-500">
                                  {new Date(h.resolvedAt).toLocaleDateString()}
                                </div>
                              </div>
                            ) : (
                              <span className="text-rose-400 text-[11px] font-medium">
                                Still Firing
                              </span>
                            )}
                          </td>

                          {/* Value */}
                          <td className="py-3.5 px-4 font-mono font-bold text-zinc-100">
                            {h.value}
                          </td>

                          {/* Summary */}
                          <td
                            className="py-3.5 px-4 text-zinc-300 max-w-xs truncate"
                            title={h.summary}
                          >
                            {h.summary}
                          </td>

                          {/* Channel Notifications */}
                          <td className="py-3.5 px-4">
                            <div className="flex flex-wrap gap-1">
                              {h.notifications && h.notifications.length > 0 ? (
                                h.notifications.map((n, idx) => {
                                  const ch = channelMap.get(n.channelId);
                                  const chName = ch ? ch.name : n.channelId.slice(-4);
                                  const isSent = n.status === 'sent';

                                  return (
                                    <span
                                      key={idx}
                                      title={
                                        isSent
                                          ? `Sent at ${new Date(n.sentAt).toLocaleTimeString()}`
                                          : `Error: ${n.error}`
                                      }
                                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                                        isSent
                                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                          : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                      }`}
                                    >
                                      {isSent ? (
                                        <Check className="h-2.5 w-2.5 text-emerald-400" />
                                      ) : (
                                        <XCircle className="h-2.5 w-2.5 text-rose-400" />
                                      )}
                                      <span>{chName}</span>
                                    </span>
                                  );
                                })
                              ) : (
                                <span className="text-zinc-600 font-mono text-[11px]">None</span>
                              )}
                            </div>
                          </td>

                          {/* Link to Events */}
                          <td className="py-3.5 px-4 text-right">
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#ccff00] font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                              <span>Events</span>
                              <ExternalLink className="h-3 w-3" />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CREATE / EDIT ALERT RULE (Plain-Language Builder)             */}
      {/* ==================================================================== */}
      <Modal
        isOpen={isRuleModalOpen}
        onClose={() => setIsRuleModalOpen(false)}
        title={editingRule ? 'Edit Alert Rule' : 'Create Alert Rule'}
        description="Configure proactive triggers with instant email and Slack notifications."
        maxWidth="2xl"
      >
        <div className="space-y-5">
          {ruleModalError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
              <span>{ruleModalError}</span>
            </div>
          )}

          {/* Dynamic Plain-Language Live Box */}
          <div className="p-3.5 rounded-2xl bg-zinc-950 border border-[#ccff00]/30 shadow-[0_0_20px_rgba(204,255,0,0.06)]">
            <span className="text-[10px] uppercase font-mono text-[#ccff00] font-semibold block mb-1">
              Plain-Language Rule Preview
            </span>
            <p className="text-sm font-mono text-zinc-100 leading-relaxed">
              {plainLanguageSentence}
            </p>
          </div>

          {/* Rule Name & Active switch */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Rule Name
              </label>
              <input
                type="text"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="e.g. Critical Destination Dead Deliveries"
                className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 placeholder:text-zinc-500 text-xs focus:outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Status
              </label>
              <button
                type="button"
                onClick={() => setRuleEnabled(!ruleEnabled)}
                className={`w-full px-3 py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                  ruleEnabled
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                    : 'bg-zinc-800/60 border-zinc-700 text-zinc-400'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${ruleEnabled ? 'bg-emerald-400' : 'bg-zinc-500'}`}
                />
                <span>{ruleEnabled ? 'Active' : 'Disabled'}</span>
              </button>
            </div>
          </div>

          {/* Condition Selector */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-2 font-sans">
              Alert Trigger Condition
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setRuleConditionType('delivery_dead')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  ruleConditionType === 'delivery_dead'
                    ? 'bg-[#ccff00]/10 border-[#ccff00]/40 text-white shadow-sm'
                    : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="text-xs font-bold font-sans">Dead Deliveries</div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  Triggers when deliveries permanently fail
                </div>
              </button>

              <button
                type="button"
                onClick={() => setRuleConditionType('failure_rate')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  ruleConditionType === 'failure_rate'
                    ? 'bg-[#ccff00]/10 border-[#ccff00]/40 text-white shadow-sm'
                    : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="text-xs font-bold font-sans">Failure Rate</div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  Triggers on percentage error spike
                </div>
              </button>

              <button
                type="button"
                onClick={() => setRuleConditionType('no_events')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  ruleConditionType === 'no_events'
                    ? 'bg-[#ccff00]/10 border-[#ccff00]/40 text-white shadow-sm'
                    : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="text-xs font-bold font-sans">Inactivity / Silence</div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  Triggers when no webhooks are received
                </div>
              </button>
            </div>
          </div>

          {/* Condition Specific Parameters */}
          <div className="p-3.5 rounded-xl bg-black/40 border border-white/[0.06] space-y-3">
            {ruleConditionType === 'delivery_dead' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Dead Deliveries Threshold (Count)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={deadCount}
                    onChange={(e) => setDeadCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Evaluation Window (Minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={deadWindow}
                    onChange={(e) => setDeadWindow(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                  />
                </div>
              </div>
            )}

            {ruleConditionType === 'failure_rate' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Threshold (% Failed)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={failureThreshold}
                    onChange={(e) =>
                      setFailureThreshold(Math.max(1, parseFloat(e.target.value) || 1))
                    }
                    className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Window (Minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={failureWindow}
                    onChange={(e) =>
                      setFailureWindow(Math.max(1, parseInt(e.target.value, 10) || 1))
                    }
                    className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Min Deliveries Required
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={failureMinDeliveries}
                    onChange={(e) =>
                      setFailureMinDeliveries(Math.max(1, parseInt(e.target.value, 10) || 1))
                    }
                    className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                  />
                </div>
              </div>
            )}

            {ruleConditionType === 'no_events' && (
              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                  Silence Duration (Minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  max={10080}
                  value={silenceMinutes}
                  onChange={(e) =>
                    setSilenceMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                  className="w-full px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-900 text-zinc-100 text-xs font-mono"
                />
              </div>
            )}
          </div>

          {/* Scope Picker */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
              Rule Scope
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2.5">
              <button
                type="button"
                onClick={() => {
                  setRuleScopeType('workspace');
                  setRuleScopeId('');
                }}
                className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                  ruleScopeType === 'workspace'
                    ? 'bg-white text-black font-semibold'
                    : 'bg-zinc-900/60 border-white/[0.08] text-zinc-400 hover:text-white'
                }`}
              >
                Entire Workspace
              </button>

              <button
                type="button"
                onClick={() => {
                  setRuleScopeType('endpoint');
                  if (endpoints.length > 0 && !ruleScopeId) {
                    setRuleScopeId(endpoints[0]!.id);
                  }
                }}
                className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                  ruleScopeType === 'endpoint'
                    ? 'bg-white text-black font-semibold'
                    : 'bg-zinc-900/60 border-white/[0.08] text-zinc-400 hover:text-white'
                }`}
              >
                Specific Endpoint
              </button>

              <button
                type="button"
                onClick={() => {
                  setRuleScopeType('destination');
                  if (destinations.length > 0 && !ruleScopeId) {
                    setRuleScopeId(destinations[0]!.id);
                  }
                }}
                className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
                  ruleScopeType === 'destination'
                    ? 'bg-white text-black font-semibold'
                    : 'bg-zinc-900/60 border-white/[0.08] text-zinc-400 hover:text-white'
                }`}
              >
                Specific Destination
              </button>
            </div>

            {/* Target Dropdown if Endpoint or Destination */}
            {ruleScopeType === 'endpoint' && (
              <select
                value={ruleScopeId}
                onChange={(e) => setRuleScopeId(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 text-xs focus:outline-none"
              >
                {endpoints.length === 0 ? (
                  <option value="">No endpoints found in workspace</option>
                ) : (
                  endpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.name} ({ep.slug})
                    </option>
                  ))
                )}
              </select>
            )}

            {ruleScopeType === 'destination' && (
              <select
                value={ruleScopeId}
                onChange={(e) => setRuleScopeId(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 text-xs focus:outline-none"
              >
                {destinations.length === 0 ? (
                  <option value="">No destinations found in workspace</option>
                ) : (
                  destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} (on {d.endpointName})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {/* Channels Picker */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-zinc-300 font-sans">
                Notify Channels
              </label>
              {verifiedChannels.length === 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setIsRuleModalOpen(false);
                    setActiveTab('channels');
                  }}
                  className="text-[11px] text-[#ccff00] hover:underline"
                >
                  Create & verify a channel first →
                </button>
              )}
            </div>

            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {channels.map((ch) => {
                const isVerified = Boolean(ch.verifiedAt);
                const isSelected = ruleChannelIds.includes(ch.id);

                return (
                  <label
                    key={ch.id}
                    className={`flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                      !isVerified
                        ? 'opacity-40 bg-zinc-900/30 border-white/[0.04] cursor-not-allowed'
                        : isSelected
                          ? 'bg-[#ccff00]/10 border-[#ccff00]/30 text-white cursor-pointer'
                          : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-zinc-200 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        disabled={!isVerified}
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setRuleChannelIds([...ruleChannelIds, ch.id]);
                          } else {
                            setRuleChannelIds(ruleChannelIds.filter((id) => id !== ch.id));
                          }
                        }}
                        className="rounded border-zinc-700 bg-zinc-900 text-[#ccff00] focus:ring-0"
                      />
                      <div className="text-xs font-medium font-sans">
                        {ch.name}
                        <span className="text-[10px] text-zinc-500 font-mono ml-2">
                          ({ch.type})
                        </span>
                      </div>
                    </div>

                    {!isVerified && (
                      <span className="text-[10px] text-amber-400/90 font-mono">
                        (Unverified - Send test first)
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Cooldown & Notify On Resolve */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Notification Cooldown (Minutes)
              </label>
              <input
                type="number"
                min={1}
                max={1440}
                value={ruleCooldown}
                onChange={(e) => setRuleCooldown(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 text-xs font-mono"
              />
            </div>

            <div className="pt-5">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleNotifyOnResolve}
                  onChange={(e) => setRuleNotifyOnResolve(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-[#ccff00] focus:ring-0"
                />
                <span className="text-xs text-zinc-300 font-sans">
                  Notify when condition resolves
                </span>
              </label>
            </div>
          </div>

          {/* Live Dry-run Results Callout inside modal */}
          {dryRunResult && (
            <div
              className={`p-3.5 rounded-xl border text-xs font-mono space-y-1.5 ${
                dryRunResult.wouldFire
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              }`}
            >
              <div className="flex items-center justify-between font-bold">
                <span>Evaluation Result:</span>
                <span>{dryRunResult.wouldFire ? 'WOULD FIRE 🚨' : 'CLEAR (OK) ✅'}</span>
              </div>
              <div>Current metric value: {dryRunResult.currentValue}</div>
              <div>Summary: {dryRunResult.summary}</div>
              {dryRunResult.topFailureReasons && dryRunResult.topFailureReasons.length > 0 && (
                <div>Top reasons: {dryRunResult.topFailureReasons.join(', ')}</div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-3 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={handleTestRuleNowInModal}
              disabled={dryRunLoading}
              className="px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-medium flex items-center gap-2 transition-all disabled:opacity-40"
            >
              {dryRunLoading ? (
                <RotateCw className="h-3.5 w-3.5 animate-spin text-[#ccff00]" />
              ) : (
                <Play className="h-3.5 w-3.5 text-[#ccff00]" />
              )}
              <span>Test rule now</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsRuleModalOpen(false)}
                className="px-4 py-2 rounded-xl border border-white/[0.08] bg-transparent hover:bg-white/[0.05] text-zinc-400 hover:text-white text-xs font-semibold transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveRuleMutation.mutate()}
                disabled={saveRuleMutation.isPending || isViewer}
                className="px-5 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold shadow-sm transition-all disabled:opacity-40"
              >
                {saveRuleMutation.isPending
                  ? 'Saving...'
                  : editingRule
                    ? 'Update Rule'
                    : 'Create Rule'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CREATE / EDIT ALERT CHANNEL                                  */}
      {/* ==================================================================== */}
      <Modal
        isOpen={isChannelModalOpen}
        onClose={() => setIsChannelModalOpen(false)}
        title={editingChannel ? 'Edit Notification Channel' : 'New Notification Channel'}
        description="Receive alert notifications via Email or incoming Slack webhooks."
        maxWidth="lg"
      >
        <div className="space-y-4">
          {channelModalError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
              <span>{channelModalError}</span>
            </div>
          )}

          {/* Channel Type */}
          {!editingChannel && (
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Channel Type
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setChannelType('email')}
                  className={`p-3 rounded-xl border text-left flex items-center gap-3 transition-all ${
                    channelType === 'email'
                      ? 'bg-[#ccff00]/10 border-[#ccff00]/40 text-white'
                      : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-white'
                  }`}
                >
                  <Mail className="h-5 w-5 text-blue-400" />
                  <div>
                    <div className="text-xs font-bold font-sans">Workspace Email</div>
                    <div className="text-[10px] text-zinc-400">Pick from members</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setChannelType('slack')}
                  className={`p-3 rounded-xl border text-left flex items-center gap-3 transition-all ${
                    channelType === 'slack'
                      ? 'bg-[#ccff00]/10 border-[#ccff00]/40 text-white'
                      : 'bg-zinc-900/40 border-white/[0.08] text-zinc-400 hover:text-white'
                  }`}
                >
                  <Send className="h-5 w-5 text-purple-400" />
                  <div>
                    <div className="text-xs font-bold font-sans">Slack Webhook</div>
                    <div className="text-[10px] text-zinc-400">Incoming webhook URL</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Channel Name */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
              Channel Name
            </label>
            <input
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="e.g. Core Engineering Team"
              className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 placeholder:text-zinc-500 text-xs focus:outline-none focus:border-white/30"
            />
          </div>

          {/* Config by Type */}
          {channelType === 'email' ? (
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Recipient Workspace Members
              </label>
              <div className="p-3 rounded-xl bg-black/40 border border-white/[0.06] space-y-2 max-h-48 overflow-y-auto">
                {members.length === 0 ? (
                  <p className="text-xs text-zinc-500 font-mono">No workspace members loaded</p>
                ) : (
                  members.map((m) => {
                    const email = m.userId?.email || '';
                    const isSelected = selectedEmails.includes(email);

                    return (
                      <label
                        key={m.id}
                        className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                          isSelected ? 'bg-white/[0.08]' : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedEmails([...selectedEmails, email]);
                              } else {
                                setSelectedEmails(selectedEmails.filter((em) => em !== email));
                              }
                            }}
                            className="rounded border-zinc-700 bg-zinc-900 text-[#ccff00] focus:ring-0"
                          />
                          <div>
                            <div className="text-xs font-medium text-zinc-200">
                              {m.userId?.name || email}
                            </div>
                            <div className="text-[11px] text-zinc-400 font-mono">{email}</div>
                          </div>
                        </div>

                        <span className="text-[10px] text-zinc-500 uppercase font-mono px-2 py-0.5 rounded bg-zinc-800">
                          {m.role}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-[11px] text-zinc-500 mt-1.5">
                HookPilot anti-relay protection strictly enforces that alert emails can only be sent
                to verified workspace members.
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 font-sans">
                Slack Incoming Webhook URL
              </label>
              <input
                type="text"
                value={slackWebhookUrl}
                onChange={(e) => setSlackWebhookUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 placeholder:text-zinc-500 text-xs font-mono focus:outline-none focus:border-white/30"
              />
              <p className="text-[11px] text-zinc-500 mt-1.5">
                Must be an https URL on hooks.slack.com. The URL is encrypted with AES-256-GCM and
                masked after saving.
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={() => setIsChannelModalOpen(false)}
              className="px-4 py-2 rounded-xl border border-white/[0.08] bg-transparent hover:bg-white/[0.05] text-zinc-400 hover:text-white text-xs font-semibold transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveChannelMutation.mutate()}
              disabled={saveChannelMutation.isPending || isViewer}
              className="px-5 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold shadow-sm transition-all disabled:opacity-40"
            >
              {saveChannelMutation.isPending
                ? 'Saving...'
                : editingChannel
                  ? 'Update Channel'
                  : 'Create Channel'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: TEST RULE DRY-RUN                                             */}
      {/* ==================================================================== */}
      <Modal
        isOpen={Boolean(dryRunModalRule)}
        onClose={() => setDryRunModalRule(null)}
        title={`Dry-Run Test: ${dryRunModalRule?.name}`}
        description="Simulated evaluation of rule metrics based on current live window."
        maxWidth="md"
      >
        <div className="space-y-4">
          {dryRunLoading ? (
            <LoadingSpinner message="Evaluating condition metrics..." />
          ) : dryRunResult ? (
            <div className="space-y-3 font-mono text-xs">
              <div
                className={`p-4 rounded-xl border text-center space-y-1 ${
                  dryRunResult.wouldFire
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                }`}
              >
                <div className="text-sm font-bold">
                  {dryRunResult.wouldFire
                    ? 'WOULD FIRE ALERT 🚨'
                    : 'CONDITION IS OK (NOT FIRING) ✅'}
                </div>
                <div className="text-xs opacity-90">
                  Current metric value: {dryRunResult.currentValue}
                </div>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06] space-y-1">
                <span className="text-[10px] text-zinc-500 uppercase block font-semibold">
                  Summary
                </span>
                <p className="text-zinc-200">{dryRunResult.summary}</p>
              </div>

              {dryRunResult.topFailureReasons && dryRunResult.topFailureReasons.length > 0 && (
                <div className="bg-black/40 p-3 rounded-xl border border-white/[0.06] space-y-1">
                  <span className="text-[10px] text-zinc-500 uppercase block font-semibold">
                    Top Failure Reasons ({dryRunResult.topFailureReasons.length})
                  </span>
                  <ul className="list-disc pl-4 space-y-0.5 text-zinc-300">
                    {dryRunResult.topFailureReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">No evaluation data available.</p>
          )}

          <div className="flex justify-end pt-2 border-t border-white/[0.08]">
            <button
              onClick={() => setDryRunModalRule(null)}
              className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: DELETE CONFIRMATIONS                                          */}
      {/* ==================================================================== */}
      <Modal
        isOpen={Boolean(deletingRule)}
        onClose={() => setDeletingRule(null)}
        title="Delete Alert Rule"
        description="Are you sure you want to permanently delete this alert rule?"
        maxWidth="sm"
      >
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Deleting rule <strong className="text-zinc-100">{deletingRule?.name}</strong> will
            remove all future evaluations and alert state tracking.
          </p>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={() => setDeletingRule(null)}
              className="px-4 py-2 rounded-xl border border-white/[0.08] text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => deletingRule && deleteRuleMutation.mutate(deletingRule.id)}
              disabled={deleteRuleMutation.isPending}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-sm"
            >
              {deleteRuleMutation.isPending ? 'Deleting...' : 'Delete Rule'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(deletingChannel)}
        onClose={() => setDeletingChannel(null)}
        title="Delete Notification Channel"
        description="Are you sure you want to permanently delete this notification channel?"
        maxWidth="sm"
      >
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Deleting channel <strong className="text-zinc-100">{deletingChannel?.name}</strong> will
            detach it from any alert rules that use it.
          </p>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={() => setDeletingChannel(null)}
              className="px-4 py-2 rounded-xl border border-white/[0.08] text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => deletingChannel && deleteChannelMutation.mutate(deletingChannel.id)}
              disabled={deleteChannelMutation.isPending}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-sm"
            >
              {deleteChannelMutation.isPending ? 'Deleting...' : 'Delete Channel'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
