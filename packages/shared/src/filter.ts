import { z } from 'zod';

export const FilterOperators = [
  'eq',
  'neq',
  'in',
  'nin',
  'contains',
  'startsWith',
  'endsWith',
  'exists',
  'notExists',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;

export type FilterOperator = (typeof FilterOperators)[number];

export const FilterCombinators = ['and', 'or'] as const;
export type FilterCombinator = (typeof FilterCombinators)[number];

export interface FilterCondition {
  field: string;
  op: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  combinator: FilterCombinator;
  conditions: Array<FilterCondition | FilterGroup>;
  [key: string]: unknown;
}

export type FilterRule = FilterGroup;

export interface FilterInput {
  body?: unknown;
  headers?: Record<string, unknown> | Map<string, unknown> | null | undefined;
  method?: string | undefined;
  contentType?: string | null | undefined;
}

export interface FilterConditionExplanation {
  field: string;
  op: FilterOperator;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface FilterExplanation {
  matched: boolean;
  reason?: string | null;
  conditions: FilterConditionExplanation[];
}

const FORBIDDEN_TOKENS = new Set(['__proto__', 'constructor', 'prototype']);

// Zod Schemas
export const FilterConditionSchema = z.object({
  field: z.string().min(1, 'Field path is required').max(256),
  op: z.enum(FilterOperators),
  value: z.any().optional(),
});

function getDepth(group: unknown, currentDepth = 1): number {
  if (!group || typeof group !== 'object') return currentDepth;
  const g = group as { conditions?: unknown[] };
  if (!Array.isArray(g.conditions) || g.conditions.length === 0) return currentDepth;

  let maxChildDepth = currentDepth;
  for (const item of g.conditions) {
    if (item && typeof item === 'object' && 'combinator' in item && 'conditions' in item) {
      const d = getDepth(item, currentDepth + 1);
      if (d > maxChildDepth) maxChildDepth = d;
    }
  }
  return maxChildDepth;
}

function countConditions(group: unknown): number {
  if (!group || typeof group !== 'object') return 0;
  const g = group as { conditions?: unknown[] };
  if (!Array.isArray(g.conditions)) return 0;

  let count = 0;
  for (const item of g.conditions) {
    if (item && typeof item === 'object') {
      if ('combinator' in item && 'conditions' in item) {
        count += countConditions(item);
      } else if ('field' in item && 'op' in item) {
        count += 1;
      }
    }
  }
  return count;
}

function collectFieldNames(group: unknown): string[] {
  if (!group || typeof group !== 'object') return [];
  const g = group as { conditions?: unknown[] };
  if (!Array.isArray(g.conditions)) return [];

  const fields: string[] = [];
  for (const item of g.conditions) {
    if (item && typeof item === 'object') {
      if ('combinator' in item && 'conditions' in item) {
        fields.push(...collectFieldNames(item));
      } else if ('field' in item && typeof (item as { field: unknown }).field === 'string') {
        fields.push((item as { field: string }).field);
      }
    }
  }
  return fields;
}

export const BaseFilterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    combinator: z.enum(FilterCombinators),
    conditions: z.array(z.union([FilterConditionSchema, BaseFilterGroupSchema])).max(20),
  }),
);

export const FilterRuleSchema = BaseFilterGroupSchema.superRefine((val, ctx) => {
  const depth = getDepth(val);
  if (depth > 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Filter exceeds maximum nesting depth of 3',
    });
  }

  const count = countConditions(val);
  if (count > 20) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Filter exceeds maximum of 20 conditions (got ${count})`,
    });
  }

  const fields = collectFieldNames(val);
  for (const f of fields) {
    if (f.includes('__proto__') || f.includes('constructor') || f.includes('prototype')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forbidden property path in field: "${f}"`,
      });
    }
  }
});

export const filterRuleSchema = FilterRuleSchema;

/**
 * Parses body based on content type or structure.
 * Never throws on bad input.
 */
