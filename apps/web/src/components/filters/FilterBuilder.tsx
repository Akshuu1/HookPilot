import { useState, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Code,
  Layers,
  Play,
  BarChart3,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FolderPlus,
} from 'lucide-react';
import {
  filterRuleSchema,
  explainFilter,
  type FilterRule,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type FilterExplanation,
  type EventResponse,
} from '@hookpilot/shared';
import { destinationsApi } from '../../api/destinations.api.js';

interface FilterBuilderProps {
  value: FilterRule | null | undefined;
  onChange: (rule: FilterRule | null) => void;
  endpointId?: string;
  destinationId?: string;
  recentEvents?: EventResponse[];
}

const OPERATORS: { label: string; value: FilterOperator; needsValue: boolean }[] = [
  { label: 'equals (eq)', value: 'eq', needsValue: true },
  { label: 'not equals (neq)', value: 'neq', needsValue: true },
  { label: 'in list (in)', value: 'in', needsValue: true },
  { label: 'not in list (nin)', value: 'nin', needsValue: true },
  { label: 'contains substring/item (contains)', value: 'contains', needsValue: true },
  { label: 'starts with (startsWith)', value: 'startsWith', needsValue: true },
  { label: 'ends with (endsWith)', value: 'endsWith', needsValue: true },
  { label: 'field exists (exists)', value: 'exists', needsValue: false },
  { label: 'field not exists (notExists)', value: 'notExists', needsValue: false },
  { label: 'greater than > (gt)', value: 'gt', needsValue: true },
  { label: 'greater or equal >= (gte)', value: 'gte', needsValue: true },
  { label: 'less than < (lt)', value: 'lt', needsValue: true },
  { label: 'less or equal <= (lte)', value: 'lte', needsValue: true },
];

function isFilterGroup(item: FilterCondition | FilterGroup): item is FilterGroup {
  return typeof item === 'object' && item !== null && 'combinator' in item && 'conditions' in item;
}

