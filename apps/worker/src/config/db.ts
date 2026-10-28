import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

let isConnected = false;

export async function connectDatabase(): Promise<typeof mongoose> {
  if (isConnected) {
    return mongoose;
  }

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected in worker');
    isConnected = true;
  });

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error in worker');
    isConnected = false;
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected in worker');
    isConnected = false;
  });

  try {
    const conn = await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    return conn;
  } catch (err) {
    logger.error({ err }, 'Failed to connect to MongoDB in worker');
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB connection closed in worker');
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
