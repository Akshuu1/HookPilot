import type { Request, Response, NextFunction } from 'express';
import { createAlertRuleSchema, updateAlertRuleSchema } from '@hookpilot/shared';
import { alertRuleService } from '../services/alert-rule.service.js';

export class AlertRuleController {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workspaceId = String(req.params.workspaceId);
      const validated = createAlertRuleSchema.parse(req.body);
      const rule = await alertRuleService.createRule(workspaceId, req.user!.id, validated);
      res.status(201).json(rule);
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workspaceId = String(req.params.workspaceId);
      const rules = await alertRuleService.listRules(workspaceId);
      res.status(200).json({ rules });
    } catch (err) {
      next(err);
    }
  }

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = req.alertRule!;
      const result = await alertRuleService.getRuleById(rule.id, rule.workspaceId.toString());
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = req.alertRule!;
      const validated = updateAlertRuleSchema.parse(req.body);
      const updated = await alertRuleService.updateRule(
        rule.id,
        rule.workspaceId.toString(),
        validated,
      );
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = req.alertRule!;
      await alertRuleService.deleteRule(rule.id, rule.workspaceId.toString());
      res.status(200).json({ success: true, message: 'Alert rule deleted' });
    } catch (err) {
      next(err);
    }
  }

  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = req.alertRule!;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const history = await alertRuleService.getRuleHistory(
        rule.id,
        rule.workspaceId.toString(),
        limit,
      );
      res.status(200).json({ history });
    } catch (err) {
      next(err);
    }
  }

  async testEvaluate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = req.alertRule!;
      const result = await alertRuleService.testEvaluate(rule.id, rule.workspaceId.toString());
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

export const alertRuleController = new AlertRuleController();
