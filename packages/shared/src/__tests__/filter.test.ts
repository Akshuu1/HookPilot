import { describe, it, expect } from 'vitest';
import {
  evaluateFilter,
  explainFilter,
  FilterRuleSchema,
  filterRuleSchema,
  type FilterRule,
  type FilterInput,
} from '../filter.js';

describe('Phase 15: Filter Rule Evaluator & Zod Schema', () => {
  describe('1. Table-driven operator tests', () => {
    type TestCase = {
      name: string;
      op:
        | 'eq'
        | 'neq'
        | 'in'
        | 'nin'
        | 'contains'
        | 'startsWith'
        | 'endsWith'
        | 'exists'
        | 'notExists'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte';
      field: string;
      value?: unknown;
      input: FilterInput;
      expected: boolean;
    };

    const cases: TestCase[] = [
      // eq
      {
        name: 'eq: matching string',
        op: 'eq',
        field: 'body.status',
        value: 'active',
        input: { body: { status: 'active' } },
        expected: true,
      },
      {
        name: 'eq: non-matching string',
        op: 'eq',
        field: 'body.status',
        value: 'active',
        input: { body: { status: 'inactive' } },
        expected: false,
      },
      {
        name: 'eq: missing field is false',
        op: 'eq',
        field: 'body.missing',
        value: 'active',
        input: { body: { status: 'active' } },
        expected: false,
      },
      // neq
      {
        name: 'neq: matching different value',
        op: 'neq',
        field: 'body.status',
        value: 'inactive',
        input: { body: { status: 'active' } },
        expected: true,
      },
      {
        name: 'neq: non-matching identical value',
        op: 'neq',
        field: 'body.status',
        value: 'active',
        input: { body: { status: 'active' } },
        expected: false,
      },
      {
        name: 'neq: missing field is false (not true)',
        op: 'neq',
        field: 'body.missing',
        value: 'active',
        input: { body: { status: 'active' } },
        expected: false,
      },
      // in
      {
        name: 'in: matching array membership',
        op: 'in',
        field: 'body.role',
        value: ['admin', 'member', 'owner'],
        input: { body: { role: 'admin' } },
        expected: true,
      },
      {
        name: 'in: non-matching array membership',
        op: 'in',
        field: 'body.role',
        value: ['admin', 'owner'],
        input: { body: { role: 'viewer' } },
        expected: false,
      },
      {
        name: 'in: missing field is false',
        op: 'in',
        field: 'body.missing',
        value: ['admin', 'owner'],
        input: { body: { role: 'admin' } },
        expected: false,
      },
      // nin
      {
        name: 'nin: matching absence from array',
        op: 'nin',
        field: 'body.role',
        value: ['admin', 'owner'],
        input: { body: { role: 'viewer' } },
        expected: true,
      },
      {
        name: 'nin: non-matching presence in array',
        op: 'nin',
        field: 'body.role',
        value: ['admin', 'owner'],
        input: { body: { role: 'admin' } },
        expected: false,
      },
      {
        name: 'nin: missing field is false',
        op: 'nin',
        field: 'body.missing',
        value: ['admin', 'owner'],
        input: { body: { role: 'admin' } },
        expected: false,
      },
      // contains
      {
        name: 'contains: string substring match',
        op: 'contains',
        field: 'body.message',
        value: 'alert',
        input: { body: { message: 'system critical alert fired' } },
        expected: true,
      },
      {
        name: 'contains: string substring non-match',
        op: 'contains',
        field: 'body.message',
        value: 'warning',
        input: { body: { message: 'system critical alert fired' } },
        expected: false,
      },
      {
        name: 'contains: array element membership',
        op: 'contains',
        field: 'body.tags',
        value: 'prod',
        input: { body: { tags: ['web', 'prod', 'us-east'] } },
        expected: true,
      },
      {
        name: 'contains: array element non-membership',
        op: 'contains',
        field: 'body.tags',
        value: 'staging',
        input: { body: { tags: ['web', 'prod', 'us-east'] } },
        expected: false,
      },
      {
        name: 'contains: missing field is false',
        op: 'contains',
        field: 'body.missing',
        value: 'prod',
        input: { body: { tags: ['web'] } },
        expected: false,
      },
      // startsWith
      {
        name: 'startsWith: matching prefix',
        op: 'startsWith',
        field: 'body.event',
        value: 'user.',
        input: { body: { event: 'user.created' } },
        expected: true,
      },
      {
        name: 'startsWith: non-matching prefix',
        op: 'startsWith',
        field: 'body.event',
        value: 'order.',
        input: { body: { event: 'user.created' } },
        expected: false,
      },
      {
        name: 'startsWith: missing field is false',
        op: 'startsWith',
        field: 'body.missing',
        value: 'user.',
        input: { body: { event: 'user.created' } },
        expected: false,
      },
      // endsWith
      {
        name: 'endsWith: matching suffix',
        op: 'endsWith',
        field: 'body.file',
        value: '.json',
        input: { body: { file: 'data.json' } },
        expected: true,
      },
      {
        name: 'endsWith: non-matching suffix',
        op: 'endsWith',
        field: 'body.file',
        value: '.csv',
        input: { body: { file: 'data.json' } },
        expected: false,
      },
      {
        name: 'endsWith: missing field is false',
        op: 'endsWith',
        field: 'body.missing',
        value: '.json',
        input: { body: { file: 'data.json' } },
        expected: false,
      },
      // exists
      {
        name: 'exists: present field is true',
        op: 'exists',
        field: 'body.metadata',
        input: { body: { metadata: { source: 'api' } } },
        expected: true,
      },
      {
        name: 'exists: null field is true (present)',
        op: 'exists',
        field: 'body.deletedAt',
        input: { body: { deletedAt: null } },
        expected: true,
      },
      {
        name: 'exists: missing field is false',
        op: 'exists',
        field: 'body.nonexistent',
        input: { body: { name: 'demo' } },
        expected: false,
      },
      // notExists
      {
        name: 'notExists: missing field is true',
        op: 'notExists',
        field: 'body.nonexistent',
        input: { body: { name: 'demo' } },
        expected: true,
      },
      {
        name: 'notExists: present field is false',
        op: 'notExists',
        field: 'body.name',
        input: { body: { name: 'demo' } },
        expected: false,
      },
      {
        name: 'notExists: present null field is false',
        op: 'notExists',
        field: 'body.deletedAt',
        input: { body: { deletedAt: null } },
        expected: false,
      },
      // gt
      {
        name: 'gt: 100 > 50 is true',
        op: 'gt',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 100 } },
        expected: true,
      },
      {
        name: 'gt: 50 > 50 is false',
        op: 'gt',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 50 } },
        expected: false,
      },
      {
        name: 'gt: missing field is false',
        op: 'gt',
        field: 'body.missing',
        value: 50,
        input: { body: { amount: 100 } },
        expected: false,
      },
      // gte
      {
        name: 'gte: 50 >= 50 is true',
        op: 'gte',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 50 } },
        expected: true,
      },
      {
        name: 'gte: 49 >= 50 is false',
        op: 'gte',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 49 } },
        expected: false,
      },
      // lt
      {
        name: 'lt: 25 < 50 is true',
        op: 'lt',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 25 } },
        expected: true,
      },
      {
        name: 'lt: 50 < 50 is false',
        op: 'lt',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 50 } },
        expected: false,
      },
      // lte
      {
        name: 'lte: 50 <= 50 is true',
        op: 'lte',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 50 } },
        expected: true,
      },
      {
        name: 'lte: 51 <= 50 is false',
        op: 'lte',
        field: 'body.amount',
        value: 50,
        input: { body: { amount: 51 } },
        expected: false,
      },
    ];

    for (const tc of cases) {
      it(tc.name, () => {
        const rule: FilterRule = {
          combinator: 'and',
          conditions: [{ field: tc.field, op: tc.op, value: tc.value }],
        };
        const result = evaluateFilter(rule, tc.input);
        expect(result).toBe(tc.expected);
      });
    }
  });

  describe('2. Combinators and Nested Groups', () => {
    it('combinator "and" requires all conditions to pass', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.tier', op: 'eq', value: 'premium' },
          { field: 'body.score', op: 'gte', value: 80 },
        ],
      };

      expect(evaluateFilter(rule, { body: { tier: 'premium', score: 90 } })).toBe(true);
      expect(evaluateFilter(rule, { body: { tier: 'premium', score: 70 } })).toBe(false);
      expect(evaluateFilter(rule, { body: { tier: 'free', score: 90 } })).toBe(false);
    });

    it('combinator "or" passes if any condition passes', () => {
      const rule: FilterRule = {
        combinator: 'or',
        conditions: [
          { field: 'body.role', op: 'eq', value: 'admin' },
          { field: 'body.vip', op: 'eq', value: true },
        ],
      };

      expect(evaluateFilter(rule, { body: { role: 'admin', vip: false } })).toBe(true);
      expect(evaluateFilter(rule, { body: { role: 'user', vip: true } })).toBe(true);
      expect(evaluateFilter(rule, { body: { role: 'user', vip: false } })).toBe(false);
    });

    it('nested groups up to depth 3 evaluate properly', () => {
      // (method === 'POST') AND ( (event === 'order.created' AND amount > 100) OR (event === 'refund') )
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'method', op: 'eq', value: 'POST' },
          {
            combinator: 'or',
            conditions: [
              {
                combinator: 'and',
                conditions: [
                  { field: 'body.event', op: 'eq', value: 'order.created' },
                  { field: 'body.amount', op: 'gt', value: 100 },
                ],
              },
              { field: 'body.event', op: 'eq', value: 'refund' },
            ],
          },
        ],
      };

      // Validates against Zod schema
      expect(() => FilterRuleSchema.parse(rule)).not.toThrow();

      // Matches branch 1
      expect(
        evaluateFilter(rule, {
          method: 'POST',
          body: { event: 'order.created', amount: 250 },
        }),
      ).toBe(true);

      // Matches branch 2
      expect(
        evaluateFilter(rule, {
          method: 'POST',
          body: { event: 'refund', amount: 10 },
        }),
      ).toBe(true);

      // Fails branch 1 (amount <= 100)
      expect(
        evaluateFilter(rule, {
          method: 'POST',
          body: { event: 'order.created', amount: 50 },
        }),
      ).toBe(false);

      // Fails outer and (method != 'POST')
      expect(
        evaluateFilter(rule, {
          method: 'GET',
          body: { event: 'refund' },
        }),
      ).toBe(false);
    });

    it('empty filter matches everything', () => {
      expect(evaluateFilter(null, { body: { a: 1 } })).toBe(true);
      expect(evaluateFilter(undefined, { body: { a: 1 } })).toBe(true);
      expect(evaluateFilter({}, { body: { a: 1 } })).toBe(true);
      expect(evaluateFilter({ combinator: 'and', conditions: [] }, { body: { a: 1 } })).toBe(true);
    });
  });

  describe('3. Depth, Condition Count, and Schema Limits', () => {
    it('accepts valid depth 3 rule', () => {
      const depth3Rule: FilterRule = {
        combinator: 'and',
        conditions: [
          {
            combinator: 'or',
            conditions: [
              {
                combinator: 'and',
                conditions: [{ field: 'body.x', op: 'eq', value: 1 }],
              },
            ],
          },
        ],
      };
      expect(() => FilterRuleSchema.parse(depth3Rule)).not.toThrow();
    });

    it('rejects rule with depth > 3', () => {
      const depth4Rule = {
        combinator: 'and',
        conditions: [
          {
            combinator: 'or',
            conditions: [
              {
                combinator: 'and',
                conditions: [
                  {
                    combinator: 'or',
                    conditions: [{ field: 'body.deep', op: 'eq', value: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(() => FilterRuleSchema.parse(depth4Rule)).toThrow(/maximum nesting depth of 3/);
    });

    it('rejects rule with more than 20 conditions', () => {
      const conditions = Array.from({ length: 21 }, (_, i) => ({
        field: `body.item_${i}`,
        op: 'eq' as const,
        value: i,
      }));

      const hugeRule = {
        combinator: 'and',
        conditions,
      };

      expect(() => FilterRuleSchema.parse(hugeRule)).toThrow(/maximum of 20 conditions/);
    });

    it('filterRuleSchema alias behaves identically', () => {
      expect(filterRuleSchema).toBe(FilterRuleSchema);
    });
  });

  describe('4. Prototype Pollution Protection', () => {
    it('rejects prototype pollution fields in FilterRuleSchema', () => {
      const maliciousCases = [
        { field: '__proto__.isAdmin', op: 'eq' as const, value: true },
        { field: 'body.constructor.prototype.admin', op: 'eq' as const, value: true },
        { field: 'headers.__proto__', op: 'eq' as const, value: 'true' },
        { field: 'body.prototype.polluted', op: 'eq' as const, value: 'yes' },
      ];

      for (const cond of maliciousCases) {
        const rule = {
          combinator: 'and',
          conditions: [cond],
        };
        expect(() => FilterRuleSchema.parse(rule)).toThrow(/Forbidden property path/);
      }
    });

    it('evaluateFilter never accesses prototype pollution paths and never throws', () => {
      const evilRule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.__proto__.polluted', op: 'eq', value: 'yes' },
          { field: 'body.constructor.prototype.polluted', op: 'eq', value: 'yes' },
          { field: 'headers.__proto__', op: 'exists' },
        ],
      };

      // Even if such a rule bypasses schema, evaluateFilter safely returns false and does not pollute Object.prototype
      expect(evaluateFilter(evilRule, { body: { name: 'test' } })).toBe(false);
      expect((Object.prototype as any).polluted).toBeUndefined();
    });
  });

  describe('5. Type Strictness, Arrays & Edge Cases', () => {
    it('strict type checking: string "5" does not equal number 5', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.count', op: 'eq', value: 5 }],
      };

      expect(evaluateFilter(rule, { body: { count: '5' } })).toBe(false);
      expect(evaluateFilter(rule, { body: { count: 5 } })).toBe(true);
    });

    it('strict boolean checking: boolean true does not equal string "true"', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.flag', op: 'eq', value: true }],
      };

      expect(evaluateFilter(rule, { body: { flag: 'true' } })).toBe(false);
      expect(evaluateFilter(rule, { body: { flag: true } })).toBe(true);
    });

    it('numeric comparison operators only compare numbers', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.val', op: 'gt', value: 10 }],
      };

      expect(evaluateFilter(rule, { body: { val: '20' } })).toBe(false);
      expect(evaluateFilter(rule, { body: { val: 20 } })).toBe(true);
    });

    it('supports array index path navigation in body.<path>.<index>', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.items.0.sku', op: 'eq', value: 'BOOK-123' },
          { field: 'body.items.1.price', op: 'lt', value: 50 },
        ],
      };

      const input: FilterInput = {
        body: {
          items: [
            { sku: 'BOOK-123', price: 100 },
            { sku: 'PEN-456', price: 15 },
          ],
        },
      };

      expect(evaluateFilter(rule, input)).toBe(true);
    });

    it('handles huge arrays without crashing or timing out', () => {
      const hugeArray = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
      hugeArray[9999] = { id: 9999 };

      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.items.9999.id', op: 'eq', value: 9999 }],
      };

      expect(evaluateFilter(rule, { body: { items: hugeArray } })).toBe(true);
    });

    it('handles malformed JSON body gracefully without throwing', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.type', op: 'eq', value: 'webhook' }],
      };

      const badInputs: FilterInput[] = [
        { body: '{ malformed json: true' },
        { body: 12345 as any },
        { body: null },
        { body: undefined },
      ];

      for (const input of badInputs) {
        expect(() => evaluateFilter(rule, input)).not.toThrow();
        expect(evaluateFilter(rule, input)).toBe(false);
      }
    });

    it('parses and filters form-urlencoded body payload', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.action', op: 'eq', value: 'checkout' },
          { field: 'body.userId', op: 'eq', value: 'usr_abc123' },
        ],
      };

      const input: FilterInput = {
        body: 'action=checkout&userId=usr_abc123&currency=USD',
        contentType: 'application/x-www-form-urlencoded',
      };

      expect(evaluateFilter(rule, input)).toBe(true);
    });

    it('filters case-insensitively on headers.<lowercase-name>', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'headers.x-github-event', op: 'eq', value: 'push' }],
      };

      const input: FilterInput = {
        headers: {
          'X-GitHub-Event': 'push',
          'Content-Type': 'application/json',
        },
      };

      expect(evaluateFilter(rule, input)).toBe(true);
    });
  });

  describe('6. explainFilter output & UI explanation', () => {
    it('returns matched, reason naming the first failing condition, and conditions list', () => {
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.type', op: 'eq', value: 'order.created' },
          { field: 'body.amount', op: 'gte', value: 500 },
        ],
      };

      const explanation = explainFilter(rule, {
        body: { type: 'order.created', amount: 150 },
      });

      expect(explanation.matched).toBe(false);
      expect(explanation.reason).toContain('Condition failed: body.amount gte 500');
      expect(explanation.conditions).toHaveLength(2);
      expect(explanation.conditions[0]).toEqual({
        field: 'body.type',
        op: 'eq',
        expected: 'order.created',
        actual: 'order.created',
        passed: true,
      });
      expect(explanation.conditions[1]).toEqual({
        field: 'body.amount',
        op: 'gte',
        expected: 500,
        actual: 150,
        passed: false,
      });
    });

    it('truncates actual value to at most 200 characters in explanation', () => {
      const longString = 'x'.repeat(500);
      const rule: FilterRule = {
        combinator: 'and',
        conditions: [{ field: 'body.notes', op: 'eq', value: 'target' }],
      };

      const explanation = explainFilter(rule, { body: { notes: longString } });
      expect(explanation.matched).toBe(false);
      expect(explanation.conditions[0].actual).toBeDefined();
      const actualStr = String(explanation.conditions[0].actual);
      expect(actualStr.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(actualStr.endsWith('...')).toBe(true);
    });
  });

  describe('7. Performance Benchmark', () => {
    it('runs 1000 evaluations on a 100 KB body in well under 1 second', () => {
      // Build ~100 KB body
      const largeObject: Record<string, unknown> = {
        id: 'evt_benchmark_test',
        type: 'payment.succeeded',
        data: {},
      };
      for (let i = 0; i < 1500; i++) {
        (largeObject.data as Record<string, unknown>)[`field_${i}`] = {
          value: i,
          desc: `Sample payload descriptive text block #${i}`,
          active: i % 2 === 0,
        };
      }
      const rawBody = JSON.stringify(largeObject);
      expect(rawBody.length).toBeGreaterThan(100_000); // Verify > 100 KB

      const rule: FilterRule = {
        combinator: 'and',
        conditions: [
          { field: 'body.type', op: 'eq', value: 'payment.succeeded' },
          { field: 'body.data.field_100.active', op: 'eq', value: true },
        ],
      };

      const input: FilterInput = {
        body: rawBody,
        contentType: 'application/json',
      };

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        const matched = evaluateFilter(rule, input);
        if (!matched) throw new Error('Evaluation unexpectedly failed');
      }
      const durationMs = performance.now() - start;

      // 1000 evaluations on 100 KB body must finish in well under 1000 ms (1s)
      expect(durationMs).toBeLessThan(1000);
    });
  });
});