export function parseBody(body: unknown, contentType?: string | null): unknown {
  if (body == null) return undefined;
  if (typeof body !== 'string') return body;

  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;

  const cType = (contentType || '').toLowerCase();

  // Try JSON if contentType indicates JSON or string starts with { or [
  if (cType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  // Try form-urlencoded if contentType indicates form or string contains = and not JSON
  if (cType.includes('form-urlencoded') || cType.includes('x-www-form-urlencoded')) {
    try {
      return Object.fromEntries(new URLSearchParams(trimmed));
    } catch {
      return undefined;
    }
  }

  // Fallback: check if valid JSON anyway
  try {
    return JSON.parse(trimmed);
  } catch {
    // If it looks like form data (contains '=' and '&'), try URLSearchParams
    if (trimmed.includes('=')) {
      try {
        return Object.fromEntries(new URLSearchParams(trimmed));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Extracts a field value from parsed input.
 * Rejects prototype pollution paths and reads only own properties.
 * Returns undefined if path does not exist.
 */
export function extractFieldValue(field: string, parsedBody: unknown, input: FilterInput): unknown {
  if (!field || typeof field !== 'string') return undefined;

  // Reject forbidden prototype pollution keywords
  if (field.includes('__proto__') || field.includes('constructor') || field.includes('prototype')) {
    return undefined;
  }

  if (field === 'method') {
    return typeof input.method === 'string' ? input.method : undefined;
  }

  if (field.startsWith('headers.')) {
    const headerName = field.slice('headers.'.length).toLowerCase();
    if (!headerName || FORBIDDEN_TOKENS.has(headerName)) return undefined;

    if (!input.headers) return undefined;

    if (input.headers instanceof Map) {
      return input.headers.get(headerName);
    }

    if (typeof input.headers === 'object') {
      const headersObj = input.headers as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(headersObj, headerName)) {
        return headersObj[headerName];
      }
      // Case-insensitive fallback
      for (const key of Object.keys(headersObj)) {
        if (key.toLowerCase() === headerName) {
          return headersObj[key];
        }
      }
    }
    return undefined;
  }

  if (field === 'body') {
    return parsedBody;
  }

  if (field.startsWith('body.')) {
    const pathStr = field.slice('body.'.length);
    if (!pathStr) return undefined;

    const parts = pathStr.split('.');
    let current: unknown = parsedBody;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }

      if (FORBIDDEN_TOKENS.has(part)) {
        return undefined;
      }

      if (Array.isArray(current)) {
        const idx = Number(part);
        if (Number.isInteger(idx) && idx >= 0 && idx < current.length) {
          current = current[idx];
        } else {
          return undefined;
        }
      } else {
        if (!Object.prototype.hasOwnProperty.call(current, part)) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[part];
      }
    }

    return current;
  }

  return undefined;
}

/**
 * Evaluates a single filter condition against the actual field value.
 * Strict semantics:
 * - A missing field (actual === undefined) makes the condition false, except notExists which is true.
 * - No implicit type coercion ('5' is not 5).
 */
export function evaluateCondition(actual: unknown, op: FilterOperator, expected: unknown): boolean {
  if (actual === undefined) {
    return op === 'notExists';
  }

  switch (op) {
    case 'exists':
      return true;

    case 'notExists':
      return false;

    case 'eq':
      return actual === expected;

    case 'neq':
      return actual !== expected;

    case 'in':
      return Array.isArray(expected) && expected.includes(actual);

    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual);

    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;

    case 'startsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );

    case 'endsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
      );

    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;

    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;

    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;

    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;

    default:
      return false;
  }
}

function truncateString(val: unknown, maxLen = 200): unknown {
  if (val === undefined) return undefined;
  if (typeof val === 'string') {
    return val.length > maxLen ? val.slice(0, maxLen) + '...' : val;
  }
  try {
    const str = JSON.stringify(val);
    if (str && str.length > maxLen) {
      return str.slice(0, maxLen) + '...';
    }
    return val;
  } catch {
    return String(val).slice(0, maxLen);
  }
}

/**
 * Pure function: evaluates whether an input matches a FilterRule.
 * Never throws on bad input. Empty filter matches everything.
 */
