import winston from 'winston';
import path from 'path';
import fs from 'fs';

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const m = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${m}`;
  })
);

const transports: winston.transport[] = [
  new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), fmt) }),
];

// File logging — skip on read-only filesystems (e.g. Vercel)
try {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  transports.push(new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }));
  transports.push(new winston.transports.File({ filename: path.join(logsDir, 'combined.log') }));
} catch {
  // silently skip file logging
}

declare global { var __logger: winston.Logger | undefined }
export const logger: winston.Logger = global.__logger ?? winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: fmt,
  transports,
});
global.__logger = logger;
