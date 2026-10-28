import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { apiKeyAuth } from '../middlewares/api-key-auth.middleware.js';
import { authRateLimiter } from '../middlewares/rate-limiter.js';

export const authRouter = Router();

authRouter.post('/register', authRateLimiter, authController.register);
authRouter.post('/login', authRateLimiter, authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', authMiddleware, authController.getMe);
authRouter.get('/verify-key', apiKeyAuth, (req, res) => {
  res.status(200).json({
    valid: true,
    workspaceId: req.workspaceId,
    apiKeyId: req.apiKey?.id,
    name: req.apiKey?.name,
  });
});