export function evaluateFilter(rule: unknown, input: FilterInput): boolean {
  try {
    if (!rule || typeof rule !== 'object') return true;

    const group = rule as FilterGroup;
    if (!group.conditions || !Array.isArray(group.conditions) || group.conditions.length === 0) {
      return true;
    }

    const parsedBody = parseBody(input.body, input.contentType);

    return evaluateGroup(group, parsedBody, input, 1);
  } catch {
    return true; // Never throw on bad input
  }
}

function evaluateGroup(
  group: FilterGroup,
  parsedBody: unknown,
  input: FilterInput,
  depth: number,
): boolean {
  if (depth > 3) return false;

  const combinator = group.combinator === 'or' ? 'or' : 'and';
  const conditions = group.conditions || [];

  if (conditions.length === 0) return true;

  if (combinator === 'or') {
    for (const item of conditions) {
      if ('combinator' in item && 'conditions' in item) {
        if (evaluateGroup(item, parsedBody, input, depth + 1)) return true;
      } else if ('field' in item && 'op' in item) {
        const actual = extractFieldValue(item.field, parsedBody, input);
        if (evaluateCondition(actual, item.op, item.value)) return true;
      }
    }
    return false;
  }

  // combinator === 'and'
  for (const item of conditions) {
    if ('combinator' in item && 'conditions' in item) {
      if (!evaluateGroup(item, parsedBody, input, depth + 1)) return false;
    } else if ('field' in item && 'op' in item) {
      const actual = extractFieldValue(item.field, parsedBody, input);
      if (!evaluateCondition(actual, item.op, item.value)) return false;
    }
  }
  return true;
}

/**
 * Returns a per-condition result list (field, op, expected, actual, passed) for the UI.
 * Never includes more than 200 characters of any actual value.
 */
export function explainFilter(rule: unknown, input: FilterInput): FilterExplanation {
  try {
    if (!rule || typeof rule !== 'object') {
      return { matched: true, reason: null, conditions: [] };
    }

    const group = rule as FilterGroup;
    if (!group.conditions || !Array.isArray(group.conditions) || group.conditions.length === 0) {
      return { matched: true, reason: null, conditions: [] };
    }

    const parsedBody = parseBody(input.body, input.contentType);
    const conditionResults: FilterConditionExplanation[] = [];

    const matched = explainGroup(group, parsedBody, input, conditionResults, 1);

    let reason: string | null = null;
    if (!matched) {
      const firstFailing = conditionResults.find((c) => !c.passed);
      if (firstFailing) {
        const expectedStr =
          firstFailing.expected !== undefined
            ? ` ${JSON.stringify(truncateString(firstFailing.expected, 50))}`
            : '';
        reason = `Condition failed: ${firstFailing.field} ${firstFailing.op}${expectedStr}`;
      } else {
        reason = 'Filter conditions did not match';
      }
    }

    return {
      matched,
      reason,
      conditions: conditionResults,
    };
  } catch {
    return { matched: true, reason: null, conditions: [] };
  }
}

function explainGroup(
  group: FilterGroup,
  parsedBody: unknown,
  input: FilterInput,
  results: FilterConditionExplanation[],
  depth: number,
): boolean {
  if (depth > 3) return false;

  const combinator = group.combinator === 'or' ? 'or' : 'and';
  const conditions = group.conditions || [];

  if (conditions.length === 0) return true;

  let groupMatched = combinator === 'and';

  for (const item of conditions) {
    if ('combinator' in item && 'conditions' in item) {
      const nestedMatched = explainGroup(item, parsedBody, input, results, depth + 1);
      if (combinator === 'or' && nestedMatched) {
        groupMatched = true;
      } else if (combinator === 'and' && !nestedMatched) {
        groupMatched = false;
      }
    } else if ('field' in item && 'op' in item) {
      const actual = extractFieldValue(item.field, parsedBody, input);
      const passed = evaluateCondition(actual, item.op, item.value);

      results.push({
        field: item.field,
        op: item.op,
        expected: truncateString(item.value, 200),
        actual: truncateString(actual, 200),
        passed,
      });

      if (combinator === 'or' && passed) {
        groupMatched = true;
      } else if (combinator === 'and' && !passed) {
        groupMatched = false;
      }
    }
  }

  return groupMatched;
}