export function FilterBuilder({
  value,
  onChange,
  destinationId,
  recentEvents = [],
}: FilterBuilderProps) {
  const [viewMode, setViewMode] = useState<'visual' | 'json'>('visual');
  const [jsonText, setJsonText] = useState(() => (value ? JSON.stringify(value, null, 2) : ''));
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Test filter states
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<FilterExplanation | null>(null);

  // Preview match count states
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<{
    matchedCount: number;
    totalEvents: number;
  } | null>(null);

  // Current working rule (or empty default)
  const currentRule: FilterRule = useMemo(() => {
    if (!value || !value.conditions) {
      return { combinator: 'and', conditions: [] };
    }
    return value;
  }, [value]);

  // Validation with shared Zod schema
  const validationResult = useMemo(() => {
    if (!currentRule.conditions || currentRule.conditions.length === 0) {
      return { isValid: true, error: null };
    }
    const parsed = filterRuleSchema.safeParse(currentRule);
    if (!parsed.success) {
      return {
        isValid: false,
        error: parsed.error.issues[0]?.message || 'Invalid filter configuration',
      };
    }
    return { isValid: true, error: null };
  }, [currentRule]);

  // Handle visual changes
  const updateRule = (newRule: FilterRule) => {
    if (newRule.conditions.length === 0) {
      onChange(null);
      setJsonText('');
    } else {
      onChange(newRule);
      setJsonText(JSON.stringify(newRule, null, 2));
    }
  };

  // Toggle Root Combinator
  const toggleRootCombinator = () => {
    updateRule({
      ...currentRule,
      combinator: currentRule.combinator === 'and' ? 'or' : 'and',
    });
  };

  // Add condition to root
  const addRootCondition = () => {
    const newCond: FilterCondition = {
      field: 'body.type',
      op: 'eq',
      value: '',
    };
    updateRule({
      ...currentRule,
      conditions: [...currentRule.conditions, newCond],
    });
  };

  // Add nested group to root
  const addNestedGroup = () => {
    const newGroup: FilterGroup = {
      combinator: currentRule.combinator === 'and' ? 'or' : 'and',
      conditions: [{ field: 'body.status', op: 'eq', value: '' }],
    };
    updateRule({
      ...currentRule,
      conditions: [...currentRule.conditions, newGroup],
    });
  };

  // Update a root-level condition
  const updateCondition = (index: number, updated: FilterCondition) => {
    const nextConditions = [...currentRule.conditions];
    nextConditions[index] = updated;
    updateRule({ ...currentRule, conditions: nextConditions });
  };

  // Remove root-level item
  const removeRootItem = (index: number) => {
    const nextConditions = currentRule.conditions.filter((_, i) => i !== index);
    updateRule({ ...currentRule, conditions: nextConditions });
  };

  // Update a nested group
  const updateNestedGroup = (groupIndex: number, updatedGroup: FilterGroup) => {
    const nextConditions = [...currentRule.conditions];
    nextConditions[groupIndex] = updatedGroup;
    updateRule({ ...currentRule, conditions: nextConditions });
  };

  // JSON view editing
  const handleJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      onChange(null);
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const zodCheck = filterRuleSchema.safeParse(parsed);
      if (!zodCheck.success) {
        setJsonError(zodCheck.error.issues[0]?.message || 'Invalid filter rule schema');
      } else {
        setJsonError(null);
        onChange(zodCheck.data);
      }
    } catch {
      setJsonError('Malformed JSON syntax');
    }
  };

  // Run Test Filter
  const handleTestFilter = async () => {
    if (!selectedEventId) return;
    setIsTesting(true);
    setTestResult(null);

    try {
      const ev = recentEvents.find((e) => e.id === selectedEventId);
      if (destinationId) {
        // Run against server API endpoint
        const res = await destinationsApi.testFilter(destinationId, { eventId: selectedEventId });
        setTestResult(res.explanation);
      } else if (ev) {
        // In-memory test using shared explainFilter pure function
        let headersObj: Record<string, unknown> = {};
        if (ev.headers && typeof ev.headers === 'object') {
          headersObj = ev.headers;
        }
        const explanation = explainFilter(currentRule, {
          body: ev.rawBody,
          headers: headersObj,
          method: ev.method,
          contentType: ev.contentType,
        });
        setTestResult(explanation);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Filter test failed';
      setTestResult({
        matched: false,
        reason: msg,
        conditions: [],
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Run Preview Filter
  const handlePreviewFilter = async () => {
    setIsPreviewing(true);
    setPreviewResult(null);

    try {
      if (destinationId) {
        const res = await destinationsApi.previewFilter(destinationId);
        setPreviewResult(res);
      } else {
        // Preview against loaded recent events
        let matched = 0;
        for (const ev of recentEvents) {
          const explanation = explainFilter(currentRule, {
            body: ev.rawBody,
            headers: ev.headers,
            method: ev.method,
            contentType: ev.contentType,
          });
          if (explanation.matched) matched++;
        }
        setPreviewResult({ matchedCount: matched, totalEvents: recentEvents.length });
      }
    } catch {
      setPreviewResult({ matchedCount: 0, totalEvents: 0 });
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-white/[0.08] bg-zinc-950/60 p-4">
      {/* Header bar: Title & Toggle */}
      <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-emerald-400" />
          <h4 className="text-xs font-bold text-zinc-200 uppercase tracking-wider">
            Rule-Based Filter
          </h4>
          <span className="text-[10px] text-zinc-500 font-mono">
            {currentRule.conditions.length === 0
              ? '(Matches all events)'
              : `(${currentRule.conditions.length} rule${currentRule.conditions.length === 1 ? '' : 's'})`}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            const nextMode = viewMode === 'visual' ? 'json' : 'visual';
            setViewMode(nextMode);
            if (nextMode === 'json') {
              setJsonText(value ? JSON.stringify(value, null, 2) : '');
            }
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/[0.08] bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] font-medium transition-colors"
        >
          <Code className="h-3.5 w-3.5" />
          <span>{viewMode === 'visual' ? 'View JSON' : 'Visual Builder'}</span>
        </button>
      </div>

      {/* Validation Message */}
      {!validationResult.isValid && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{validationResult.error}</span>
        </div>
      )}

      {/* Mode 1: JSON Editor */}
      {viewMode === 'json' ? (
        <div className="space-y-2">
          <textarea
            rows={8}
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            placeholder='{\n  "combinator": "and",\n  "conditions": [\n    { "field": "body.type", "op": "eq", "value": "order.created" }\n  ]\n}'
            className="w-full p-3 rounded-xl border border-white/[0.08] bg-zinc-950 text-emerald-400 font-mono text-xs focus:outline-none focus:border-white/30"
          />
          {jsonError && <p className="text-xs text-rose-400 font-mono">{jsonError}</p>}
        </div>
      ) : (
        /* Mode 2: Visual Builder */
        <div className="space-y-3">
          {/* Root Combinator & Header Actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-400">Match</span>
              <button
                type="button"
                onClick={toggleRootCombinator}
                className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-mono font-bold text-xs hover:bg-emerald-500/25 transition-colors uppercase"
              >
                {currentRule.combinator === 'and' ? 'ALL (AND)' : 'ANY (OR)'}
              </button>
              <span className="text-zinc-400">of the following conditions:</span>
            </div>
          </div>

          {/* Condition Rows List */}
          {currentRule.conditions.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-500 border border-dashed border-white/[0.08] rounded-xl bg-zinc-900/20">
              No filter conditions. All incoming webhooks will be forwarded to this destination.
            </div>
          ) : (
            <div className="space-y-2.5">
              {currentRule.conditions.map((item, idx) => {
                if (isFilterGroup(item)) {
                  // Render Nested Group (One level of nesting)
                  return (
                    <div
                      key={`group-${idx}`}
                      className="p-3 rounded-xl border border-indigo-500/20 bg-indigo-950/10 space-y-2.5 pl-4 ml-2 border-l-2 border-l-indigo-500"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-indigo-300 font-semibold">Nested Group: Match</span>
                          <button
                            type="button"
                            onClick={() =>
                              updateNestedGroup(idx, {
                                ...item,
                                combinator: item.combinator === 'and' ? 'or' : 'and',
                              })
                            }
                            className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono font-bold text-[11px] uppercase hover:bg-indigo-500/30"
                          >
                            {item.combinator.toUpperCase()}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeRootItem(idx)}
                          className="p-1 text-zinc-500 hover:text-rose-400 transition-colors"
                          title="Remove nested group"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* Nested Conditions */}
                      <div className="space-y-2">
                        {item.conditions.map((nestedCond, nIdx) => {
                          const cond = nestedCond as FilterCondition;
                          return (
                            <ConditionRow
                              key={`nested-${idx}-${nIdx}`}
                              condition={cond}
                              onChange={(updated) => {
                                const nextNested = [...item.conditions];
                                nextNested[nIdx] = updated;
                                updateNestedGroup(idx, { ...item, conditions: nextNested });
                              }}
                              onRemove={() => {
                                const nextNested = item.conditions.filter((_, i) => i !== nIdx);
                                if (nextNested.length === 0) {
                                  removeRootItem(idx);
                                } else {
                                  updateNestedGroup(idx, { ...item, conditions: nextNested });
                                }
                              }}
                            />
                          );
                        })}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const nextNested = [
                            ...item.conditions,
                            { field: 'body.event', op: 'eq' as FilterOperator, value: '' },
                          ];
                          updateNestedGroup(idx, { ...item, conditions: nextNested });
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add condition to group</span>
                      </button>
                    </div>
                  );
                }

                // Render Top-level Condition Row
                return (
                  <ConditionRow
                    key={`cond-${idx}`}
                    condition={item}
                    onChange={(updated) => updateCondition(idx, updated)}
                    onRemove={() => removeRootItem(idx)}
                  />
                );
              })}
            </div>
          )}

          {/* Builder Add Action Buttons */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={addRootCondition}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-semibold transition-colors"
            >
              <Plus className="h-3.5 w-3.5 text-emerald-400" />
              <span>Add Condition</span>
            </button>

            <button
              type="button"
              onClick={addNestedGroup}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-semibold transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5 text-indigo-400" />
              <span>Add Group</span>
            </button>
          </div>
        </div>
      )}

      {/* 'Test this filter' & Preview Panel */}
      <div className="pt-3 border-t border-white/[0.08] space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
            <Play className="h-3.5 w-3.5 text-emerald-400" />
            <span>Test & Preview Filter</span>
          </span>

          <button
            type="button"
            onClick={handlePreviewFilter}
            disabled={isPreviewing}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-white/[0.08] bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-medium transition-colors disabled:opacity-50"
          >
            <BarChart3 className="h-3.5 w-3.5 text-amber-400" />
            <span>{isPreviewing ? 'Testing last 100...' : 'Preview match rate'}</span>
          </button>
        </div>

        {/* Preview Results Banner */}
        {previewResult && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-mono flex items-center justify-between">
            <span>
              Matches <strong>{previewResult.matchedCount}</strong> of the last{' '}
              <strong>{previewResult.totalEvents}</strong> events
            </span>
            <span className="text-[11px] font-bold">
              {previewResult.totalEvents > 0
                ? `${Math.round((previewResult.matchedCount / previewResult.totalEvents) * 100)}% match rate`
                : 'No historical events'}
            </span>
          </div>
        )}

        {/* Test Against Specific Event */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <select
            value={selectedEventId}
            onChange={(e) => setSelectedEventId(e.target.value)}
            className="flex-1 px-3 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-200 text-xs font-mono focus:outline-none focus:border-white/30"
          >
            <option value="">Select recent event to test against...</option>
            {recentEvents.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.method} {ev.id.slice(0, 8)}... - {new Date(ev.receivedAt).toLocaleTimeString()}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleTestFilter}
            disabled={!selectedEventId || isTesting}
            className="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 text-xs font-semibold transition-colors disabled:opacity-40 shrink-0"
          >
            {isTesting ? 'Evaluating...' : 'Test Filter'}
          </button>
        </div>

        {/* Explanation Table from explainFilter */}
        {testResult && (
          <div className="rounded-xl border border-white/[0.08] bg-zinc-950/80 overflow-hidden text-xs">
            <div
              className={`p-2.5 font-bold flex items-center justify-between ${
                testResult.matched
                  ? 'bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/20'
                  : 'bg-rose-500/10 text-rose-400 border-b border-rose-500/20'
              }`}
            >
              <div className="flex items-center gap-1.5">
                {testResult.matched ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <span>{testResult.matched ? 'FILTER PASSED (Matched)' : 'FILTER REJECTED'}</span>
              </div>
              {testResult.reason && (
                <span className="text-[11px] font-normal text-rose-300 font-mono">
                  {testResult.reason}
                </span>
              )}
            </div>

            {testResult.conditions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="bg-zinc-900/60 text-zinc-400 border-b border-white/[0.06]">
                    <tr>
                      <th className="px-3 py-2">Field</th>
                      <th className="px-3 py-2">Op</th>
                      <th className="px-3 py-2">Expected</th>
                      <th className="px-3 py-2">Actual Value</th>
                      <th className="px-3 py-2 text-right">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {testResult.conditions.map((cond, i) => (
                      <tr key={i} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-zinc-200 font-semibold">{cond.field}</td>
                        <td className="px-3 py-2 text-amber-400">{cond.op}</td>
                        <td className="px-3 py-2 text-zinc-300 max-w-[120px] truncate">
                          {cond.expected !== undefined ? JSON.stringify(cond.expected) : '—'}
                        </td>
                        <td className="px-3 py-2 text-zinc-400 max-w-[160px] truncate">
                          {cond.actual !== undefined ? JSON.stringify(cond.actual) : 'missing'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              cond.passed
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-rose-500/10 text-rose-400'
                            }`}
                          >
                            {cond.passed ? 'PASS' : 'FAIL'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConditionRowProps {
  condition: FilterCondition;
  onChange: (updated: FilterCondition) => void;
  onRemove: () => void;
}

function ConditionRow({ condition, onChange, onRemove }: ConditionRowProps) {
  const currentOpMeta = OPERATORS.find((o) => o.value === condition.op) || OPERATORS[0]!;
  const needsValue = currentOpMeta.needsValue;

  const handleFieldChange = (field: string) => {
    onChange({ ...condition, field });
  };

  const handleOpChange = (op: FilterOperator) => {
    onChange({ ...condition, op });
  };

  const handleValueChange = (valStr: string) => {
    // If numeric comparison, parse number
    if (['gt', 'gte', 'lt', 'lte'].includes(condition.op)) {
      const num = Number(valStr);
      onChange({ ...condition, value: isNaN(num) ? valStr : num });
      return;
    }
    // If in/nin list
    if (['in', 'nin'].includes(condition.op)) {
      const parts = valStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      onChange({ ...condition, value: parts });
      return;
    }
    // If boolean representation
    if (valStr === 'true') {
      onChange({ ...condition, value: true });
      return;
    }
    if (valStr === 'false') {
      onChange({ ...condition, value: false });
      return;
    }
    onChange({ ...condition, value: valStr });
  };

  const displayValue = useMemo(() => {
    if (condition.value === undefined || condition.value === null) return '';
    if (Array.isArray(condition.value)) return condition.value.join(', ');
    return String(condition.value);
  }, [condition.value]);

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-zinc-900/60 p-2.5 rounded-xl border border-white/[0.06]">
      {/* Field Input */}
      <input
        type="text"
        required
        value={condition.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        placeholder="e.g. body.type or headers.x-event"
        className="flex-1 min-w-[140px] px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-mono focus:outline-none focus:border-white/30"
      />

      {/* Operator Dropdown */}
      <select
        value={condition.op}
        onChange={(e) => handleOpChange(e.target.value as FilterOperator)}
        className="sm:w-48 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-200 text-xs font-medium focus:outline-none focus:border-white/30"
      >
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Value Input (Hidden if operator does not need value) */}
      {needsValue ? (
        <input
          type="text"
          value={displayValue}
          onChange={(e) => handleValueChange(e.target.value)}
          placeholder={
            ['in', 'nin'].includes(condition.op)
              ? 'item1, item2, item3'
              : ['gt', 'gte', 'lt', 'lte'].includes(condition.op)
                ? 'number (e.g. 100)'
                : 'expected value'
          }
          className="flex-1 min-w-[130px] px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-mono focus:outline-none focus:border-white/30"
        />
      ) : (
        <div className="flex-1 px-2.5 py-1.5 text-[11px] text-zinc-500 italic bg-zinc-950/40 rounded-lg">
          (No value needed)
        </div>
      )}

      {/* Remove Condition */}
      <button
        type="button"
        onClick={onRemove}
        className="p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors self-end sm:self-center"
        title="Remove condition"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
